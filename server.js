// ─────────────────────────────────────────────────────────────
// Chat Boy AI — server
// A relay that can NEVER read the chat: it only ever sees room IDs
// (a hash) and AES-encrypted blobs. Messages live in RAM only; seen
// messages are wiped ~30s after everyone leaves, unread ones expire
// after 24h, and a restart wipes everything instantly.
// ─────────────────────────────────────────────────────────────
import express from 'express';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ── VAPID keys for Web Push.
// On hosts with ephemeral disks (Render free), keys MUST come from env vars —
// otherwise every restart generates new keys and kills existing subscriptions.
// Locally / on a VPS, they're auto-generated once and stored in data/vapid.json.
const vapidPath = path.join(DATA, 'vapid.json');
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  console.log('Using VAPID keys from environment');
} else if (fs.existsSync(vapidPath)) {
  vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapid));
  console.log('Generated new VAPID keys');
}
webpush.setVapidDetails('mailto:hello@chatboy.local', vapid.publicKey, vapid.privateKey);

// ── Push subscriptions (persisted so notifications survive restarts).
// Shape: { roomId: [ { subId, subscription } ] } — no names, no content. ──
const subsPath = path.join(DATA, 'subs.json');
let subs = {};
try { subs = JSON.parse(fs.readFileSync(subsPath, 'utf8')); } catch { /* first run */ }
const saveSubs = () => fs.writeFileSync(subsPath, JSON.stringify(subs));

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vapid-public-key', (req, res) => res.json({ key: vapid.publicKey }));

// Health check (Render + cron-job.org keep-alive pings this)
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post('/api/subscribe', (req, res) => {
  const { roomId, subId, subscription } = req.body || {};
  if (!roomId || !/^[a-f0-9]{64}$/.test(roomId) || !subId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'bad request' });
  }
  subs[roomId] = (subs[roomId] || []).filter(s => s.subId !== subId);
  subs[roomId].push({ subId, subscription });
  saveSubs();
  console.log(`[push] subscribed ${subId.slice(0, 6)}… to room ${roomId.slice(0, 8)}… (${subs[roomId].length} device(s))`);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { roomId, subId } = req.body || {};
  if (subs[roomId]) subs[roomId] = subs[roomId].filter(s => s.subId !== subId);
  saveSubs();
  res.json({ ok: true });
});

// Sends a real push to EVERY subscription in the room (including the sender)
// so users can verify notifications work. Generic text only, like all pushes.
app.post('/api/test-push', async (req, res) => {
  const { roomId } = req.body || {};
  if (!roomId || !/^[a-f0-9]{64}$/.test(roomId)) return res.status(400).json({ error: 'bad request' });
  await notifyRoom(roomId, '__nobody__');
  res.json({ ok: true, targets: (subs[roomId] || []).length });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`Chat Boy AI up on port ${PORT}`)
);

// ── Realtime relay. RAM only — a restart wipes every room instantly. ──
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // roomId -> { clients:Set, messages:[], wipeTimer }

// Unread messages must survive so async texting works ("hey" sent while the
// other person is away). They expire after 24h regardless — ephemerality kept.
const MAX_AGE = 24 * 60 * 60 * 1000;
function sweep(r) {
  const now = Date.now();
  r.messages = r.messages.filter(m => now - m.ts < MAX_AGE);
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { clients: new Set(), messages: [], wipeTimer: null });
  return rooms.get(id);
}

function broadcastPresence(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  const payload = JSON.stringify({ type: 'presence', online: r.clients.size });
  for (const c of r.clients) if (c.readyState === 1) c.send(payload);
}

