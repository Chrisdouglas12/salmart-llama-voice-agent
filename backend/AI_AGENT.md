# AI agent backend (`/api/ai`)

This is the newer conversational agent surface. It is separate from the
original `/api/assistant` voice/vision router (documented in
[`README.md`](README.md)) and is the one the rewritten mobile AI client uses.

All whole files here were copied byte-identically from the live server:
`services/ai/**`, `services/logger.js`, `routes/aiRoutes.js`,
`routes/aiFormBridge.js`, and `scripts/ai-eval.js`. Two append-only patches
cover the pre-existing live files: `app.ai.patch` (mounts) and
`routes/searchRoutes.ai-bridge.patch` (shared search helpers). The anonymous
voice change to the legacy router is in
`routes/assistantRoutes.event.patch` (see "Anonymous voice" below).

## Files

```
services/ai/agentRunner.js         one turn: model loop, tool calls, timings
services/ai/conversationStore.js   AIConversation persistence + ownership rules
services/ai/metaProvider.js        adapter over lib/assistant/llama.js
services/ai/pendingAction.js       AIPendingAction: confirm/cancel/expiry
services/ai/pendingFormPatch.js    AIPendingFormPatch: one-shot form patches
services/ai/taskState.js           persisted task memory (goal/drafts/last result)
services/ai/metrics.js             allowlisted turn/action counters + latency
services/ai/platform.js            android/ios/web hint for the Google URL
services/ai/history.js             replay hygiene: drops orphaned tool_calls pairs
services/ai/structuredBlocks.js    pure tool-results → typed `structured[]` builder
services/ai/toolExecutor.js        single validation/auth/confirmation choke-point
services/ai/toolRegistry.js        the 22-tool allowlist
services/ai/tools/authTools.js     onboarding + Google sign-in URL + auth-error guidance
services/ai/tools/navigationTools.js screen allowlist + navigateToScreen
services/ai/tools/productTools.js  live search/details via searchRoutes._internal
services/ai/tools/sellerTools.js   own listings, draft, price change
services/ai/tools/formTools.js     pure form normalisers (createAd/request/profile/register)
services/ai/tools/messagingTools.js prepare + send seller enquiry
services/ai/tools/orderTools.js    buyer order reads
services/ai/tools/cartTools.js     buyer cart add (same guards as POST /api/cart; checkout stays manual)
services/ai/sellingSession.js      listing workflow state (type, asked steps; snapshot re-read every turn)
lib/assistant/sellingFlow.js       per-type question order, spoken-price parser, field rules
services/logger.js                 Winston logger used by AI modules
lib/assistant/speechLang.js        transcript → eng/yor/hau/ibo for same-language voice
lib/assistant/mmsTts.js            Meta MMS voice output over Hugging Face
lib/assistant/authGuidance.js      spoken auth-error guidance (closed code allowlist, no PII)
routes/aiRoutes.js                 /api/ai endpoints
routes/aiFormBridge.js             /api/ai/forms/drain
scripts/ai-eval.js                 scripted offline + live evaluation
```

`services/ai/metaProvider.js` deliberately reuses the pre-existing
`lib/assistant/llama.js#chatCompletion` client. It does not duplicate the Meta
HTTP call. That client reads `META_API_KEY`, `META_API_BASE`,
`MODEL_BRAIN`, `META_REASONING_EFFORT`, and `META_TIMEOUT_MS` through
`lib/assistant/config.js`.

## Mounts

The live `app.js` mounts the form bridge **before** the router:

```js
const aiRoutes = require('./routes/aiRoutes.js');
const aiFormBridge = require('./routes/aiFormBridge.js');

app.use('/api/ai/forms', aiFormBridge);
app.use('/api/ai', aiRoutes);
```

`backend/app.ai.patch` contains exactly those additions plus the
`trust proxy: 1` fix. Both AI patches are
generated against server commit `708ece30b` (the pre-agent tree); apply them
there, or use them as the reviewable diff if the live tree already has the
mounts. Do not replace the whole live `app.js`.

`services/ai/tools/productTools.js` calls the same query helpers as
`GET /search` through `routes/searchRoutes.js#_internal`. The live
`searchRoutes.js` therefore has an append-only export block at the bottom
(`router._internal = { buildProductCriteria, runProductQuery, shapeProduct,
enrichSellers, baseProductCriteria, VALID_CATEGORIES }`), captured in
`backend/routes/searchRoutes.ai-bridge.patch`. Without it the product tools
fail loudly at boot by design.

## Request lifecycle

1. The client calls `POST /api/ai/conversations` once and keeps the returned
   `conversationId` (and `anonymousId` while signed out).
2. Each message calls `POST /api/ai/turn`.
3. `aiRoutes.js` replays at most the last 60 stored messages, starting at the
   first `user` message, then runs them through `sanitizeHistory`: any
   assistant `tool_calls` without all its `tool` responses (left by a
   timed-out or failed turn) is dropped with a warning, because the provider
   rejects the whole turn with `400 Missing tool response` otherwise. The
   same filter runs before persisting a turn, and replay-time filtering
   self-heals conversations poisoned before the fix shipped.
