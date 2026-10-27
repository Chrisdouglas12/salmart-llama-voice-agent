# New work — Meta Global AI Developer Hackathon 2026

Event window: **26 October – 4 November 2026** (hacking opened Oct 26 after the
kickoff). Everything in this repository was written inside that window. The
Salmart product itself predates it and is not included here.

---

## 1. Event work in this repo (with evidence)

### Whole new files — backend

All eight `lib/assistant/` modules and both new routes first appear in the
server repo at commit `4252e0663` (Oct 27, post-kickoff), except `shelfie.js`,
which was written during the event as untracked work. Copies here are
byte-identical to the live sources (verified by hash).

| File | Bytes | What it does |
| --- | --- | --- |
| `backend/lib/assistant/config.js` | 5025 | env, model ids, sticky live/fallback state, recovery probe |
| `backend/lib/assistant/llama.js` | 11114 | Meta chat, vision, Muse Voice Transcribe, ffmpeg WAV conversion |
| `backend/lib/assistant/agent.js` | 10404 | tool-calling loop, envelope, fallback orchestration |
| `backend/lib/assistant/tools.js` | 11425 | tool schemas → app actions |
| `backend/lib/assistant/form.js` | 21324 | Pidgin/English parsing → exact Create Ad values |
| `backend/lib/assistant/mockAgent.js` | 15535 | deterministic fallback brain |
| `backend/lib/assistant/mongoSearch.js` | 3233 | catalogue search over the host Post model |
| `backend/lib/assistant/shelfie.js` | 27044 | **Aya Shelfie**: vision boxes, crops, deterministic price bands |
| `backend/lib/assistant/tasks.js` | new | **Task planner**: scope-change detection, draft merge, price-gate proposal, per-user task store (dependency-free, unit-tested) |
| `backend/routes/visionRoutes.js` | 11642 | standalone vision routes, written during the event (reference — not mounted in `app.js`; the mounted equivalents are `/api/assistant/rank-photos` and `/api/assistant/ad-from-image`) |
| `backend/routes/voiceRoutes.js` | 2402 | standalone transcribe route, written during the event (reference — not mounted; the mounted equivalent is `/api/assistant/transcribe`) |
| `backend/tests/agent-tasks.test.js` | new | **Eval suite**: 8/8 passing (`node --test tests/assistant-tasks.test.js`) |
| `backend/package.json` | new | fresh manifest for the extract |
| `backend/.env.example` | new | fresh template, blank values |

### Event diffs to pre-existing files

| Patch | Base (pre-kickoff) | Change |
| --- | --- | --- |
| `backend/routes/assistantRoutes.event.patch` | server `routes/assistantRoutes.js` at `8c5bef3e2` (Oct 26, pre-kickoff) | +374/−9: Meta imports, recovery probe, Shelfie helpers, `runMetaAgent`, Meta-first `PROVIDERS` order, `metaVision`, Meta transcription, `provider`/`model` fields, `GET /status`, `POST /scan-shop`, Gemini TTS (`POST /speak`), `get_my_listings`, `update_listing_price` + confirm gate, task-state wiring, new navigable screens |
| `mobile/salmart-mobile.event.patch` | app at `5ce993f` (Oct 26, pre-kickoff) | +582/−48 across 12 files: `sessionId`, product cards, `add_to_cart`, brain label, Shelfie UI, `assistantStatus`, `assistantShelfScan`, `assistantSpeak` + server-voice playback, 5 new navigable screens, `showroomCreate`/`vtu` loader fixes, mic FAB allowlist, cart-screen mic, panel-header cart badge, keyboard-safe `Sheet`, slide transitions with underlay + stable route ids, cold-start fade, mount-on-tap panels, LAN override, one starter chip |

Both patches were verified with `git apply --check --reverse` against the live
worktrees. No other files in either source repo were touched by the event work.

**Provenance attestation:** the nine whole backend files above
(`lib/assistant/*.js`, `routes/visionRoutes.js`, `routes/voiceRoutes.js`)
were written fresh during the event window — not carried over from any
pre-kickoff experiment. Pre-existing code enters this repo only as diff
context lines inside the two event patches, never as copied files.

### Aya Shelfie (event work)

| Rule | Implementation |
| --- | --- |
| The model may see and describe, but never price | `shelfie.js` uses `muse-spark-1.3` only for items + boxes; prices come from injected `searchProducts()` |
| Prices are reproducible | quartile band over comparable listings, Naira rounding |
| Every card has a photo | ffmpeg crops per box; failed crop → full-frame thumbnail |
| Duplicates removed | title-token containment + box IoU |
| Nothing auto-published | drafts only; seller taps **Post** per card |
| No silent fake success | canned shelf only when `SHELFIE_FALLBACK=true` (default off) |

---

## 2. Pre-existing Salmart (not in this repo, not claimed)

- Marketplace feed, search, cart, checkout, auth/JWT, seller chat, Mongo models.
- The React Native app shell, navigation, theme, original assistant screen.
- The original assistant route, Gemini/Groq providers, `/rank-photos` gallery
  route (kept as fallbacks).
- Production hosting and data.

The Salmart product belongs to the same solo builder. Prompt wording and lessons
learned from the prior assistant were reused; no prior code was copied in. The
demo calls no non-Meta pipeline: speech is Muse Voice (Groq Whisper fallback),
vision is Muse Spark (Gemini/Groq fallbacks).

---

## 3. Verification status

Verified during the event: live Meta chat + tool calling (`muse-spark-1.3`),
photo understanding (`/ad-from-image` → `fill_ad`), STT
(`muse-voice-transcribe-1.0`, `m4a` → WAV), host routes with a test JWT,
Shelfie crops on a real JPEG, `node --check` on all backend files.

Not claimed: on-device run from this repo, production deployment/load test, a
real multi-item shelf photo end to end, Wonder/Image on the shipped path.

---

## 4. Why these decisions

- **Meta first, fallback second** — the primary brain is Meta; existing
  providers only keep a seller unblocked.
- **Voice is the product** — form, gallery and cart are all reachable by talking.
- **Seller stays in control** — no publish tool, no phone-number capture, no
  bulk post.
- **Extract, not fork** — only event work is submitted; the host stays private.
