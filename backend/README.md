# Backend — event work extract

Whole files here are new modules written during the event (Oct 26 – Nov 4,
2026), byte-identical to the live server sources. `assistantRoutes.event.patch`
is the event's diff to the pre-existing live route file — no pre-hackathon code
is copied into this repo.

## Mounted surface (what the app and any test calls)

The live `app.js` mounts exactly one assistant router — nothing else in this
folder is reachable over HTTP:

```js
app.use('/api/assistant', assistantRoutes);
```

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/assistant/chat` | JWT | Meta → Groq → Gemini orchestrator |
| `POST` | `/api/assistant/transcribe` | JWT | voice → text (multipart field `audio`, ≤10 MB) |
| `POST` | `/api/assistant/speak` | JWT | text → spoken WAV (Gemini TTS; JSON `{ text }`) |
| `POST` | `/api/assistant/ad-from-image` | JWT | photo → `fill_ad` draft (field `image`, JPEG/PNG/WebP ≤8 MB) |
| `POST` | `/api/assistant/scan-shop` | JWT | Shelfie: shelf photo → priced drafts (field `image`) |
| `POST` | `/api/assistant/rank-photos` | JWT | gallery ranking (pre-existing route file, Groq/Gemini) |
| `GET` | `/api/assistant/status` | public | provider + model state |
| `GET` | `/api/assistant/ping` | public | liveness |

See the top-level README for curl examples against these routes.

## Agent tools (11, Phase 1–3)

Read-only and client-directed: `search_products`, `get_my_listings`
(owner-scoped, feeds last-shown resolution), `get_cart`, `navigate` (15
screens), `fill_ad_form` (validates only — the user taps Post),
`find_photo_in_gallery`, `choose_photo`. Verified writes: `add_to_cart`,
`remove_from_cart` (upsert semantics), `start_chat_with_seller` (intent gate),
`update_listing_price` (two-call confirm gate + DB re-read; rejects non-owned
and sold listings; clears an active discount like `PATCH /post/:id`).

No publish, price-guess, profile-write, showroom-write, or payment tool
exists — by product rule, not omission. Multi-turn memory is the per-user task
store (`lib/assistant/tasks.js`): goal, merged draft, last results, 30-min
TTL; scope changes reset it and clear last-shown ids.

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
```

`visionRoutes.js` / `voiceRoutes.js` are event-written reference modules.
Nothing in the live server requires or mounts them, so copying them into
`<server>/routes/` alone exposes nothing — they are included as reviewable
event work. The mounted voice/vision paths are the `/api/assistant` rows above.

Requires `express`, `multer`, `dotenv`, `@ffmpeg-installer/ffmpeg`
(`backend/package.json`; open-source, labelled). `mongoSearch.js` imports the
pre-existing host model `models/postSchema.js` — an integration point, not
copied.

## The route patch

`routes/assistantRoutes.event.patch` (+166/−3, base: pre-kickoff
`routes/assistantRoutes.js`) adds: Meta imports + recovery probe, Shelfie
location helpers + fallback gate, `runMetaAgent`, Meta-first provider order,
`metaVision`, Meta transcription with Groq fallback, `provider`/`model` in
replies, `GET /status`, and `POST /scan-shop` with its wiring
(`searchProducts`, `normalizeAdFields` stay in the host file).

Apply from the server repo root (it already mounts `/api/assistant`):

```bash
git apply /path/to/extract/backend/routes/assistantRoutes.event.patch
cp backend/lib/assistant/*.js <server>/lib/assistant/
```

## Configuration

See `.env.example` (blank values). `SHELFIE_FALLBACK` defaults to off;
`STT_*` default to the Meta key/base; `DEMO_MODE=auto|live|mock`.