4. `agentRunner.js` calls the model with the tools allowed for the caller's
   auth state, then executes requested tools until it gets a final answer.
   Hard limits: 4 model iterations, 6 tool calls, 45 seconds wall clock. It
   returns `timings.llmMs` and `timings.toolMs` alongside the stop reason.
   Inside the provider client, a 404 `model_not_found` is retried once with a
   served id, and an empty `finish_reason: "length"` answer is retried once
   with a larger token budget (reasoning tokens count against `max_tokens`).
5. `toolExecutor.js` is the only execution path. It checks the allowlist,
   auth, `wired`, and AJV input validation, strips any model-supplied
   `userId`/`sellerId`, and either runs the handler or creates a pending
   confirmation.
6. `aiRoutes.js` rebuilds the conversation's task state (`taskState.beginTurn`
   → `applyToolResults` → `finishTurn`), injects it into the system prompt as
   data, and persists it under `AIConversation.collectedInfo.task` so the next
   turn — or the next app launch — resumes the same goal.
7. `aiRoutes.js` turns tool results into the typed `structured` array via
   `services/ai/structuredBlocks.js`, persists any `fill_*` blocks to
   `AIPendingFormPatch`, records one allowlisted metrics row, and returns the
   reply.

## Task memory

A turn no longer starts from a blank slate. Before the model call the route:

1. Loads `AIConversation.collectedInfo.task` (if any).
2. Calls `taskState.beginTurn`, which resets the task when the new message
   changes scope ("actually, never mind", "start over", a different goal) and
   otherwise keeps the existing goal, drafts, and last search.
3. Prepends `taskState.buildPromptBlock(task)` to the system prompt. The block
   is capped (160-char goal, 24 fields, 80-char prompt values) and says
   explicitly that it is remembered state, not user instructions.
4. Merges every executed tool's result back with `taskState.applyToolResults`
   (`prepareAdForm` → `adDraft`, `fillRequestForm` → `drafts.request`,
   `searchProducts` → `lastSearch`, `prepareSellerEnquiry` → `drafts.message`).
5. Persists `{ currentTask, collectedInfo, status }`, where `status` is
   `active` or `awaiting_confirmation`.

Privacy rules enforced in `taskState.js`: `password`, `phone`, `email`, bank
and identifier keys are stripped before storage and never echoed in the prompt
block. A registration turn keeps `emailProvided` / `phoneProvided` /
`emailDeclined` — flags only — so the model can remember that a contact detail
is handled without storing the value.
Only `active`/`awaiting_confirmation` are persisted as live statuses;
completed and cancelled tasks collapse back to `active` so a stale task never
claims work that did not happen.

## Metrics

`services/ai/metrics.js` stores one `AIMetric` row per turn and per
confirm/cancel, with a 90-day TTL. The schema is deliberately closed: `kind`,
`ok`, `anonymous`, `stopReason`, `errorCode`, `latencyMs`, rounded `llmMs` /
`toolMs`, `messageChars`, a capped tool-name list, and internal ids. Message
text, replies, names, emails, and phone numbers are never written.

`GET /api/ai/metrics/summary?days=7` is admin-only (`verifyAdmin`) and returns
counters and percentiles only:

```json
{
  "success": true,
  "window": { "from": "…", "to": "…", "days": 7 },
  "totals": {
    "turns": 40, "actions": 3, "okTurns": 38, "failedTurns": 2,
    "anonymousTurns": 11, "authenticatedTurns": 29,
    "errorRate": 0.05, "toolCalls": 22, "toolErrors": 1
  },
  "latencyMs": { "p50": 2400, "p95": 6100, "max": 12000 },
  "stops": { "final": 39, "timeout": 1 },
  "errorCodes": { "TURN_FAILED": 2 },
  "tools": { "searchProducts": { "calls": 12, "errors": 0 } },
  "actions": { "confirm": { "ok": 3, "errors": 0 } },
  "screens": { "create_ad": 5 },
  "platforms": { "android": 30, "ios": 10 },
  "sampled": 43,
  "truncated": false
}
```

`days` is clamped to 1–90. The query is capped at the newest 5,000 rows;
`truncated` says whether that cap was hit.

## Endpoints

