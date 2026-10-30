# For judges — run and verify Aya in 5 minutes

No API keys needed: all model keys live in the hosted server environment, never
in this repo. You only need the URL and the test account below.

## Option A — live product (recommended)

- **App:** production build on the Play Store (includes the event code):
  `TODO_USER: paste the Play Store listing link`
- **API base:** production, `https://app.salmartonline.com.ng` (runs the event
  code after deploy — verify `/api/assistant/status` reports
  `meta-model-api` before recording).
- **Test account:** `TODO_USER: paste judge login (email + password) — a sandbox seller with sample listings, not production data`
- **Steps:**
  1. `GET {BASE}/api/assistant/status` — no auth. Confirms which brain is live
     (`meta-model-api` + `muse-spark-1.3` when the Meta key is healthy).
  2. Log into the app (or use the JWT) and open the assistant.
  3. Follow `DEMO.md` Scenes 1–4 verbatim; each states the exact utterance and
     the expected tool receipt.
  4. Scene 5 shows refusal + recovery (try pricing another seller's listing).
- Sign-in is required for everything except `/status` and `/ping`; the account
  above is a sandbox seller with sample listings, not production data.
- Server env needed for the full demo (keys never in the repo): `META_API_KEY`
  (chat/vision/STT − every AI reply comes from Meta), `HF_API_KEY` (optional;
  only if you set `TTS_MODE=mms` — the default `TTS_MODE=device` uses the
  phone's own voice because Hugging Face retired the hosted Meta MMS route),
  `TOGETHER_API_KEY` (Glimmer brain — confirm the model slug as
  `GLIMMER_MODEL` on the Together dashboard), `BG_API_URL` + `BG_API_KEY`
  (commercial matting endpoint for `/photo-clean`; without them the app
  honestly keeps original photos). Run `npm install` on the server for
  `sharp` (photo compositing).

## Option B — verify from this repo alone (no server, no keys)

Keyless and dependency-free. From `backend/`:

```bash
npm run demo    # the 7-turn judge script through the real deterministic
                # brain + tool contracts (sample catalogue, clearly labelled)
npm test        # 23/23: 16 legacy + 7 keyless AI form-normaliser tests
```

`npm run demo` prints every turn with its real envelope — navigations,
`pick_photo`/`choose_photo`, `fill_ad` with exact form values (₦50000,
FCT - Abuja, New), budget-filtered search, `add_to_cart`, and checkout with
verified title/price. Nothing is published; the seller always taps Post.
`npm test` covers scope-change detection, correction-preserving draft merges,
price-gate validation, confirm-gate shape, Glimmer payload shape, bg-clean
contract rejections, task TTL/expiry, and prompt-block honesty, plus AI form
aliases, dropped unknown values, and sensitive-field exclusion.

The newer `/api/ai` agent (17 tools, confirmation flow, durable form bridge)
needs Mongo and a Meta key for a live turn, so its full contract is documented
in [`backend/AI_AGENT.md`](backend/AI_AGENT.md) rather than exercised by the
keyless demo.

## Option C — sample run + video

- **Demo video (3 min, required):** opens with *"Salmart, our Nigerian
  marketplace app, existed before this week; this week I built Aya, its
  Meta-powered voice assistant — Meta-first chat with tool calling, voice
  transcription, photo autofill, and one-photo shelf scanning — and wired it
  into the live app."* Then DEMO.md Scenes 1–4 in the real app.
- **Release media:** the video and sample photos are attached to the GitHub
  release on this repo (`TODO_USER: paste release link once published`).
- **Sample transcript:** `TRANSCRIPT.md` holds real request/response pairs
  captured against the hosted server (`TODO_USER: fill after deploying`).

## What you will NOT find here (on purpose)

- No provider keys, `.env` files, tokens, or database URIs — ever.
- No pre-hackathon code: whole files are event-written; pre-existing files
  appear only as patch files (see `NEW_WORK.md` for proof).
- No publish button for the agent to press: the seller always taps Post. Any
  "listing created" claim in the demo is the user tapping Post on camera.
