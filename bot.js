// Telegram bot for managing license keys & admins.
// Menu-driven: Generate / Users / Admins / Stats
// Per-key actions: extend, freeze, block, unbind, delete

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const ADMINS_FILE = path.join(__dirname, 'admins.json');
const PAGE_SIZE = 6;

// ---------- helpers ----------
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}
function durLabel(d) { return d === 0 ? 'forever' : d + 'd'; }
function statusOf(k) {
  if (k.blocked) return 'blocked';
  if (k.frozen) return 'frozen';
  if (k.expiresAt !== null && Date.now() > k.expiresAt) return 'expired';
  if (k.boundIP) return 'active';
  return 'unbound';
}
function statusEmoji(s) {
  return ({
    active:   '🟢',
    unbound:  '🟡',
    expired:  '🔴',
    frozen:   '❄️',
    blocked:  '⛔'
  })[s] || '⚪';
}
function shortKey(k) {
  // KEY-AAAA-BBBB-CCCC-DDDD -> AAAA…DDDD
  const parts = k.split('-');
  if (parts.length >= 5) return parts[1] + '…' + parts[4];
  return k.slice(0, 10);
}
function timeLeft(k) {
  if (k.expiresAt === null) return '∞';
  const ms = k.expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return d + 'd ' + h + 'h';
  return h + 'h';
}

function loadAdmins(seed) {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr.map(Number));
    }
  } catch (_) {}
  const set = new Set((seed || []).map(Number));
  saveAdminsSet(set);
  return set;
}
function saveAdminsSet(set) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify([...set]));
}

