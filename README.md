# Aya — a voice-first marketplace agent for Salmart

**Meta Global AI Developer Hackathon 2026 · Build for Your World · Indie track (solo)**

Salmart is the team's own Nigerian marketplace (pre-existing product, private
repositories). Many of its best sellers are more comfortable talking than
typing, so the Create Ad form — title, price, place, condition, photo — is the
wall between them and earning.

**Aya removes that wall.** The seller talks in English or Pidgin. Aya opens the
right screen, filters the phone's recent photos, reads the chosen photo, fills
the form live, and stops. The seller reviews the form and taps **Post**.

## Compliance statement (read first)

This repository is a **standalone public extract containing only work done
during the event (Oct 26 – Nov 4, 2026)**:

- Every whole file in `backend/` was first written during the event window.
- The two `.event.patch` files contain only the event's additions to
  pre-existing files. No pre-hackathon code is copied into this repo.
- Pre-existing Salmart code (marketplace, auth, cart, checkout, app shell, the
  original assistant, Gemini/Groq providers, Mongo models) is **not** in this
  repo. Where event code calls into it, the integration point is named in the
  docs so judges can see the boundary.
- Open-source dependencies (`express`, `multer`, `dotenv`,
  `@ffmpeg-installer/ffmpeg`, Expo/React Native) are labelled in
  `backend/package.json` and below.

**Video opening line (as required):** *"Salmart, our Nigerian marketplace app,
existed before this week; this week I built Aya, its Meta-powered voice
assistant — Meta-first chat with tool calling, voice transcription, photo
autofill, and one-photo shelf scanning — and wired it into the live app."*

## The flow

| Seller says | Aya does |
| --- | --- |
| "I want to sell something" | Opens **Create Ad** |
| "Open my gallery, I just snapped one house" | Opens the gallery and keeps the house photos |
| "Pick the second one" | Selects that photo and reads it |
| "Two bedroom flat, 50k, Abuja, brand new" | Fills title, price, location and condition as they speak |
| "Find me iPhone under 200k" | Searches the catalogue and shows matching listings |
| "Find the shoes I listed" | Lists the seller's own active ads (real postIds) |
| "Change their price to 70,000" | Asks for confirmation, then updates the price (verified re-read) |
| "Forget the shoes, sell a blender" | Resets the task; stale ids never leak |
| "Add it to cart" | Adds the listing the buyer just saw |
| "Take me to checkout" | Opens checkout with that item |

Two rules are enforced in code, not just in the prompt:

1. **Aya never publishes.** There is no publish tool. The seller always taps Post.
2. **Aya never asks for a phone number.** Contact happens through the app's
   existing seller chat.

### Aya Shelfie — one photo, many drafts

A seller with a table full of stock photographs the whole shelf once.
`muse-spark-1.3` finds up to six distinct items and draws a normalised box
around each; the server crops a card photo per item and prices each item
**deterministically from comparable Salmart listings** — the model only sees
and describes, never prices. Each card opens the normal Create Ad form; the
seller reviews and taps **Post**. No bulk publish. A failed scan can only
return the labelled canned shelf when `SHELFIE_FALLBACK=true` (off by default).

## Repository layout (event work only)

