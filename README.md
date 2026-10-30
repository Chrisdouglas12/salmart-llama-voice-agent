# Aya — a voice assistant for people technology leaves behind

Salmart is a Nigerian marketplace app (built before this hackathon). **Aya is new: a Meta-powered voice assistant built during this hackathon** that lets elderly and low-digital-literacy users register, sign in, recover accounts, message sellers, and pay — through conversation, not forms.

## The problem

For a struggling user, Salmart's register screen (5 fields + password rules + email link) is a locked door. "I can't enter my account" fires a password reset they never asked for. A forgotten email means a dead account. Checkout charges the whole cart with no selection. These users don't need a chatbot — they need someone who understands what they want and does it with them.

## What Aya does (all live, all tested)

- **Understands account problems** — 11 intents, 11 conversation states. "I can't enter my account" gets one clarifying question, never an instant reset.
- **Recovers forgotten emails** — Google-or-email branch, mail-app guidance, honest limits (no name lookup, no invented channels).
- **Registers by conversation** — one field at a time, local password helper, app-opening verification links.
- **Guides buying end-to-end** — finds the item, drafts the seller message, holds it in cart, tick-to-pay checkout, mic stays visible over Paystack with exact payment steps and escrow reassurance.
- **Never lies, never leaks** — passwords/OTPs typed in chat are refused before reaching Meta; success is claimed only from real app state; Meta models only, end to end.

## Verify in 60 seconds

```bash
cd backend
npm test        # keyless contract tests
npm run demo    # 7-turn scripted run through the real tool contracts
```

Live app: point at the server URL, follow `DEMO.md` (the 3-minute script). No keys in this repo — ever.

## Repo map

- `backend/` — every AI module (whole files) + patches to pre-existing server files (`.patch`). No Salmart product code copied.
- `mobile/` — one patch with the assistant UI, auth screens, cart, and mic changes.
- `NEW_WORK.md` — what was built this week, file by file, with proof.
- `DEMO.md` — the 3-minute demo script, word for word.
