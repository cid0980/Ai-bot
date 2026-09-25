// ─────────────────────────────────────────────────────────────
// Chat Boy AI — client
// Locked   → harmless offline AI chatbot (the decoy).
// Unlocked → real E2E-encrypted chat with your friend, same screen.
// Unlock   → triple-tap the 🤖 logo, enter your shared secret as the
//            "API key". Both sides use the SAME secret, no links needed.
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
};

// ── UI helpers ──
function scrollDown() { chat.scrollTop = chat.scrollHeight; }
function bubble(text, who = 'bot') {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  chat.appendChild(d); scrollDown();
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
function showTyping() {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  chat.appendChild(d); scrollDown();
  return d;
}

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
  if (/(what can you do|help|features)/.test(t)) return 'I can chat, crack jokes 😂, share fun facts 🧠, and keep you company. Try the suggestions below! (Tip: enable 🔔 notifications so you never miss my replies.)';
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
  bubble('👋 Welcome to Chat Boy AI! I\'m your pocket buddy — ask me anything, anytime.');
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

async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, enc.encode(JSON.stringify({ t: text })));
  return { iv: b64e(iv), ct: b64e(ct) };
}

async function decryptText(ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) }, S.key, b64d(ctB64));
  return JSON.parse(dec.decode(pt)).t;
}

// ── Real chat (unlocked mode) ──
function setStatus() {
  if (!S.unlocked) { statusText.textContent = 'Always here to help'; statusDot.className = 'dot'; return; }
  statusText.textContent = S.online === 2 ? 'Pro replies active' : 'Pro replies active';
  statusDot.className = 'dot' + (S.online === 2 ? '' : ' away');
}

async function renderMessage(m, who) {
  try {
    bubble(await decryptText(m.iv, m.ct), who);
  } catch {
    bubble('🔒 Couldn\'t decrypt — wrong secret?', 'sys');
  }
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
    if (m.type === 'history' && Array.isArray(m.messages)) {
      chat.innerHTML = '';
      for (const msg of m.messages) await renderMessage(msg, msg.from === S.mySubId ? 'me' : 'bot');
      if (!m.messages.length) sys('Connected. Say hi — messages vanish after everyone leaves.');
    }
    if (m.type === 'msg' && m.message) {
      if (m.message.from === S.mySubId) return; // our own echo from another tab
      renderMessage(m.message, 'bot');
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
  S.key = key; S.roomId = roomId; S.unlocked = true;
  $('sessCode').textContent = code;
  $('sessInfo').classList.remove('hidden');
  $('sheetWrap').classList.add('hidden');
  lockBtn.classList.remove('hidden');
  chips.classList.add('hidden');
  input.placeholder = 'Message…';
  chat.innerHTML = '';
  sys('Pro connected ✓  Code: ' + code);
  setStatus(); connect(); pokeIdle();
  await ensurePush(); // needs roomId, so it happens here
  toast('Pro replies enabled');
}

function lock(msg) {
  S.unlocked = false; S.key = null; S.roomId = null;
  try { S.ws && S.ws.close(); } catch {}
  S.ws = null;
  clearTimeout(S.idleTimer);
  lockBtn.classList.add('hidden');
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
      toast('Enable notifications to get my replies 🔔');
      if (await Notification.requestPermission() !== 'granted') return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await (await fetch('/api/vapid-public-key')).json();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    }
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

lockBtn.onclick = async () => {
  try {
    await fetch('/api/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: S.roomId, subId: S.mySubId }),
    });
  } catch {}
  lock('Session ended.');
};

$('bellBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('Notifications not supported here');
  if (Notification.permission === 'granted') return toast('Reply notifications are on 🔔');
  if (await Notification.requestPermission() === 'granted') {
    toast('Reply notifications are on 🔔');
    if (S.unlocked) ensurePush();
  } else toast('Notifications blocked in browser settings');
};

// ── Composer ──
form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  pokeIdle();
  if (!S.unlocked) { bubble(text, 'me'); decoyAnswer(text); return; }
  // Real (encrypted) send
  try {
    const { iv, ct } = await encryptText(text);
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ type: 'msg', iv, ct }));
      bubble(text, 'me');
    } else toast('Reconnecting… try again in a sec');
  } catch { toast('Send failed'); }
});

chips.addEventListener('click', e => {
  const q = e.target?.dataset?.q;
  if (!q || S.unlocked) return;
  bubble(q, 'me'); decoyAnswer(q);
});

// ── Boot ──
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
decoyWelcome();
setStatus();
paintBell();