```
backend/
  package.json                 fresh manifest for the extract (open-source deps only)
  .env.example                 fresh template, blank values
  lib/assistant/
    config.js                  NEW: env, models, sticky provider state, recovery probe
    llama.js                   NEW: Meta chat, vision, Muse Voice Transcribe
    agent.js                   NEW: tool-calling loop, envelope, fallback orchestration
    tools.js                   NEW: tool schemas → fill_ad / pick_photo / add_to_cart / …
    form.js                    NEW: Pidgin/English parsing → exact Create Ad values
    mockAgent.js               NEW: deterministic fallback brain (no-key / offline)
    mongoSearch.js             NEW: catalogue search over the host Post model
    shelfie.js                 NEW: Aya Shelfie — boxes, crops, deterministic price bands
    tasks.js                   NEW: task planner — scope reset, draft merge, price gate, task store
  routes/
    visionRoutes.js            NEW: standalone voice/vision route modules written
    voiceRoutes.js             during the event (reference — NOT mounted; the
                               mounted equivalents are the /api/assistant routes
                               below, which is what the app and any test calls)
    assistantRoutes.event.patch  EVENT DIFF to the pre-existing live route file:
                               Meta-first orchestrator, runMetaAgent, metaVision,
                               Meta transcription, /status, /ping reply fields,
                               POST /scan-shop, Shelfie wiring, provider/model,
                               /speak (Gemini TTS), get_my_listings,
                               update_listing_price + confirm gate, task state,
                               extended navigable screens
  tests/
    agent-tasks.test.js        NEW: eval suite, 8/8 passing
mobile/
  salmart-mobile.event.patch   EVENT DIFF to the pre-existing React Native app
                               (7 files, +343/−12): sessionId, product cards,
                               add_to_cart, brain label, Shelfie UI, gallery
                               ranking, LAN API override, one starter chip
```

Apply points (in the private Salmart repos, not here):

```bash
# server repo root — the host already mounts /api/assistant
git apply /path/to/extract/backend/routes/assistantRoutes.event.patch
cp backend/lib/assistant/*.js <server>/lib/assistant/
```

`visionRoutes.js` / `voiceRoutes.js` are event-written reference modules, not
server wiring: the live `app.js` mounts only `/api/assistant`, so copying them
into `<server>/routes/` alone exposes nothing. They are included as reviewable
event work; the mounted voice/vision surface is the `/api/assistant` table
below, which is what the app calls and what any test should call.

Both patches were verified with `git apply --check --reverse` against the live
worktrees they were taken from.

```bash
# app repo root
git apply /path/to/extract/mobile/salmart-mobile.event.patch
```

## Test against the main backend

All of these hit the mounted `/api/assistant` router. `/status` and `/ping`
are public; everything else needs the app's JWT (`Authorization: Bearer …`).

```bash
BASE=https://app.salmartonline.com.ng   # or http://<laptop-LAN-IP>:3000 locally
JWT=<test JWT>

# which brain is live (public)
curl $BASE/api/assistant/status

# chat (Meta-first, Groq/Gemini fallback)
curl -X POST $BASE/api/assistant/chat \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"find me iPhone under 200k"}],"sessionId":"test-1"}'

# voice → text (multipart field `audio`, ≤10 MB)
curl -X POST $BASE/api/assistant/transcribe \
  -H "Authorization: Bearer $JWT" -F "audio=@voice.m4a"

# text → spoken reply (JSON { text }, ≤500 chars; base64 WAV back)
curl -X POST $BASE/api/assistant/speak \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"text":"I find one iPhone for you for 195,000 naira."}'

# vision → ad draft (multipart field `image`, JPEG/PNG/WebP ≤8 MB)
curl -X POST $BASE/api/assistant/ad-from-image \
  -H "Authorization: Bearer $JWT" -F "image=@photo.jpg" -F "text=50k Abuja brand new"

# Shelfie → priced drafts (multipart field `image`)
curl -X POST $BASE/api/assistant/scan-shop \
  -H "Authorization: Bearer $JWT" -F "image=@shelf.jpg"

# background cleanup → white 1080px cover (multipart field `image`;
# CLEAN_UNAVAILABLE when no matting endpoint is configured — by design)
curl -X POST $BASE/api/assistant/photo-clean \
  -H "Authorization: Bearer $JWT" -F "image=@photo.jpg"
```

Recoverable failures return HTTP 200 with `{ success: false, code, message }`
(`NO_AUDIO`, `NO_IMAGE`, `BAD_IMAGE`, `TRANSCRIBE_FAILED`, `VISION_UNAVAILABLE`,
`SCAN_FAILED`) — the client reads `success`, not the status code.