| Method | Path | Auth | Limit | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/ai/conversations` | soft | 40/min | create or resume a conversation |
| `POST` | `/api/ai/conversations/rebind` | hard | 40/min | anonymous → authenticated, one-way |
| `POST` | `/api/ai/turn` | soft | 30/min | one user message, run the agent |
| `POST` | `/api/ai/actions/:actionId/confirm` | hard | 60/min | run a confirmed consequential action |
| `POST` | `/api/ai/actions/:actionId/cancel` | hard | 60/min | cancel a pending action (idempotent) |
| `GET` | `/api/ai/tasks/:actionId` | hard | 60/min | read a pending action's state |
| `POST` | `/api/ai/forms/drain` | hard | 60/min | claim a queued form patch once |
| `GET` | `/api/ai/metrics/summary` | admin | — | counters + latency, no message text |

**Soft auth** means: no `Authorization` header is fine (anonymous
conversations), but a header that is present must carry a valid Bearer token.
**Hard auth** means `verifyToken` and a non-empty `req.user.userId` are
required. **Admin** means `verifyAdmin` (admin Bearer token, admin cookie, or
`x-admin-token`).

### `POST /api/ai/conversations`

```json
{ "conversationId": "optional-existing-id", "anonymousId": "optional-client-id" }
```

Response:

```json
{
  "success": true,
  "conversationId": "…",
  "created": true,
  "status": "active",
  "anonymousId": "only returned when created while signed out"
}
```

A conversation owned by a `userId` can only be opened by that user. An
anonymous conversation can only be opened with the exact `anonymousId` it was
created with; a missing or wrong id returns `404` and does not disclose
whether the conversation exists. The only way to take ownership is `rebind`.

### `POST /api/ai/conversations/rebind`

```json
{ "conversationId": "…", "anonymousId": "…" }
```

Both fields are required. It succeeds only if the conversation is still
anonymous and the `anonymousId` matches. Repeating it after a successful bind
returns `{ "success": true, "alreadyBound": true }`; an unknown or foreign
conversation returns `404`.

### `POST /api/ai/turn`

```json
{
  "conversationId": "…",
  "anonymousId": "required for anonymous conversations",
  "message": "find me an iPhone under 200k",
  "context": { "screen": "search", "productId": "…" }
}
```

`message` is capped at 2,000 characters. `context` is optional, capped at 8
keys, and only string (≤120 chars), finite number, and boolean values survive.
It is appended to the system prompt as **data**, not instructions.

Response:

```json
{
  "success": true,
  "requestId": "uuid",
  "conversationId": "…",
  "reply": "I found 3 iPhones under ₦200,000.",
  "stopReason": "final",
  "structured": [
    { "type": "product_results", "products": [], "total": 3, "hint": null }
  ]
}
```

`stopReason` is one of `final`, `timeout`, `error`, `tool_call_limit`.
`toolLog` is included only when `NODE_ENV !== 'production'`.

A turn that prepares a consequential action also returns a top-level block:

```json
{
  "confirmation_required": {
    "actionId": "uuid",
    "toolName": "updateProductPrice",
    "summary": "Change the price of listing … to ₦70,000.",
    "preview": { "kind": "price_change", "productId": "…", "newPrice": 70000 }
  }
}
```

### `POST /api/ai/actions/:actionId/confirm`

Requires the user who owns the pending action. The action is atomically
claimed (`pending → executing`) before the handler runs, so a double tap
returns `409` instead of executing twice.

```json
{ "success": true, "requestId": "…", "actionId": "…", "result": { } }
```

Failure statuses: `404` unknown/foreign action, `409` already
executing/executed/cancelled, `410` expired, `400` handler rejected the
action (for example the listing or price changed), `500` unexpected error.

### `POST /api/ai/actions/:actionId/cancel`

Cancelling a pending or failed action succeeds. Cancelling an already
cancelled action succeeds with `alreadyCancelled: true`. Cancelling an
executed/executing action returns `409`.

### `GET /api/ai/tasks/:actionId`

Returns `{ success, actionId, toolName, state, summary, result, createdAt,
expiresAt }` for the owner. `state` is one of `pending`, `executing`,
`executed`, `failed`, `cancelled`, `expired`.

### `POST /api/ai/forms/drain`

```json
{ "target": "createAd" }
```

`target` must be one of `createAd`, `createRequest`, `editProfile`,
`register`. The response is either `{ "success": true, "patch": null }` or:

```json
{
  "success": true,
  "patch": {
    "fields": { "title": "iPhone 13 Pro", "price": 450000 },
    "say": "I filled the title and price. Add a photo and tap Post.",
    "createdAt": "2026-10-29T…"
  }
}
```

Ownership comes from the JWT only. A drain deletes the row, so the patch is
applied exactly once.

## `structured` blocks

`structured` is an array. The client must ignore unknown `type` values.

| `type` | Payload | Produced by |
| --- | --- | --- |
| `product_results` | `{ products, total, hint }` | `searchProducts` |
| `product_details` | `{ product }` | `getProductDetails` |
| `listing_list` | `{ listings, total }` | `getMyListings` |
| `order_information` | `{ orders, total }` | `getMyOrders` |
| `order_details` | `{ found, order }` | `getOrderDetails` |
| `onboarding_options` | `{ methods }` | `getAvailableAuthenticationMethods` |
| `message_preview` | `{ prepared }` | `prepareSellerEnquiry` |
| `capabilities` | `{ capabilities }` | `getAvailableAppCapabilities` |
| `fill_ad` | `{ target: 'createAd', fields, say }` | `prepareAdForm`, `createProductDraft` |
| `fill_request` | `{ target: 'createRequest', fields, say }` | `fillRequestForm` |
| `fill_profile` | `{ target: 'editProfile', fields, say }` | `fillProfileForm` |
| `fill_register` | `{ target: 'register', fields, say }` | `prepareRegistration` |
| `navigate` | `{ target: '<screen key>', query }` | `navigateToScreen` |
| `auth_url` | `{ authMethod: 'google', url, platform }` | `startGoogleAuthentication` |

`auth_url` is not a redirect. The client renders a tappable Google button and
opens the URL only when the user taps it, so a misheard utterance cannot launch
a browser. The URL is gated twice (`structuredBlocks.js`, then the client):
`http(s)` only, host must match `APP_BASE_URL`, path must be `/auth/google`, no
credentials, no fragment, ≤2,048 characters. A model-supplied URL is never
trusted; `authTools.js` rebuilds it from the configured base and the platform
hint (`services/ai/platform.js`).

`confirmation_required` is deliberately top-level, not inside `structured`,
because it drives a distinct confirmation UI.

At most one `navigate` block is emitted per turn. If the model asks for more
than one, the last request wins instead of bouncing the user through
intermediate screens. The target is re-checked against the server allowlist
before the block is emitted, and the client re-checks it again.

## Navigation

`navigateToScreen` is the only way the agent can move the user between screens.
It accepts one screen key from a fixed allowlist in
`services/ai/tools/navigationTools.js`, which mirrors the mobile app's native
routes (`src/state/routes.js` → `NATIVE_SCREENS`):

```
market, requests, alerts, messages, deals, profile, search, cart, referral,
createAd, createRequest, editProfile, ads, promote, showrooms, vtu,
register, signin, passwordReset
```

The bottom-tab roots (`market`, `requests`, `alerts`, `messages`, `deals`,
`profile`) are switched to rather than stacked, so Back returns to the app.

Deliberately **not** navigable:

- `ai` / `assistant` — the global mic must never bounce the user into the AI
  chat screen; that is the whole point of inline voice.
- id-based routes (`checkout`, `chat`, `showroom`, `profile`-by-id) — the model
  cannot know a real listing/partner/user id, so opening one would only show an
  empty screen. Those stay a tap on real data.

`search` may carry a short `query`, which the client passes as a route param.
The query is single-line and capped at 120 characters. All other screens ignore
it.

## Confirmation model

Tools with `requiresConfirmation: true` never execute inline. The executor
snapshots `toolName` + validated `args` into `AIPendingAction` and returns
`CONFIRMATION_REQUIRED`; the model is instructed to stop and ask the user to
confirm in the app. The only execution path is
`POST /api/ai/actions/:id/confirm`.

- Stored with both `userId` and `conversationId`; confirm requires the
  matching `userId` (the conversation id is recorded for context). A foreign
  action is indistinguishable from a missing one.
- Arguments are never re-read from the model.
- Pending actions expire after 10 minutes (`expiresAt` TTL index). Executed,
  failed, and cancelled records are kept for 30 days for audit but are
  one-way and cannot be replayed.
- `updateProductPrice` re-reads the listing on confirm and rejects non-owned,
  sold, or changed listings rather than applying stale intent.

## Form bridge

Form tools are pure: they validate and normalise the model's patch but never
write to Mongo. The matching screen applies the patch and the user taps
Save/Post.

- `createAd` accepts title, description, price, quantity, condition,
  category, location, postType, serviceType. Unknown categories/locations are
  dropped, never guessed.
- `createRequest` accepts category (six-value allowlist), text, budget,
  location.
- `editProfile` accepts first/last name, bio, state, city only. Phone,
  password, bank details, and photos are never part of a patch.
- `register` accepts first/last name, email or phone number, and referral code.
  The password and the agreement tick are never part of a patch — see
  "Registration for voice-first users" below.
- One live patch per `(userId, target)`, latest wins, 10-minute TTL.
- A turn returns `fill_*` inline for the currently mounted screen **and**
  persists it. A screen that mounts later calls `/api/ai/forms/drain` once.
- Patches are only persisted for authenticated turns; anonymous users still
  get the inline `structured` block, but cannot drain later.

## Registration for voice-first users

The person using the app may not be able to read comfortably. `register` is the
one auth screen the agent may open, and `prepareRegistration` pre-fills the
harmless half of it:

- Allowed fields: `firstName`, `lastName`, `email`, `phoneNumber`, `referrer`,
  plus the `noEmail` flag. An invalid email or phone is dropped rather than
  filled.
- Never accepted, never stored, never repeated, never spoken: `password`,
  `confirm`, `agreed`. Extra keys are discarded by the normaliser, so a model
  that tries to fill them changes nothing.
- The tool returns `manualSteps: ['password', 'agreement', 'create_account']`
  so the model can name what is left without claiming it did it.

The mobile `RegisterScreen` applies the patch and asks one question at a time:

1. Name and email-or-phone, by voice.
2. If the user has no email, the tool is called with `noEmail=true` and the
   phone number is collected instead. Phone-only accounts are valid.
3. A secure password modal opens by itself with the keyboard focused. The value
   stays in the component and goes only to `POST /register`.
4. The agreement card is last, and ticking it is the user's own action.
5. When everything is complete and the box is ticked, the assistant says "I am
   creating your account now." and the form submits.

Server policy for this hackathon: email and phone are both accepted, no OTP or
verification gate is inserted, the account is created as verified, and
`POST /register` returns a 30-day JWT plus the user object. The app applies that
session immediately, opens Market, and speaks "Welcome to Salmart, we are glad
to have you here. Would you like to buy or sell something?" The generic
post-sign-in resume turn is suppressed for this transition.

Security limits, stated plainly because they are product limits, not bugs:

- A password must never be spoken to the assistant, typed into a chat, or
  handled by the server outside the registration request. It is hashed by
  `/register` and never logged.
- Phone numbers are treated as unverified for this hackathon. The verification
  screen remains only for older accounts that still need an email link.

## Google sign-in handoff

Sign-in is the one action the agent cannot complete itself, and it must never
ask for a password. `startGoogleAuthentication` returns an `auth_url` block
built from `APP_BASE_URL`; the platform comes from the model argument or, if
omitted, the client's `Platform.OS` in `context`.

On the client:

1. Prefer the native Google account picker (`runGoogleAuth`). It returns an
   idToken to `POST /auth/google/mobile`; an existing complete account gets a
   session, a brand-new account gets a `setup_token` and lands on the profile
   completion screen.
2. If the native module is missing (Expo Go), the user cancels, or the native
   path fails, the same `auth_url` opens in a system browser. The existing
   `salmart://auth/callback` handler finishes the flow.
