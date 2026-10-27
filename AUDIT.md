# Audit — Salmart universal AI agent (event work, Oct 2026)

Independent-prompt audit, produced before any Phase 1–4 code. Inspection method:
three parallel audits of the live repos (server tool system, app navigation +
screens, task API contracts) plus direct reads. Line numbers refer to the
pre-existing live files at audit time.

## 1. Current architecture

- **Server** (`routes/assistantRoutes.js`, ~1330 lines): single-turn ReAct loop,
  max 5 tool steps, Meta → Groq → Gemini failover. One shared tool schema (9
  tools) translated for all providers. Fixed envelope
  `{ message, products, actions, navigations, provider, model }`. Per-user
  `lastShown` map (30-min TTL) enables pronoun resolution. JWT everywhere
  except `/status`, `/ping`.
- **App** (`AssistantContext` + `AssistantScreen`): context orchestrates chat,
  voice in/out, cards, cart, gallery, Shelfie. The **`adPatch` bridge** carries
  sanitized draft fields into `CreateAdScreen`, which live-fills and reports a
  snapshot (`missing[]`, `hasPhoto`) per keystroke. Floating mic FAB on every
  screen is the AI-mode entry. Publishing is user-only (Post button →
  optimistic queue).

## 2. Existing capabilities (verified)

Search with budget/category/location filters; pronoun resolution; cart
add/remove/read DB-verified; seller contact behind the only confirmation gate;
10-screen navigation; ad fill + gallery + vision autofill + Shelfie; provider
failover with anti-repeat; voice in/out; brain label.

## 3. Missing capabilities (found)

- No task planner: single-turn loop, no plan object, no cross-turn task state.
- No publish/price/profile/showroom tools — but the underlying APIs exist
  (`POST /post`, `PUT /post/edit/:postId`, `PATCH /post/:id`,
  `POST /post/:id/discount`, `PUT /update-profile`, `POST /api/showrooms/*`).
- Only 10/27 screens server-routable; `search`, `editProfile`,
  `showroomCreate` take no params; `showroomCreate`/`vtu` had missing screen
  loaders (silent WebView fallback).
- One confirmation gate (seller contact); no idempotency keys on task
  endpoints; creates return no server id (optimistic queue).
- No eval suite.

## 4. Integration risks

Blind retries can double-create/double-charge (no idempotency keys); param-less
screens silently ignore params (arrival ≠ done); creates are id-less so success
must be reported as "prepared, awaiting Post"; payments stay out of agent
execution.

## 5. Proposed architecture (adopted)

Keep the ReAct loop. Add: per-user task state (`lib/assistant/tasks.js`,
dependency-free and unit-tested); tools in phases (read-only first, guarded
writes, never publish/pay); extended navigation allowlist + fixed loaders;
image selection always user-controlled via the native picker.

## 6. Implementation plan (executed)

- Phase 1: `get_my_listings` (read-only, owner-scoped, feeds `lastShown`) +
  `ads` navigation.
- Phase 2: `update_listing_price` with two-call confirm gate + DB re-read.
- Phase 3: task store, scope-change reset, 7 new navigable screens, loader
  fixes, prompt sections.
- Phase 4: `backend/tests/agent-tasks.test.js` (8/8 passing) + `DEMO.md`.

## 7. Held deviations (product rules outrank the prompt)

1. **No `publish_listing` tool, ever.** Scene 3's "confirmation" is the user
   tapping the native Post button. The form contract (`AI NEVER publishes`)
   depends on it.
2. **No payment/promotion execution.** Agent opens the promote screen and
   explains; it never calls `/initiate*`.
