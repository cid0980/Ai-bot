// ─────────────────────────────────────────────────────────────
// Chat Boy AI — client
// Locked   → harmless offline AI chatbot (the decoy).
// Unlocked → real E2E-encrypted chat with your friend, same screen.
// Unlock   → triple-tap the 🤖 logo, enter your shared secret as the
//            "API key". Both sides use the SAME secret, no links needed.
// Session  → survives refresh (sessionStorage), dies with the tab.
// ─────────────────────────────────────────────────────────────
'use strict';

const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('input'), form = $('composer');
const statusText = $('statusText'), statusDot = document.querySelector('#status .dot');
const lockBtn = $('lockBtn'), chips = $('chips');

// ── State (the key lives in RAM only — never localStorage) ──
const S = {
  unlocked: false,
  key: null,        // CryptoKey (AES-GCM), derived from the secret
  roomId: null,     // sha256('room:' + secret) — the server only sees this
  ws: null,
  mySubId: localStorage.getItem('cb_sub') || (() => {
    const v = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('cb_sub', v);
    return v;
  })(),
  idleTimer: null,
  pushOn: localStorage.getItem('cb_push') !== 'off', // notification preference
  msgIndex: new Map(), // id -> { text, mine, replyTo, seen, acked, ts }
  replyTo: null,       // { id, t, mine } quoted in the composer
  stick: true,         // auto-scroll pinned to bottom?
  unread: 0,           // new messages arrived while scrolled up
  online: 1,
  editingId: null,     // message id currently being revised in the composer
  lastDayStart: null,  // day-divider tracker
  blobUrls: new Set(),   // decrypted media URLs (revoked on clear)
  currentAudio: null,
  remoteTyping: null,  // friend's typing bubble element
  remoteTypingTimer: null,
};

// ── UI helpers ──
function scrollDown() { chat.scrollTop = chat.scrollHeight; }
function bubble(text, who = 'bot', stick = true) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  chat.appendChild(d);
  if (stick) scrollDown();
  return d;
}
function sys(text) { bubble(text, 'sys'); }
let toastT;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function showTyping(stick = true) {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  chat.appendChild(d);
  if (stick) scrollDown();
  return d;
}
function hideRemoteTyping() {
  clearTimeout(S.remoteTypingTimer);
  if (S.remoteTyping) { try { S.remoteTyping.remove(); } catch {} S.remoteTyping = null; }
}
function sendSeen(ids) {
  if (!S.unlocked || !S.ws || S.ws.readyState !== 1 || !ids.length) return;
  try { S.ws.send(JSON.stringify({ type: 'seen', ids })); } catch {}
}
function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((b - a) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  try { return d.toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch { return ''; }
}
function maybeDayDivider(ts) {
  if (!ts) return;
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (start === S.lastDayStart) return;
  S.lastDayStart = start;
  const el = document.createElement('div');
  el.className = 'dayDiv';
  el.textContent = dayLabel(ts);
  chat.appendChild(el);
}
function tickText(rec) {
  const s = rec.seen ? 'Seen \u2713\u2713' : rec.acked ? '\u2713\u2713 Delivered' : '\u2713 Sent';
  return rec.ts ? fmtTime(rec.ts) + ' \u00b7 ' + s : s;
}
function paintStatus(row, rec) {
  const el = row.querySelector('.seenMark');
  if (el) { el.textContent = tickText(rec); el.classList.toggle('isSeen', !!rec.seen); }
}
function setBadge(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge();
  } catch {}
}
let AC = null;
function pop() {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.09);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g); g.connect(AC.destination);
    o.start(t); o.stop(t + 0.14);
  } catch {}
}
function buzz() { try { navigator.vibrate && navigator.vibrate(30); } catch {} }
function stopAudio() { try { S.currentAudio && S.currentAudio.pause(); } catch {} S.currentAudio = null; }
function clearBlobs() { try { S.blobUrls.forEach(u => URL.revokeObjectURL(u)); } catch {} S.blobUrls.clear(); }
function paintJump() {
  const j = $('jumpBtn');
  j.classList.toggle('hidden', S.stick || !S.unread);
  if (S.unread) j.innerHTML = ICON.chev + '<span>' + S.unread + ' new message' + (S.unread > 1 ? 's' : '') + '</span>';
  setBadge(S.unread);
}
chat.addEventListener('scroll', () => {
  S.stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
  if (S.stick) S.unread = 0;
  paintJump();
}, { passive: true });
$('jumpBtn').onclick = () => { S.stick = true; S.unread = 0; paintJump(); scrollDown(); };

// ── Decoy bot brain (offline, keyword-based) ──
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs! 🐛',
  'I told my computer I needed a break… now it won\'t stop sending me KitKat ads. 🍫',
  'Why did the phone go to therapy? It had too many hang-ups! 📱',
  'There are only 10 kinds of people: those who understand binary and those who don\'t. 😄',
];
const FACTS = [
  'Honey never spoils. Archaeologists found 3,000-year-old honey in Egyptian tombs — still edible! 🍯',
  'Octopuses have three hearts and blue blood. 🐙',
  'A day on Venus is longer than its year. It just really hates Mondays. 🪐',
  'Your phone has more computing power than NASA had in 1969. 🚀',
];
const FALLBACKS = [
  'Interesting! Tell me more about that. 🤔',
  'Hmm, let me think… I\'d say go with your gut on this one. ✨',
  'Good question! Here\'s my take: break it into small steps and start with the easiest one. 💪',
  'I\'m still learning, but I\'m pretty sure you\'ve got this! 🙌',
  'Noted! Anything else I can help with? 😊',
];
const pick = a => a[Math.floor(Math.random() * a.length)];

