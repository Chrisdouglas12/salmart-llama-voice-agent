
# NEW_WORK — Built 26 Oct - 4 Nov 2026

*Salmart app existed before this hackathon. This repo = ONLY the new AI feature built this week.*

### What we built

*Meta-first voice assistant* that works from any screen. Speak, don't type.

*Backend `backend/` — all new files, this week:*
- `lib/assistant/` — Meta client (chat/vision/transcribe), 11 auth intents, credential guard, session state
- `services/ai/` — `/api/ai` agent loop (21 tools), selling flow (photo-first), touch-to-buy, cart tools
- `routes/aiRoutes.js`, `visionRoutes.js`, `voiceRoutes.js` — AI endpoints
- `scripts/` + `tests/` — 24 test files, 156/156 pass keyless

*Patches to old files — small diffs only:*
- Voice/vision routes, Shelfie scan, search bridge, payment selection, chat fraud filter
- `userSchema` + `userRoutes` — register/login with email OR Nigerian phone, verified JWT
- `app.ai.patch` — mounts `/api/ai`

*Mobile `mobile/*.patch` — 6 patches:*
1. Global mic FAB + AI chat + tick-to-pay cart + seller chat draft
2. Voice-first registration — one-question steps, live field fill, email optional, phone from any network, secure password modal, auto sign-in, model-written welcome
3. Registration read-back — password/privacy summaries spoken by the assistant, pulsing password/agreement/confirm controls, mic-only final card, "register me" creates the account, spoken changes update the form, submitting + congratulations cards
4. Touch-to-buy — say "I want to buy", assistant searches, says "touch the one you want", tap previews only, say "save it" to add to cart
5. Selling — photo-first, auto-fill with "I filled X", quantity→discount offer, auto-scroll to filled field
6. First-run onboarding — server-written welcome spoken over the sign-in screen as a bottom card, then a pulsing microphone-permission card, thanks line, global mic reuse

*How judges can run (no keys):*
- `npm run demo` — shows registration, buying, selling via real modules
- `npm run test:keyless` — 156/156 tests

*Proof:*
- 156/156 keyless tests pass, including the registration script, first-run welcome and empty-final fallback contracts
- Voice turn: median 12.6s (STT 4.7s + agent 6.4s), streaming first sentence in ∼1.1s
- Touch-to-buy: 18/18 tests, live Meta calls in English and Pidgin passed
- No keys, tokens, or DB URIs in repo. Agent never publishes or pays — user taps final button.
