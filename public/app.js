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
  msgIndex: new Map(), // id -> { text, mine, replyTo, seen }
  replyTo: null,       // { id, t, mine } quoted in the composer
  stick: true,         // auto-scroll pinned to bottom?
  unread: 0,           // new messages arrived while scrolled up
  online: 1,
  editingId: null,     // message id currently being revised in the composer
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
function paintJump() {
  const j = $('jumpBtn');
  j.classList.toggle('hidden', S.stick || !S.unread);
  if (S.unread) j.innerHTML = ICON.chev + '<span>' + S.unread + ' new message' + (S.unread > 1 ? 's' : '') + '</span>';
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
function chatBubble(id, who, text, replyTo, edited, seen) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.dataset.id = id;
  if (replyTo && replyTo.t) {
    const q = document.createElement('div');
    q.className = 'quote';
    const b = document.createElement('b');
    b.textContent = replyTo.mine ? 'You' : 'Friend';
    const s = document.createElement('span');
    s.textContent = replyTo.t.length > 120 ? replyTo.t.slice(0, 120) + '…' : replyTo.t;
    q.appendChild(b); q.appendChild(s); d.appendChild(q);
  }
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
    const st = document.createElement('span');
    st.className = 'seenMark' + (seen ? ' isSeen' : '');
    st.textContent = seen ? 'Seen ✓✓' : '✓ Sent';
    d.appendChild(st);
  }
  chat.appendChild(d);
  return d;
}

