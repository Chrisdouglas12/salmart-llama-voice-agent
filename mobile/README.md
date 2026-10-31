# Mobile — event diff extract

Three patches are kept here, plus full copies of the new AI client, so the code
can be read without applying anything.

| Patch | Size | Base commit | Covers |
| --- | --- | --- | --- |
| `salmart-mobile.event.patch` | +943 / −149 | `5ce993f` | original event frontend work (18 files) |
| `salmart-mobile.ai-voice.patch` | +2451 / −464 | `e3076a1` | inline voice, screen navigation, voice-assisted registration, Google handoff, long-press AI screen, same-language voice, post-sign-in resume, LAN dev API discovery (28 files) |
| `salmart-mobile.registration.patch` | +625 / −424 | on top of `salmart-mobile.ai-voice.patch` | voice-first sign-up: optional email, phone fallback, secure password modal, agreement card, automatic sign-in, spoken welcome, standard device voice (7 files) |

`mobile/src/**` holds the **current, complete** frontend AI code under its real
app path, so a reviewer can read it without applying anything:

- `src/ai/**` — the complete AI Mode client (10 files), created in the
  `NewAIFeatures` commit `41e2387`, extended in `c37217c`, and hardened in the
  Day 1 P0 pass (inline Google handoff, long-press screen open, spoken
  registration steps).

Unchanged or pre-existing app code is not copied into this repo; where our work
edits such a file, the change is in the patch.

### Pointing the app at a laptop (LAN dev)

No LAN IP is baked in. `config.js` asks `src/config/devHost.js` to turn the
Metro host (`Constants.expoConfig.hostUri`) into an API origin — only for
private IPv4 or loopback, so tunnels and release builds keep the normal
`https://<API_DOMAIN>`. With the backend running on the same PC:

```bash
# backend repo
npm run dev:local        # prints http://<lan-ip>:3000, opens the firewall path
# app repo
npx expo start --lan     # scan the QR on the phone (same Wi-Fi)
```

`EXPO_PUBLIC_API_URL` still wins when set; `EXPO_PUBLIC_API_PORT` changes the
backend port. Verified here: config parses under Babel (127/127 files) and the
pure resolver passes 10/10 host cases (private IPv4, loopback→`10.0.2.2` on
Android, tunnel rejected, empty rejected).

### The AI client (`src/ai/`)

| File | Role |
| --- | --- |
| `AIContext.js` | conversation lifecycle, anonymous → signed-in rebind, inline voice (`toggleRecording`), text `send()`, runs the `navigate` block, client screen allowlist, Google handoff (`startGoogleAuth` with native → browser fallback), spoken notices, speaker-language (`lang` from transcription → turn context + spoken reply), one spoken resume turn after a rebind that follows a real conversation |
| `AIModeButton.js` | global mic: live status, spoken reply, Confirm/Cancel, Google card, auto-dismiss; tap records inline and never opens the AI screen, long-press opens it with the current screen as context |
| `AIModeScreen.js` | the AI conversation screen (messages, composer, suggestions); sends `{ screen, platform }` context, handles the Google block and "hear this" speech |
| `api.js` | HTTP client for `/api/ai/*` on top of `src/api/client.js` |
| `speak.js` | spoken replies through the device's standard text-to-speech voice. No locale, voice or pitch is selected, so the phone uses the voice its owner already chose in system settings |
| `UseAIPatch.js` | form-patch consumer; reads `fill_ad` / `fill_request` / `fill_profile` / `fill_register` / `register_focus` and drains queued patches |
| `registrationSnapshot.js` | **new**: sends field-completion booleans plus the active step to the next AI turn; the password is never part of the snapshot |
| `components/StructuredBlock.js` | renders the typed `structured[]` blocks (products, listings, orders, onboarding, message preview, `auth_url`, `fill_register`) |
| `components/ConfirmationCard.js` | Confirm/Cancel UI for consequential actions |
| `components/MessageBubble.js` | chat bubble; passes the auth/speak handlers to structured blocks |
| `components/ProductCardMini.js` | compact product card used inside chat |

Wiring that lives in the app repo and is **not** copied here (it is mostly
pre-existing code edited by the same work): `App.js` (`AIProvider` and
`<AIModeButton />` mount), `src/api/client.js`, the form screens
(`CreateAdScreen`, `CreateRequestScreen`, `EditProfileScreen`), and
`src/state/{Navigation.js,routes.js,AssistantContext.js}`. The app commit
`41e2387` shows those edits; the backend half is in `backend/`.

