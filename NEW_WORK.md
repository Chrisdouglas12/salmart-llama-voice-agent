# NEW_WORK — built 26 Oct – 4 Nov 2026, during this hackathon

**Salmart (the marketplace app) predates this event and is not in this repo.** Everything below is the AI feature, written this week: Meta-first voice assistant, conversational auth, seller messaging, and guided checkout.

## New backend files (`backend/` — whole files, event-written)

| File | One line |
|---|---|
| `lib/assistant/llama.js` | Meta chat/vision/transcribe client + model recovery |
| `lib/assistant/agent.js` | Legacy tool-calling loop + fallback orchestration |
| `lib/assistant/authIntents.js` | 11 auth intents, 11 conversation states, one-question steps, voice-first registration order |
| `lib/assistant/credentialGuard.js` | Refuses/redacts passwords, OTPs, tokens before Meta sees them |
| `lib/assistant/authGuidance.js` | Closed outcome codes → one spoken sentence + fixing screen |
| `lib/assistant/authSession.js` | Server-owned auth state across turns (never secrets) |
| `services/ai/*` | `/api/ai` agent: turn loop, tool allowlist (21 tools), confirmations, task memory |
| `lib/assistant/sellingFlow.js` | Photo-first question order, quantity→discount offer, spoken-price parsing |
| `services/ai/sellingSession.js` | Server-owned selling state, skip-once optionals, discount script block |
| `services/ai/tools/cartTools.js` | Agent cart add, same guards as `POST /api/cart` |
| `routes/aiRoutes.js`, `routes/aiFormBridge.js` | Agent endpoints + form-patch bridge |
| `routes/visionRoutes.js`, `routes/voiceRoutes.js` | Reference vision/voice modules |
| `lib/assistant/shelfie.js`, `clean.js`, `mmsTts.js`, `speechLang.js`, `glimmer.js`, `form.js`, `tasks.js`, `mongoSearch.js`, `config.js`, `tools.js`, `mockAgent.js` | Shelf scan, photo cleanup, voice output, language detect, fallback brain, form parsing, task memory, search, config, legacy tools, mock brain |
| `scripts/muse-diag.js`, `scripts/ai-eval.js` | Render connectivity diagnostic, scripted eval |
| `tests/` (16 files) | Contract tests for intents, guard, guidance, tools, handoff, fallback |

## Patches to pre-existing server files (append-only, no product code copied)

| Patch | Change |
|---|---|
| `routes/assistantRoutes.event.patch` | Meta provider order, voice/vision routes, Shelfie, MMS voice |
| `routes/socketRoutes.attachment.patch` | Attachment type normalisation (chat delivery fix) |
| `routes/searchRoutes.ai-bridge.patch` | Reuse live search helpers in product tools |
| `routes/userRoutes.verify-email.patch` | App-opening verify/reset links in emails |
| `routes/paymentRoutes.selection.patch` | `/pay-cart` accepts a validated item selection; fulfillment settles only paid lines |
| `routes/chat-filter-presend.patch` | Photo pre-send scan endpoint + group REST filter/retract |
| `routes/socketRoutes.fraud-filter.patch` | Caption/photo OCR retract via shared helper |
| `routes/ai-selling-photo-first.patch` | Photo-first selling: photo step first, quantity→discount offer with suggestion, skipStep for declined optionals, auto photo chooser on createAd navigation |
| `models/userSchema.registration.patch` | Email optional for non-anonymous accounts, so a phone-only sign-up validates |
| `routes/userRoutes.registration.patch` | `/register` accepts email or Nigerian phone, checks both for duplicates, marks the account verified, and returns a 30-day JWT; `/login` accepts either identifier |
| `app.ai.patch` | Mount `/api/ai` |

## Mobile (`mobile/salmart-mobile.ai-voice.patch` + `mobile/salmart-mobile.registration.patch`)

First patch: global mic FAB (+ above the "+" button, hidden on splash, present over Paystack), AI chat screen, auth screens (verify/resend, Google + verify actions), tick-to-pay cart, seller-chat draft handoff, outcome codes feeding the next AI turn. Selling: photo-first walkthrough (gallery/camera choice sheet on arrival, vision auto-fill with "I filled X" summary), quantity→discount offer with concrete suggestion, assistant-filled bulk tier, skip-once optionals, no-repeat missing-field steps.

Second patch: voice-first registration. Full name collected in one question; email optional (Google, Yahoo, or any other); when there is no email, a phone number from MTN, Airtel, Glo, or any other network is collected by voice; one secure password modal with the keyboard already focused, a sized card rather than a full-screen sheet, a readable suggested code with Copy/Use actions and a "Hear how" spoken explanation; agreement card last; automatic submit and sign-in after server confirmation; Market opened without a second login; the post-registration welcome is written by the model from a `registration_complete` event, with a fixed fallback; generic post-sign-in resume suppressed for that transition. A stored registration step is dropped once the user is signed in or moves off the register screen, so an abandoned or manually completed sign-up is never replayed. Spoken replies now use the phone's standard device voice only.

## Proof

- Live server suite passed **119/119** before the registration change. After it, the four affected files pass **44/44**: `node --test backend/tests/ai-auth-accessibility.test.js backend/tests/ai-form-tools.test.js backend/tests/ai-task-state.test.js backend/tests/ai-navigation.test.js`.
- Voice-turn latency was measured from the production logs, not estimated: the median turn was **12.6 s end to end** (speech-to-text ~4.7 s + agent turn ~6.4 s, with 3–10 s and 2–15 s spreads). The agent half now runs at minimal reasoning, an 800-token budget, a 20-message history window, 3 iterations and a 25 s wall clock; the two log lines above show each half after the change. Speech-to-text uses Meta's `PUSH_TO_TALK` mode because the app uploads one finished clip per turn (the mode Meta documents for a controlled recording), and a stuck call is capped at 25 s. It remains the provider's ASR service. After speaking, the voice turn streams: `POST /api/ai/turn` with `Accept: text/event-stream` emits one `sentence` event per reply sentence plus a final `done` event with the full payload, and the phone speaks each sentence as it arrives — the user hears the answer starting while the turn completes. Measured streaming overhead is nil (first token ~1.1–1.6 s with the full prompt and tool list).
- Keyless extract tests pass here (`backend/tests/`, e.g. 15/15 auth-accessibility).
- Changed mobile files parse under Babel (JSX/JS). No device was attached, so the secure modal, keyboard focus, automatic sign-in, copy-to-clipboard suggestion and model-written welcome are not device-verified.
- Whole files first appear in the server repo at post-kickoff commits (`4252e0663`, `3a803c49f`); pre-existing files ship only as diffs above.
- No provider keys, `.env` files, tokens, or database URIs anywhere in this repo.
- The agent never publishes, pays, or sets credentials — the user always taps the final button.
