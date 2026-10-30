/* CommonJS port of salmart-llama-voice-agent/backend/lib/llama.js.
 * Generated from the hackathon repo; keep the two in sync. */
/**
 * Meta Model API client.
 *
 * Everything the agent needs from the model goes through this file, so the app
 * routes never talk HTTP directly. Model API is OpenAI-compatible:
 *   POST {base}/chat/completions
 *   POST {base}/asr/transcribe       (Muse Voice Transcribe, WAV in)
 *
 * Nothing here guesses a model name at runtime. If Meta ships new ids, only
 * .env changes.
 */
const { spawn } = require("node:child_process");
const { config, markMetaDown, markMetaUp } = require("./config.js");

// Bundled ffmpeg lets the phone's m4a (or the browser's webm) become the mono
// 16 kHz WAV that Muse Voice Transcribe requires. Optional: if the package is
// missing we still try an ffmpeg on PATH.
let ffmpegBin = null;
try {
  ffmpegBin = require("@ffmpeg-installer/ffmpeg").path;
} catch {
  ffmpegBin = null;
}

class LlamaError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = "LlamaError";
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

async function postJson(url, body, { apiKey, timeoutMs, label }) {
  if (!apiKey) throw new LlamaError(`${label}: missing API key`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    markMetaDown(`${label}: network error (${e.message})`);
    throw new LlamaError(`${label}: network error (${e.message})`, { cause: e });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const detail = data?.error?.message || data?.message || data?.detail || text.slice(0, 400) || res.statusText;
    // A bad photo or a malformed request is this call's problem, not the
    // provider being down. Only auth, rate-limit and server/network failures
    // pause Meta for everyone; otherwise one corrupt gallery image would take
    // the whole assistant offline.
    const providerDown = res.status === 401 || res.status === 403 || res.status === 408 ||
      res.status === 429 || res.status >= 500;
    if (providerDown) markMetaDown(`${label}: ${res.status} ${detail}`);
    throw new LlamaError(`${label}: ${res.status} ${detail}`, { status: res.status, body: data });
  }
  markMetaUp();
  return data;
}

// Model ids we are willing to retry with, newest first. The list is only used
// when the provider says the configured id does not exist AND /models cannot be
// reached; normally the available ids come from the provider itself.
// -contributor variants are real servable ids (seen on the /models list), so
// they belong here too.
const KNOWN_CHAT_MODELS = [
  "muse-spark-1.3", "muse-spark-1.3-contributor",
  "muse-spark-1.2", "muse-spark-1.2-contributor",
  "muse-spark-1.1", "muse-wonder-1.0",
];

// A deploy with a stale MODEL_BRAIN answers 404 `model_not_found` on every
// turn. Remember which id actually worked so only the first turn pays for the
// discovery round-trip, and remember ids proven dead so we never retry them.
const workingModelFor = new Map();
const deadModels = new Set();

// /models is cheap and rarely changes; one lookup per process is enough.
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
let modelListCache = { at: 0, ids: null };
// Last reason /models could not be read. Surfaced in the 404 walk log so a
// deploy tells us whether the key is rejected (401/403), the endpoint moved,
// or the network failed — instead of just saying "unreadable".
let lastModelsError = null;

// Upper bound for the one retry made when reasoning tokens ate the whole
// budget (Muse Spark and Muse Wonder reason even at "low").
const MAX_ANSWER_TOKENS = 8000;

/** True when the provider rejected the request because the model id is unknown. */
function isModelNotFound(err) {
  if (!(err instanceof LlamaError) || err.status !== 404) return false;
  const code = err.body?.error?.code;
  if (code) return code === "model_not_found";
  return /model.*not found/i.test(err.message);
}

/** Append the id we actually sent, so a 404 in the logs is diagnosable. */
function withModelHint(err, model) {
  if (!(err instanceof LlamaError)) return err;
  const hint = `[model=${model}]`;
  if (!err.message.includes(hint)) err.message = `${err.message} ${hint}`;
  err.model = model;
  return err;
}

