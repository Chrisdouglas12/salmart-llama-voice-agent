# DEMO — 3 minutes, word for word

Setup: seller test account, one active listing, 2+ items in cart. Record in one take; rehearse free with `DEMO_MODE=mock` first.

## 0:00–0:25 — The problem

Show the register screen. Say: *"For my grandmother, this screen is a locked door. She can't type reliably, passwords confuse her, and 'I can't enter my account' fires a reset she never asked for. This week I taught Salmart's assistant to talk her through it instead."*

## 0:25–1:25 — Account access without the forms

1. Mic: **"I can't enter my account."** → one clarifying question, not a reset. *(`beginAuthHelp(ACCOUNT_ACCESS)`)*
2. **"I forgot the email I used."** → Google-or-email branch, mail-app guidance, honest limits.
3. **"I want to join."** → full name first; email question names Google/Yahoo/any other; if no email, phone question names MTN/Airtel/Glo/any other; the secure password box opens itself with the keyboard, shows a suggested code you can copy and save, and a "Hear how" button explains the box; the agreement is last; server confirms, Market opens signed in, and the assistant writes the welcome question aloud.

## 1:25–2:30 — Buying without reading the interface

1. **"I want to buy a bag."** → one short question: what kind of bag?
2. **"A black leather bag."** → search with those words; the picture picker opens by itself. Say: *"Touch the one you want — you don't need to read or say its name."*
3. Touch a card → the assistant reads that item's title and description aloud and asks: *"Should I save it for you so you can buy it later, or do you want me to chat the seller for you?"* Nothing is saved yet — the tap only previews. Say **"Save it"** → the validated cart tool runs once and the "In your cart" card appears; the assistant tells you to ask it to open the cart when ready, then offers to chat the seller about availability.
4. **"Yes, chat him."** → chat opens with the draft and product photo; press send. Then open the cart: tick items (₦0 default with 2+ items) → green Pay button → Paystack opens **with the mic above it** → **"What do I do here?"** → exact steps + escrow reassurance.
5. Point out: a sold-out item keeps the picker open so the buyer can touch another one; the tap itself is a direct server call, not a model guess; saying "save it" twice never adds the item twice.

## 2:30–3:00 — The guarantees

To camera: *"Typed passwords never reach Meta. Success is claimed only from real app state. Meta models only, end to end."* End card: 127/127 keyless tests, live Meta model, repo link.

## Selling (same shoot, second take)

1. Mic: **"I want to sell my phone."** → CreateAd opens and the gallery opens by itself; closing it opens the camera.
2. Pick a photo → the assistant reads it, fills what it can, and speaks each fill — never re-asking what the photo already filled. One question at a time after that, including quantity and the bulk-discount offer.
3. When the form is finished → *"You can tap Publish/Post now — want me to read the filled details first?"* → **"Yes."** → reads from Description to the end, then asks for corrections or the tap. The seller always taps Post; there is no publish tool.