3. The card stays tappable and in place — no automatic browser launch — and the
   reply is spoken with a "Hear what to do" line.

The referral code, when present, is read from the gated URL only after the
backend `[A-Za-z0-9_-]{1,64}` check, so a new account still links its referrer.

## Conversational onboarding

The same global mic is the entry point to signup, sign-in, and recovery.
The system prompt teaches the model six intents using only flows that exist:

- **register** → navigate `register` + `prepareRegistration` (name plus email or phone; the password and agreement stay in the screen's own secure controls).
- **sign_in** → email users go to `signin` (the model never asks for, accepts, or repeats a password); Google users get the `auth_url` handoff.
- **recover_account** → navigate `passwordReset` and explain one step at a time (email → emailed link → new password; expired links are re-requested from the same screen).
- **explain_authentication_options** → `getAvailableAuthenticationMethods` + `getOnboardingState`.
- **continue_pending_authentication / explain_authentication_error** → the `explainAuthError` tool maps the real backend outcome (`email_exists`, `invalid_password`, `no_account`, `google_only`, `unverified`, `expired_link`, `verification_pending`, `suspended`, `recovery_failed`, `google_cancelled`, `session_expired`) to one short spoken sentence plus the screen that fixes it. Raw backend messages never reach the model (they can contain emails); unknown codes get generic help, never an invented diagnosis.
- **resume_original_intention** → the task goal survives rebind on the same conversation; after sign-in the app runs one spoken resume turn ("I just signed in…") and the model continues instead of asking the user to repeat. A manual sign-in with no prior AI conversation stays silent. Only the app's verified auth state counts — returning to the app is not proof.

Security (enforced by shape): no passwords in chat/history/model, no tokens to the model, no invented auth results, no model-driven credential changes, no sensitive logging. `authentication_success` is only ever spoken after the real auth system confirms it (the `alreadySignedIn`/`ok` paths, never a model claim). Registration itself is server-confirmed: the app opens Market only after `/register` returns a session.

## Anonymous voice

A signed-out user can still talk to the agent; the voice endpoints on the
legacy router accept a missing token without weakening authenticated calls:

- `POST /api/assistant/transcribe` and `POST /api/assistant/speak` use
  `softVoiceAuth`: no `Authorization` header → anonymous; a present-but-invalid
  or expired Bearer token is still a `401`. A valid token sets `req.userId`.
- Per-IP limits: transcribe 30/min and 300/hour; speak 90/min and 1,200/hour.
  Over-limit responses are `{ success: false, code: 'VOICE_RATE_LIMIT' }`.
- `/api/ai` turns were already anonymous-capable through soft auth; the mobile
  client creates an anonymous conversation and rebinds it after sign-in.

The change is captured in `routes/assistantRoutes.event.patch`, which applies
to the pre-event `assistantRoutes.js` blob `eb30b5582` (plus
`assistantGallery.js` blob `ab1b359` from the same commit) and reproduces both
live files byte-for-byte.

## Same-language voice (Meta MMS, no Gemini)

No Google AI key exists anywhere in the voice path. The reply is spoken in the
language the person actually spoke:

1. `POST /api/assistant/transcribe` returns `{ success, text, lang, provider,
   model }`, where `lang` is one of `eng`/`yor`/`hau`/`ibo` from
   `lib/assistant/speechLang.js` (unique diacritics first, then distinctive
   everyday words; anything uncertain stays English).
2. The mobile client sends that `lang` with the `/api/ai` turn (so the model
   replies in the same language — see the `lang` rule in the system prompt)
   and with `POST /api/assistant/speak` as `{ text, lang }`.
3. `lib/assistant/mmsTts.js` posts the text to the per-language Meta MMS model
   and returns the same `{ audio, mimeType, provider: 'meta-mms', model, voice }`
   contract the old TTS path used, so the client player is unchanged. Without
   `lang` it detects from the reply text itself.
4. `{ success: false, code: 'TTS_UNAVAILABLE' }` → the phone's own TTS speaks
   instead, so a reply is never silent. `GET /api/assistant/status` reports
   `tts: { provider: 'meta-mms', configured }`.

**Voice-output status (checked 30 Oct 2026).** Hugging Face retired
`api-inference.huggingface.co` (the name no longer resolves) and its successor
router answers `Model not supported by provider hf-inference` for the
`facebook/mms-tts-*` repos — they have no hosted provider, and the Meta Model
API itself exposes no TTS model (`/models` lists chat, image, vision and
transcription only). So there is currently **no hosted Meta voice-output
endpoint**. Rather than fail on every turn, `TTS_MODE` defaults to `device`:
`/speak` answers `TTS_UNAVAILABLE` in ~20 ms and the phone's own voice speaks.
Set `TTS_MODE=mms` (plus `HF_INFERENCE_BASE` if you self-host) to re-enable the
Meta MMS path when a reachable endpoint exists — no client or route change
needed. A ten-minute circuit breaker in `mmsTts.js` stops hammering a dead
provider, and `[mmsTts] server voice unavailable …` logs the real reason.

The legacy chat/vision/gallery chain is Meta → Glimmer (Meta open weights)
only; there is no third-party fallback anywhere. STT is Meta Muse Voice
Transcribe only — a failure surfaces as `TRANSCRIBE_FAILED` with the reason
in the server logs, never a silent third-party transcript.
Gemini was removed from the orchestrator, the vision chain, the gallery
ranker, and TTS; Groq was removed from chat, STT, vision, and gallery; and
`@google/genai` + `groq-sdk` are gone from `package.json`. Google
OAuth sign-in (`passport-google-oauth20`, `/auth/google`) is untouched — that
is sign-in, not Gemini.

## Trace logs (how to read a Render incident)

Every voice/assistant operation logs one line on success and one on failure,
so a log tail tells the whole story without a reproducer:

| Prefix | When | Example |
| --- | --- | --- |
| `[config]` | boot | key fingerprint (`len`, last-4 `tail`), `base`, proxy set/unset |
| `✅/❌ Meta Model API` | boot | one live chat call from the deploy itself (mirrors the MongoDB block; never exits) |
| `[muse chat]` | 404/model-list events | dead id, candidates tried, provider `/models` list or failure reason |
| `[agentRunner]` | `/api/ai` turn start/end/fail | `requestId`, stop reason, `llmMs`/`toolMs`, tool count |
| `[metaProvider]` | each model call ok/fail | `requestId`, model id, status, ms |
| `[assistant]` | legacy turn/vision/transcribe/speak/rank ok/fail | provider, model/voice, ms, error status + message |

At boot, `GET /api/assistant/status` exposes the same state (`chat`,
`glimmer`, `bgClean`, `tts`) for the diagnostics screen.

## Tool allowlist (20)

| Tool | Category | Auth | Writes | Confirm |
| --- | --- | --- | --- | --- |
| `getOnboardingState` | onboarding | no | no | no |
| `getAvailableAuthenticationMethods` | onboarding | no | no | no |
| `startGoogleAuthentication` | onboarding | no | no | no |
| `explainAuthError` | onboarding | no | no | no |
| `searchProducts` | product | no | no | no |
| `getProductDetails` | product | no | no | no |
| `getMyListings` | seller | yes | no | no |
| `createProductDraft` | seller | yes | no (draft only) | no |
| `updateProductPrice` | seller | yes | yes | **yes** |
| `publishProductListing` | seller | yes | yes | **yes** |
| `prepareAdForm` | form | yes | no | no |
| `fillRequestForm` | form | yes | no | no |
| `fillProfileForm` | form | yes | no | no |
| `prepareRegistration` | form | no | no | no |
| `navigateToScreen` | navigation | no | no | no |
| `prepareSellerEnquiry` | messaging | yes | no | no |
| `sendSellerEnquiry` | messaging | yes | yes | **yes** |
| `getMyOrders` | order | yes | no | no |
| `getOrderDetails` | order | yes | no | no |
| `getAvailableAppCapabilities` | help | no | no | no |

`publishProductListing` is registered with `wired: false`, so the executor
returns `TOOL_NOT_AVAILABLE`. Publishing needs the seller's photo/file upload,
which only the mobile client produces. There is no path for the model to
publish on its own.

Anonymous callers only receive tools with `requiresAuth: false`. Tool
handlers additionally re-check `ctx.userId`; the model cannot pass an owner
id.

## Data and retention

| Model | Contents | Retention |
| --- | --- | --- |
| `AIConversation` | messages, task state, ownership | 30 days authenticated, 1 day anonymous |
| `AIPendingAction` | proposed action, args, summary, preview, state | 10 min pending; 30 days after finish/cancel |
| `AIPendingFormPatch` | one form patch per user/target | 10 min, deleted on drain |
| `AIMetric` | allowlisted counters, stop reasons, latency, tool names | 90 days |

Indexes are declared in the schemas and are created by Mongoose on connect.

## Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `META_API_KEY` | `lib/assistant/config.js` | server-only; never ship to the client |
| `META_API_BASE` | `lib/assistant/config.js` | default `https://api.meta.ai/v1` |
| `MODEL_BRAIN` | `lib/assistant/config.js` | default `muse-spark-1.3`; the agent's model. Quoted values are stripped (with a one-time warning), and a 404 "model not found" walks every remaining candidate id (fallback env, known ids including `-contributor` variants, then the provider's `/models` list), so a stale deploy env cannot take chat down. The legacy `/api/assistant/status` reports the active id under `chat`. |
| `MODEL_BRAIN_FALLBACK` | `lib/assistant/config.js` | optional; model used for the one-shot 404 retry. Default `muse-spark-1.2` (deliberately different from the primary). Must be an id Meta currently serves |
| `META_REASONING_EFFORT` | `lib/assistant/config.js` | default `low`; `none` is rejected |
| `META_TIMEOUT_MS` | `lib/assistant/config.js` | default 45,000 |
| `META_COOLDOWN_MS` | `lib/assistant/config.js` | legacy provider recovery interval; the `/api/ai` path calls Meta directly |
| `DEMO_MODE` | `lib/assistant/config.js` | legacy assistant `auto`/`live`/`mock`; `/api/ai` has no mock brain and requires a real key |
| `APP_BASE_URL` | `services/ai/tools/authTools.js` | public origin used in the Google sign-in URL |
| `AI_LOG_LEVEL` | `services/logger.js` | default `info`; writes `logs/ai.log` |
| `JWT_SECRET` | host `middleware/auths.js` | required by all authenticated routes |
| `MONGO_URI` | host `app.js` | required for conversations/actions/patches |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `authTools.js` | Google is reported unsupported and the URL tool fails when unset |
| `HF_API_KEY` (or `HUGGINGFACE_API_KEY`) | `lib/assistant/mmsTts.js` | server-only; Meta MMS voice output. Without it `/speak` returns `TTS_UNAVAILABLE` and the phone speaks instead |
| `MMS_TTS_MODEL_ENG` / `_YOR` / `_HAU` / `_IBO` | `lib/assistant/mmsTts.js` | optional per-language voice overrides; defaults are `facebook/mms-tts-{eng,yor,hau,ibo}` |
| `TTS_TIMEOUT_MS` | `lib/assistant/mmsTts.js` | default 30,000 |
| `TTS_MAX_CHARS` | `lib/assistant/mmsTts.js` | default 500; longer replies are cut before synthesis |
| `NODE_ENV` | `aiRoutes.js` | `production` hides `toolLog`; also affects the `APP_BASE_URL` default |

