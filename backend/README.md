# Backend — event work extract

Whole files here are new modules written during the event (Oct 26 – Nov 4,
2026). The `/api/ai` files are hash-identical to current live; the legacy
`lib/assistant/` files are the event-time snapshot, and three of them
(`config.js`, `tools.js`, `mockAgent.js`) have since received small live edits
(see `NEW_WORK.md`). The `.patch` files are the event's diffs to pre-existing
live files — no pre-hackathon code is copied into this repo.

Two AI surfaces are covered:

- `/api/assistant` — the original voice/vision assistant (below).
- `/api/ai` — the newer conversational agent. Its endpoints, tool allowlist,
  confirmation flow, form bridge, and environment are documented in
  [`AI_AGENT.md`](AI_AGENT.md).

## Mounted surface (what the app and any test calls)

The live `app.js` mounts both surfaces:

```js
app.use('/api/assistant', assistantRoutes);
app.use('/api/ai/forms', aiFormBridge);
app.use('/api/ai', aiRoutes);
```

The form bridge is mounted before the `/api/ai` router so its `/drain` path
matches first.

### `/api/assistant` (voice/vision surface)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/assistant/chat` | JWT | Meta → Glimmer orchestrator |
| `POST` | `/api/assistant/transcribe` | JWT | voice → text (multipart field `audio`, ≤10 MB); response includes `lang` (eng/yor/hau/ibo) |
| `POST` | `/api/assistant/speak` | JWT | text → spoken audio (Meta MMS voices via Hugging Face; JSON `{ text, lang? }`, voice mirrors the speaker's language) |
| `POST` | `/api/assistant/ad-from-image` | JWT | photo → `fill_ad` draft (field `image`, JPEG/PNG/WebP ≤8 MB) |
| `POST` | `/api/assistant/photo-clean` | JWT | background cleanup → white 1080px cover (field `image`); `CLEAN_UNAVAILABLE` when no matting endpoint is configured |
| `POST` | `/api/assistant/scan-shop` | JWT | Shelfie: shelf photo → priced drafts (field `image`) |
| `POST` | `/api/assistant/rank-photos` | JWT | gallery ranking (pre-existing route file, Meta vision) |
| `GET` | `/api/assistant/status` | public | provider + model state |
| `GET` | `/api/assistant/ping` | public | liveness |

See the top-level README for curl examples against these routes.

### `/api/ai` (agent surface)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/ai/conversations` | soft | create or resume an anonymous/authenticated conversation |
| `POST` | `/api/ai/conversations/rebind` | JWT | one-way anonymous → authenticated bind |
| `POST` | `/api/ai/turn` | soft | one user message through the tool-calling agent |
| `POST` | `/api/ai/actions/:id/confirm` | JWT | execute a pending price/message action |
| `POST` | `/api/ai/actions/:id/cancel` | JWT | cancel a pending action |
| `GET` | `/api/ai/tasks/:id` | JWT | read a pending action's state |
| `POST` | `/api/ai/forms/drain` | JWT | claim a queued one-shot form patch |

Soft auth allows anonymous turns but rejects an invalid Bearer token. All
consequential actions are prepared by the agent and only run through the
confirm endpoint. Full request/response examples are in
[`AI_AGENT.md`](AI_AGENT.md).

## `/api/assistant` tools (14: 9 original + 5 event)

Read-only and client-directed: `search_products`, `get_my_listings`
(owner-scoped, feeds last-shown resolution), `get_cart`, `navigate` (21
screens — every non-auth screen; chat/showroom/group require their id),
`fill_ad_form` (validates only — the user taps Post), `fill_profile_form`
(names/bio/state/city — avatar, phone, bank, password never fillable; user
taps Save), `fill_request_form` (category/text/budget/location — photo stays
manual; user posts), `find_photo_in_gallery`, `choose_photo`, `request_system_photo` (bare "I want
to sell" → the phone gallery opens; the seller picks; the photo lands on the
form). Verified
writes: `add_to_cart`, `remove_from_cart` (upsert semantics),
`start_chat_with_seller` (intent gate), `update_listing_price` (two-call
confirm gate + DB re-read; rejects non-owned and sold listings; clears an
active discount like `PATCH /post/:id`).
Provider order: Meta → Glimmer (`GLIMMER_FIRST=true` puts
Glimmer first to demo the Meta brains side by side).

No publish, price-guess, profile-write, showroom-write, or payment tool
exists — by product rule, not omission. Multi-turn memory is the per-user task
store (`lib/assistant/tasks.js`): goal, merged draft, last results, 30-min
TTL; scope changes reset it and clear last-shown ids.

The `/api/ai` agent has a separate 17-tool allowlist (onboarding, products,
seller, forms, messaging, orders, help) with its own confirmation and expiry
model. See [`AI_AGENT.md`](AI_AGENT.md).

## New modules

```
lib/assistant/config.js       env, model ids, sticky provider state, recovery
lib/assistant/llama.js        Meta chat, vision, Muse Voice Transcribe
lib/assistant/agent.js        tool-calling loop + fallback orchestration
lib/assistant/tools.js        tool schemas → app actions
lib/assistant/form.js         Pidgin/English parsing → exact form values
lib/assistant/mockAgent.js    deterministic fallback brain
lib/assistant/mongoSearch.js  catalogue search (calls the host Post model)
lib/assistant/shelfie.js      Aya Shelfie: boxes, crops, price bands
routes/visionRoutes.js        standalone vision routes (reference, NOT mounted)
routes/voiceRoutes.js         standalone transcribe route (reference, NOT mounted)

services/ai/agentRunner.js    agent turn loop: 4 iterations / 6 tools / 45s
services/ai/conversationStore.js  AIConversation + ownership/rebind rules
services/ai/metaProvider.js   adapter over lib/assistant/llama.js
services/ai/pendingAction.js  AIPendingAction: confirm/cancel/expiry
services/ai/pendingFormPatch.js   one-shot form patch per user/target
services/ai/toolExecutor.js   allowlist, auth, AJV validation, confirmation
services/ai/toolRegistry.js   the 17-tool allowlist
services/ai/tools/*.js        auth, product, seller, form, messaging, order
services/logger.js            Winston logger used by the AI modules
routes/aiRoutes.js            /api/ai endpoints + structured response builder
routes/aiFormBridge.js        /api/ai/forms/drain
tests/ai-form-tools.test.js   7 keyless form-normaliser tests
```

`visionRoutes.js` / `voiceRoutes.js` are event-written reference modules.
Nothing in the live server requires or mounts them, so copying them into
`<server>/routes/` alone exposes nothing — they are included as reviewable
event work. The mounted voice/vision paths are the `/api/assistant` rows above.

Requires `express`, `multer`, `dotenv`, `@ffmpeg-installer/ffmpeg` for the
legacy surface, and `ajv`, `express-rate-limit`, `mongoose`, `uuid`, `winston`
for `/api/ai` (`backend/package.json`; open-source, labelled).
`mongoSearch.js`, the AI product/seller/messaging/order tools, and the AI
conversation/action models all import pre-existing host models and helpers —
integration points, not copied.

## The route patches

### Legacy assistant patch

`routes/assistantRoutes.event.patch` (+603/−190 on `routes/assistantRoutes.js`
plus +20/−60 on `routes/assistantGallery.js`, base: pre-kickoff commit
`8c5bef3e2`) adds: Meta imports + recovery probe, Shelfie
location helpers + fallback gate, `runMetaAgent`, Meta → Glimmer provider
order, `metaVision`, Meta transcription, `provider`/`model` in
replies, `GET /status` (+`chat`/`glimmer`/`bgClean`/`tts`), `POST /scan-shop`
with its wiring (`searchProducts`, `normalizeAdFields` stay in the host
file), Meta MMS voice (`/speak` with `lang`, `/transcribe` returns `lang`),
anonymous voice limits, and per-operation trace logs. No Gemini or Groq
remains; gallery ranking is Meta vision.

### AI agent patches

`app.ai.patch` adds the two `/api/ai` mounts to the live `app.js` and the two
requires. `routes/searchRoutes.ai-bridge.patch` appends the `_internal` export
block that lets `services/ai/tools/productTools.js` reuse the live search
helpers instead of duplicating query logic. Both are append-only: they do not
change existing behaviour.

Apply from the server repo root (it already mounts `/api/assistant`):

```bash
git apply /path/to/extract/backend/routes/assistantRoutes.event.patch
git apply /path/to/extract/backend/app.ai.patch
git apply /path/to/extract/backend/routes/searchRoutes.ai-bridge.patch
cp backend/lib/assistant/*.js <server>/lib/assistant/
cp -R backend/services/ai <server>/services/
cp backend/services/logger.js <server>/services/
cp backend/routes/aiRoutes.js backend/routes/aiFormBridge.js <server>/routes/
```

## Configuration

See `.env.example` (blank values). `SHELFIE_FALLBACK` defaults to off;
`STT_*` default to the Meta key/base; `DEMO_MODE=auto|live|mock` applies to the
legacy `/api/assistant` brain — `/api/ai` always calls Meta and has no mock
fallback. The AI agent also reads `APP_BASE_URL` for Google sign-in links and
`AI_LOG_LEVEL` for its Winston logger; both are listed in
[`AI_AGENT.md`](AI_AGENT.md#environment).