/** Ids the provider advertises, or null when that endpoint cannot be read. */
async function listAvailableModels() {
  if (modelListCache.ids && Date.now() - modelListCache.at < MODEL_LIST_TTL_MS) {
    return modelListCache.ids;
  }
  try {
    const res = await fetch(`${config.meta.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.meta.apiKey}` },
      signal: AbortSignal.timeout(Math.min(config.meta.timeoutMs, 10_000)),
    });
    if (!res.ok) {
      lastModelsError = `/models HTTP ${res.status}`;
      console.warn(`[muse chat] /models returned ${res.status}; falling back to candidate walk`);
      return modelListCache.ids;
    }
    const data = await res.json();
    const ids = (data?.data || data?.models || [])
      .map(m => (typeof m === "string" ? m : m?.id))
      .filter(Boolean);
    if (ids.length) {
      modelListCache = { at: Date.now(), ids };
      lastModelsError = null;
    } else {
      // 200 with no usable ids: the key is reaching Meta but Meta is not
      // serving this origin (key restriction, revoked project, or a proxy
      // mangling the response). Say so plainly instead of "unreadable".
      const preview = JSON.stringify(data).slice(0, 200);
      lastModelsError = `/models HTTP ${res.status} with no model ids: ${preview}`;
      console.warn(`[muse chat] /models returned ${res.status} with no model ids: ${preview}`);
    }
    return ids.length ? ids : modelListCache.ids;
  } catch (e) {
    lastModelsError = `/models fetch failed: ${e?.message || e}`;
    console.warn(`[muse chat] /models unreachable (${e?.message || e}); falling back to candidate walk`);
    return modelListCache.ids;
  }
}

/** Higher rank = preferred fallback. "muse-spark-1.3" beats "1.2-contributor". */
function chatModelRank(id) {
  const m = /^muse-(spark|wonder)-(\d+(?:\.\d+)?)/.exec(id);
  if (!m) return -1;
  const family = m[1] === "spark" ? 1000 : 0;
  return family + Number(m[2]) - (/contributor/.test(id) ? 0.5 : 0);
}

/**
 * Ordered candidate ids to try after `failedModel` 404s, dead ids removed.
 * When /models is readable it is the source of truth: configured ids not on
 * the list are skipped, and the list's own newest chat model is appended.
 * When /models is unreadable, every configured/known id is tried in order.
 */
