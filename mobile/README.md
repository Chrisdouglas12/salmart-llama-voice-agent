# Mobile — event diff extract

`salmart-mobile.event.patch` (+943/−149, base: pre-kickoff app commit `5ce993f`)
is the complete event frontend work. No pre-hackathon app code is copied into
this repo.

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
