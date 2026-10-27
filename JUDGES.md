# For judges — run and verify Aya in 5 minutes

No API keys needed: all model keys live in the hosted server environment, never
in this repo. You only need the URL and the test account below.

## Option A — hosted demo (recommended)

- **App:** Play Store internal-testing track (NOT the production release):
  `TODO_USER: paste the internal-track opt-in link from Play Console`
  Judges join via the link; no public production risk, available within hours.
- **API base:** staging server running the event code:
  `TODO_USER: paste deployed base URL, e.g. https://aya-demo.onrender.com`
  (The staging build must bake in `EXPO_PUBLIC_API_URL=<staging base>` at
  build time. Production `app.salmartonline.com.ng` does NOT run the event
  code — do not point judges there.)
- **Test account:** `TODO_USER: paste judge login (email + password) or a long-lived test JWT`
- **Steps:**
  1. `GET {BASE}/api/assistant/status` — no auth. Confirms which brain is live
     (`meta-model-api` + `muse-spark-1.3` when the Meta key is healthy).
  2. Log into the app (or use the JWT) and open the assistant.
  3. Follow `DEMO.md` Scenes 1–4 verbatim; each states the exact utterance and
     the expected tool receipt.
  4. Scene 5 shows refusal + recovery (try pricing another seller's listing).
- Sign-in is required for everything except `/status` and `/ping`; the account
  above is a sandbox seller with sample listings, not production data.

## Option B — verify from this repo alone (no server, no keys)

```bash
cd backend
node --test tests/assistant-tasks.test.js
```

8/8 passing, zero dependencies: scope-change detection, correction-preserving
draft merges, price-gate validation, confirm-gate shape, task TTL/expiry,
prompt-block honesty. This is the planning layer the demo runs on.

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
  appear only as `.event.patch` diffs (see `NEW_WORK.md` for proof).
- No publish button for the agent to press: the seller always taps Post. Any
  "listing created" claim in the demo is the user tapping Post on camera.