## Pre-existing integration points (not in this repo)

Event code calls these pre-existing Salmart modules; they are named here, not
copied:

| Module | Used by event code |
| --- | --- |
| `middleware/auths.js` (`verifyToken`) | every assistant route |
| `models/postSchema.js` | catalogue search, Shelfie comparables |
| `models/showRoomSchema.js`, `models/cartSchema.js`, `models/messageSchema.js` | tool runners |
| `app.js` (`app.use('/api/assistant', …)`) | mount point |
| App `src/theme`, `src/state/{Navigation,AuthContext,CartContext}`, `src/ui/{kit,chat,cards}`, `src/chat/store` | assistant screen/context imports |
| Pre-existing Groq/Gemini providers + `/rank-photos` gallery route | kept as fallbacks |

## Models

All model access goes through the **Meta Model API** at
`https://api.meta.ai/v1`.

| Purpose | Model |
| --- | --- |
| Chat, tool calling, image understanding | `muse-spark-1.3` |
| Speech to text | `muse-voice-transcribe-1.0` |
| Spoken replies (voice output) | Gemini TTS (Meta and Groq are STT-only; key already configured) |
| Agentic fallback + side-by-side brain | Muse Glimmer 30B (open weights, Apache-2.0), hosted via Together AI — 30B needs 17GB+ VRAM, so on-phone inference is impossible; same tool loop as Spark |
| Background cleanup | Commercial pay-per-call matting endpoint (env-configured). NOT BRIA RMBG weights: they are CC BY-NC, unusable in a commercial marketplace. NOT raw SAM: needs prompts + GPU self-hosting with no hosted API |
| Deeper planning (configured, not on the critical path) | `muse-wonder-1.0` |
| Image generation (configured, not on the critical path) | `muse-image-1.0` |

`META_REASONING_EFFORT` accepts `minimal`/`low`/`medium`/`high`/`xhigh`/`max`;
`none` is rejected. Groq/Gemini remain as fallbacks so a seller is never
blocked by a dead key. SAM 3.1 is not integrated; Shelfie boxes come from the
vision model and are cropped server-side with ffmpeg.

## Run and verify

**Judges start here: [`JUDGES.md`](JUDGES.md)** — hosted demo URL + test
account (no keys needed), the in-repo test command, and the video/release
checklist.

Runnable from this repo with zero dependencies (no Mongo, no keys, no host
app) — this is the executable verification judges can run in seconds:

```bash
cd backend
node --test tests/assistant-tasks.test.js
```

Expect **8/8 passing**: scope-change detection, correction-preserving draft
merges, price-gate validation, confirm-gate shape, task TTL/expiry, and
prompt-block honesty. `node --check` passes on every backend file.

Also verified live during the event:

- Live Meta chat + tool calling with `muse-spark-1.3`.
- Photo understanding on a real image (`/ad-from-image` → `fill_ad`).
- Speech-to-text with `muse-voice-transcribe-1.0`, including `m4a` → WAV.
- `/status`, `/chat`, `/rank-photos`, `/ad-from-image` against the host backend
  with a test JWT (navigation, search, cart, checkout actions).
- Shelfie crop path on a real JPEG: drafts with cropped data-URI photos and
  price bands.
- `node --check` on all backend files; mobile patch files parse as valid diffs.

Not claimed: on-device run from this repo (the app is private), production
deployment/load test, a real multi-item shelf photo end to end, or Muse
Wonder/Image on the shipped path.

## Security

- No API key, `.env`, token or database URI is committed; `.env.example` files
  hold blank values only.
- The mobile build never embeds a provider key. All model calls happen
  server-side. Assistant routes keep the host's existing JWT middleware
  (`/status`, `/ping` are the only public routes and expose no secrets).

---

Built by **Christian Friday Douglas** for the **Meta Global AI Developer
Hackathon 2026** · Node · Express · React Native · Meta Model API
