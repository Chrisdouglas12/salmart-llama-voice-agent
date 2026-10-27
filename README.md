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
  routes/
    visionRoutes.js            NEW: POST /rank-photos, POST /ad-from-image
    voiceRoutes.js             NEW: POST /transcribe (+ client-transcript fallback)
    assistantRoutes.event.patch  EVENT DIFF to the pre-existing live route file:
                               Meta-first orchestrator, runMetaAgent, metaVision,
                               Meta transcription, /status, /ping reply fields,
                               POST /scan-shop, Shelfie wiring, provider/model
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
cp backend/routes/visionRoutes.js backend/routes/voiceRoutes.js <server>/routes/

# app repo root
git apply /path/to/extract/mobile/salmart-mobile.event.patch
```

Both patches were verified with `git apply --check --reverse` against the live
worktrees they were taken from.

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
| Deeper planning (configured, not on the critical path) | `muse-wonder-1.0` |
| Image generation (configured, not on the critical path) | `muse-image-1.0` |

`META_REASONING_EFFORT` accepts `minimal`/`low`/`medium`/`high`/`xhigh`/`max`;
`none` is rejected. Groq/Gemini remain as fallbacks so a seller is never
blocked by a dead key. SAM 3.1 is not integrated; Shelfie boxes come from the
vision model and are cropped server-side with ffmpeg.

## Verification (during the event)

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