function botReply(q) {
  const t = q.toLowerCase();
  if (/(joke|funny|laugh)/.test(t)) return pick(JOKES);
  if (/(fact|did you know)/.test(t)) return pick(FACTS);
  if (/(who are you|your name|about you)/.test(t)) return 'I\'m Chat Boy, your pocket AI buddy! 🤖 Ask me anything — jokes, facts, advice, you name it.';
  if (/(what can you do|help|features)/.test(t)) return 'I can chat, crack jokes 😂, share fun facts 🧠, and keep you company. Try the suggestions below! (Tip: tap the bell icon, top right, so you never miss my replies.)';
  if (/\btime\b/.test(t)) return 'It\'s ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' right now. ⏰';
  if (/\b(date|day|today)\b/.test(t)) return 'Today is ' + new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) + '. 📅';
  if (/(thank|thanks|thx)/.test(t)) return 'Anytime! That\'s what I\'m here for. 😊';
  if (/(hi|hello|hey|yo)\b/.test(t) && t.length < 20) return pick(['Hey there! 👋 What\'s up?', 'Hello! 😊 How can I help today?', 'Hey hey! Ask me anything. ✨']);
  if (/(bye|good ?night|see you)/.test(t)) return 'See you soon! I\'ll be right here. 👋';
  if (/(love|like) you/.test(t)) return 'Aww! I like you too — as a friend. 🤖❤️';
  return pick(FALLBACKS);
}

function decoyWelcome() {
  stopAudio(); clearBlobs();
  chat.innerHTML = '';
  bubble('Welcome to Chat Boy AI! I\'m your pocket buddy — ask me anything, anytime.');
}

function decoyAnswer(q) {
  const tp = showTyping();
  setTimeout(() => { tp.textContent = botReply(q); scrollDown(); }, 700 + Math.random() * 900);
}

// ── Crypto (WebCrypto: PBKDF2 → AES-GCM-256) ──
const enc = new TextEncoder(), dec = new TextDecoder();
const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function deriveAll(secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('chatboy.ai/v1'), iterations: 210000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  const roomId = hex(await crypto.subtle.digest('SHA-256', enc.encode('room:' + secret)));
  const fpRaw = hex(await crypto.subtle.digest('SHA-256', enc.encode('fp:' + secret)));
  // Session code from the key fingerprint — both sides compare it once.
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += ABC[parseInt(fpRaw.slice(i * 2, i * 2 + 2), 16) % ABC.length];
  return { key, roomId, code: code.slice(0, 4) + '-' + code.slice(4) };
}

async function encryptPayload(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, enc.encode(JSON.stringify(obj)));
  return { iv: b64e(iv), ct: b64e(ct) };
}

async function decryptPayload(ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) }, S.key, b64d(ctB64));
  return JSON.parse(dec.decode(pt)); // { t, replyTo? }
}

// ── Real chat (unlocked mode) ──
function setStatus() {
  if (!S.unlocked) { statusText.textContent = 'Always here to help'; statusDot.className = 'dot'; return; }
  statusText.textContent = 'Pro replies active';
  statusDot.className = 'dot' + (S.online === 2 ? '' : ' away');
}

// Structured chat bubble: optional quote, text, edited marker. Tracked by id.
function chatBubble(id, who, text, replyTo, edited, meta) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.dataset.id = id;
  appendQuote(d, replyTo);
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = text;
  d.appendChild(span);
  if (edited) {
    const e = document.createElement('span');
    e.className = 'editedMark';
    e.textContent = '(edited)';
    d.appendChild(e);
  }
  if (who === 'me') {
    const el = document.createElement('span');
    el.className = 'seenMark' + (meta.seen ? ' isSeen' : '');
    d.appendChild(el);
    paintStatus(d, meta);
  } else if (who === 'bot' && meta.ts) {
    const el = document.createElement('span');
    el.className = 'timeMark';
    el.textContent = fmtTime(meta.ts);
    d.appendChild(el);
  }
  chat.appendChild(d);
  return d;
}

async function renderMessage(m, who) {
  try {
    const p = await decryptPayload(m.iv, m.ct);
    maybeDayDivider(m.ts);
    if (p.kind === 'img' || p.kind === 'audio') {
      const rec = { text: p.kind === 'img' ? 'Photo' : 'Voice note', kind: p.kind, mime: p.mime,
        dur: p.dur || 0, mine: who === 'me', replyTo: p.replyTo || null, seen: !!m.seen, acked: true, ts: m.ts, url: null };
      try {
        const bytes = b64d(p.data);
        rec.url = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'application/octet-stream' }));
        S.blobUrls.add(rec.url);
      } catch { /* undecryptable media — bubble shows a placeholder */ }
      S.msgIndex.set(m.id, rec);
      chatBubbleMedia(m.id, who, rec);
      return;
    }
    const rec = { text: p.t, mine: who === 'me', replyTo: p.replyTo || null, seen: !!m.seen, acked: true, ts: m.ts };
    S.msgIndex.set(m.id, rec);
    chatBubble(m.id, who, p.t, p.replyTo || null, !!m.edited, rec);
  } catch {
    bubble('🔒 Couldn\'t decrypt — wrong secret?', 'sys', false);
  }
}