async function resolveCandidateModels(failedModel) {
  const available = await listAvailableModels();
  const seen = new Set();
  const out = [];
  const push = (id) => {
    if (!id || id === failedModel || seen.has(id) || deadModels.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const preferred = [config.meta.brainModelFallback, ...KNOWN_CHAT_MODELS, config.meta.brainModel];
  if (available) {
    for (const id of preferred) if (available.includes(id)) push(id);
    const extra = available
      .filter(id => !seen.has(id) && id !== failedModel && !deadModels.has(id)
        && !/voice|image|transcribe|whisper|tts/i.test(id))
      .sort((a, b) => chatModelRank(b) - chatModelRank(a));
    for (const id of extra) push(id);
  } else {
    for (const id of preferred) push(id);
  }
  return { candidates: out, available };
}

/** Pick a model id that is not the one that just failed, or null. */
async function resolveUnavailableModel(failedModel) {
  const { candidates } = await resolveCandidateModels(failedModel);
  return candidates[0] || null;
}

/** Pull text out of either a string or an array of content parts. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === "string" ? p : p?.text || "")).join("").trim();
  }
  return "";
}

/**
 * One chat-completion call.
 * @returns {{ message: object, raw: object, model: string }}
 */
async function chatCompletion({
  messages,
  tools = undefined,
  toolChoice = undefined,
  temperature = 0.2,
  maxTokens = 1600,
  reasoningEffort = config.meta.reasoningEffort,
  model = config.meta.brainModel,
} = {}) {
  // If an earlier turn proved this id is dead, go straight to the one that
  // worked instead of spending a 404 on every message.
  const requestedModel = model;
  const activeModel = workingModelFor.get(requestedModel) || requestedModel;
  const body = {
    model: activeModel,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  // Muse Spark / Muse Wonder always reason; the token budget includes reasoning.
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }

  const fetchChat = (payload) => postJson(`${config.meta.baseUrl}/chat/completions`, payload, {
    apiKey: config.meta.apiKey,
    timeoutMs: config.meta.timeoutMs,
    label: "muse chat",
  });

  let data;
  let usedModel = activeModel;
  try {
    data = await fetchChat(body);
  } catch (e) {
    // A stale/mistyped model id in a deploy's env answers 404 `model_not_found`.
    // Walk every remaining candidate instead of failing on the first retry:
    // 404 does not trip the provider cooldown (see postJson), so this is safe.
    if (!isModelNotFound(e)) throw withModelHint(e, activeModel);
    deadModels.add(activeModel);

    const { candidates, available } = await resolveCandidateModels(activeModel);
    if (!candidates.length) throw withModelHint(e, activeModel);

    console.warn(`[muse chat] model "${activeModel}" not found; trying ${candidates.join(', ')}`
      + (available ? ` (provider lists: ${available.join(', ')})` : ` (${lastModelsError || '/models unreadable'})`));
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        data = await fetchChat({ ...body, model: candidate });
        usedModel = candidate;
        workingModelFor.set(requestedModel, candidate);
        console.warn(`[muse chat] model "${candidate}" works; using it for "${requestedModel}"`);
        lastErr = null;
        break;
      } catch (e2) {
        if (!isModelNotFound(e2)) throw withModelHint(e2, candidate);
        deadModels.add(candidate);
        lastErr = withModelHint(e2, candidate);
      }
    }
    if (lastErr) {
      lastErr.message += ` [tried: ${[activeModel, ...candidates].join(', ')}]`
        + (available ? ` [available: ${available.join(', ')}]` : ` [${lastModelsError || '/models unreadable'}]`);
      throw lastErr;
    }
  }

  const readAnswer = (payload) => {
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw withModelHint(
        new LlamaError("muse chat: response had no message", { body: payload }),
        payload?.model || usedModel,
      );
    }
    return { choice, message };
  };

  let { choice, message } = readAnswer(data);

  // Muse Spark / Muse Wonder always reason and max_tokens includes reasoning.
  // A tight budget can be spent entirely on thinking, which reads as "no
  // answer" even though the call succeeded. One bigger retry is cheaper than
  // failing the turn.
  const empty = !messageText(message) && !message.tool_calls?.length;
  if (empty && choice.finish_reason === "length" && maxTokens < MAX_ANSWER_TOKENS) {
    const retryTokens = Math.min(maxTokens * 2, MAX_ANSWER_TOKENS);
    const retryModel = data?.model || usedModel;
    console.warn(`[muse chat] no answer in ${maxTokens} tokens (reasoning used the budget); retrying with ${retryTokens}`);
    data = await fetchChat({ ...body, model: retryModel, max_tokens: retryTokens });
    ({ choice, message } = readAnswer(data));
  }

  if (!messageText(message) && !message.tool_calls?.length) {
    throw withModelHint(new LlamaError(
      `muse chat: empty answer (finish_reason=${choice.finish_reason || "unknown"}, reasoning_tokens=${data?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"})`,
      { body: data },
    ), data?.model || usedModel);
  }
  return { message, raw: data, model: data?.model || usedModel };
}

/**
 * Vision call that must return JSON.
 * @param {{prompt: string, images: Array<{base64: string, mime?: string}>, model?: string, maxTokens?: number}} args
 */
