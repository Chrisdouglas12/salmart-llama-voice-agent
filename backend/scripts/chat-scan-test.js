// scripts/chat-scan-test.js
//
// Direct test for the chat photo-fraud scanner, bypassing chat itself:
//   node scripts/chat-scan-test.js <image-url>
//   node scripts/chat-scan-test.js ./photo.jpg
//
// Prints the OCR text and whether the existing text filter blocks it.
// If this says skipped=error, the scanner cannot run (usually dead Meta
// credit or no network) — and that is exactly why a photo "went through":
// the scanner fails OPEN so chat never breaks.
//
// Env names match the server: META_API_KEY, META_API_BASE, MODEL_VISION /
// MODEL_BRAIN, CHAT_IMAGE_SCAN.

'use strict';

const fs = require('fs');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node scripts/chat-scan-test.js <image-url | local-file>');
    process.exitCode = 2;
    return;
  }
  try {
    require('dotenv').config();
  } catch (_e) { /* dotenv optional on Render */ }

  if (/^https?:\/\//i.test(input)) {
    const { scanChatImage } = require('../services/chatImageScan');
    const out = await scanChatImage(input);
    console.log('[chat-scan-test]', JSON.stringify(out));
    return;
  }

  // Local file: same pipeline the service runs (vision → text filter).
  const { visionJSON } = require('../lib/assistant/llama');
  const { scanMessage } = require('../routes/chatContentFilter.server');
  const ext = String(input.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const base64 = fs.readFileSync(input).toString('base64');
  const { OCR_PROMPT } = require('../services/chatImageScan');
  try {
    const { text } = await visionJSON({
      prompt: OCR_PROMPT,
      images: [{ base64, mime }],
      maxTokens: 300,
      reasoningEffort: 'minimal',
    });
    const ocrText = String(text || '').trim();
    const result = scanMessage(ocrText);
    console.log('[chat-scan-test]', JSON.stringify({ ...result, ocrText: ocrText.slice(0, 500) }));
  } catch (e) {
    // Fail-open, same as the live path — print WHY so it can be fixed.
    console.log('[chat-scan-test]', JSON.stringify({
      blocked: false, skipped: 'error', reason: e?.message || String(e),
    }));
  }
}

main().then(
  () => {},
  (e) => { console.error('[chat-scan-test] failed:', e?.message || e); process.exitCode = 1; },
);
