# 🤖 Chat Boy AI — a secret chat hiding inside an AI chatbot

Open it and it looks (and acts) like a cute offline AI buddy. Triple-tap the 🤖
logo, enter your shared secret as the "API key", and the same screen becomes a
real end-to-end-encrypted chat with your friend. No links to share — ever.

## How you two use it

1. Agree on ONE secret phrase **in person / by voice** (e.g. `purple mango thunder 42`).
   Longer = stronger. This is both your room and your encryption key.
2. Both open the app → triple-tap the 🤖 logo → type the secret → **Connect**.
3. Compare the **Session code** once (call out `8F3K-Q2LM` to each other). Same code =
   same room, no wrong-password mix-ups.
4. Chat. Your friend's messages arrive looking like bot replies — same bubbles,
   same screen. Tap 🔒 (or just close the tab) to lock back to the decoy.
5. Notifications say only **"Chat Boy AI — You have a new notification"**.
   Tapping one opens the locked decoy screen, never the chat.

## How the secrecy works

| Requirement | Implementation |
|---|---|
| Nobody can read it, not even the server | AES-256-GCM, key = PBKDF2(secret, 210k rounds). Server only stores ciphertext + a room hash. There is no plaintext anywhere outside your two screens. |
| Deleted after you both close | Server keeps messages in RAM only. 30s after the last socket leaves (covers refreshes), messages **everyone has seen** are wiped. **Unread** messages wait for the other person (max 24h) so async texting works. A server restart wipes everything instantly. |
| No links | Room ID = `SHA-256("room:" + secret)`. Same secret ⇒ same room, automatically. |
| Discreet notifications | Push payload is a fixed generic string. No sender, no content, no metadata in the notification. |
| Looks like an AI app | Default screen is a working offline chatbot (jokes, facts, time…). The unlock gesture is invisible; the password field is disguised as an "API key". |
| Idle safety | Auto-locks after 5 min idle; the key exists in RAM only and is dropped on lock. |

## Run it

```bash
cd secret-chat
npm install
node server.js
# open http://localhost:3000 (use two browsers/tabs to test both sides)
```

## Put it on the internet (Render, free, ~5 min)

Push notifications require **HTTPS**, so the app needs a permanent home:

1. Push this folder to a GitHub repo (e.g. `chat-boy-ai`).
2. Go to **render.com** → sign in with GitHub → **New → Blueprint** →
   pick the repo → Deploy. (`render.yaml` is already in this folder.)
3. In Render → your service → **Environment**, add these two variables
   (generate your own pair with `node -e "import('web-push').then(w=>console.log(JSON.stringify(w.default.generateVAPIDKeys())))"`):
   - `VAPID_PUBLIC_KEY` = your public key
   - `VAPID_PRIVATE_KEY` = your private key
4. Render gives you a URL like `https://chat-boy-ai.onrender.com`.
   **That's the one link you share with your friend, once.** Done forever.
5. (Recommended) Stop cold-start sleeps: create a free **UptimeRobot**
   monitor (HTTP, every 5 min) pointing at
   `https://chat-boy-ai.onrender.com/api/health`. This keeps the free
   server awake so messages + notifications are instant, 24/7.

On iPhone, push needs the app **installed to Home Screen** (Share → Add to
Home Screen) on iOS 16.4+. Android works straight from the browser
(Chrome / Samsung Internet).

## Honest limitations

- A weak secret (`1234`, your names) can be brute-forced by anyone holding the
  server data. Use 4+ random words.
- The server host can see *metadata* (when a room is active, IPs) — just never
  the content.
- No protection against someone physically holding your unlocked phone, or a
  compromised browser. Lock (🔒) when done.

## Features

- 🔔 **Push that survives closes** — generic *"You have a new notification"* (no names,
  no content). Tapping it opens the locked decoy. 🔔 bell is an on/off switch;
  🔒 locking never stops notifications. A "Send test notification" button in
  Developer settings verifies it end-to-end.
- 🔄 **Refresh-safe session** — the tab remembers the secret until closed, so a
  refresh reconnects instantly. New/closed tab = locked again.
- ✏️ **Edit** — long-press it → Edit, then revise right in the chat box. No popups.
- ↩️ **Reply** — swipe any bubble left-to-right, double-click it, or long-press → Reply. Works on your own messages too.
- ⬇️ **Smart auto-scroll** — sticks to bottom while chatting; a "↓ New messages"
  pill appears when you're reading history.
- **Espresso & paper themes** — warm charcoal dark mode and warm paper light mode with an amber accent. Toggle in the header, remembered per device.
- 🔒 **Quick rejoin** — the 🔒 button stays in the header. Single-tap to lock, triple-tap it to jump straight back into the same room (the tab remembers the secret until closed).
- ✓✓ **Seen receipts** — your messages show *✓ Sent*, flipping to *Seen ✓✓* the moment your friend reads them — synced even if you were offline when they read it.
- **Clean icon set** — Lucide-style SVG icons and a self-hosted Inter font. No emoji buttons.