async function visionJSON({
  prompt,
  images,
  model = config.meta.visionModel,
  maxTokens = 1200,
  reasoningEffort = "minimal",
}) {
  const content = [{ type: "text", text: prompt }];
  for (const img of images || []) {
    const mime = img.mime || "image/jpeg";
    content.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${img.base64}` },
    });
  }

  const { message, model: used } = await chatCompletion({
    model,
    messages: [{ role: "user", content }],
    temperature: 0.1,
    maxTokens,
    reasoningEffort,
  });

  const text = messageText(message);
  return { data: parseJsonLoose(text), text, model: used };
}

/** Tolerant JSON parser: models sometimes wrap JSON in prose or fences. */
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  try { return JSON.parse(s); } catch { /* keep looking */ }

  const firstObj = s.indexOf("{");
  const lastObj = s.lastIndexOf("}");
  if (firstObj !== -1 && lastObj > firstObj) {
    try { return JSON.parse(s.slice(firstObj, lastObj + 1)); } catch { /* ignore */ }
  }
  const firstArr = s.indexOf("[");
  const lastArr = s.lastIndexOf("]");
  if (firstArr !== -1 && lastArr > firstArr) {
    try { return JSON.parse(s.slice(firstArr, lastArr + 1)); } catch { /* ignore */ }
  }
  return null;
}

const LANGUAGE_NAMES = {
  en: "English", fr: "French", pt: "Portuguese", es: "Spanish", ar: "Arabic",
  ha: "Hausa", yo: "Yoruba", ig: "Igbo", sw: "Swahili", am: "Amharic",
  zh: "Chinese", hi: "Hindi", de: "German", it: "Italian", ru: "Russian",
  ja: "Japanese", ko: "Korean", tr: "Turkish", id: "Indonesian", vi: "Vietnamese",
};

// Product words the model would otherwise mishear on a phone mic.
const DEFAULT_KEYWORDS = ["Salmart", "Naira", "Lagos", "Abuja", "Port Harcourt", "Pidgin"];

/** Read the format of a RIFF/WAVE buffer, or null if it is not a WAV. */
function wavFormat(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        codec: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    }
    if (id === "data") break;
    off = body + size + (size % 2);
  }
  return fmt;
}

/** True when the buffer is already the mono s16le 16/24 kHz WAV Meta accepts. */
function isMetaWav(buf) {
  const f = wavFormat(buf);
  return Boolean(
    f && f.codec === 1 && f.channels === 1 && f.bits === 16 &&
    (f.sampleRate === 16000 || f.sampleRate === 24000),
  );
}

function runFfmpeg(input) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin || "ffmpeg";
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn", "-map", "0:a:0",
      "-ac", "1", "-ar", "16000",
      "-f", "wav", "-acodec", "pcm_s16le",
      "pipe:1",
    ];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new LlamaError("stt: audio conversion timed out"));
    }, config.meta.timeoutMs);

    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new LlamaError(`stt: ffmpeg unavailable (${e.message})`, { cause: e }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(err).toString("utf8").slice(0, 300);
        return reject(new LlamaError(`stt: audio conversion failed (${detail || `exit ${code}`})`));
      }
      resolve(Buffer.concat(out));
    });

    child.stdin.on("error", () => { /* reported by close/error */ });
    child.stdin.end(input);
  });
}

/**
 * Normalise phone/browser audio to the WAV format Muse Voice Transcribe takes:
 * RIFF/WAVE, mono, 16-bit PCM, 16 kHz or 24 kHz.
 */
async function toMetaWav(buffer) {
  if (isMetaWav(buffer)) return buffer;
  const wav = await runFfmpeg(buffer);
  if (!isMetaWav(wav)) {
    throw new LlamaError("stt: converted audio was not mono s16le 16 kHz WAV");
  }
  return wav;
}

/**
 * Muse Voice Transcribe. Returns the transcript, or null when STT is not
 * configured so the route can fall back to a client transcript.
 *
 * Meta's contract: multipart with a JSON `request` part and an `audio` part.
 * https://dev.meta.ai/docs/api-reference/voice/transcribe
 */
async function transcribeAudio({
  buffer,
  mimetype = "audio/m4a",
  filename = "voice.m4a",
  language,
  keywords = DEFAULT_KEYWORDS,
  mode = "ENDPOINTING",
}) {
  if (!config.stt.configured) return null;

  let wav;
  try {
    wav = await toMetaWav(buffer);
  } catch (e) {
    console.warn(`[stt] ${e.message} (${mimetype}, ${filename})`);
    throw e;
  }

  const request = {
    model: config.stt.model,
    audioEncoding: "WAV",
    mode,
  };
  if (keywords?.length) request.keywords = keywords;
  const langName = LANGUAGE_NAMES[String(language || "").toLowerCase()];
  if (langName) request.languageBias = [langName, "English"];

  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");

  let res;
  try {
    res = await fetch(`${config.stt.baseUrl}${config.stt.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.stt.apiKey}`,
        Accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(config.meta.timeoutMs),
    });
  } catch (e) {
    throw new LlamaError(`stt: network error (${e.message})`, { cause: e });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    throw new LlamaError(`stt: ${res.status} ${data?.error?.message || text.slice(0, 300)}`, {
      status: res.status, body: data,
    });
  }
  return String(data?.transcript || data?.text || "").trim();
}
/**
 * Boot-time sanity check: is the configured brain id one Meta actually serves?
 * Never throws. `ok` is null when /models could not be read (no network, no
 * key), so callers can stay quiet instead of alarming on every offline start.
 *
 * @returns {Promise<{ok: boolean|null, model: string, fallback: string|null, available: string[], reason?: string}>}
 */
async function verifyBrainModel() {
  const model = config.meta.brainModel;
  if (!config.meta.apiKey) {
    return { ok: null, model, fallback: null, available: [], reason: "META_API_KEY is empty" };
  }
  const available = await listAvailableModels();
  if (!available) {
    return { ok: null, model, fallback: null, available: [], reason: "could not read /models" };
  }
  if (available.includes(model)) {
    return { ok: true, model, fallback: null, available };
  }
  const fallback = await resolveUnavailableModel(model);
  return { ok: false, model, fallback, available };
}

/** The id chat calls actually use right now (after any model_not_found repair). */
function activeBrainModel() {
  const requested = config.meta.brainModel;
  return {
    requested,
    active: workingModelFor.get(requested) || requested,
    fallback: config.meta.brainModelFallback,
    endpoint: `${config.meta.baseUrl}/chat/completions`,
    modelsError: lastModelsError,
  };
}

/**
 * Opt-in boot self-test (META_SELFTEST=true): one minimal chat call to prove
 * whether THIS machine's network/key can reach the model. The 404 mystery of
 * Oct 29 was origin-dependent — 200 from a laptop, 404 from Render with the
 * same key — and only a live call from the deploy itself settles that.
 * Never throws; logs one line. Costs a single tiny request per boot.
 */
async function chatSelfTest() {
  if (!config.meta.apiKey) return { ok: null, reason: 'META_API_KEY is empty' };
  const model = config.meta.brainModel;
  try {
    const data = await postJson(`${config.meta.baseUrl}/chat/completions`, {
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 256,
      ...(config.meta.reasoningEffort ? { reasoning_effort: config.meta.reasoningEffort } : {}),
    }, { apiKey: config.meta.apiKey, timeoutMs: Math.min(config.meta.timeoutMs, 30_000), label: 'muse self-test' });
    const text = messageText(data?.choices?.[0]?.message);
    return { ok: true, model: data?.model || model, reply: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, model, status: e?.status, message: String(e?.message || e).slice(0, 200) };
  }
}

module.exports = {
  chatCompletion,
  visionJSON,
  transcribeAudio,
  toMetaWav,
  messageText,
  parseJsonLoose,
  verifyBrainModel,
  activeBrainModel,
  chatSelfTest,
  LlamaError,
  // Test-only: clear the in-process model memory between isolated cases.
  __resetModelState() {
    workingModelFor.clear();
    deadModels.clear();
    modelListCache = { at: 0, ids: null };
    lastModelsError = null;
  },
};
