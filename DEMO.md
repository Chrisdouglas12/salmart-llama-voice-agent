# Demo script — chatbot vs. universal agent (5 scenes, ~4 minutes)

Only implemented, tested behaviour. No simulated backend success: every state
change below is a verified write or a user tap. Use a seller test account with
at least one active listing (e.g. shoes).

## Scene 1 — Natural intent

Say: **"I want to sell something."**
Expect: the phone's own gallery opens (user-controlled picker — the assistant
never chooses). Pick a photo: it lands on the single-scroll Create Ad form,
vision reads it, and the description fills live and editable. Then say:

**"Two bedroom flat, 50k, Abuja, brand new."**

Price, location, condition and category fill step by step, top to bottom.
The seller reviews and taps **Post**. Nothing is published by the agent.

## Scene 2 — Live correction (no restart)

Say: **"Actually, make it 70,000, and shorten the description."**
Expect: same draft patched in place (price 70000, description rewritten);
unrelated fields untouched. Then say: **"Forget the shoes. I want to sell a
blender instead."** Expect: task resets, old draft cleared, blender flow
starts — stale ids never leak (scope reset also clears last-shown products).

## Scene 3 — Safe completion

Expect: completed preview in the real form with `missing[]` read aloud. The
agent waits. **You tap Post.** The agent never publishes; success is reported
as "prepared", never "listed", until the queue confirms.

## Scene 4 — Cross-app control (existing listings)

Say: **"Find the shoes I listed."**
Expect: `get_my_listings` → real titles/prices/postIds in-thread.
Say: **"Change their price to 70,000."**
Expect: first reply is a confirmation question with old → new price. Say
**"Yes."** Expect: `update_listing_price(confirm:true)` → *"Nike shoes:
₦75,000 → ₦70,000"*, re-read from the database.
Say: **"Now open my profile for editing."**
Expect: `navigate(editProfile)` → Edit Profile opens; avatar change stays a
manual picker tap (the agent never sets photos).

## Scene 5 — Intelligent recovery

Try: change the price of a listing that isn't yours, or one already sold.
Expect: refusal with the reason (*"That listing is not yours"* /
*"already sold"*), valid progress preserved, next step offered. Kill the
server voice mid-reply: the app falls back to phone TTS without stalling.

## What "agentic" means here

Intent → verified tools → observed state → confirmation gates → honest
reporting. Every scene above maps to a tool call with a database or UI
receipt, listed in `NEW_WORK.md`.
