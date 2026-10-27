/* ------------------------------------------------------------------
 * Background cleanup for product photos (create-ad pipeline).
 *
 * Contract-first: POST multipart `image` to BG_API_URL with
 * `Authorization: Bearer BG_API_KEY` must answer 200 with RGBA PNG bytes
 * (transparent background). We flatten onto white, resize to 1080px and
 * return JPEG — the ecommerce-standard cover. No URL/key configured, wrong
 * content type back, or any failure: throw, and callers keep the original
 * photo. A "cleaned" photo is never faked.
 *
 * License diligence (Oct 2026): BRIA RMBG v1.4/v2.0 weights are CC BY-NC —
 * NOT usable in Salmart, a commercial marketplace. SAM checkpoints need
 * box/point prompts and GPU self-hosting; there is no hosted promptable SAM
 * API. So this module targets a commercially-licensed pay-per-call matting
 * endpoint (fal.ai, Replicate, Cloudinary add-on): the provider handles
 * licensing, we hold no weights, BG_MODEL records which service ran.
 * ------------------------------------------------------------------ */

function bgCfg() {
  return {
    apiUrl: String(process.env.BG_API_URL || '').trim(),
    apiKey: String(process.env.BG_API_KEY || '').trim(),
    label: String(process.env.BG_MODEL || 'bg-matting').trim(),
    timeoutMs: Number(process.env.BG_TIMEOUT_MS) || 45000,
  };
}

function bgConfigured() {
  const c = bgCfg();
  return !!(c.apiUrl && c.apiKey);
}

const CLEAN_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/* Provider call: raw RGBA PNG bytes out. Kept separate from compositing so
 * the contract is unit-testable without sharp or network (see tests). */
async function fetchRgba({ buffer, mime }, fetchImpl = fetch) {
  const c = bgCfg();
  if (!c.apiUrl || !c.apiKey) throw new Error('bgclean_not_configured');
  if (!buffer || !buffer.length) throw new Error('empty_image');
  if (!CLEAN_MIMES.includes(String(mime || '').toLowerCase())) {
    throw new Error('unsupported_image_type');
  }
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), 'photo.jpg');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let res;
  try {
    res = await fetchImpl(c.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`bgclean_network: ${e?.message || e}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`bgclean_http_${res.status}`);
  const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
  if (!type.includes('image/')) throw new Error('bgclean_bad_response');
  return Buffer.from(await res.arrayBuffer());
}

/* RGBA in, white 1080px JPEG out. sharp loads lazily so requiring this
 * module never fails where sharp isn't installed. */
async function compositeEcommerce(pngBuffer) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (_e) {
    throw new Error('bgclean_no_sharp');
  }
  return sharp(pngBuffer)
    .flatten({ background: '#ffffff' })
    .resize({ width: 1080, withoutEnlargement: true })
    .jpeg({ quality: 0.85 })
    .toBuffer();
}

async function cleanBackground({ buffer, mime } = {}) {
  const rgba = await fetchRgba({ buffer, mime });
  const out = await compositeEcommerce(rgba);
  return { buffer: out, mimeType: 'image/jpeg', label: bgCfg().label };
}

module.exports = { bgCfg, bgConfigured, fetchRgba, compositeEcommerce, cleanBackground };
