// ─────────────────────────────────────────────────────────────
// Chat Boy AI — server
// A relay that can NEVER read the chat: it only ever sees room IDs
// (a hash) and AES-encrypted blobs. Messages live in RAM only and
// the room is wiped ~30s after the last person leaves.
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

// ── VAPID keys for Web Push (auto-generated once, then reused) ──
const vapidPath = path.join(DATA, 'vapid.json');
let vapid;
if (fs.existsSync(vapidPath)) {
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

// Health check (Render + UptimeRobot keep-alive pings this)
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post('/api/subscribe', (req, res) => {
  const { roomId, subId, subscription } = req.body || {};
  if (!roomId || !/^[a-f0-9]{64}$/.test(roomId) || !subId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'bad request' });
  }
  subs[roomId] = (subs[roomId] || []).filter(s => s.subId !== subId);
  subs[roomId].push({ subId, subscription });
  saveSubs();
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { roomId, subId } = req.body || {};
  if (subs[roomId]) subs[roomId] = subs[roomId].filter(s => s.subId !== subId);
  saveSubs();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`Chat Boy AI up on port ${PORT}`)
);

// ── Realtime relay. RAM only — a restart wipes every room instantly. ──
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // roomId -> { clients:Set, messages:[], wipeTimer }

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
  const payload = JSON.stringify({ title: 'Chat Boy AI', body: 'You have a new notification' });
  for (const s of list) {
    if (s.subId === exceptSubId) continue;
    try {
      await webpush.sendNotification(s.subscription, payload);
    } catch (e) {
      // Subscription dead (app uninstalled / permission revoked) — drop it.
      if (e.statusCode === 404 || e.statusCode === 410) {
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

  ws.send(JSON.stringify({ type: 'history', messages: r.messages }));
  broadcastPresence(roomId);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'msg' && typeof m.iv === 'string' && typeof m.ct === 'string' && m.ct.length <= 20000) {
      const msg = { id: crypto.randomUUID(), from: subId, iv: m.iv, ct: m.ct, ts: Date.now() };
      r.messages.push(msg);
      if (r.messages.length > 200) r.messages = r.messages.slice(-200);
      for (const c of r.clients) {
        if (c !== ws && c.readyState === 1) c.send(JSON.stringify({ type: 'msg', message: msg }));
      }
      notifyRoom(roomId, subId);
    }
  });

  ws.on('close', () => {
    r.clients.delete(ws);
    broadcastPresence(roomId);
    if (r.clients.size === 0) {
      // Everybody left (closed the app). 30s grace covers accidental
      // refreshes — then the room and its messages are gone forever.
      r.wipeTimer = setTimeout(() => rooms.delete(roomId), 30_000);
    }
  });
});