`services/logger.js` writes to `logs/ai.log`; Winston creates the `logs/`
directory on first write. `AI_LOG_LEVEL=info` is fine for production.

## Local dev from a phone (same Wi-Fi)

Running the backend and Metro on the PC and the app on a physical phone:

```bash
# terminal 1 - this repo
npm run dev:local          # NODE_ENV=development, prints this PC's LAN origin

# terminal 2 - the mobile app repo
npx expo start --lan       # open the QR in Expo Go / the dev build
```

`scripts/dev-local.ps1` exists because three defaults fight LAN testing:

| Default | Why it breaks LAN testing | What the script does |
| --- | --- | --- |
| `.env` has `NODE_ENV=production` | secure-only session cookie + Render OAuth callback | forces `NODE_ENV=development` for the process |
| `APP_BASE_URL` unset | Google hand-off URL points at `localhost`/Render | sets it to `http://<lan-ip>:<port>` |
| Windows Firewall | phone silently cannot reach port 3000 | adds a private-profile rule (needs one elevated run; prints the exact command otherwise) |

The app needs **no** `EXPO_PUBLIC_API_URL`: `config.js` derives the API origin
from the Metro host (`Constants.expoConfig.hostUri`) when no explicit override
is set, and only for private IPv4/loopback hosts. `npx expo start --lan` on the
same PC that runs the backend is therefore enough, and a DHCP address change
does not break it. Set `EXPO_PUBLIC_API_URL` to override (tunnel, staging,
production), `EXPO_PUBLIC_API_PORT` if the backend is not on 3000.

