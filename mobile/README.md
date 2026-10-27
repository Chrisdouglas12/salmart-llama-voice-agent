# Mobile — event diff extract

`salmart-mobile.event.patch` (+343/−12, base: pre-kickoff app commit `5ce993f`)
is the complete event frontend work. No pre-hackathon app code is copied into
this repo.

## What the patch adds (7 files)

| File | Event change |
| --- | --- |
| `src/state/AssistantContext.js` | `sessionId`, product-card shaping, `add_to_cart`, gallery ranking, Shelfie scan → inline cards → cache crop → Create Ad, navigation |
| `src/screens/AssistantScreen.js` | brain label from `/status`, shelf scan button, `Scan my shelf` chip, inline draft row |
| `src/api/endpoints.js` | `assistantStatus()`, `assistantShelfScan()`, `sessionId` on `/chat` |
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

Pre-existing modules referenced but not copied: `src/theme`,
`src/state/{Navigation,AuthContext,CartContext}`, `src/ui/{kit,chat,cards}`,
`src/chat/store`.
