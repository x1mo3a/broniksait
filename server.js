const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'keys.json');

app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Explicit fallback for the root URL (helps when something else hijacks it)
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// trust proxy so req.ip returns real client IP behind proxies
app.set('trust proxy', true);

// UID 0 is reserved (admin slot) and never auto-assigned. Auto IDs start at 1.
function ensureUids(db) {
  const used = new Set();
  for (const k of db.keys) {
    if (typeof k.uid === 'number') used.add(k.uid);
  }
  let next = 1;
  while (used.has(next)) next++;

  const sorted = db.keys.slice().sort((a, b) => a.createdAt - b.createdAt);
  let changed = false;
  for (const k of sorted) {
    if (typeof k.uid !== 'number') {
      while (used.has(next)) next++;
      k.uid = next;
      used.add(next);
      next++;
      changed = true;
    }
  }
  if (typeof db.nextUid !== 'number' || db.nextUid < 1) {
    db.nextUid = next;
    changed = true;
  }
  return changed;
}

function loadDB() {
  let db;
  try {
    if (!fs.existsSync(DB_FILE)) db = { keys: [], nextUid: 0 };
    else db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    db = { keys: [], nextUid: 0 };
  }
  if (!Array.isArray(db.keys)) db.keys = [];
  const changed = ensureUids(db);
  if (changed) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (_) {}
  }
  return db;
}

function takeUid(db) {
  if (typeof db.nextUid !== 'number' || db.nextUid < 1) db.nextUid = 1;
  const used = new Set();
  for (const k of db.keys) if (typeof k.uid === 'number') used.add(k.uid);
  while (used.has(db.nextUid) || db.nextUid === 0) db.nextUid++;
  const u = db.nextUid;
  db.nextUid++;
  return u;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function generateKey() {
  // KEY-XXXX-XXXX-XXXX-XXXX
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `KEY-${part()}-${part()}-${part()}-${part()}`;
}

function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

let cachedPublicIP = null;
let cachedPublicIPAt = 0;

function fetchPublicIP() {
  // cache for 5 minutes
  if (cachedPublicIP && Date.now() - cachedPublicIPAt < 5 * 60 * 1000) {
    return Promise.resolve(cachedPublicIP);
  }
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=text', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ip = data.trim();
        if (ip) {
          cachedPublicIP = ip;
          cachedPublicIPAt = Date.now();
        }
        resolve(ip || null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

async function getClientIP(req) {
  let ip = req.ip || req.connection.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  if (isPrivateIP(ip)) {
    const pub = await fetchPublicIP();
    if (pub) return pub;
  }
  return ip;
}

// duration in days, 0 = forever
const VALID_DURATIONS = [7, 14, 30, 90, 0];

// Generate a new key
app.post('/api/generate', (req, res) => {
  const { duration } = req.body;
  const d = Number(duration);
  if (!VALID_DURATIONS.includes(d)) {
    return res.status(400).json({ error: 'Invalid duration. Use 7, 14, 30, 90 or 0 (forever).' });
  }
  const db = loadDB();
  const now = Date.now();
  const expiresAt = d === 0 ? null : now + d * 24 * 60 * 60 * 1000;
  const newKey = {
    uid: takeUid(db),
    key: generateKey(),
    durationDays: d,
    createdAt: now,
    expiresAt,
    boundIP: null,
    boundAt: null,
    frozen: false, frozenRemaining: null,
    blocked: false
  };
  db.keys.push(newKey);
  saveDB(db);
  res.json(newKey);
});

// List all keys
app.get('/api/keys', (req, res) => {
  const db = loadDB();
  res.json(db.keys);
});

// Delete a key
app.delete('/api/keys/:key', (req, res) => {
  const db = loadDB();
  const before = db.keys.length;
  db.keys = db.keys.filter(k => k.key !== req.params.key);
  saveDB(db);
  res.json({ deleted: before - db.keys.length });
});

// Change UID
app.post('/api/keys/:key/uid', (req, res) => {
  const newUid = Number(req.body && req.body.uid);
  if (!Number.isInteger(newUid) || newUid < 0) {
    return res.status(400).json({ error: 'UID must be a non-negative integer.' });
  }
  const db = loadDB();
  const k = db.keys.find(x => x.key === req.params.key);
  if (!k) return res.status(404).json({ error: 'Not found' });
  if (k.uid === newUid) return res.json(k);
  if (db.keys.some(x => x.uid === newUid && x.key !== k.key)) {
    return res.status(409).json({ error: 'UID already in use by another key.' });
  }
  k.uid = newUid;
  if (typeof db.nextUid !== 'number' || db.nextUid <= newUid) db.nextUid = newUid + 1;
  saveDB(db);
  res.json(k);
});

// Reset binding (release IP)
app.post('/api/keys/:key/reset', (req, res) => {
  const db = loadDB();
  const k = db.keys.find(x => x.key === req.params.key);
  if (!k) return res.status(404).json({ error: 'Not found' });
  k.boundIP = null;
  k.boundAt = null;
  saveDB(db);
  res.json(k);
});

// Validate a key (used by C++ client)
app.post('/api/validate', async (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ status: 'invalid', message: 'invalid key!' });
  }
  const ip = await getClientIP(req);
  const db = loadDB();
  const k = db.keys.find(x => x.key === key.trim());
  if (!k) {
    return res.json({ status: 'invalid', message: 'invalid key!' });
  }
  // blocked?
  if (k.blocked) {
    return res.json({ status: 'invalid', message: 'invalid key!', reason: 'blocked' });
  }
  // frozen?
  if (k.frozen) {
    return res.json({ status: 'invalid', message: 'invalid key!', reason: 'frozen' });
  }
  // expired?
  if (k.expiresAt !== null && Date.now() > k.expiresAt) {
    return res.json({ status: 'invalid', message: 'invalid key!', reason: 'expired' });
  }
  // bind to IP if not bound
  if (!k.boundIP) {
    k.boundIP = ip;
    k.boundAt = Date.now();
    saveDB(db);
  } else if (k.boundIP !== ip) {
    return res.json({ status: 'invalid', message: 'invalid key!', reason: 'ip_mismatch' });
  }
  res.json({
    status: 'granted',
    message: 'access granted!',
    uid: k.uid,
    isAdmin: k.uid === 0,
    boundIP: k.boundIP,
    expiresAt: k.expiresAt,
    durationDays: k.durationDays
  });
});

app.listen(PORT, () => {
  console.log(`License server running on http://localhost:${PORT}`);
});

// Start Telegram bot. Config from env vars first, then config.json fallback.
const CONFIG_FILE = path.join(__dirname, 'config.json');
try {
  let token = process.env.TG_TOKEN || '';
  let adminIds = (process.env.ADMIN_IDS || '')
    .split(',').map(s => Number(s.trim())).filter(Boolean);

  if ((!token || !adminIds.length) && fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!token) token = cfg.telegramToken;
    if (!adminIds.length) adminIds = cfg.adminIds || [];
  }

  if (token) {
    bot.start({ token, adminIds, generateKey, loadDB, saveDB });
  } else {
    console.log('[bot] No TG_TOKEN env var and no config.json — Telegram bot disabled.');
  }
} catch (e) {
  console.error('[bot] failed to start:', e.message);
}
