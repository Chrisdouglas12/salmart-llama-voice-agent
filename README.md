# Salmart Intelligence

Voice-first AI inside the Salmart marketplace. Speak, and the app does it.

Built for the Meta AI Developer Hackathon 2026. The Salmart app existed before; this repo is only the new AI layer.

## Demo (video)

The video shows two flows (limited time):

- **Registration by voice** — guided one-question steps, email optional, Nigerian phone accepted, secure password box, tick-to-agree, spoken summary, say "register me".
- **Buying by voice + touch** — say "I want to buy", the AI says "touch the one you want", tap previews photo and price, say "save it" to add to cart.

**Selling is also supported, not shown in the video:** snap a product photo and the AI auto-fills title, description, and category, then walks through price, quantity, and discount one question at a time. Same for cart, checkout guidance, and seller chat.

## Models used

| Job | Model |
|---|---|
| Chat + reasoning (brain) | `muse-spark-1.3` (fallback `muse-spark-1.2`) |
| Vision (product photos, Shelfie) | `muse-spark-1.3` |
| Speech-to-text | `muse-voice-transcribe-1.0` (push-to-talk) |
| Deep reasoning | `muse-wonder-1.0` |
| Image tasks | `muse-image-1.0` |
| Backup brain (no key needed) | Muse Glimmer 30B via Together AI |

Voice output uses the **phone's own TTS voice** — we have no access to hosted Meta MMS voices, so the server writes the words and the device speaks them.

## Try it

**App (easiest):** install from the Play Store and run the registration flow with any mock data (no real data needed):
https://play.google.com/store/apps/details?id=com.salmartTech.salmart

**Server:** live on Render — `https://salmart.onrender.com`. The demo's API calls go through Render to the Meta-hosted models above.

**Run the code on any machine:**

```bash
cd backend
cp .env.example .env   # add META_API_KEY (or leave blank for keyless mode)
npm install
npm run test:keyless   # 179/179, no keys needed
npm run demo           # registration + buying + selling walkthrough
npm start              # serves on PORT (default 3000)
```

Keyless tests and the demo run with no API keys and no database.