Requirements: phone and PC on the same Wi-Fi, backend reachable at
`http://<lan-ip>:3000/` from the phone's browser first. Google works through
the native picker; the browser fallback needs an https callback, which a LAN
address cannot provide (Google rejects private-IP redirect URIs).

## Applying to the live server

From the server repo root:

```bash
git apply /path/to/extract/backend/app.ai.patch
git apply /path/to/extract/backend/routes/searchRoutes.ai-bridge.patch
git apply /path/to/extract/backend/routes/assistantRoutes.event.patch
cp -R /path/to/extract/backend/services/ai <server>/services/
cp /path/to/extract/backend/services/logger.js <server>/services/
cp /path/to/extract/backend/lib/assistant/llama.js <server>/lib/assistant/
cp /path/to/extract/backend/lib/assistant/speechLang.js <server>/lib/assistant/
cp /path/to/extract/backend/lib/assistant/mmsTts.js <server>/lib/assistant/
cp /path/to/extract/backend/routes/aiRoutes.js <server>/routes/
cp /path/to/extract/backend/routes/aiFormBridge.js <server>/routes/
cp /path/to/extract/backend/scripts/ai-eval.js <server>/scripts/
```

`assistantRoutes.event.patch` targets blobs `eb30b5582` (`routes/assistantRoutes.js`)
and `ab1b359` (`routes/assistantGallery.js`) at the pre-event commit. Apply it only to that base; if the live files have
already moved on, use it as the reviewable diff rather than forcing it.