// ---------- main ----------
function start(opts) {
  const { token, adminIds, generateKey, loadDB, saveDB } = opts;
  if (!token || token === 'PUT_YOUR_BOT_TOKEN_HERE') {
    console.log('[bot] Telegram token not set, skipping bot start.');
    return null;
  }

  const admins = loadAdmins(adminIds);
  const SUPER = Number((adminIds && adminIds[0]) || 0); // first admin from config = super-admin
  const isAdmin = (id) => admins.has(Number(id));
  const isSuper = (id) => Number(id) === SUPER;

  // per-chat state for multi-step actions
  const state = new Map(); // chatId -> { awaiting: 'addAdminId' }

  const bot = new TelegramBot(token, { polling: true });
  bot.on('polling_error', (e) => console.error('[bot] polling error:', e.message));

  // ---------- key ops ----------
  function createKey(d) {
    const db = loadDB();
    const now = Date.now();
    const k = {
      key: generateKey(),
      durationDays: d,
      createdAt: now,
      expiresAt: d === 0 ? null : now + d * 86400000,
      boundIP: null, boundAt: null,
      frozen: false, frozenRemaining: null,
      blocked: false
    };
    db.keys.push(k);
    saveDB(db);
    return k;
  }
  function findKey(keyStr) {
    const db = loadDB();
    return { db, k: db.keys.find(x => x.key === keyStr) };
  }
  function extendKey(keyStr, days) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    if (k.expiresAt === null && !k.frozen) return k; // forever stays forever
    if (k.frozen) {
      k.frozenRemaining = (k.frozenRemaining || 0) + days * 86400000;
    } else {
      k.expiresAt = (k.expiresAt || Date.now()) + days * 86400000;
    }
    saveDB(db);
    return k;
  }
  function freezeKey(keyStr) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    if (!k.frozen) {
      k.frozenRemaining = k.expiresAt === null ? null : Math.max(0, k.expiresAt - Date.now());
      k.frozen = true;
      k.expiresAt = null;
      saveDB(db);
    }
    return k;
  }
  function unfreezeKey(keyStr) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    if (k.frozen) {
      k.frozen = false;
      if (k.frozenRemaining !== null) k.expiresAt = Date.now() + k.frozenRemaining;
      else k.expiresAt = null;
      k.frozenRemaining = null;
      saveDB(db);
    }
    return k;
  }
  function blockKey(keyStr) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    k.blocked = true; saveDB(db); return k;
  }
  function unblockKey(keyStr) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    k.blocked = false; saveDB(db); return k;
  }
  function unbindKey(keyStr) {
    const { db, k } = findKey(keyStr);
    if (!k) return null;
    k.boundIP = null; k.boundAt = null; saveDB(db); return k;
  }
  function deleteKey(keyStr) {
    const db = loadDB();
    const before = db.keys.length;
    db.keys = db.keys.filter(x => x.key !== keyStr);
    saveDB(db);
    return before > db.keys.length;
  }

  // ---------- views ----------
  function mainMenuKb() {
    return {
      inline_keyboard: [
        [{ text: '🔑 Generate key', callback_data: 'gen' }],
        [{ text: '👥 Users',        callback_data: 'users:0' }],
        [{ text: '👮 Admins',       callback_data: 'admins' },
         { text: '📊 Stats',        callback_data: 'stats' }]
      ]
    };
  }

  function genMenuKb() {
    return {
      inline_keyboard: [
        [
          { text: '7d',  callback_data: 'gen:7'  },
          { text: '14d', callback_data: 'gen:14' },
          { text: '30d', callback_data: 'gen:30' }
        ],
        [
          { text: '90d', callback_data: 'gen:90' },
          { text: '∞ Forever', callback_data: 'gen:0' }
        ],
        [{ text: '← Back', callback_data: 'home' }]
      ]
    };
  }

  function usersListKb(page) {
    const db = loadDB();
    const all = db.keys.slice().sort((a, b) => b.createdAt - a.createdAt);
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const rows = slice.map(k => {
      const s = statusOf(k);
      const ip = k.boundIP || 'no-ip';
      const label = `${statusEmoji(s)} ${shortKey(k.key)} • ${ip}`;
      return [{ text: label, callback_data: 'k:' + k.key }];
    });

    const nav = [];
    if (page > 0) nav.push({ text: '« Prev', callback_data: 'users:' + (page - 1) });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' });
    if (page < pages - 1) nav.push({ text: 'Next »', callback_data: 'users:' + (page + 1) });
    rows.push(nav);
    rows.push([{ text: '🔄 Refresh', callback_data: 'users:' + page },
               { text: '← Back',     callback_data: 'home' }]);
    return { inline_keyboard: rows };
  }

  function keyDetailText(k) {
    const s = statusOf(k);
    const lines = [
      `*Key:* \`${k.key}\``,
      `*Status:* ${statusEmoji(s)} ${s}`,
      `*Duration:* ${durLabel(k.durationDays)}`,
      `*Time left:* ${timeLeft(k)}`,
      `*Bound IP:* ${k.boundIP ? '`' + k.boundIP + '`' : '—'}`,
      `*Bound at:* ${fmtDate(k.boundAt)}`,
      `*Created:* ${fmtDate(k.createdAt)}`,
      `*Expires:* ${k.expiresAt === null ? '∞' : fmtDate(k.expiresAt)}`
    ];
    if (k.frozen && k.frozenRemaining !== null) {
      const d = Math.floor(k.frozenRemaining / 86400000);
      const h = Math.floor((k.frozenRemaining % 86400000) / 3600000);
      lines.push(`*Frozen remaining:* ${d}d ${h}h`);
    }
    return lines.join('\n');
  }

  function keyActionKb(k) {
    const ext = (d) => ({ text: '+' + d + 'd', callback_data: 'k:ext:' + d + ':' + k.key });
    const rows = [
      [ext(7), ext(14), ext(30), ext(90)],
      [
        k.frozen
          ? { text: '🔥 Unfreeze', callback_data: 'k:unfreeze:' + k.key }
          : { text: '❄️ Freeze',   callback_data: 'k:freeze:'   + k.key },
        k.blocked
          ? { text: '✅ Unblock',  callback_data: 'k:unblock:'  + k.key }
          : { text: '⛔ Block',    callback_data: 'k:block:'    + k.key }
      ],
      [{ text: '🔓 Unbind IP', callback_data: 'k:unbind:' + k.key }],
      [{ text: '🗑 Delete',    callback_data: 'k:delask:' + k.key }],
      [{ text: '← Back to users', callback_data: 'users:0' }]
    ];
    return { inline_keyboard: rows };
  }

  function adminsView() {
    const list = [...admins];
    let text = '*Admins (' + list.length + ')*\n\n';
    text += list.map(id => `• \`${id}\`` + (Number(id) === SUPER ? ' _(super)_' : '')).join('\n');
    text += '\n\nUse the buttons below to manage admins. Only super-admin can add/remove.';
    const rows = [];
    if (Number(list.length) > 0) {
      for (const id of list) {
        if (Number(id) === SUPER) continue;
        rows.push([{ text: '🗑 Remove ' + id, callback_data: 'adm:del:' + id }]);
      }
    }
    rows.push([{ text: '➕ Add admin', callback_data: 'adm:add' }]);
    rows.push([{ text: '← Back', callback_data: 'home' }]);
    return { text, kb: { inline_keyboard: rows } };
  }

  function statsView() {
    const db = loadDB();
    let active = 0, unbound = 0, expired = 0, frozen = 0, blocked = 0;
    for (const k of db.keys) {
      const s = statusOf(k);
      if (s === 'active') active++;
      else if (s === 'unbound') unbound++;
      else if (s === 'expired') expired++;
      else if (s === 'frozen') frozen++;
      else if (s === 'blocked') blocked++;
    }
    return [
      '*📊 Stats*',
      `Total: *${db.keys.length}*`,
      `🟢 Active: ${active}`,
      `🟡 Unbound: ${unbound}`,
      `❄️ Frozen: ${frozen}`,
      `⛔ Blocked: ${blocked}`,
      `🔴 Expired: ${expired}`
    ].join('\n');
  }

  // ---------- messaging helpers ----------
  function sendHome(chatId) {
    return bot.sendMessage(chatId,
      '*🔐 License Bot*\n\nChoose an action:',
      { parse_mode: 'Markdown', reply_markup: mainMenuKb() });
  }
  function editToHome(cq) {
    return bot.editMessageText('*🔐 License Bot*\n\nChoose an action:', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      parse_mode: 'Markdown', reply_markup: mainMenuKb()
    }).catch(() => {});
  }
  function deny(msgOrCq, isCq) {
    const id = isCq ? msgOrCq.from.id : msgOrCq.from.id;
    const chat = isCq ? msgOrCq.message.chat.id : msgOrCq.chat.id;
    bot.sendMessage(chat, `Access denied. Your ID: \`${id}\``, { parse_mode: 'Markdown' });
    if (isCq) bot.answerCallbackQuery(msgOrCq.id, { text: 'denied' });
  }

  // ---------- text commands ----------
  bot.onText(/^\/(start|menu)\b/, (msg) => {
    if (!isAdmin(msg.from.id)) return deny(msg, false);
    sendHome(msg.chat.id);
  });

  bot.onText(/^\/myid\b/, (msg) => {
    bot.sendMessage(msg.chat.id, `Your ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
  });

  // free-text input handler (for "add admin" flow)
  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!isAdmin(msg.from.id)) return;
    const st = state.get(msg.chat.id);
    if (!st) return;
    if (st.awaiting === 'addAdminId') {
      state.delete(msg.chat.id);
      if (!isSuper(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 'Only super-admin can add admins.');
      }
      const id = Number(msg.text.trim());
      if (!Number.isInteger(id) || id <= 0) {
        return bot.sendMessage(msg.chat.id, 'Invalid Telegram ID.');
      }
      admins.add(id);
      saveAdminsSet(admins);
      bot.sendMessage(msg.chat.id, `✅ Added admin \`${id}\``, { parse_mode: 'Markdown' });
      const v = adminsView();
      bot.sendMessage(msg.chat.id, v.text, { parse_mode: 'Markdown', reply_markup: v.kb });
    }
  });

  // ---------- callback handler ----------
  bot.on('callback_query', async (cq) => {
    if (!isAdmin(cq.from.id)) return deny(cq, true);
    const data = cq.data || '';
    const ack = (text) => bot.answerCallbackQuery(cq.id, text ? { text } : {});
    const editText = (text, kb) => bot.editMessageText(text, {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      parse_mode: 'Markdown', reply_markup: kb
    }).catch(() => {});

    try {
      if (data === 'noop') return ack();
      if (data === 'home') { ack(); return editToHome(cq); }

      if (data === 'gen') {
        ack();
        return editText('*Generate key*\n\nPick a duration:', genMenuKb());
      }
      if (data.startsWith('gen:')) {
        const d = Number(data.slice(4));
        if (![7, 14, 30, 90, 0].includes(d)) return ack('Invalid');
        const k = createKey(d);
        ack('Generated');
        return bot.sendMessage(cq.message.chat.id,
          '*✅ New key created*\n\n' + keyDetailText(k),
          { parse_mode: 'Markdown', reply_markup: keyActionKb(k) });
      }

      if (data.startsWith('users:')) {
        const page = Number(data.split(':')[1]) || 0;
        ack();
        const db = loadDB();
        const total = db.keys.length;
        const head = total === 0
          ? '*👥 Users*\n\n_No keys yet._'
          : `*👥 Users (${total})*\n\nTap a key to manage it:`;
        return editText(head, usersListKb(page));
      }

      if (data === 'stats') {
        ack();
        return editText(statsView(), { inline_keyboard: [[{ text: '← Back', callback_data: 'home' }]] });
      }

      if (data === 'admins') {
        ack();
        const v = adminsView();
        return editText(v.text, v.kb);
      }

      if (data === 'adm:add') {
        if (!isSuper(cq.from.id)) return ack('Only super-admin');
        ack();
        state.set(cq.message.chat.id, { awaiting: 'addAdminId' });
        return bot.sendMessage(cq.message.chat.id,
          'Send the Telegram ID of the new admin (just the number).\n_Tip: ask them to run /myid in this bot._',
          { parse_mode: 'Markdown' });
      }
      if (data.startsWith('adm:del:')) {
        if (!isSuper(cq.from.id)) return ack('Only super-admin');
        const id = Number(data.slice(8));
        if (id === SUPER) return ack('Cannot remove super-admin');
        admins.delete(id);
        saveAdminsSet(admins);
        ack('Removed');
        const v = adminsView();
        return editText(v.text, v.kb);
      }

      // key actions: "k:<key>" (open) or "k:<action>:<key>" or "k:ext:<days>:<key>"
      if (data.startsWith('k:')) {
        const rest = data.slice(2);
        // open detail
        if (rest.startsWith('KEY-')) {
          const { k } = findKey(rest);
          if (!k) return ack('Key not found');
          ack();
          return editText(keyDetailText(k), keyActionKb(k));
        }
        const parts = rest.split(':');
        const action = parts[0];

        if (action === 'ext') {
          const days = Number(parts[1]);
          const key = parts.slice(2).join(':');
          const k = extendKey(key, days);
          if (!k) return ack('Not found');
          ack(`+${days}d`);
          return editText('✅ Extended\n\n' + keyDetailText(k), keyActionKb(k));
        }

        const key = parts.slice(1).join(':');

        if (action === 'freeze')   { const k = freezeKey(key);   if (!k) return ack('Not found'); ack('Frozen');    return editText('❄️ Frozen\n\n' + keyDetailText(k), keyActionKb(k)); }
        if (action === 'unfreeze') { const k = unfreezeKey(key); if (!k) return ack('Not found'); ack('Unfrozen');  return editText('🔥 Unfrozen\n\n' + keyDetailText(k), keyActionKb(k)); }
        if (action === 'block')    { const k = blockKey(key);    if (!k) return ack('Not found'); ack('Blocked');   return editText('⛔ Blocked\n\n' + keyDetailText(k), keyActionKb(k)); }
        if (action === 'unblock')  { const k = unblockKey(key);  if (!k) return ack('Not found'); ack('Unblocked'); return editText('✅ Unblocked\n\n' + keyDetailText(k), keyActionKb(k)); }
        if (action === 'unbind')   { const k = unbindKey(key);   if (!k) return ack('Not found'); ack('Unbound');   return editText('🔓 Unbound\n\n' + keyDetailText(k), keyActionKb(k)); }

        if (action === 'delask') {
          ack();
          return editText('⚠️ *Delete this key?*\n\n`' + key + '`', {
            inline_keyboard: [[
              { text: 'Yes, delete', callback_data: 'k:delyes:' + key },
              { text: 'Cancel',      callback_data: 'k:' + key }
            ]]
          });
        }
        if (action === 'delyes') {
          const ok = deleteKey(key);
          ack(ok ? 'Deleted' : 'Not found');
          return editText(ok ? '🗑 Deleted: `' + key + '`' : 'Not found',
            { inline_keyboard: [[{ text: '← Back to users', callback_data: 'users:0' }]] });
        }
      }

      ack();
    } catch (err) {
      console.error('[bot] cb error:', err);
      ack('Error');
    }
  });

  console.log('[bot] Telegram bot started. Admins:', [...admins].join(', '));
  return bot;
}

module.exports = { start };
