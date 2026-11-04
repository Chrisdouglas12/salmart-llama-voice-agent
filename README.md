# Salmart Intelligence — Voice-first marketplace

> Don't make people learn technology. Make technology understand people.

**Impact:** 700M+ people worldwide struggle to read or type. Most apps today assumes you can read 12 form fields and type perfectly. If you can't, you're locked out of the app.

Salmart Intelligence fixes that: Register by voice. Buy by touch. Chat seller by voice. No typing. No reading required.

**Built for:** Meta AI Developer Hackathon 2026 — Track: Build for Your World
**Declaration:** The Salmart app existed before. This repo is only the new AI layer built during the hackathon.

**Demo Video (3 min):** https://youtube.com/shorts/1EfUJaZ6D40?si=BRfFtk7PVaBrQBsg
**Try it:** Play Store: https://play.google.com/store/apps/details?id=com.salmartTech.salmart
**Server:** Live on Render — `https://salmart.onrender.com`

---

## What it does

### 1. Registration by voice
Guided one-question steps. Email optional. Nigerian phone accepted. Secure password box. Tick-to-agree. Spoken summary — AI reads back "Is everything correct?" — say "register me" to create account.

### 2. Buying by voice + touch
Say "I want to buy a bag/shoe or anything", AI says "touch the one you want", you tap,ai reads price, title and description for you. you can ask ai to save it/add it to cart for, or chat the seller.

**Reliability by design:**
- AI confirms what it heard before it acts
- Tap previews, never auto-buys
- User still controls payment — AI never charges
- Works on low-end Android, low network

### 3. Selling + Chat (also supported)
Snap a product photo and AI auto-fills title, description, and category, then walks through price, quantity, and discount one question at a time. Same for cart, checkout guidance, and seller chat with auto-attached product photo.

## Proof it uses Meta AI

Live Render logs show real calls to Meta-hosted models:

- `muse-spark-1.3` — reasoning + tool calls: `registration_started`, `navigateToScreen`, `account_created`
- `muse-voice-transcribe-1.0` — speech-to-text (push-to-talk)

## Models used

| Job | Model |
|---|---|
| Chat + reasoning (brain) | `muse-spark-1.3` (fallback `muse-spark-1.2`) |
| Vision (product photos, Shelfie) | `muse-spark-1.3` |
| Speech-to-text | `muse-voice-transcribe-1.0` (push-to-talk) |
| Deep reasoning | `muse-wonder-1.0` |
| Image tasks | `muse-image-1.0` |

Voice output uses the **phone's own TTS voice** — we have no access to hosted Meta MMS voices, so the server writes the words and the device speaks them.

## Try it

**App (easiest):** install from the Play Store and run the registration flow with any mock data (no real data needed):
https://play.google.com/store/apps/details?id=com.salmartTech.salmart

**Server:** live on Render — `https://salmart.onrender.com`. The demo's API calls go through Render to the Meta-hosted models above.

**Run the code on any machine:**

```bash
cd backend
npm install
npm run test:keyless   # 179/179, no keys or database needed
npm run demo           # registration + buying + selling walkthrough, no keys needed