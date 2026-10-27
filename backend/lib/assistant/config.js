/* CommonJS port of salmart-llama-voice-agent/backend/lib/config.js.
 * Generated from the hackathon repo; keep the two in sync. */
const dotenv = require("dotenv");

dotenv.config();

const bool = (v) => String(v || "").toLowerCase() === "true";
const trimSlash = (v) => String(v || "").replace(/\/+$/, "");

const META_API_KEY = String(process.env.META_API_KEY || "").trim();
const META_API_BASE = trimSlash(process.env.META_API_BASE || "https://api.meta.ai/v1");
const STT_API_KEY = String(process.env.STT_API_KEY || "").trim();
const STT_API_BASE = trimSlash(process.env.STT_API_BASE);
const STT_MODEL = String(process.env.STT_MODEL || "muse-voice-transcribe-1.0").trim();
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
    brainModel: process.env.MODEL_BRAIN || "muse-spark-1.3",
    visionModel: process.env.MODEL_VISION || process.env.MODEL_BRAIN || "muse-spark-1.3",
    deepModel: process.env.MODEL_DEEP || "muse-wonder-1.0",
    imageModel: process.env.MODEL_IMAGE || "muse-image-1.0",
    voiceModel: STT_MODEL,
    guardModel: process.env.MODEL_GUARD || "",
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

