/* ------------------------------------------------------------------
 * Muse Glimmer via hosted OpenAI-compatible inference (Together AI).
 *
 * Why hosted, not on-device: Glimmer-30B needs ~17GB+ quantized — Mac/RTX
 * territory, not phones. "Local agentic" here means Meta's open agent model
 * (tool use + failure recovery + 131K context) served over an OpenAI-style
 * API, running the SAME tool loop as Spark. No key → provider is skipped,
 * exactly like groq/gemini when unconfigured.
 *
 * Best practices per Meta's model card: temperature 1.0, top_p 0.95, and a
 * "Reasoning strength: ..." system line. Temperature/top_p live here; the
 * reasoning-strength line is appended by the route's glimmer runner so the
 * shared system prompt stays untouched for other providers.
 * ------------------------------------------------------------------ */

const trimSlash = s => String(s || '').replace(/\/+$/, '');

function glimmerCfg() {
  return {
    apiKey: String(process.env.TOGETHER_API_KEY || '').trim(),
    baseUrl: trimSlash(process.env.TOGETHER_API_BASE || 'https://api.together.xyz/v1'),
    // Confirm the exact slug on the Together dashboard; override via env.
    model: String(process.env.GLIMMER_MODEL || 'meta-models/Muse-Glimmer-30B').trim(),
    timeoutMs: Number(process.env.GLIMMER_TIMEOUT_MS) || 60000,
  };
}

function glimmerConfigured() {
  const c = glimmerCfg();
  return !!(c.apiKey && c.model);
}

/* OpenAI-shaped call. Returns { raw } with choices[0].message carrying
 * content and/or tool_calls, so the route's agent loop treats Glimmer
 * exactly like the Meta/Groq OpenAI-style runners. */
async function glimmerChat({ messages, tools, toolChoice = 'auto', maxTokens = 2400 } = {}) {
  const c = glimmerCfg();
  if (!c.apiKey) throw new Error('glimmer_not_configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let res;
  try {
    res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        ...(tools ? { tools, tool_choice: toolChoice } : {}),
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`glimmer_network: ${e?.message || e}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`glimmer_http_${res.status}: ${String(body).slice(0, 200)}`);
  }
  const data = await res.json();
  return { raw: data, model: c.model };
}

module.exports = { glimmerCfg, glimmerConfigured, glimmerChat };