## AI voice mode, screen navigation and registration

Source: AI client from app repo `41e2387` (`NewAIFeatures`), then the
voice/navigation/registration work from `c37217c`, then the Day 1 P0 pass, then
the Meta-voice pass — the ten files below. Backend counterpart is documented in
[`../backend/AI_AGENT.md`](../backend/AI_AGENT.md).

| File | Change |
| --- | --- |
| `src/ai/AIContext.js` | `send()` returns `{ ok, reply, structured, confirmation, navigatedTo }`; single `toggleRecording(context)` path transcribes → sends → speaks; executes the `navigate` block on every turn (voice and text); client-side screen allowlist that excludes `ai`/`assistant` and id-based routes; `startGoogleAuth` prefers the native picker and falls back to the backend `auth_url` in a system browser; `notice()` and `speak()` for spoken status; `authBusy` prevents double taps; voice turns carry the speaker's `lang` from transcription into the turn context and the spoken reply; registration snapshots ride along with the turn and `suppressNextResume()` replaces the generic post-sign-in resume with the registration welcome |
| `src/ai/AIModeButton.js` | global mic is inline: listening status, spoken reply, Confirm/Cancel, Google button, auto-dismiss after 10 s; tap never pushes the AI screen; **hold 450 ms** opens `ai` with `{ screen: currentName }` and swallows the following tap so the long press cannot also record |
| `src/ai/AIModeScreen.js` | sends `{ screen, platform }` on every text/voice turn; routes `auth_url` to the Google handler and `onSpeak` to the "hear this" lines |
| `src/ai/UseAIPatch.js` | accepts `register` as a form target, maps `fill_register`, and focuses the step named by a `register_focus` block |
| `src/ai/registrationSnapshot.js` | **new**: whitelists the registration snapshot to booleans plus `activeField`/`stage`; password keys are stripped before anything leaves the screen |
| `src/ai/speak.js` | **rewritten**: device-standard TTS only (`Speech.speak(line, { rate: 1.0 })`), no custom locale or voice selection |
| `src/api/endpoints.js` | `register()` returns the JWT and user fields, so a successful sign-up signs the user in without a second login |
| `src/ai/components/StructuredBlock.js` | **new renderers** for `auth_url` (tappable "Continue with Google", never auto-opens) and `fill_register` (explains the remaining manual steps, can be read aloud) |
| `src/ai/components/MessageBubble.js` | passes `onOpenAuth` / `onSpeak` through to structured blocks |
| `src/screens/RegisterScreen.js` | voice-first form: optional email, phone fallback, one secure password modal with the keyboard focused, agreement card last, automatic submit and sign-in, Market reset, exact spoken welcome |
| `src/state/AuthContext.js` | applies the session returned by `/register` immediately; the verification path remains only for older unverified accounts |

`RegisterScreen.js`, `src/state/AuthContext.js` and `src/api/endpoints.js` are
pre-existing screens/modules, so they are **not** copied into this repo in full.
Their voice-first registration changes are visible only as the `+` side of
`salmart-mobile.registration.patch`, the same way the event patch carries edits
to pre-existing files.

What a non-reading user gets: tap the global mic and speak. The assistant can
open the right screen ("take me to my messages", "help me create an account"),
speak its answer, and run the action without leaving the current screen. On the
register screen it asks for name and email-or-phone by voice, opens the secure
password box itself when that step comes, then the agreement card. Ticking the
box is the user's own action; when it is ticked and everything is complete the
assistant says "I am creating your account now.", the server creates the
account, and the app opens Market signed in and speaks the welcome question.
For sign-in it shows one "Continue with Google" button; tapping it opens the
account picker (or the system browser on a build without the native module), and
the user never types a Google password into the assistant.

Auth and voice when signed out: the global mic still records and speaks. A
missing token is allowed on `/api/assistant/transcribe` and `/api/assistant/speak`
with per-IP rate limits; an expired token still returns `401` and the app tells
the user to sign in again.

Same-language voice: `/transcribe` returns the speaker's `lang`
(eng/yor/hau/ibo); the app sends it with the turn (the model replies in that
language) and with `/speak` (the Meta MMS voice matches). No Gemini key is
used anywhere — set `HF_API_KEY` on the server for voice output.

Deliberate limits (product limits, not bugs):

