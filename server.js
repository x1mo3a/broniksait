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

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { keys: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { keys: [] };
  }
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
    key: generateKey(),
    durationDays: d,
    createdAt: now,
    expiresAt,
    boundIP: null,
    boundAt: null
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
    boundIP: k.boundIP,
    expiresAt: k.expiresAt,
    durationDays: k.durationDays
  });
});

app.listen(PORT, () => {
  console.log(`License server running on http://localhost:${PORT}`);
});

// Start Telegram bot if config is present
const CONFIG_FILE = path.join(__dirname, 'config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    bot.start({
      token: cfg.telegramToken,
      adminIds: cfg.adminIds || [],
      generateKey,
      loadDB,
      saveDB
    });
  } else {
    console.log('[bot] config.json not found, Telegram bot disabled. Copy config.example.json -> config.json to enable.');
  }
} catch (e) {
  console.error('[bot] failed to start:', e.message);
}
