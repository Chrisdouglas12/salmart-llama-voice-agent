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
  const body = {
    model,
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

  const data = await postJson(`${config.meta.baseUrl}/chat/completions`, body, {
    apiKey: config.meta.apiKey,
    timeoutMs: config.meta.timeoutMs,
    label: "muse chat",
  });

  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new LlamaError("muse chat: response had no message", { body: data });
  }
  if (!messageText(message) && !message.tool_calls?.length) {
    throw new LlamaError(
      `muse chat: empty answer (finish_reason=${choice.finish_reason || "unknown"}, reasoning_tokens=${data?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"})`,
      { body: data },
    );
  }
  return { message, raw: data, model: data?.model || model };
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
module.exports = {
  chatCompletion,
  visionJSON,
  transcribeAudio,
  toMetaWav,
  messageText,
  parseJsonLoose,
  LlamaError,
};