async function renderMessage(m, who) {
  try {
    const p = await decryptPayload(m.iv, m.ct);
    S.msgIndex.set(m.id, { text: p.t, mine: who === 'me', replyTo: p.replyTo || null, seen: !!m.seen });
    chatBubble(m.id, who, p.t, p.replyTo || null, !!m.edited, !!m.seen);
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
      S.msgIndex.clear();
      S.unread = 0; S.stick = true; paintJump();
      for (const msg of m.messages) await renderMessage(msg, msg.from === S.mySubId ? 'me' : 'bot');
      if (!m.messages.length) sys('Connected. Say hi — seen messages vanish after everyone leaves.');
      scrollDown();
      sendSeen(m.messages.map(x => x.id)); // read receipt → server may wipe these later
    }
    if (m.type === 'msg' && m.message) {
      if (m.message.from === S.mySubId) return; // our own echo from another tab
      await renderMessage(m.message, 'bot');
      if (S.stick) scrollDown();
      else { S.unread++; paintJump(); }
      sendSeen([m.message.id]);
    }
    if (m.type === 'edit' && m.message) applyEdit(m.message);
    if (m.type === 'seen' && m.by !== S.mySubId && Array.isArray(m.ids)) {
      for (const id of m.ids) {
        const rec = S.msgIndex.get(id);
        if (!rec || !rec.mine || rec.seen) continue;
        rec.seen = true;
        const el = chat.querySelector(`.msg[data-id="${CSS.escape(id)}"] .seenMark`);
        if (el) { el.textContent = 'Seen ✓✓'; el.classList.add('isSeen'); }
      }
    }
  };
  ws.onclose = () => { if (S.unlocked) setTimeout(() => S.unlocked && connect(), 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function pokeIdle() {
  clearTimeout(S.idleTimer);
  if (!S.unlocked) return;
  S.idleTimer = setTimeout(() => { lock('Session ended (idle too long).'); }, 5 * 60 * 1000);
}
['pointerdown', 'keydown'].forEach(e => addEventListener(e, pokeIdle, { passive: true }));

async function unlock(secret) {
  const { key, roomId, code } = await deriveAll(secret);
  try { sessionStorage.setItem('cb_secret', secret); } catch {} // refresh-safe, dies with tab
  S.key = key; S.roomId = roomId; S.unlocked = true;
  $('sessCode').textContent = code;
  $('sessInfo').classList.remove('hidden');
  $('sheetWrap').classList.add('hidden');
  chips.classList.add('hidden');
  input.placeholder = 'Message…';
  chat.innerHTML = '';
  sys('Pro connected ✓  Code: ' + code + ' — swipe right to reply, long-press a message for more');
  setStatus(); connect(); pokeIdle();
  await ensurePush(); // needs roomId, so it happens here
  toast('Pro replies enabled');
}

function lock(msg) {
  S.unlocked = false; S.key = null; S.roomId = null;
  // NOTE: the secret STAYS in sessionStorage (tab memory, dies with the tab)
  // so triple-tapping 🔒 can quick-rejoin. True logout = close the tab.
  S.msgIndex.clear();
  cancelReply();
  cancelEdit();
  hideRemoteTyping();
  S.unread = 0; S.stick = true; paintJump();
  try { S.ws && S.ws.close(); } catch {}
  S.ws = null;
  clearTimeout(S.idleTimer);
  chips.classList.remove('hidden');
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

function paintBell() { $('bellBtn').innerHTML = S.pushOn ? ICON.bell : ICON.bellOff; }

$('bellBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('Notifications not supported here');
  if (Notification.permission !== 'granted') {
    if (await Notification.requestPermission() === 'granted') {
      S.pushOn = true; localStorage.setItem('cb_push', 'on'); paintBell();
      toast('Reply notifications are on');
      if (S.unlocked) ensurePush();
    } else toast('Notifications blocked in browser settings');
    return;
  }
  // Permission granted → bell is a real on/off switch.
  S.pushOn = !S.pushOn;
  localStorage.setItem('cb_push', S.pushOn ? 'on' : 'off');
  paintBell();
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

// ── Message action sheet (long-press / right-click menu, Instagram-style) ──
let sheetId = null;
function openMsgSheet(id) {
  const rec = S.msgIndex.get(id);
  if (!rec || !S.unlocked) return;
  sheetId = id;
  $('msgSheetPreview').textContent = (rec.mine ? 'You: ' : 'Friend: ') + rec.text.slice(0, 80);
  $('msgEdit').style.display = rec.mine ? '' : 'none'; // edit: own messages only
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

// Swipe LEFT → RIGHT to reply (bubble follows your finger, Instagram-style),
// long-press any bubble for the Reply / Edit / Copy menu.
let gX = 0, gY = 0, gEl = null, gLong = null, gLongFired = false, gDX = 0;
function swipeReset() {
  if (!gEl) return;
  gEl.style.transition = 'transform .15s';
  gEl.style.transform = '';
  const el = gEl;
  setTimeout(() => { el.style.transition = ''; }, 160);
  $('swipeHint').style.opacity = '0';
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
  gDX = Math.max(0, dx); // left-to-right only
  const pull = Math.min(gDX, 90);
  gEl.style.transform = 'translateX(' + pull + 'px)';
  // ↩️ arrow sits in the revealed gap (follows the row's original position).
  const r = gEl.getBoundingClientRect(), a = $('app').getBoundingClientRect();
  const hint = $('swipeHint');
  hint.style.left = Math.max(4, (r.left - a.left) - pull + 8) + 'px';
  hint.style.top = (r.top - a.top + 6) + 'px';
  hint.style.opacity = Math.min(1, gDX / 60);
}, { passive: true });
function swipeEnd(e) {
  clearTimeout(gLong);
  if (!gEl) return;
  const id = gEl.dataset.id, dx = gDX, fired = gLongFired, y0 = gY;
  swipeReset();
  gEl = null; gDX = 0;
  if (!S.unlocked || fired) return;
  if (e && e.changedTouches && Math.abs(e.changedTouches[0].clientY - y0) >= 50) return; // was a scroll
  if (dx >= 70 && id) setReply(id);
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
  if (!rec || !rec.mine || !S.unlocked) return;
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
    catch { toast('Edit failed'); }
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
      S.msgIndex.set(id, { text, mine: true, replyTo: payload.replyTo || null, seen: false });
      chatBubble(id, 'me', text, payload.replyTo || null, false, false);
      cancelReply();
      clearTimeout(typingTimer); sendTyping(false);
      S.stick = true; S.unread = 0; paintJump(); scrollDown();
    } else toast('Reconnecting… try again in a sec');
  } catch { toast('Send failed'); }
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
};

// ── Theme (dark / light) ──
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('cb_theme', t); } catch {}
  $('themeBtn').innerHTML = t === 'light' ? ICON.sun : ICON.moon;
}
$('themeBtn').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
};

// ── Boot ──
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
applyTheme(localStorage.getItem('cb_theme') || 'dark');
decoyWelcome();
setStatus();
paintBell();

// Refresh-safe session: the tab remembers the secret until it is closed.
// (New tab / closed tab = locked again. Nothing is written to disk.)
const savedSecret = sessionStorage.getItem('cb_secret');
if (savedSecret) {
  unlock(savedSecret)
    .then(() => toast('Session restored'))
    .catch(() => sessionStorage.removeItem('cb_secret'));
}
