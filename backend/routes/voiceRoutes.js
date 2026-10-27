/* CommonJS port of salmart-llama-voice-agent/backend/routes/voiceRoutes.js. */
/**
 * POST /api/assistant/transcribe
 *
 * Multipart field `audio` (the app) or a JSON `{ text }` body (the web demo /
 * browsers that transcribe on-device). Failures are HTTP 200 with
 * `{ success:false, code }` because the app reads `success`, not the status.
 */
const express = require("express");
const multer = require("multer");
const { transcribeAudio } = require("../lib/assistant/llama.js");
const { config } = require("../lib/assistant/config.js");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  const fallbackText = String(req.body?.text || "").trim();
  const language = String(req.body?.language || "en").trim() || "en";

  if (!req.file) {
    if (fallbackText) {
      return res.json({ success: true, text: fallbackText, provider: "client", model: "browser" });
    }
    return res.json({
      success: false,
      code: "NO_AUDIO",
      message: "No audio was sent.",
    });
  }

  if (!config.stt.configured) {
    // On-device / browser speech is still fine: let the client send the text.
    if (fallbackText) {
      return res.json({ success: true, text: fallbackText, provider: "client", model: "client-fallback" });
    }
    return res.json({
      success: false,
      code: "STT_UNAVAILABLE",
      message: "Speech-to-text is not configured on this server. Type it or use the phone keyboard.",
    });
  }

  try {
    const text = await transcribeAudio({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype || "audio/m4a",
      filename: req.file.originalname || "voice.m4a",
      language,
    });
    if (!text) {
      return res.json({ success: false, code: "EMPTY_TRANSCRIPT", message: "I didn't catch that. Try again." });
    }
    return res.json({ success: true, text, provider: "meta", model: config.stt.model });
  } catch (e) {
    console.error("[assistant/transcribe]", e.message);
    if (fallbackText) {
      return res.json({ success: true, text: fallbackText, provider: "client", model: "client-fallback" });
    }
    return res.json({
      success: false,
      code: "STT_FAILED",
      message: "I couldn't hear that clearly. Try again.",
    });
  }
});

module.exports = router;
