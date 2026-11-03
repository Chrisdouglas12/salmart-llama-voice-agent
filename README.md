# Salmart Intelligence
### AI that understands people, not just commands.

_Meta-powered, voice-first assistant built during Meta AI Developer Hackathon 2026._

Salmart marketplace existed before. _Salmart Intelligence is the new AI layer built this week._

*The Problem*
Most apps assume you can read, type, and navigate menus. But millions can't.

I've seen it myself — even educated people asking "Please, how do I do this? How do I do that?" And even we developers struggle when an app is new to us.

What if you could just speak to the app and it understands you, and does exactly what you want or guides you through it?

That's why I built Salmart Intelligence — an agentic AI inside Salmart that helps educated and uneducated people use the app without learning the interface.

*What we built — voice + touch from any screen:*

- *Register by voice:* Guided conversation, email optional, Nigerian phone accepted
- *Shop by touch:* Say "I want to buy", AI says "touch the one you want" — touch shows photo, real price, seller. Tap never buys, you say "save it"
- *Buy & pay with guidance:* Add to cart, chat seller, tick-to-pay via Paystack — AI guides, you tap the final button
- *First-run onboarding:* Welcome spoken from server, asks for mic with voice, not a system popup

*Powered by Meta*
Meta Llama for intent + context, Meta ASR for voice (PUSH_TO_TALK), vision for Shelfie scan. AI reasoning connected to 21 real app tools — it doesn't just chat, it does.

*Why it matters*
If Meta's models can power apps that adapt to people, not the other way round — elderly users, illiterate users, anyone — Meta's ecosystem wins beyond chat.

> Don't make people learn technology. Make technology understand people.

*Verify in 30 seconds:*
cd backend
npm run test:keyless  # 128/128
npm run demo          # registration + buying + selling
See `NEW_WORK.md` (what's new this week).