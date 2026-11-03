
# NEW_WORK — Built 26 Oct - 4 Nov 2026

*Salmart app existed before this hackathon. This repo = ONLY the new AI feature built this week.*

### What we built

*Meta-first voice assistant* that works from any screen. Speak, don't type.

*Backend `backend/` — all new files, this week:*
- `lib/assistant/` — Meta client (chat/vision/transcribe), 11 auth intents, credential guard, session state
- `services/ai/` — `/api/ai` agent loop (21 tools), selling flow (photo-first), touch-to-buy, cart tools
- `routes/aiRoutes.js`, `visionRoutes.js`, `voiceRoutes.js` — AI endpoints
- `scripts/` + `tests/` — 20 test files, 128/128 pass keyless

*Patches to old files — small diffs only:*
- Voice/vision routes, Shelfie scan, search bridge, payment selection, chat fraud filter
- `userSchema` + `userRoutes` — register/login with email OR Nigerian phone, verified JWT
- `app.ai.patch` — mounts `/api/ai`

*Mobile `mobile/*.patch` — 6 patches:*
1. Global mic FAB + AI chat + tick-to-pay cart + seller chat draft
2. Voice-first registration — one-question steps, email optional, phone from any network, secure password modal, auto sign-in, model-written welcome
3. Touch-to-buy — say "I want to buy", assistant searches, says "touch the one you want", tap previews only, say "save it" to add to cart
4. Selling — photo-first, auto-fill with "I filled X", quantity→discount offer, auto-scroll to filled field
5. First-run onboarding — welcome spoken from server, asks for mic permission with voice, thanks line, global mic reuse

*How judges can run (no keys):*
- `npm run demo` — shows registration, buying, selling via real modules
- `npm run test:keyless` — 128/128 tests

*Proof:*
- 119/119 tests passed live, 44/44 after registration change
- Voice turn: median 12.6s (STT 4.7s + agent 6.4s), streaming first sentence in ∼1.1s
- Touch-to-buy: 18/18 tests, live Meta calls in English and Pidgin passed
- No keys, tokens, or DB URIs in repo. Agent never publishes or pays — user taps final button.
