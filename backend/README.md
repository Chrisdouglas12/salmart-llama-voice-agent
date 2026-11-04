Backend — Built During Hackathon (Oct 26 - Nov 4, 2026)

All files here are new, written during the event. `/api/ai` files are identical to live. Legacy `lib/assistant/` files are event snapshots — 3 got small live edits after (`config.js`, `tools.js`, `mockAgent.js`). See `../NEW_WORK.md`.

`.patch` files = diffs to old server files. No pre-hackathon code copied.

Two AI Surfaces

*Live `app.js` mounts:*
```js
app.use('/api/assistant', assistantRoutes);
app.use('/api/ai/forms', aiFormBridge);
app.use('/api/ai', aiRoutes);
_1. `/api/assistant` — Voice / Vision (original)_
Method	Path	Auth	Purpose
POST	`/chat`	JWT	Meta → Glimmer orchestrator
POST	`/transcribe`	JWT	voice → text (audio ≤10MB, returns lang: eng/yor/hau/ibo)
POST	`/speak`	JWT	text → voice (MMS voices, mirrors user language)
POST	`/ad-from-image`	JWT	photo → draft ad
POST	`/photo-clean`	JWT	background → white 1080px cover
POST	`/scan-shop`	JWT	Shelfie: shelf photo → priced drafts
GET	`/status`, `/ping`	public	provider + model state, liveness
_2. `/api/ai` — Conversational Agent (new)_
Method	Path	Auth	Purpose
POST	`/conversations`	soft	create/resume anonymous or auth chat
POST	`/conversations/rebind`	JWT	bind anonymous → authenticated
POST	`/turn`	soft	one user message → agent loop
POST	`/actions/:id/confirm`	JWT	execute pending action
POST	`/actions/:id/cancel`	JWT	cancel pending
GET	`/tasks/:id`	JWT	read pending state
POST	`/forms/drain`	JWT	claim one-shot form patch
Soft auth = anonymous allowed, invalid token rejected. All real actions require confirm. Details in `AI_AGENT.md`.

Tools

Total distinct tools across both surfaces = 21 (some overlap).

_`/api/assistant` — 14 tools (9 original + 5 event):_
Read-only + form-fill: `search_products`, `get_my_listings`, `get_cart`, `navigate` (21 screens), `fill_ad_form`, `fill_profile_form`, `fill_request_form`, `find_photo_in_gallery`, `choose_photo`, `request_system_photo`
Verified writes: `add_to_cart`, `remove_from_cart`, `start_chat_with_seller`, `update_listing_price` (2-step confirm + ownership check)

No publish, price-guess, or payment tool — by design.

_`/api/ai` — 17 tools_ (onboarding, products, seller, forms, messaging, orders, help) — see `AI_AGENT.md`.

Provider order: Meta → Glimmer. `GLIMMER_FIRST=true` flips for demo.

Memory: per-user task store (goal, draft, last results, 30-min TTL). Scope change resets it.

New Modules
lib/assistant/
  config.js, llama.js, agent.js, tools.js, form.js, mockAgent.js
  mongoSearch.js, shelfie.js

services/ai/
  agentRunner.js (4 iterations / 6 tools / 45s)
  conversationStore.js, metaProvider.js, pendingAction.js
  toolRegistry.js (17 tools), toolExecutor.js
  tools/*.js, pendingFormPatch.js
  logger.js

routes/
  aiRoutes.js, aiFormBridge.js
  visionRoutes.js, voiceRoutes.js (reference, NOT mounted)
tests/ — 20 files, 128/128 keyless for backend alone. 156/156 total with root tests.

`visionRoutes.js` / `voiceRoutes.js` are reference only — copying them alone exposes nothing. Mounted routes are the `/api/assistant` table above.

_Dependencies:_ `express`, `multer`, `dotenv`, `ajv`, `mongoose`, `uuid`, `winston` — all in `backend/package.json`.

Patches

- `assistantRoutes.event.patch` — Meta provider, Shelfie, MMS voice, `/status`, trace logs (+603/-190)
- `app.ai.patch` — mounts `/api/ai`
- `searchRoutes.ai-bridge.patch` — reuses live search helpers
- `userRoutes.verify-email.patch` — app-opening verify/reset links
- `userSchema.registration.patch` + `userRoutes.registration.patch` — register/login with email OR Nigerian phone, 30-day JWT, verified

_Apply:_
git apply backend/routes/assistantRoutes.event.patch
git apply backend/app.ai.patch
git apply backend/routes/searchRoutes.ai-bridge.patch
git apply backend/routes/userRoutes.verify-email.patch
git apply backend/models/userSchema.registration.patch
git apply backend/routes/userRoutes.registration.patch
cp backend/lib/assistant/*.js <server>/lib/assistant/
cp -R backend/services/ai <server>/services/
cp backend/routes/aiRoutes.js backend/routes/aiFormBridge.js <server>/routes/
Config

See `.env.example`.
- `SHELFIE_FALLBACK=off` by default
- `STT_*` = Meta keys
- `DEMO_MODE=auto|live|mock` for `/api/assistant` only — `/api/ai` always calls Meta, no mock
- `APP_BASE_URL`, `AI_LOG_LEVEL` for `/api/ai` — see `AI_AGENT.md`