// Deliberately generic: no sender, no content — just "something happened".
async function notifyRoom(roomId, exceptSubId) {
  const list = subs[roomId] || [];
  if (!list.length) { console.log(`[push] room ${roomId.slice(0, 8)}… has no subscriptions, skipped`); return; }
  const payload = JSON.stringify({ title: 'Chat Boy AI', body: 'You have a new notification' });
  for (const s of list) {
    if (s.subId === exceptSubId) continue;
    try {
      await webpush.sendNotification(s.subscription, payload);
      console.log(`[push] sent to ${s.subId.slice(0, 6)}… in room ${roomId.slice(0, 8)}…`);
    } catch (e) {
      console.warn(`[push] FAILED to ${s.subId.slice(0, 6)}… status=${e.statusCode} ${e.body || e.message || ''}`);
      // 403 = keys rotated or revoked, 404/410 = subscription dead. All three
      // mean "will never work again" — drop it; the client re-subscribes
      // automatically on every unlock.
      if ([403, 404, 410].includes(e.statusCode)) {
        subs[roomId] = subs[roomId].filter(x => x.subId !== s.subId);
        saveSubs();
      }
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://local');
  const roomId = url.searchParams.get('room');
  const subId = url.searchParams.get('sub') || '';
  if (!roomId || !/^[a-f0-9]{64}$/.test(roomId)) return ws.close();

  const r = getRoom(roomId);
  if (r.wipeTimer) { clearTimeout(r.wipeTimer); r.wipeTimer = null; } // someone's back — cancel wipe
  r.clients.add(ws);
  sweep(r);

  // `seen` = someone OTHER than you confirmed this message (your read receipt).
  ws.send(JSON.stringify({ type: 'history', messages: r.messages.map(m => ({
    id: m.id, from: m.from, iv: m.iv, ct: m.ct, ts: m.ts, kind: m.kind || 'text',
    edited: !!m.edited, seen: m.seenBy.some(s => s !== subId),
  })) }));
  broadcastPresence(roomId);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    // Typing indicator: relayed live, never stored (carries no content).
    if (m.type === 'typing') {
      for (const c of r.clients) {
        if (c !== ws && c.readyState === 1) c.send(JSON.stringify({ type: 'typing', from: subId, on: m.on === true }));
      }
      return;
    }
    // Read receipt: client confirms it rendered these messages.
    // The sender(s) get told live so their ✓ can flip to Seen.
    if (m.type === 'seen' && Array.isArray(m.ids)) {
      const confirmed = [];
      for (const msg of r.messages) {
        if (!m.ids.includes(msg.id)) continue;
        if (!msg.seenBy.includes(subId)) msg.seenBy.push(subId);
        confirmed.push(msg.id);
      }
      if (confirmed.length) {
        const payload = JSON.stringify({ type: 'seen', by: subId, ids: confirmed });
        for (const c of r.clients) {
          if (c !== ws && c.readyState === 1) c.send(payload);
        }
      }
      return;
    }
    // Edit: only the original sender may edit (basic from-match guard).
    if (m.type === 'edit' && typeof m.id === 'string' && typeof m.iv === 'string' && typeof m.ct === 'string' && m.ct.length <= 20000) {
      const msg = r.messages.find(x => x.id === m.id);
      if (msg && msg.from === subId && !msg.kind) {
        msg.iv = m.iv; msg.ct = m.ct; msg.edited = true;
        for (const c of r.clients) {
          if (c !== ws && c.readyState === 1) c.send(JSON.stringify({ type: 'edit', message: msg }));
        }
      }
      return;
    }
    if (m.type === 'msg' && typeof m.iv === 'string' && typeof m.ct === 'string') {
      const kind = (m.kind === 'img' || m.kind === 'audio') ? m.kind : null;
      if (m.ct.length > (kind ? 2800000 : 20000)) return;
      // Client-generated id (lets the sender render + edit instantly).
      const id = (typeof m.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(m.id)) ? m.id : crypto.randomUUID();
      const msg = { id, from: subId, iv: m.iv, ct: m.ct, ts: Date.now(), seenBy: [], ...(kind ? { kind } : {}) };
      r.messages.push(msg);
      if (r.messages.length > 200) r.messages = r.messages.slice(-200);
      for (const c of r.clients) {
        if (c !== ws && c.readyState === 1) c.send(JSON.stringify({ type: 'msg', message: msg }));
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'acked', clientId: m.id, id }));
      notifyRoom(roomId, subId);
    }
  });

  ws.on('close', () => {
    r.clients.delete(ws);
    broadcastPresence(roomId);
    if (r.clients.size === 0) {
      // Everybody left (closed the app). 30s grace covers accidental
      // refreshes — then messages everyone has SEEN are gone forever.
      // Unread messages stay, waiting for the other person (max 24h).
      r.wipeTimer = setTimeout(() => {
        sweep(r);
        r.messages = r.messages.filter(msg => !msg.seenBy.some(s => s !== msg.from));
        if (r.messages.length === 0) rooms.delete(roomId);
      }, 30_000);
    }
  });
});