Then install the dependencies listed in `backend/package.json` (`ajv`,
`express-rate-limit`, `mongoose`, `uuid`, `winston`, plus the existing
`express`/`dotenv`) and restart. The three Mongo collections are created on
first use; `AIMetric` is the fourth and is created on first metric write.

Do not copy `backend/services/ai/tools/productTools.js` without the
`searchRoutes.js` export block: the module throws at boot if
`searchRoutes._internal` is missing, on purpose.

## Tests and verification

```bash
cd backend
npm test              # 84/84 across 12 keyless suites
npm run eval:ai       # 11/11 offline contract checks
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `assistant-tasks.test.js` | 10 | legacy task planner |
| `assistant-glimmer-clean.test.js` | 6 | Glimmer client + cleanup contract |
| `ai-form-tools.test.js` | 10 | form normalisers: price/location/condition aliases, service vs regular listings, unknown values dropped, empty patches rejected, sensitive profile fields never patched, registration drops password/agreement |
| `ai-navigation.test.js` | 5 | screen allowlist (including `ai` and id-based routes refused), query normalisation, form-fill ordering, one `navigate` per turn, forged targets dropped |
| `ai-task-state.test.js` | 8 | task create/merge/TTL/reset, prompt block honesty, privacy stripping |
| `ai-metrics.test.js` | 4 | closed schema, text/phone/email rejection, aggregation, percentiles |
| `ai-auth-url.test.js` | 4 | Google URL gate (`https`, `/auth/google`, no credentials, length cap) and platform fallback |
| `speech-lang-mms.test.js` | 12 | same-language detection (diacritics, word votes, ambiguity stays English), hint normalisation, MMS contract over stubbed fetch, device-voice default makes no network call, `empty_text`/`tts_not_configured`/HTTP-error codes |
| `meta-only.test.js` | 2 | hackathon compliance guard: no third-party provider reference in shipped source or manifest |
| `ai-history.test.js` | 8 | replay hygiene: orphans dropped, strays dropped, wire shape valid |
| `ai-auth-guidance.test.js` | 5 | closed auth-error codes, short safe speech, no echo, anonymous registry wiring |
| `llama-model-fallback.test.js` | 10 | stale `MODEL_BRAIN` 404 recovery, working-id reuse, non-model 404 surfaced, full candidate walk, empty `/models` walk + reason, `chatSelfTest` ok/fail, boot `/models` check, reasoning-budget retry |

All twelve need no Mongo and no provider key. Most need no network; the model
fallback suite stubs `fetch` so it is offline too.

`npm test` and `npm run eval:ai` are plain `package.json` scripts
(`node --test "tests/**/*.test.js"` and `node scripts/ai-eval.js`). The quoted
glob matters: Node 24 treats a bare directory argument as a module path.

### Scripted evaluation

`scripts/ai-eval.js` has two modes:

```bash
node scripts/ai-eval.js
node scripts/ai-eval.js --live --base https://your-api [--token JWT] [--soft]
```

- **Offline** (default) runs 11 checks over the pure layers that decide what
  the app may render and remember: navigation targets, form fills, registration
  privacy, the Google URL gate, and task-memory reset/privacy/prompt output.
  It needs no keys and no network.
- **Live** creates one throwaway conversation against a running `/api/ai` and
  sends a fixed script of utterances, checking replies, structured blocks, and
  latency. Without `--token` it runs anonymously, which also exercises the
  anonymous voice path. `--soft` reports failures as warnings.

Live mode was **not** run from this extract: it needs a deployed server,
`META_API_KEY`, and Mongo. Offline mode (11/11) and the full `npm test`
(84/84) were run here. The extract ships no `node_modules`; to run the suites
without reinstalling 700+ packages they were executed with `NODE_PATH`
pointing at the working copy's `node_modules` (every file compared here is
SHA-256 identical to its live counterpart), and both scripts also pass in the
live repo itself.

## Known limitations

- `getAvailableAppCapabilities` lists every wired tool, including
  authenticated ones, to anonymous callers. Its description says "right now",
  so filtering by `ctx.isAuthenticated` is a sensible follow-up.
- Order amounts are stored with `currencyUnit` (`naira`/`kobo`), but
  `orderTools.js` currently displays the raw `amount` with
  `currency: 'NGN'`. Treat this as a display bug until the amount is
  normalised.
- `publishProductListing` is intentionally unavailable.
- Registration is voice-first end to end, but the final checks were script and
  parser tests only: no physical device was attached, so tapping through the
  secure modal and the spoken welcome still needs a device pass.
- Navigation is limited to screens that take no id. Opening a specific listing,
  chat thread, showroom, or checkout still needs the user to tap the real row.
- The agent has no streaming transport; each turn returns one JSON response.
- The metrics summary uses the existing admin auth (`verifyAdmin`); there is no
  separate read-only metrics token.
- Task memory is scoped to one conversation and is cleared by `reset()` /
  rebind-to-a-new-conversation; it is not a cross-device profile.
