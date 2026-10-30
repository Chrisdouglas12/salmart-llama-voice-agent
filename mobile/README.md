# Mobile — event diff extract

Two patches are kept here, plus full copies of the new AI client, so the code
can be read without applying anything.

| Patch | Size | Base commit | Covers |
| --- | --- | --- | --- |
| `salmart-mobile.event.patch` | +943 / −149 | `5ce993f` | original event frontend work (18 files) |
| `salmart-mobile.ai-voice.patch` | +1135 / −79 | `41e2387` | inline voice, screen navigation, voice-assisted registration, Google handoff, long-press AI screen, same-language voice, post-sign-in resume, LAN dev API discovery (11 files) |

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
| `speak.js` | server TTS (`/api/assistant/speak` → Meta MMS voices) with `expo-speech` fallback; `speakReply(text, lang)` carries the speaker's language both ways. With no hosted Meta voice endpoint today (`TTS_MODE=device`), the server answers `TTS_UNAVAILABLE` instantly and the phone's own voice speaks |
| `UseAIPatch.js` | form-patch consumer; reads `fill_ad` / `fill_request` / `fill_profile` / `fill_register` and drains queued patches |
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
| `src/ai/AIContext.js` | `send()` returns `{ ok, reply, structured, confirmation, navigatedTo }`; single `toggleRecording(context)` path transcribes → sends → speaks; executes the `navigate` block on every turn (voice and text); client-side screen allowlist that excludes `ai`/`assistant` and id-based routes; `startGoogleAuth` prefers the native picker and falls back to the backend `auth_url` in a system browser; `notice()` and `speak()` for spoken status; `authBusy` prevents double taps; voice turns carry the speaker's `lang` from transcription into the turn context and the spoken reply |
| `src/ai/AIModeButton.js` | global mic is inline: listening status, spoken reply, Confirm/Cancel, Google button, auto-dismiss after 10 s; tap never pushes the AI screen; **hold 450 ms** opens `ai` with `{ screen: currentName }` and swallows the following tap so the long press cannot also record |
| `src/ai/AIModeScreen.js` | sends `{ screen, platform }` on every text/voice turn; routes `auth_url` to the Google handler and `onSpeak` to the "hear this" lines |
| `src/ai/UseAIPatch.js` | accepts `register` as a form target and maps the `fill_register` block |
| `src/ai/speak.js` | **new**: server TTS via `/api/assistant/speak` (Meta MMS voices), falling back to `expo-speech` (with BCP-47 language mapping); works while signed out |
| `src/api/endpoints.js` | `assistantSpeak` accepts `{ text, lang }` and forwards the speaker's language |
| `src/ai/components/StructuredBlock.js` | **new renderers** for `auth_url` (tappable "Continue with Google", never auto-opens) and `fill_register` (explains the remaining manual steps, can be read aloud) |
| `src/ai/components/MessageBubble.js` | passes `onOpenAuth` / `onSpeak` through to structured blocks |
| `src/screens/RegisterScreen.js` | applies the assistant's name/email/referral pre-fill, shows what was filled with a "read the steps aloud" button, adds a device-only "Make a password for me" generator that fills both password fields and spells the password with the phone voice |

`RegisterScreen.js` is a pre-existing screen (added in `ee91a27`, before the
hackathon), so it is **not** copied into this repo in full. Its assistant
additions are visible only as the `+` side of `salmart-mobile.ai-voice.patch`,
the same way the event patch carries edits to pre-existing files.

What a non-reading user gets: tap the global mic and speak. The assistant can
open the right screen ("take me to my messages", "help me create an account"),
speak its answer, and run the action without leaving the current screen. On the
register screen it fills name, email and referral code, then reads the remaining
steps out loud. For sign-in it shows one "Continue with Google" button; tapping
it opens the account picker (or the system browser on a build without the native
module), and the user never types a Google password into the assistant.

Auth and voice when signed out: the global mic still records and speaks. A
missing token is allowed on `/api/assistant/transcribe` and `/api/assistant/speak`
with per-IP rate limits; an expired token still returns `401` and the app tells
the user to sign in again.

Same-language voice: `/transcribe` returns the speaker's `lang`
(eng/yor/hau/ibo); the app sends it with the turn (the model replies in that
language) and with `/speak` (the Meta MMS voice matches). No Gemini key is
used anywhere — set `HF_API_KEY` on the server for voice output.

Deliberate limits (product limits, not bugs):

- A password is never spoken to the assistant, never sent to the server, and
  never stored by it. The generator runs on the phone only.
- The terms checkbox, the Create account tap, and the email verification link
  stay with the user. `POST /register` requires a password and returns no
  token, and there is no phone/OTP or passwordless signup yet, so registration
  cannot be completed fully hands-free without a helper.

Apply the newer patch from the app repo root:

```bash
git apply /path/to/extract/mobile/salmart-mobile.ai-voice.patch
```

It is generated against app commit `41e2387`, so apply it to a tree at (or from)
that base; the current app repo already contains the work in its working tree.
The files under `mobile/src/` are the same content as the app repo, byte for
byte. `git apply --check -R` against the current tree confirms the patch is the
exact reverse of the present changes.

Verification: `node scripts/check-syntax.js` in the app repo parses 127/127
files. Not run on a device or simulator yet, so the mic, long press, Google
handoff, and registration flow still need a dev-build test.

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