- A password is never spoken to the assistant, never included in a turn, a
  snapshot, history or text-to-speech. It is typed once into the secure modal
  and sent only to `POST /register`, where it is hashed and never logged.
- The agreement tick, the final Create account tap and (for older accounts) the
  verification link stay with the user.
- Phone numbers are treated as unverified for the hackathon. No OTP is sent and
  no verification gate is inserted after a new registration.

Apply the voice patch, then the registration patch, from the app repo root:

```bash
git apply /path/to/extract/mobile/salmart-mobile.ai-voice.patch
git apply /path/to/extract/mobile/salmart-mobile.registration.patch
```

`salmart-mobile.registration.patch` is generated against the app tree **after**
the voice patch, so the two apply in order. The files under `mobile/src/` are
the same content as the app repo, byte for byte. `git apply --check -R` against
the app repo confirms each patch is the exact reverse of the present changes.

Verification: the app repo parses every changed file under Babel (JSX/JS), and
the backend contract tests pass (41/41 in the four auth/form/task/navigation
files). Not run on a device or simulator yet, so the mic, secure modal, keyboard
focus, automatic sign-in and spoken welcome still need a dev-build pass.

## Original event work

`salmart-mobile.event.patch` (+943/−149, base: pre-kickoff app commit `5ce993f`)
is the complete event frontend work.

## What the patch adds (18 files)

| File | Event change |
| --- | --- |
| `src/state/AssistantContext.js` | `sessionId`, product-card shaping, `add_to_cart`, gallery ranking, server-voice replies (`/speak` + expo-speech fallback), Shelfie scan → inline cards → cache crop → Create Ad, system-gallery sell flow, mic FAB allowlist, profile/request patch channels, search-page preference, all-screen navigation |
| `src/state/Navigation.js` | stable route ids (no remounts mid-transition), iOS-style parallax + dim underlay, `showroomCreate`/`vtu` loader fixes |
| `src/ui/TabBar.js` | bar can never be squeezed into the system nav area |
| `src/screens/CreateAdScreen.js` | single-scroll form (Next step removed), cover-photo pipeline, top-bar mic, top-to-bottom step fill |
| `App.js` | cold-start fade (no hard cut), theme-driven system background, mount-on-tap panels |
| `src/ui/kit.js` | `Sheet` lifts above the keyboard by measured overlap (all bottom sheets with inputs) |
| `src/ui/Shell.js` | cart shortcut with live count badge in every panel header |
| `src/screens/CartScreen.js` | assistant mic button in the cart header (the FAB does not render here) |
| `src/screens/AssistantScreen.js` | brain label from `/status`, shelf scan button, `Scan my shelf` chip, inline draft row |
| `src/screens/SearchScreen.js` | loads voice queries + price/category filters from route params |
| `src/screens/EditProfileScreen.js` | voice fill for name/bio/state/city (validated; photo/phone/bank/password stay manual, Save stays manual) |
| `src/screens/CreateRequestScreen.js` | voice fill for category/text/budget/location (photo stays manual, posting stays manual) |
| `src/screens/ShowroomCreateScreen.js` | opens on the voiced tab (new photos / existing listing / text) |
| `src/api/endpoints.js` | `assistantStatus()`, `assistantShelfScan()`, `assistantSpeak()`, `assistantPhotoClean()`, `sessionId` on `/chat` |
| `src/api/client.js` | full-origin `EXPO_PUBLIC_API_URL` override, no production failover for it |
| `src/assistant/dialog.js` | one `Scan my shelf` starter chip |
| `config.js` | exposes `EXPO_PUBLIC_API_URL` (`API_URL` build-time fallback) |
| `.env.example` | documents the LAN override |

Apply from the app repo root:

```bash
git apply /path/to/extract/mobile/salmart-mobile.event.patch
npx expo start -c
```

## Device testing

```dotenv
# app .env
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000
```

Use the laptop's LAN IP, not `localhost`; restart Metro after changing it
(Expo inlines `EXPO_PUBLIC_*` at build time). Unset, the app uses its existing
production hosts unchanged.

Pre-existing modules referenced but not copied in full: `src/theme`,
`src/state/{AuthContext,CartContext}`, `src/ui/{chat,cards}`,
`src/chat/store`. (`src/state/Navigation.js`, `src/ui/kit.js`,
`src/ui/Shell.js` are pre-existing files carrying event patches above.)
