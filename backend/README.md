# Backend — event work extract

Whole files here are new modules written during the event (Oct 26 – Nov 4,
2026), byte-identical to the live server sources. `assistantRoutes.event.patch`
is the event's diff to the pre-existing live route file — no pre-hackathon code
is copied into this repo.

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
routes/visionRoutes.js        POST /rank-photos, POST /ad-from-image
routes/voiceRoutes.js         POST /transcribe
```

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
cp backend/routes/visionRoutes.js backend/routes/voiceRoutes.js <server>/routes/
```

## Configuration

See `.env.example` (blank values). `SHELFIE_FALLBACK` defaults to off;
`STT_*` default to the Meta key/base; `DEMO_MODE=auto|live|mock`.
