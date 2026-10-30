/* CommonJS port of salmart-llama-voice-agent/backend/lib/config.js.
 * Generated from the hackathon repo; keep the two in sync. */
const dotenv = require("dotenv");

dotenv.config();

const bool = (v) => String(v || "").toLowerCase() === "true";
const trimSlash = (v) => String(v || "").replace(/\/+$/, "");
// Env dashboards often keep the quotes a developer pasted. A quoted model id
// is sent verbatim and Meta answers 404 "model not found", so strip them — and
// say so once, because the deploy's env is the only place that value exists.
function cleanModel(v) {
  const raw = String(v || "").trim();
  const clean = raw.replace(/^['"]+|['"]+$/g, "").trim();
  if (raw && raw !== clean) {
    console.warn(`[config] model env value has stray quotes/whitespace: ${JSON.stringify(raw)} → using "${clean}"`);
  }
  return clean;
}

const DEFAULT_BRAIN_MODEL = "muse-spark-1.3";
// The previous version Meta still serves. It must differ from the primary:
// when both were "muse-spark-1.3" a single bad MODEL_BRAIN left no retry path.
const DEFAULT_BRAIN_FALLBACK = "muse-spark-1.2";

const META_API_KEY = String(process.env.META_API_KEY || "").trim();
const META_API_BASE = trimSlash(process.env.META_API_BASE || "https://api.meta.ai/v1");
// Boot fingerprint: length + last 4 chars only, never the secret. Lets ops
// compare the Render key against the local key without pasting either.
// Proxy presence is logged too: an egress proxy can mangle API responses.
if (META_API_KEY) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy;
  console.log(`[config] META_API_KEY present (len=${META_API_KEY.length}, tail=…${META_API_KEY.slice(-4)}, base=${META_API_BASE}, proxy=${proxy ? 'set' : 'unset'})`);
} else {
  console.warn('[config] META_API_KEY is empty; the demo brain will answer');
}
const STT_API_KEY = String(process.env.STT_API_KEY || "").trim();
const STT_API_BASE = trimSlash(process.env.STT_API_BASE);
const STT_MODEL = cleanModel(process.env.STT_MODEL)
  || cleanModel(process.env.MODEL_VOICE)
  || "muse-voice-transcribe-1.0";
const SALMART_API_BASE = trimSlash(process.env.SALMART_API_BASE);

const forcedMode = String(process.env.DEMO_MODE || "auto").toLowerCase();
const metaConfigured = Boolean(META_API_KEY);
const mock = forcedMode === "mock" || (forcedMode !== "live" && !metaConfigured);

// If the venue Wi-Fi drops or the key is rejected, stop re-trying the model on
// every message. The demo brain takes over immediately and a background probe
// keeps checking until a real call succeeds. Until then we stay in demo mode:
// a judge's first message must never wait on a dead provider.
const DOWN_COOLDOWN_MS = Number(process.env.META_COOLDOWN_MS || 60_000);
let metaDown = false;
let metaDownReason = "";
let recoveryTimer = null;
let recoveryProbe = null;

/** The server registers the function used to test whether the model is back. */
function setRecoveryProbe(fn) {
  recoveryProbe = typeof fn === "function" ? fn : null;
  if (metaDown) scheduleRecovery();
}

function scheduleRecovery() {
  if (recoveryTimer || metaDown || !recoveryProbe || mock) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (!metaDown) return;
    try {
      await recoveryProbe();
    } catch (_e) {
      // chatCompletion already marked it down and rescheduled.
      scheduleRecovery();
    }
  }, DOWN_COOLDOWN_MS);
  // Never keep the Node process alive just for this retry.
  recoveryTimer.unref?.();
}

function markMetaDown(reason) {
  const wasDown = metaDown;
  metaDown = true;
  metaDownReason = String(reason || "model unavailable").slice(0, 300);
  if (!wasDown) {
    console.warn(`[config] Meta model paused, using the demo brain. Retrying every ${Math.round(DOWN_COOLDOWN_MS / 1000)}s: ${metaDownReason}`);
  }
  scheduleRecovery();
}

function markMetaUp() {
  metaDown = false;
  metaDownReason = "";
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

function metaIsDown() {
  return metaDown;
}

function shouldUseMock() {
  return mock || metaDown;
}

const config = {
  port: Number(process.env.PORT || 5000),

  meta: {
    apiKey: META_API_KEY,
    baseUrl: META_API_BASE,
    // Model API ids: https://dev.meta.ai/docs/models
    // A hardcoded fallback matters: a deploy with no MODEL_BRAIN/META_MODEL sent
    // `model: undefined` and Meta answered 404 "model not found", which took the
    // whole chat down even though the default model was available.
    brainModel: cleanModel(process.env.MODEL_BRAIN)
      || cleanModel(process.env.META_MODEL)
      || DEFAULT_BRAIN_MODEL,
    brainModelFallback: cleanModel(process.env.MODEL_BRAIN_FALLBACK) || DEFAULT_BRAIN_FALLBACK,
    visionModel: cleanModel(process.env.MODEL_VISION)
      || cleanModel(process.env.MODEL_BRAIN)
      || DEFAULT_BRAIN_MODEL,
    deepModel: cleanModel(process.env.MODEL_DEEP) || "muse-wonder-1.0",
    imageModel: cleanModel(process.env.MODEL_IMAGE) || "muse-image-1.0",
    voiceModel: STT_MODEL,
    guardModel: cleanModel(process.env.MODEL_GUARD),
    // none/minimal/low/medium/high/xhigh/max. "none" is rejected by Muse.
    reasoningEffort: process.env.META_REASONING_EFFORT || "low",
    timeoutMs: Number(process.env.META_TIMEOUT_MS || 45000),
    configured: metaConfigured,
  },

  stt: {
    apiKey: STT_API_KEY || META_API_KEY,
    baseUrl: STT_API_BASE || META_API_BASE,
    model: STT_MODEL,
    path: process.env.STT_PATH || "/asr/transcribe",
    // A real transcription call needs a base URL, a model and a key.
    configured: Boolean(STT_MODEL && (STT_API_BASE || metaConfigured) && (STT_API_KEY || META_API_KEY)),
  },

  salmart: {
    baseUrl: SALMART_API_BASE,
    token: String(process.env.SALMART_API_TOKEN || "").trim(),
    searchPath: process.env.SALMART_SEARCH_PATH || "/search",
    configured: Boolean(SALMART_API_BASE),
  },

  demoMode: forcedMode,
  mock,
  // Loud but useful in logs: judges should never wonder which brain answered.
  providerLabel: mock ? "demo-brain" : "meta-model-api",
  verbose: bool(process.env.VERBOSE) || true,
};

function providerStatus() {
  const down = metaIsDown();
  const usingDemo = mock || down;
  return {
    mode: usingDemo ? "mock" : "live",
    label: usingDemo ? "demo-brain" : "meta-model-api",
    metaConfigured: config.meta.configured,
    metaDown: down,
    metaDownReason: down ? metaDownReason : undefined,
    brainModel: config.meta.brainModel,
    visionModel: config.meta.visionModel,
    deepModel: config.meta.deepModel,
    imageModel: config.meta.imageModel,
    voiceModel: config.meta.voiceModel,
    baseUrl: config.meta.baseUrl,
    sttConfigured: config.stt.configured,
    salmartConfigured: config.salmart.configured,
  };
}

module.exports = {
  config,
  setRecoveryProbe,
  markMetaDown,
  markMetaUp,
  metaIsDown,
  shouldUseMock,
  providerStatus,
};