// Incoming edit from the friend: swap text in place.
async function applyEdit(m) {
  const rec = S.msgIndex.get(m.id);
  if (!rec) return;
  try {
    const p = await decryptPayload(m.iv, m.ct);
    rec.text = p.t;
    const sel = `.msg[data-id="${CSS.escape(m.id)}"]`;
    const el = chat.querySelector(sel + ' .txt');
    if (el) el.textContent = p.t;
    const wrap = chat.querySelector(sel);
    if (wrap && !wrap.querySelector('.editedMark')) {
      const e = document.createElement('span');
      e.className = 'editedMark';
      e.textContent = '(edited)';
      wrap.appendChild(e);
    }
  } catch { /* undecryptable edit — ignore */ }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${S.roomId}&sub=${S.mySubId}`);
  S.ws = ws;
  S.online = 1;
  statusText.textContent = 'Connecting…';
  statusDot.className = 'dot retry';
  ws.onopen = () => { if (S.unlocked) setStatus(); };
  ws.onmessage = async ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'presence') { S.online = m.online; setStatus(); }
    if (m.type === 'typing' && m.from !== S.mySubId) {
      clearTimeout(S.remoteTypingTimer);
      if (m.on) {
        if (!S.remoteTyping || !S.remoteTyping.isConnected) S.remoteTyping = showTyping(S.stick);
        S.remoteTypingTimer = setTimeout(hideRemoteTyping, 5000); // safety if 'off' is lost
      } else hideRemoteTyping();
    }
    if (m.type === 'history' && Array.isArray(m.messages)) {
      chat.innerHTML = '';
      hideRemoteTyping();
      stopAudio(); clearBlobs();
      S.msgIndex.clear();
      S.lastDayStart = null;
      S.unread = 0; S.stick = true; paintJump();
      for (const msg of m.messages) await renderMessage(msg, msg.from === S.mySubId ? 'me' : 'bot');
      if (!m.messages.length) sys('Connected. Say hi — seen messages vanish after everyone leaves.');
      scrollDown();
      sendSeen(m.messages.map(x => x.id)); // read receipt → server may wipe these later
    }
    if (m.type === 'msg' && m.message) {
      if (m.message.from === S.mySubId) return; // our own echo from another tab
      await renderMessage(m.message, 'bot');
      pop(); buzz();
      if (S.stick) scrollDown();
      else { S.unread++; paintJump(); }
      sendSeen([m.message.id]);
    }
    if (m.type === 'edit' && m.message) applyEdit(m.message);
    if (m.type === 'seen' && m.by !== S.mySubId && Array.isArray(m.ids)) {
      for (const id of m.ids) {
        const rec = S.msgIndex.get(id);
        if (!rec || !rec.mine || rec.seen) continue;
        rec.seen = true; rec.acked = true;
        const row = chat.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
        if (row) paintStatus(row, rec);
      }
    }
    if (m.type === 'acked' && typeof m.clientId === 'string') {
      const rec = S.msgIndex.get(m.clientId);
      if (!rec || !rec.mine || rec.acked) return;
      rec.acked = true;
      const row = chat.querySelector(`.msg[data-id="${CSS.escape(m.clientId)}"]`);
      if (typeof m.id === 'string' && m.id !== m.clientId) {
        // Server normalized our id — remap so future receipts still match.
        S.msgIndex.delete(m.clientId);
        S.msgIndex.set(m.id, rec);
        if (row) row.dataset.id = m.id;
      }
      if (row) paintStatus(row, rec);
    }
  };
  ws.onclose = () => {
    if (!S.unlocked) return;
    statusText.textContent = 'Reconnecting…';
    statusDot.className = 'dot retry';
    setTimeout(() => S.unlocked && connect(), 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function pokeIdle() {
  clearTimeout(S.idleTimer);
  if (!S.unlocked) return;
  S.idleTimer = setTimeout(() => { lock('Session ended (idle too long).'); }, 5 * 60 * 1000);
}
['pointerdown', 'keydown'].forEach(e => addEventListener(e, pokeIdle, { passive: true }));

// Shake to panic-lock (Android needs no permission for this).
let lastShake = 0, shakeCount = 0;
addEventListener('devicemotion', e => {
  if (!S.unlocked) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  if (Math.abs(a.x) + Math.abs(a.y) + Math.abs(a.z) > 42) {
    const now = Date.now();
    shakeCount = (now - lastShake < 900) ? shakeCount + 1 : 1;
    lastShake = now;
    if (shakeCount >= 2) { shakeCount = 0; lock('Locked'); }
  }
});

async function unlock(secret) {
  const { key, roomId, code } = await deriveAll(secret);
  try { sessionStorage.setItem('cb_secret', secret); } catch {} // refresh-safe, dies with tab
  S.key = key; S.roomId = roomId; S.unlocked = true;
  $('sessCode').textContent = code;
  $('sessInfo').classList.remove('hidden');
  $('sheetWrap').classList.add('hidden');
  chips.classList.add('hidden');
  $('attachBtn').classList.remove('hidden');
  input.placeholder = 'Message…';
  chat.innerHTML = '';
  sys('Pro connected ✓  Code: ' + code + ' — swipe a message to reply, long-press for more');
  setStatus(); connect(); pokeIdle();
  await ensurePush(); // needs roomId, so it happens here
  renderAlerts();
  toast('Pro replies enabled');
}

function lock(msg) {
  S.unlocked = false; S.key = null; S.roomId = null;
  // NOTE: the secret STAYS in sessionStorage (tab memory, dies with the tab)
  // so triple-tapping 🔒 can quick-rejoin. True logout = close the tab.
  S.msgIndex.clear();
  S.lastDayStart = null;
  cancelReply();
  cancelEdit();
  hideRemoteTyping();
  S.unread = 0; S.stick = true; paintJump();
  try { S.ws && S.ws.close(); } catch {}
  S.ws = null;
  clearTimeout(S.idleTimer);
  chips.classList.remove('hidden');
  $('attachBtn').classList.add('hidden');
  input.placeholder = 'Ask Chat Boy anything…';
  setStatus(); decoyWelcome();
  if (msg) toast(msg);
}

// ── Push notifications (generic text only — never who, never what) ──
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

async function ensurePush() {
  try {
    if (!S.pushOn) return; // user switched notifications off in-app
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      // Asked in decoy language — "AI reply" notifications.
      toast('Enable notifications to get my replies');
      if (await Notification.requestPermission() !== 'granted') return;
    }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/vapid-public-key')).json();
    let sub = await reg.pushManager.getSubscription();
    let knownKey = null;
    try { knownKey = localStorage.getItem('cb_vapid'); } catch {}
    if (sub && knownKey !== key) {
      // Server keys changed since we subscribed (e.g. env vars added later),
      // or first run after this fix — the old subscription is poison, remake it.
      try { await sub.unsubscribe(); } catch {}
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    }
    try { localStorage.setItem('cb_vapid', key); } catch {}
    await fetch('/api/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: S.roomId, subId: S.mySubId, subscription: sub }),
    });
  } catch (e) { console.warn('push setup failed', e); }
}

// ── Unlock gesture: triple-tap the 🤖 logo ──
let taps = [];
$('logo').addEventListener('click', () => {
  const now = Date.now();
  taps = taps.filter(t => now - t < 1000);
  taps.push(now);
  if (taps.length >= 3) {
    taps = [];
    $('sheetWrap').classList.remove('hidden');
    if (!S.unlocked) { $('apiKey').value = ''; $('sessInfo').classList.add('hidden'); }
    setTimeout(() => $('apiKey').focus(), 100);
  }
});
$('closeSheet').onclick = () => $('sheetWrap').classList.add('hidden');
$('sheetWrap').addEventListener('click', e => { if (e.target.id === 'sheetWrap') $('sheetWrap').classList.add('hidden'); });
$('connectBtn').onclick = async () => {
  const v = $('apiKey').value.trim();
  if (!v) return toast('Enter your API key');
  $('connectBtn').textContent = 'Connecting…';
  try { await unlock(v); }
  catch (e) { console.error(e); toast('Could not connect'); }
  $('connectBtn').textContent = 'Connect';
  $('apiKey').value = ''; // don't leave the secret in the DOM
};
$('testPushBtn').onclick = async () => {
  if (!S.unlocked) return;
  try {
    const r = await fetch('/api/test-push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: S.roomId }),
    });
    const j = await r.json();
    toast(j.ok ? `Test sent to ${j.targets} device(s) — check notifications` : 'Test failed');
  } catch { toast('Test failed'); }
};

// 🔒 single-tap while unlocked = lock. Triple-tap while locked = quick rejoin.
let lockTaps = [];
lockBtn.onclick = () => {
  if (S.unlocked) { lock('Locked — triple-tap the lock icon to jump back in'); return; }
  const now = Date.now();
  lockTaps = lockTaps.filter(t => now - t < 1000);
  lockTaps.push(now);
  if (lockTaps.length === 1) toast('Locked');
  if (lockTaps.length < 3) return;
  lockTaps = [];
  let secret = null;
  try { secret = sessionStorage.getItem('cb_secret'); } catch {}
  if (secret) unlock(secret).then(() => toast('Welcome back')).catch(() => toast('Could not rejoin'));
  else { $('sheetWrap').classList.remove('hidden'); setTimeout(() => $('apiKey').focus(), 100); } // fresh tab → normal unlock
};
// Note: locking does NOT unsubscribe — notifications keep working while hidden.
// Only the 🔔 toggle below (or browser settings) stops them.

function paintBell() {
  const granted = ('Notification' in window) && Notification.permission === 'granted';
  $('bellBtn').innerHTML = (S.pushOn && granted) ? ICON.bell : ICON.bellOff;
  // Red bell = you want notifications but they CAN'T work. Tap it to fix.
  $('bellBtn').classList.toggle('warn', S.pushOn && !granted && ('Notification' in window));
}

$('bellBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('Notifications not supported here');
  if (Notification.permission === 'denied') {
    // The browser will never re-prompt — the user must flip it in site settings.
    toast('Blocked: address-bar lock icon → Site settings → Notifications → Allow');
    renderAlerts();
    return;
  }
  if (Notification.permission === 'default') {
    if (await Notification.requestPermission() === 'granted') {
      S.pushOn = true; localStorage.setItem('cb_push', 'on'); paintBell(); renderAlerts();
      toast('Reply notifications are on');
      if (S.unlocked) ensurePush();
    } else renderAlerts();
    return;
  }
  // Permission granted → bell is a real on/off switch.
  S.pushOn = !S.pushOn;
  localStorage.setItem('cb_push', S.pushOn ? 'on' : 'off');
  paintBell();
  renderAlerts();
  if (S.pushOn) {
    if (S.unlocked) await ensurePush();
    toast('Reply notifications are on');
  } else {
    try {
      if (S.unlocked) {
        await fetch('/api/unsubscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId: S.roomId, subId: S.mySubId }),
        });
      }
    } catch {}
    toast('Reply notifications are off');
  }
};

// ── Reply (swipe a bubble / double-click) ──
function setReply(id) {
  const rec = S.msgIndex.get(id);
  if (!rec || !S.unlocked) return;
  if (S.editingId) cancelEdit();
  S.replyTo = { id, t: rec.text, mine: rec.mine };
  $('replyText').textContent = `${rec.mine ? 'You' : 'Friend'}: ${rec.text}`;
  $('replyBar').classList.remove('hidden');
  input.focus();
}
function cancelReply() {
  S.replyTo = null;
  $('replyBar').classList.add('hidden');
}
$('replyCancel').onclick = cancelReply;
function jumpTo(id) {
  if (!id) return;
  const el = chat.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return toast('Original message is gone');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation if re-tapped
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

// ── Message action sheet (long-press / right-click menu, Instagram-style) ──
let sheetId = null;
function openMsgSheet(id) {
  const rec = S.msgIndex.get(id);
  if (!rec || !S.unlocked) return;
  sheetId = id;
  $('msgSheetPreview').textContent = (rec.mine ? 'You: ' : 'Friend: ') + rec.text.slice(0, 80);
  $('msgEdit').style.display = (rec.mine && !rec.kind) ? '' : 'none'; // edit: own text only
  $('msgCopy').style.display = rec.kind ? 'none' : '';
  $('msgSheetWrap').classList.remove('hidden');
}
function closeMsgSheet() { $('msgSheetWrap').classList.add('hidden'); sheetId = null; }
$('msgReply').onclick = () => { const id = sheetId; closeMsgSheet(); if (id) setReply(id); };
$('msgEdit').onclick = () => { const id = sheetId; closeMsgSheet(); if (id) startEdit(id); };
$('msgCopy').onclick = async () => {
  const rec = S.msgIndex.get(sheetId);
  closeMsgSheet();
  if (!rec) return;
  try { await navigator.clipboard.writeText(rec.text); toast('Copied'); }
  catch { toast('Copy failed'); }
};
$('msgSheetClose').onclick = closeMsgSheet;
$('msgSheetWrap').addEventListener('click', e => { if (e.target.id === 'msgSheetWrap') closeMsgSheet(); });

// Swipe a bubble sideways (EITHER direction) to reply — the bubble follows
// your finger, Instagram-style. Long-press any bubble for Reply / Edit / Copy.
let gX = 0, gY = 0, gEl = null, gLong = null, gLongFired = false, gDX = 0;
function swipeReset() {
  if (!gEl) return;
  gEl.style.transition = 'transform .15s';
  gEl.style.transform = '';
  const el = gEl;
  setTimeout(() => { el.style.transition = ''; }, 160);
  $('swipeHint').style.opacity = '0';
  $('swipeHint').style.transform = '';
}
chat.addEventListener('touchstart', e => {
  if (!S.unlocked) return;
  const b = e.target.closest('.msg[data-id]');
  if (!b) return;
  const t = e.touches[0];
  gX = t.clientX; gY = t.clientY; gEl = b; gLongFired = false; gDX = 0;
  clearTimeout(gLong);
  gLong = setTimeout(() => {
    gLongFired = true;
    if (navigator.vibrate) navigator.vibrate(25);
    openMsgSheet(b.dataset.id);
  }, 550);
}, { passive: true });
chat.addEventListener('touchmove', e => {
  if (!gEl) return;
  const t = e.touches[0];
  const dx = t.clientX - gX, dy = t.clientY - gY;
  if (Math.abs(dx) + Math.abs(dy) > 12) clearTimeout(gLong); // moved → not a long-press
  if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { gDX = 0; swipeReset(); return; } // scrolling
  gDX = Math.max(-90, Math.min(90, dx)); // either direction, clamped
  const pull = gDX;
  gEl.style.transform = 'translateX(' + pull + 'px)';
  // Arrow sits in the revealed gap (mirrored when dragging left).
  const r = gEl.getBoundingClientRect(), a = $('app').getBoundingClientRect();
  const hint = $('swipeHint');
  if (pull >= 0) hint.style.left = Math.max(4, (r.left - a.left) - pull + 8) + 'px';
  else hint.style.left = ((r.right - a.left) + 8) + 'px';
  hint.style.top = (r.top - a.top + 6) + 'px';
  hint.style.transform = pull < 0 ? 'scaleX(-1)' : '';
  hint.style.opacity = Math.min(1, Math.abs(pull) / 60);
}, { passive: true });
function swipeEnd(e) {
  clearTimeout(gLong);
  if (!gEl) return;
  const id = gEl.dataset.id, dx = gDX, fired = gLongFired, y0 = gY;
  swipeReset();
  gEl = null; gDX = 0;
  if (!S.unlocked || fired) return;
  if (e && e.changedTouches && Math.abs(e.changedTouches[0].clientY - y0) >= 50) return; // was a scroll
  if (Math.abs(dx) >= 70 && id) setReply(id);
}
chat.addEventListener('touchend', swipeEnd, { passive: true });
chat.addEventListener('touchcancel', () => swipeEnd(null), { passive: true });
// Desktop: double-click = reply (any bubble, yours included), right-click = menu.
chat.addEventListener('dblclick', e => {
  const b = e.target.closest('.msg[data-id]');
  if (!b || !S.unlocked) return;
  setReply(b.dataset.id);
});
chat.addEventListener('contextmenu', e => {
  const b = e.target.closest('.msg[data-id]');
  if (!b || !S.unlocked) return;
  if (sheetId === b.dataset.id) return; // sheet already open (mobile long-press double-fire)
  e.preventDefault();
  openMsgSheet(b.dataset.id);
});

// ── Inline edit (Instagram-style: revise right in the composer, no popups) ──
function startEdit(id) {
  const rec = S.msgIndex.get(id);
  if (!rec || !rec.mine || rec.kind || !S.unlocked) return;
  cancelReply();
  S.editingId = id;
  $('editText').textContent = rec.text.length > 80 ? rec.text.slice(0, 80) + '…' : rec.text;
  $('editBar').classList.remove('hidden');
  input.value = rec.text;
  $('send').innerHTML = ICON.check;
  input.focus();
}
async function commitEdit(id, text) {
  const rec = S.msgIndex.get(id);
  if (!rec || text === rec.text) return; // unchanged → nothing to send
  const payload = { t: text };
  if (rec.replyTo) payload.replyTo = rec.replyTo;
  const { iv, ct } = await encryptPayload(payload);
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'edit', id, iv, ct }));
  rec.text = text; // optimistic update
  const wrap = chat.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (wrap) {
    const t = wrap.querySelector('.txt');
    if (t) t.textContent = text;
    if (!wrap.querySelector('.editedMark')) {
      const e = document.createElement('span');
      e.className = 'editedMark';
      e.textContent = '(edited)';
      wrap.appendChild(e);
    }
  }
}
function cancelEdit() {
  S.editingId = null;
  $('editBar').classList.add('hidden');
  input.value = '';
  $('send').innerHTML = ICON.send;
}
$('editCancel').onclick = cancelEdit;

// ── Typing indicator (sender side) ──
let typingTimer = null, typingSent = false;
function sendTyping(on) {
  if (!S.unlocked || !S.ws || S.ws.readyState !== 1) return;
  if (on === typingSent) return;
  typingSent = on;
  try { S.ws.send(JSON.stringify({ type: 'typing', on })); } catch {}
}
input.addEventListener('input', () => {
  if (!S.unlocked) return;
  sendTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(false), 2500);
});

// ── Photos + voice notes (E2E-encrypted blobs, same wipe rules as text) ──
function appendQuote(d, replyTo) {
  if (!replyTo || !replyTo.t) return;
  const q = document.createElement('div');
  q.className = 'quote tappable';
  q.title = 'Jump to original';
  q.onclick = () => jumpTo(replyTo.id);
  const b = document.createElement('b');
  b.textContent = replyTo.mine ? 'You' : 'Friend';
  const s = document.createElement('span');
  s.textContent = replyTo.t.length > 120 ? replyTo.t.slice(0, 120) + '…' : replyTo.t;
  q.appendChild(b); q.appendChild(s); d.appendChild(q);
}
function b64eBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function chatBubbleMedia(id, who, rec) {
  const d = document.createElement('div');
  d.className = 'msg ' + who + ' media';
  d.dataset.id = id;
  appendQuote(d, rec.replyTo);
  if (rec.kind === 'img') {
    if (rec.url) {
      const im = document.createElement('img');
      im.className = 'mediaImg';
      im.src = rec.url;
      im.alt = 'Photo';
      im.onclick = () => openPhoto(rec.url);
      d.appendChild(im);
    } else {
      const s = document.createElement('span');
      s.className = 'txt';
      s.textContent = 'Photo unavailable';
      d.appendChild(s);
    }
  } else {
    d.appendChild(buildPlayer(rec));
  }
  if (who === 'me') {
    const el = document.createElement('span');
    el.className = 'seenMark' + (rec.seen ? ' isSeen' : '');
    d.appendChild(el);
    paintStatus(d, rec);
  } else if (rec.ts) {
    const el = document.createElement('span');
    el.className = 'timeMark';
    el.textContent = fmtTime(rec.ts);
    d.appendChild(el);
  }
  chat.appendChild(d);
}
function buildPlayer(rec) {
  const wrap = document.createElement('div');
  wrap.className = 'aud';
  const btn = document.createElement('button');
  btn.className = 'audPlay';
  btn.setAttribute('aria-label', 'Play voice note');
  btn.innerHTML = ICON.play;
  const bar = document.createElement('div');
  bar.className = 'audBar';
  const fill = document.createElement('div');
  fill.className = 'audFill';
  bar.appendChild(fill);
  const time = document.createElement('span');
  time.className = 'audTime';
  time.textContent = fmtDur(0) + ' / ' + fmtDur(rec.dur);
  wrap.appendChild(btn); wrap.appendChild(bar); wrap.appendChild(time);
  let audio = null;
  btn.onclick = () => {
    if (!rec.url) return;
    if (!audio) {
      audio = new Audio(rec.url);
      audio.onpause = () => { btn.innerHTML = ICON.play; };
      audio.onended = () => {
        btn.innerHTML = ICON.play;
        fill.style.width = '0%';
        time.textContent = fmtDur(0) + ' / ' + fmtDur(rec.dur);
        if (S.currentAudio === audio) S.currentAudio = null;
      };
      audio.ontimeupdate = () => {
        const du = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (rec.dur || 1);
        const ct = isFinite(audio.currentTime) ? audio.currentTime : 0;
        fill.style.width = Math.min(100, (ct / du) * 100) + '%';
        time.textContent = fmtDur(ct) + ' / ' + fmtDur(du);
      };
      audio.onerror = () => { btn.innerHTML = ICON.play; if (S.currentAudio === audio) S.currentAudio = null; toast('Cannot play this voice note'); };
    }
    if (audio.paused) {
      if (S.currentAudio && S.currentAudio !== audio) S.currentAudio.pause();
      S.currentAudio = audio;
      btn.innerHTML = ICON.pause;
      audio.play().catch(() => { btn.innerHTML = ICON.play; if (S.currentAudio === audio) S.currentAudio = null; toast('Playback failed — try again'); });
    } else {
      audio.pause();
    }
  };
  return wrap;
}
async function jpegDims(file) {
  const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { w: (buf[i + 7] << 8) | buf[i + 8], h: (buf[i + 5] << 8) | buf[i + 6] };
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
async function pngDims(file) {
  const buf = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return null;
  return { w: (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19],
           h: (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23] };
}
async function fileToJpeg(file, maxDim = 1280, q = 0.82) {
  // Fast path: read dimensions from headers, decode pre-downscaled.
  // A 48MP camera photo (~190MB as a bitmap) would OOM a mobile tab otherwise.
  try {
    let dims = null;
    if (file.type === 'image/png') dims = await pngDims(file);
    else if (file.type === 'image/jpeg' || file.type === 'image/jpg') dims = await jpegDims(file);
    if (dims && dims.w > 0 && dims.h > 0 && window.createImageBitmap) {
      const sc = Math.min(1, maxDim / Math.max(dims.w, dims.h));
      const w = Math.max(1, Math.round(dims.w * sc)), h = Math.max(1, Math.round(dims.h * sc));
      const bmp = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', imageOrientation: 'from-image' });
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const out = await new Promise(res => cv.toBlob(res, 'image/jpeg', q));
      if (out) return out;
    }
  } catch { /* fall through to legacy path */ }
  // Legacy path (small images, webp, gifs, anything the fast path rejects).
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      const sc = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * sc); h = Math.round(h * sc);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    img.src = url;
  });
}
async function sendMedia(kind, blob, meta = {}) {
  if (!S.unlocked) return;
  if (!S.ws || S.ws.readyState !== 1) return toast('Reconnecting… try again in a sec');
  if (blob.size > 2000000) return toast('File too large (2 MB max)');
  try {
    const buf = await blob.arrayBuffer();
    const payload = { kind, mime: blob.type || meta.mime || 'application/octet-stream', data: b64eBytes(new Uint8Array(buf)) };
    if (meta.dur) payload.dur = meta.dur;
    if (S.replyTo) payload.replyTo = { id: S.replyTo.id, t: S.replyTo.t, mine: S.replyTo.mine };
    const { iv, ct } = await encryptPayload(payload);
    if (ct.length > 2800000) return toast('File too large after encryption');
    const id = (crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    S.ws.send(JSON.stringify({ type: 'msg', id, iv, ct, kind }));
    const url = URL.createObjectURL(blob);
    S.blobUrls.add(url);
    const rec = { text: kind === 'img' ? 'Photo' : 'Voice note', kind, mine: true,
      replyTo: payload.replyTo || null, seen: false, acked: false, ts: Date.now(), url, dur: meta.dur || 0 };
    S.msgIndex.set(id, rec);
    maybeDayDivider(rec.ts);
    chatBubbleMedia(id, 'me', rec);
    cancelReply();
    clearTimeout(typingTimer); sendTyping(false);
    pokeIdle();
    S.stick = true; S.unread = 0; paintJump(); scrollDown();
  } catch (e) { console.warn('media send failed', e); toast('Send failed'); }
}
async function sendPhotoFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Not an image');
  try {
    await sendMedia('img', await fileToJpeg(file));
  } catch { toast('Could not read that photo'); }
}
// ── attach sheet ──
function openAttach() { if (S.unlocked) $('attachSheetWrap').classList.remove('hidden'); }
function closeAttach() { $('attachSheetWrap').classList.add('hidden'); }
$('attachBtn').onclick = openAttach;
$('attachClose').onclick = closeAttach;
$('attachSheetWrap').addEventListener('click', e => { if (e.target.id === 'attachSheetWrap') closeAttach(); });
$('attachGallery').onclick = () => { closeAttach(); $('filePick').click(); };
$('attachCamera').onclick = () => { closeAttach(); $('camPick').click(); };
$('attachVoice').onclick = () => { closeAttach(); startVoice(); };
$('filePick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) sendPhotoFile(f); };
$('camPick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) sendPhotoFile(f); };
// ── voice recorder ──
let MR = null, MRchunks = [], MRtimer = null, MRstart = 0, MRstream = null, MRmime = '', MRdiscard = false;
let MRAC = null, MRlevelTimer = null;
async function startVoice() {
  if (!S.unlocked || MR) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Microphone blocked'); }
  MRstream = stream;
  const mtrk = stream.getAudioTracks()[0];
  if (!mtrk || mtrk.readyState !== 'live') { stream.getTracks().forEach(t => t.stop()); MRstream = null; return toast('No live microphone found'); }
  if (mtrk.muted) { stream.getTracks().forEach(t => t.stop()); MRstream = null; return toast('Mic is muted — another app may be using it'); }
  MRmime = (window.MediaRecorder && ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))) || '';
  try { MR = MRmime ? new MediaRecorder(stream, { mimeType: MRmime }) : new MediaRecorder(stream); }
  catch { stream.getTracks().forEach(t => t.stop()); MRstream = null; return toast('Recording not supported'); }
  if (!MRmime) MRmime = MR.mimeType || 'audio/webm';
  MRchunks = []; MRdiscard = false;
  MR.ondataavailable = e => { if (e.data && e.data.size) MRchunks.push(e.data); };
  MR.onstop = onVoiceStop;
  form.classList.add('hidden');
  $('recBar').classList.remove('hidden');
  MRstart = Date.now();
  $('recTime').textContent = '0:00';
  MRtimer = setInterval(() => {
    const s = Math.floor((Date.now() - MRstart) / 1000);
    $('recTime').textContent = fmtDur(s);
    if (s >= 120 && MR) { try { MR.stop(); } catch {} }
  }, 500);
  MR.start(1000);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    MRAC = new Ctx();
    const msrc = MRAC.createMediaStreamSource(stream);
    const anz = MRAC.createAnalyser(); anz.fftSize = 512;
    msrc.connect(anz);
    const arr = new Uint8Array(anz.frequencyBinCount);
    const dot = document.querySelector('#recBar .recDot');
    MRlevelTimer = setInterval(() => {
      try {
        anz.getByteTimeDomainData(arr);
        let sum = 0;
        for (let i = 0; i < arr.length; i++) { const v = (arr[i] - 128) / 128; sum += v * v; }
        const lvl = Math.min(1, Math.sqrt(sum / arr.length) * 3);
        if (dot) dot.style.boxShadow = '0 0 0 ' + Math.round(lvl * 12) + 'px rgba(229,72,77,.45)';
      } catch {}
    }, 120);
  } catch {}
}
function endVoice(discard) {
  MRdiscard = discard;
  clearInterval(MRtimer);
  try { MR && MR.state !== 'inactive' && MR.stop(); } catch {}
  if (!MR) { form.classList.remove('hidden'); $('recBar').classList.add('hidden'); }
}
async function onVoiceStop() {
  form.classList.remove('hidden');
  $('recBar').classList.add('hidden');
  if (MRstream) { MRstream.getTracks().forEach(t => t.stop()); MRstream = null; }
  try { clearInterval(MRlevelTimer); } catch {} MRlevelTimer = null;
  try { MRAC && MRAC.close(); } catch {} MRAC = null;
  try { const dot = document.querySelector('#recBar .recDot'); if (dot) dot.style.boxShadow = ''; } catch {}
  const chunks = MRchunks, mime = MRmime, discard = MRdiscard, dur = Math.round((Date.now() - MRstart) / 1000);
  MR = null; MRchunks = [];
  if (discard || !chunks.length) return;
  const blob = new Blob(chunks, { type: mime });
  if (blob.size < 500) return toast('Recording failed — mic gave no data');
  await sendMedia('audio', blob, { dur, mime });
}
$('recCancel').onclick = () => endVoice(true);
$('recStop').onclick = () => endVoice(false);
// ── fullscreen photo viewer ──
// ── fullscreen photo viewer (pinch-zoom + pan + double-tap) ──
let PZ = { scale: 1, x: 0, y: 0 }, pzT = null, pzLastTap = 0;
function applyPZ(instant) {
  const im = $('photoImg');
  im.style.transition = instant ? 'none' : 'transform .18s ease';
  im.style.transform = 'translate(' + PZ.x + 'px,' + PZ.y + 'px) scale(' + PZ.scale + ')';
}
function openPhoto(url) {
  PZ = { scale: 1, x: 0, y: 0 }; pzT = null;
  applyPZ(true);
  $('photoImg').src = url;
  $('photoSave').href = url;
  $('photoView').classList.remove('hidden');
}
function closePhoto() {
  $('photoView').classList.add('hidden');
  $('photoImg').src = '';
  PZ = { scale: 1, x: 0, y: 0 }; pzT = null;
}
$('photoX').onclick = closePhoto;
$('photoView').addEventListener('click', e => { if (e.target.id === 'photoView') closePhoto(); });
$('photoImg').addEventListener('click', () => {
  const now = Date.now();
  if (now - pzLastTap < 300) {
    if (PZ.scale > 1) PZ = { scale: 1, x: 0, y: 0 };
    else PZ = { scale: 2.5, x: 0, y: 0 };
    applyPZ(false);
    pzLastTap = 0;
  } else pzLastTap = now;
});
$('photoImg').addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    pzT = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, s0: PZ.scale,
      x0: PZ.x, y0: PZ.y, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
  } else if (e.touches.length === 1 && PZ.scale > 1) {
    pzT = { pan: true, sx: e.touches[0].clientX - PZ.x, sy: e.touches[0].clientY - PZ.y };
  }
}, { passive: false });
$('photoImg').addEventListener('touchmove', e => {
  if (!pzT) return;
  if (e.touches.length === 2 && !pzT.pan) {
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    PZ.scale = Math.min(4, Math.max(1, pzT.s0 * d / pzT.d0));
    PZ.x = pzT.x0 + ((a.clientX + b.clientX) / 2 - pzT.cx);
    PZ.y = pzT.y0 + ((a.clientY + b.clientY) / 2 - pzT.cy);
    if (PZ.scale <= 1) { PZ.scale = 1; PZ.x = 0; PZ.y = 0; }
    applyPZ(true);
  } else if (e.touches.length === 1 && pzT.pan) {
    e.preventDefault();
    const lim = 260 * PZ.scale;
    PZ.x = Math.max(-lim, Math.min(lim, e.touches[0].clientX - pzT.sx));
    PZ.y = Math.max(-lim, Math.min(lim, e.touches[0].clientY - pzT.sy));
    applyPZ(true);
  }
}, { passive: false });
$('photoImg').addEventListener('touchend', e => { if (e.touches.length === 0) pzT = null; });

// ── Composer ──
form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  pokeIdle();
  if (S.editingId) {
    const id = S.editingId;
    cancelEdit();
    clearTimeout(typingTimer); sendTyping(false);
    try { await commitEdit(id, text); toast('Edited'); }
    catch { startEdit(id); input.value = text; toast('Edit failed'); }
    return;
  }
  if (!S.unlocked) { bubble(text, 'me'); decoyAnswer(text); return; }
  // Real (encrypted) send — client-generated id so we can render + edit instantly.
  try {
    const payload = { t: text };
    if (S.replyTo) payload.replyTo = { id: S.replyTo.id, t: S.replyTo.t, mine: S.replyTo.mine };
    const { iv, ct } = await encryptPayload(payload);
    if (S.ws && S.ws.readyState === 1) {
      const id = (crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2));
      S.ws.send(JSON.stringify({ type: 'msg', id, iv, ct }));
      const rec = { text, mine: true, replyTo: payload.replyTo || null, seen: false, acked: false, ts: Date.now() };
      S.msgIndex.set(id, rec);
      maybeDayDivider(rec.ts);
      chatBubble(id, 'me', text, payload.replyTo || null, false, rec);
      cancelReply();
      clearTimeout(typingTimer); sendTyping(false);
      S.stick = true; S.unread = 0; paintJump(); scrollDown();
    } else { input.value = text; toast('Reconnecting… try again in a sec'); }
  } catch { input.value = text; toast('Send failed'); }
});

chips.addEventListener('click', e => {
  const q = e.target?.dataset?.q;
  if (!q || S.unlocked) return;
  bubble(q, 'me'); decoyAnswer(q);
});

// ── Inline SVG icon set (Lucide-style strokes — no emoji in the chrome) ──
const SVGW = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const svgIcon = inner => `<svg ${SVGW} aria-hidden="true">${inner}</svg>`;
const ICON = {
  moon: svgIcon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  bell: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bellOff: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>'),
  send: svgIcon('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>'),
  check: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  chev: svgIcon('<path d="m6 9 6 6 6-6"/>'),
  play: svgIcon('<path d="M8 5.5v13l11-6.5z"/>'),
  pause: svgIcon('<path d="M9 5v14M15 5v14"/>'),
};

// ── Alert bar: install nudge + notification watchdog (persistent until fixed) ──
let deferredInstall = null, installDismissed = false;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderAlerts(); });
addEventListener('appinstalled', () => { deferredInstall = null; renderAlerts(); });

function renderAlerts() {
  const bar = $('alertBar');
  bar.innerHTML = '';
  const rows = [];
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  // 1. Notifications wanted but broken → strongest warning, NO dismiss button.
  if (S.pushOn && perm === 'denied') {
    rows.push({ text: 'Notifications are blocked — you will miss new messages.', btn: 'Fix', fn: fixNotif, danger: true });
  } else if (S.pushOn && perm === 'default') {
    rows.push({ text: 'Enable notifications to get new-message alerts.', btn: 'Enable', fn: fixNotif });
  }
  // 2. Install nudge — every visit until installed (X hides it for this session only).
  if (!isInstalled() && !installDismissed) {
    if (deferredInstall) {
      rows.push({ text: 'Install Chat Boy AI for the full experience.', btn: 'Install', fn: doInstall, x: true });
    } else if (isIOS()) {
      rows.push({ text: 'iPhone: Share → Add to Home Screen to install (required for notifications).', x: true });
    }
  }
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = 'alertRow' + (r.danger ? ' danger' : '');
    const s = document.createElement('span');
    s.textContent = r.text;
    d.appendChild(s);
    if (r.btn) {
      const b = document.createElement('button');
      b.textContent = r.btn;
      b.onclick = r.fn;
      d.appendChild(b);
    }
    if (r.x) {
      const x = document.createElement('button');
      x.className = 'alertX';
      x.textContent = '✕';
      x.setAttribute('aria-label', 'Dismiss');
      x.onclick = () => { installDismissed = true; renderAlerts(); };
      d.appendChild(x);
    }
    bar.appendChild(d);
  }
  bar.classList.toggle('hidden', !rows.length);
}
async function fixNotif() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') {
    toast('Blocked: address-bar lock icon → Site settings → Notifications → Allow');
    return;
  }
  if (await Notification.requestPermission() === 'granted') {
    S.pushOn = true;
    try { localStorage.setItem('cb_push', 'on'); } catch {}
    paintBell();
    if (S.unlocked) ensurePush();
    toast('Reply notifications are on');
  }
  renderAlerts();
}
async function doInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice; // accepted → `appinstalled` hides the row
  renderAlerts();
}
// Watchdog: re-verify reality whenever the tab regains focus + every 30s.
let lastPerm = null;
function checkNotif() {
  const p = ('Notification' in window) ? Notification.permission : 'unsupported';
  if (p !== lastPerm) { lastPerm = p; paintBell(); renderAlerts(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNotif(); });
addEventListener('focus', checkNotif);
setInterval(checkNotif, 30000);

// ── Theme (dark / light) ──
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('cb_theme', t); } catch {}
  $('themeBtn').innerHTML = t === 'light' ? ICON.sun : ICON.moon;
}
function applyAccent(a) {
  if (!['amber', 'forest', 'oxblood'].includes(a)) a = 'amber';
  document.documentElement.dataset.accent = a;
  try { localStorage.setItem('cb_accent', a); } catch {}
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.a === a));
}
document.querySelectorAll('.swatch').forEach(s => { s.onclick = () => applyAccent(s.dataset.a); });
$('themeBtn').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
};

// ── Boot ──
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
applyTheme(localStorage.getItem('cb_theme') || 'dark');
applyAccent(localStorage.getItem('cb_accent') || 'amber');
decoyWelcome();
setStatus();
paintBell();
renderAlerts();
checkNotif();

// Refresh-safe session: the tab remembers the secret until it is closed.
// (New tab / closed tab = locked again. Nothing is written to disk.)
const savedSecret = sessionStorage.getItem('cb_secret');
if (savedSecret) {
  unlock(savedSecret)
    .then(() => toast('Session restored'))
    .catch(() => sessionStorage.removeItem('cb_secret'));
}
