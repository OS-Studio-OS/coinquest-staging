const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';
const CRYPTO_API_URL = process.env.CRYPTO_API_URL || 'https://testnet-pay.crypt.bot/api';
const SERVER_URL = process.env.SERVER_URL || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '1376300464').split(',').map(s => s.trim());

const TOURNAMENT_CONFIG = {
  entryFee: 0.5,
  prizePoolPercent: 0.8,
  platformPercent: 0.2,
  durationDays: 7,
  currency: 'TON'
};

const STARS_PACKAGES = [
  { id: 'stars_100', stars: 100, coins: 1000, label: '1,000 монет' },
  { id: 'stars_250', stars: 250, coins: 2750, label: '2,750 монет' },
  { id: 'stars_500', stars: 500, coins: 6000, label: '6,000 монет' },
  { id: 'stars_1000', stars: 1000, coins: 13000, label: '13,000 монет' },
];

const DB_PATH = process.env.DB_PATH || '/app/data/bank.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    coins INTEGER DEFAULT 0,
    tp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    coins_per_tap INTEGER DEFAULT 1,
    idle_per_sec REAL DEFAULT 0,
    last_seen INTEGER DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by INTEGER,
    referral_earnings INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS boosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    boost_type TEXT NOT NULL,
    level INTEGER DEFAULT 1,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    reward_coins INTEGER DEFAULT 0,
    reward_tp INTEGER DEFAULT 0,
    target_value INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS user_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    progress INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    claimed INTEGER DEFAULT 0,
    completed_at INTEGER,
    UNIQUE(user_id, task_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
  CREATE TABLE IF NOT EXISTS promos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    reward_coins INTEGER DEFAULT 0,
    reward_tp INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT 100,
    uses INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS promo_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    promo_id INTEGER NOT NULL,
    used_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, promo_id)
  );
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    entry_fee REAL DEFAULT 0.5,
    prize_pool REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    starts_at INTEGER,
    ends_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS tournament_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    tp_at_entry INTEGER DEFAULT 0,
    paid_amount REAL DEFAULT 0,
    payment_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(tournament_id, user_id),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL,
    currency TEXT,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    external_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get();
if (taskCount.c === 0) {
  db.exec(`
    INSERT INTO tasks (type, title, description, reward_coins, reward_tp, target_value) VALUES
    ('tap', 'Первые шаги', 'Сделай 100 тапов', 500, 10, 100),
    ('tap', 'Тапер', 'Сделай 1000 тапов', 2000, 50, 1000),
    ('tap', 'Мастер тапов', 'Сделай 10000 тапов', 10000, 200, 10000),
    ('referral', 'Пригласи друга', 'Пригласи 1 друга', 1000, 20, 1),
    ('referral', 'Команда', 'Пригласи 5 друзей', 5000, 100, 5),
    ('level', 'Новичок', 'Достигни 2 уровня', 2000, 30, 2),
    ('level', 'Опытный', 'Достигни 5 уровня', 10000, 150, 5);
  `);
}

// Миграции — добавляем все недостающие колонки (для существующих БД)
const existingCols = db.pragma('table_info(users)').map(c => c.name);
const usersMigrations = [
  ['username',          'TEXT'],
  ['first_name',        'TEXT'],
  ['coins',             'INTEGER DEFAULT 0'],
  ['tp',                'INTEGER DEFAULT 0'],
  ['level',             'INTEGER DEFAULT 1'],
  ['coins_per_tap',     'INTEGER DEFAULT 1'],
  ['idle_per_sec',      'REAL DEFAULT 0'],
  ['last_seen',         'INTEGER DEFAULT 0'],
  ['referral_code',     'TEXT'],
  ['referred_by',       'INTEGER'],
  ['referral_earnings', 'INTEGER DEFAULT 0'],
];
for (const [col, type] of usersMigrations) {
  if (!existingCols.includes(col)) {
    db.exec('ALTER TABLE users ADD COLUMN ' + col + ' ' + type);
    console.log('Migration: added column ' + col + ' to users');
  }
}

// Миграции tournament_entries
const teCols = db.pragma('table_info(tournament_entries)').map(c => c.name);
const teMigrations = [
  ['paid_amount',  'REAL DEFAULT 0'],
  ['payment_id',   'TEXT'],
  ['tp_at_entry',  'INTEGER DEFAULT 0'],
];
for (const [col, type] of teMigrations) {
  if (!teCols.includes(col)) {
    db.exec('ALTER TABLE tournament_entries ADD COLUMN ' + col + ' ' + type);
    console.log('Migration: added column ' + col + ' to tournament_entries');
  }
}

const promoCount = db.prepare('SELECT COUNT(*) as c FROM promos').get();
if (promoCount.c === 0) {
  db.exec(`
    INSERT INTO promos (code, reward_coins, reward_tp, max_uses) VALUES
    ('START500', 500, 10, 1000),
    ('LAUNCH2026', 1000, 25, 500);
  `);
}

const tournamentCount = db.prepare("SELECT COUNT(*) as c FROM tournaments WHERE status='active'").get();
if (tournamentCount.c === 0) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO tournaments (title, entry_fee, prize_pool, status, starts_at, ends_at) VALUES (?, ?, ?, 'active', ?, ?)`)
    .run('Турнир #1', 0.5, 0, now, now + 7 * 24 * 3600);
}

console.log('✅ Database initialized');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function validateTelegramData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (expectedHash !== hash) return null;
    const userParam = params.get('user');
    return userParam ? JSON.parse(userParam) : null;
  } catch (e) { return null; }
}

function getUserFromRequest(req) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (initData && initData.length > 0) {
    // 1. Полная валидация подписи (production)
    const validated = validateTelegramData(initData);
    if (validated) return validated;
    // 2. Staging: initData есть, но подпись не проходит — извлекаем user напрямую
    try {
      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      if (userParam) {
        const u = JSON.parse(userParam);
        if (u && u.id) return u;
      }
    } catch (e) {}
  }
  // 3. Fallback: явный userId в заголовке или теле запроса
  const userId = req.headers['x-user-id'] || req.body?.userId;
  if (userId) return { id: parseInt(userId), first_name: 'Player', username: 'player' };
  return null;
}

function requireAdmin(req, res, next) {
  const user = getUserFromRequest(req);
  const userId = String(parseInt(user?.id || req.body?.userId || req.headers['x-user-id'] || 0));
  if (!userId || userId === '0' || !ADMIN_IDS.includes(userId)) return res.status(403).json({ error: 'Forbidden' });
  req.adminId = userId;
  next();
}

function getOrCreateUser(tgUser) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  if (!user) {
    const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    db.prepare('INSERT INTO users (id, username, first_name, referral_code) VALUES (?, ?, ?, ?)')
      .run(tgUser.id, tgUser.username || '', tgUser.first_name || '', refCode);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  }
  return user;
}

function getActiveBoosts(userId) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT * FROM boosts WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').all(userId, now);
}

function calcIdleIncome(user) { return user.idle_per_sec || 0; }

function applyIdleIncome(user) {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.min(now - (user.last_seen || now), 8 * 3600);
  if (elapsed <= 0) return 0;
  const earned = Math.floor(elapsed * calcIdleIncome(user));
  if (earned > 0) db.prepare('UPDATE users SET coins = coins + ?, last_seen = ? WHERE id = ?').run(earned, now, user.id);
  return earned;
}

app.post('/api/init', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const refCode = req.body?.ref;
    let user = getOrCreateUser(tgUser);
    if (refCode && !user.referred_by) {
      const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(refCode);
      if (referrer && referrer.id !== user.id) {
        db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, user.id);
        db.prepare('UPDATE users SET coins = coins + 500, referral_earnings = referral_earnings + 500 WHERE id = ?').run(referrer.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
    }
    const idleEarned = applyIdleIncome(user);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id);
    const tasks = db.prepare('SELECT * FROM tasks WHERE is_active = 1').all();
    const userTasks = db.prepare('SELECT * FROM user_tasks WHERE user_id = ?').all(user.id);
    const taskMap = {};
    userTasks.forEach(ut => { taskMap[ut.task_id] = ut; });
    const tasksWithProgress = tasks.map(t => ({
      ...t, progress: taskMap[t.id]?.progress || 0,
      completed: taskMap[t.id]?.completed || 0, claimed: taskMap[t.id]?.claimed || 0
    }));
    const boosts = getActiveBoosts(user.id);
    let referralCount = 0;
    try { referralCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by = ?').get(user.id)?.c || 0; } catch (e) {}
    const referralLink = `https://t.me/CoinQuest_Staging_bot/app?startapp=ref_${user.referral_code}`;
    res.json({
      success: true,
      user: { id: user.id, username: user.username, firstName: user.first_name, coins: user.coins, tp: user.tp,
        level: user.level, coinsPerTap: user.coins_per_tap, idlePerSec: user.idle_per_sec, idleIncome: user.idle_per_sec, idleEarned },
      tasks: tasksWithProgress, boosts, referralCount, referralLink,
      referralEarned: user.referral_earnings || 0, isAdmin: ADMIN_IDS.includes(String(parseInt(user.id)))
    });
  } catch (e) { console.error('/api/init error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/tap', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { taps = 1 } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const coinsEarned = Math.max(1, taps) * (user.coins_per_tap || 1);
    const tpEarned = Math.max(1, taps);
    db.prepare('UPDATE users SET coins = coins + ?, tp = tp + ?, last_seen = ? WHERE id = ?')
      .run(coinsEarned, tpEarned, Math.floor(Date.now() / 1000), user.id);
    const tapTasks = db.prepare("SELECT t.*, ut.progress, ut.completed FROM tasks t LEFT JOIN user_tasks ut ON t.id = ut.task_id AND ut.user_id = ? WHERE t.type = 'tap' AND t.is_active = 1").all(user.id);
    for (const task of tapTasks) {
      if (task.completed) continue;
      const newProgress = (task.progress || 0) + Math.max(1, taps);
      const completed = newProgress >= task.target_value ? 1 : 0;
      db.prepare('INSERT INTO user_tasks (user_id, task_id, progress, completed) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, task_id) DO UPDATE SET progress = ?, completed = ?')
        .run(user.id, task.id, newProgress, completed, newProgress, completed);
    }
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({ success: true, coins: updatedUser.coins, tp: updatedUser.tp, coinsEarned, tpEarned });
  } catch (e) { console.error('/api/tap error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/claim-task', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const taskId = req.body?.taskId || req.body?.task_id;
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const userTask = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(tgUser.id, taskId);
    if (!userTask?.completed) return res.status(400).json({ error: 'Task not completed' });
    if (userTask?.claimed) return res.status(400).json({ error: 'Already claimed' });
    db.prepare('UPDATE user_tasks SET claimed = 1, completed_at = ? WHERE user_id = ? AND task_id = ?')
      .run(Math.floor(Date.now() / 1000), tgUser.id, taskId);
    db.prepare('UPDATE users SET coins = coins + ?, tp = tp + ? WHERE id = ?').run(task.reward_coins, task.reward_tp, tgUser.id);
    const updatedUser = db.prepare('SELECT coins, tp FROM users WHERE id = ?').get(tgUser.id);
    res.json({ success: true, coins: updatedUser.coins, tp: updatedUser.tp });
  } catch (e) { console.error('/api/claim-task error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/update-task-progress', (req, res) => { res.json({ success: true }); });

app.post('/api/redeem-promo', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const promo = db.prepare('SELECT * FROM promos WHERE code = ? AND is_active = 1').get(code.toUpperCase());
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    if (promo.uses >= promo.max_uses) return res.status(400).json({ error: 'Промокод исчерпан' });
    const alreadyUsed = db.prepare('SELECT id FROM promo_uses WHERE user_id = ? AND promo_id = ?').get(tgUser.id, promo.id);
    if (alreadyUsed) return res.status(400).json({ error: 'Вы уже использовали этот промокод' });
    db.prepare('INSERT INTO promo_uses (user_id, promo_id) VALUES (?, ?)').run(tgUser.id, promo.id);
    db.prepare('UPDATE promos SET uses = uses + 1 WHERE id = ?').run(promo.id);
    db.prepare('UPDATE users SET coins = coins + ?, tp = tp + ? WHERE id = ?').run(promo.reward_coins, promo.reward_tp, tgUser.id);
    const updatedUser = db.prepare('SELECT coins, tp FROM users WHERE id = ?').get(tgUser.id);
    res.json({ success: true, reward: { coins: promo.reward_coins, tp: promo.reward_tp }, coins: updatedUser.coins, tp: updatedUser.tp });
  } catch (e) { console.error('/api/redeem-promo error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/buy-boost', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { boostType } = req.body;
    const BOOST_PRICES = {
      'tap_x2': { coins: 5000, multiplier: 2, field: 'coins_per_tap' },
      'idle_x2': { coins: 8000, multiplier: 2, field: 'idle_per_sec' },
    };
    const boost = BOOST_PRICES[boostType];
    if (!boost) return res.status(400).json({ error: 'Unknown boost type' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.coins < boost.coins) return res.status(400).json({ error: 'Недостаточно монет' });
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(boost.coins, user.id);
    if (boost.field === 'coins_per_tap') {
      db.prepare('UPDATE users SET coins_per_tap = coins_per_tap * ? WHERE id = ?').run(boost.multiplier, user.id);
    } else {
      const current = user.idle_per_sec || 0.1;
      db.prepare('UPDATE users SET idle_per_sec = ? WHERE id = ?').run(current * boost.multiplier, user.id);
    }
    db.prepare('INSERT INTO boosts (user_id, boost_type, level) VALUES (?, ?, 1)').run(user.id, boostType);
    const updatedUser = db.prepare('SELECT coins, coins_per_tap, idle_per_sec FROM users WHERE id = ?').get(user.id);
    res.json({ success: true, ...updatedUser });
  } catch (e) { console.error('/api/buy-boost error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/referrals', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const referrals = db.prepare('SELECT id, username, first_name, coins, tp, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT 50').all(tgUser.id);
    const user = db.prepare('SELECT referral_code, referral_earnings FROM users WHERE id = ?').get(tgUser.id);
    const referralLink = `https://t.me/CoinQuest_Staging_bot/app?startapp=ref_${user?.referral_code}`;
    res.json({ success: true, referrals, referralLink, referralEarned: user?.referral_earnings || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', (req, res) => {
  try {
    const top = db.prepare('SELECT id, username, first_name, tp, coins FROM users ORDER BY tp DESC LIMIT 50').all();
    res.json({ success: true, leaderboard: top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tournament', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const tournament = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!tournament) return res.json({ success: true, tournament: null });
    const playersCount = db.prepare('SELECT COUNT(*) as c FROM tournament_entries WHERE tournament_id = ?').get(tournament.id)?.c || 0;
    const prizePool = tournament.prize_pool || (playersCount * tournament.entry_fee * TOURNAMENT_CONFIG.prizePoolPercent);
    const isInTournament = !!db.prepare('SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ?').get(tournament.id, tgUser.id);
    const topPlayers = db.prepare('SELECT u.id, u.username, u.first_name, u.tp FROM tournament_entries te JOIN users u ON u.id = te.user_id WHERE te.tournament_id = ? ORDER BY u.tp DESC LIMIT 10').all(tournament.id);
    res.json({ success: true, tournament: { ...tournament, prizePool: Math.round(prizePool * 100) / 100, playersCount, isInTournament, entryFee: TOURNAMENT_CONFIG.entryFee, prizePoolPercent: TOURNAMENT_CONFIG.prizePoolPercent * 100, platformPercent: TOURNAMENT_CONFIG.platformPercent * 100, topPlayers } });
  } catch (e) { console.error('/api/tournament error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/tournament-invoice', async (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const tournament = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!tournament) return res.status(404).json({ error: 'Нет активного турнира' });
    const alreadyIn = db.prepare('SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ?').get(tournament.id, tgUser.id);
    if (alreadyIn) return res.status(400).json({ error: 'Вы уже в турнире' });
    const response = await axios.post(`${CRYPTO_API_URL}/createInvoice`, {
      asset: 'TON', amount: TOURNAMENT_CONFIG.entryFee.toString(),
      description: `Вход в турнир TapCrown #${tournament.id}`,
      payload: JSON.stringify({ type: 'tournament_entry', userId: tgUser.id, tournamentId: tournament.id }),
      allow_comments: false, allow_anonymous: false
    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN } });
    const inv = response.data.result;
    res.json({ success: true, invoiceUrl: inv.pay_url, invoiceId: inv.invoice_id });
  } catch (e) { console.error('/api/tournament-invoice error:', e); res.status(500).json({ error: e.message }); }
});

// Ручное подтверждение оплаты турнира (polling после оплаты)
app.post('/api/tournament-confirm', async (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
    // Проверяем уже в турнире
    const tournament = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!tournament) return res.status(404).json({ error: 'Нет активного турнира' });
    const alreadyIn = db.prepare('SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ?').get(tournament.id, tgUser.id);
    if (alreadyIn) return res.json({ success: true, status: 'already_in' });
    // Запрашиваем статус инвойса у CryptoBot
    const resp = await axios.get(`${CRYPTO_API_URL}/getInvoices`, {
      params: { invoice_ids: String(invoiceId) },
      headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
    });
    const items = resp.data?.result?.items || [];
    const invoice = items[0];
    if (!invoice) return res.json({ success: false, status: 'not_found' });
    if (invoice.status !== 'paid') return res.json({ success: false, status: invoice.status });
    // Инвойс оплачен — засчитываем вход
    let data = {};
    try { data = JSON.parse(invoice.payload || '{}'); } catch(e) {}
    if (data.type !== 'tournament_entry' || data.userId != tgUser.id) {
      return res.status(400).json({ error: 'Неверный инвойс' });
    }
    db.prepare('INSERT OR IGNORE INTO tournament_entries (tournament_id, user_id, paid_amount, payment_id) VALUES (?, ?, ?, ?)')
      .run(tournament.id, tgUser.id, parseFloat(invoice.amount), String(invoice.invoice_id));
    db.prepare('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?')
      .run(parseFloat(invoice.amount) * TOURNAMENT_CONFIG.prizePoolPercent, tournament.id);
    // Уведомление
    if (BOT_TOKEN) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: tgUser.id,
        text: `✅ Вы вошли в турнир TapCrown #${tournament.id}!\n\nВзнос: ${invoice.amount} TON\nВаши TP: ${user?.tp || 0}\n\nУдачи! 🏆`
      }).catch(() => {});
    }
    res.json({ success: true, status: 'confirmed' });
  } catch (e) { console.error('/api/tournament-confirm error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/stars-invoice', async (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { packageId } = req.body;
    const pkg = STARS_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Unknown package' });
    const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      title: `${pkg.label} для TapCrown`,
      description: `Получи ${pkg.label} в игре TapCrown`,
      payload: JSON.stringify({ type: 'stars_purchase', userId: tgUser.id, packageId: pkg.id, coins: pkg.coins }),
      currency: 'XTR',
      prices: [{ label: pkg.label, amount: pkg.stars }]
    });
    if (!response.data.ok) throw new Error(response.data.description);
    res.json({ success: true, invoiceLink: response.data.result });
  } catch (e) { console.error('/api/stars-invoice error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/stars-success', (req, res) => {
  try {
    const tgUser = getUserFromRequest(req);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    const { packageId, telegramPaymentChargeId } = req.body;
    const pkg = STARS_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Unknown package' });
    const chargeId = telegramPaymentChargeId || null;
    if (chargeId) {
      const existing = db.prepare('SELECT id FROM payments WHERE external_id = ?').get(chargeId);
      if (existing) return res.status(400).json({ error: 'Already processed' });
    }
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(pkg.coins, tgUser.id);
    db.prepare('INSERT INTO payments (user_id, type, amount, currency, payload, status, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tgUser.id, 'stars', pkg.stars, 'XTR', JSON.stringify({ packageId }), 'completed', telegramPaymentChargeId || null);
    const updatedUser = db.prepare('SELECT coins FROM users WHERE id = ?').get(tgUser.id);
    res.json({ success: true, coins: updatedUser.coins });
  } catch (e) { console.error('/api/stars-success error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body;
    if (update.pre_checkout_query) {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        pre_checkout_query_id: update.pre_checkout_query.id, ok: true
      });
      return res.json({ ok: true });
    }
    if (update.message?.successful_payment) {
      const payment = update.message.successful_payment;
      const payload = JSON.parse(payment.invoice_payload || '{}');
      if (payload.type === 'stars_purchase') {
        const pkg = STARS_PACKAGES.find(p => p.id === payload.packageId);
        const uid = parseInt(payload.userId);
        if (pkg && uid) {
          const existing = db.prepare('SELECT id FROM payments WHERE external_id = ?').get(payment.telegram_payment_charge_id);
          if (!existing) {
            db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(pkg.coins, uid);
            db.prepare('INSERT INTO payments (user_id, type, amount, currency, payload, status, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(uid, 'stars', payment.total_amount, 'XTR', payment.invoice_payload, 'completed', payment.telegram_payment_charge_id);
            const LOGS_CHAT = process.env.LOGS_CHAT_ID || '-1002xxxxxxxxx';
            if (BOT_TOKEN && LOGS_CHAT) {
              axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: LOGS_CHAT,
                text: `⭐ Stars payment\nUser: ${uid}\nPackage: ${pkg.label}\nStars: ${payment.total_amount}\nCharge: ${payment.telegram_payment_charge_id}`
              }).catch(() => {});
            }
          }
        }
      }
      return res.json({ ok: true });
    }
    res.json({ ok: true });
  } catch (e) { console.error('/api/telegram-webhook error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/crypto-webhook', (req, res) => {
  try {
    const { update_type, payload: invoicePayload } = req.body;
    if (update_type === 'invoice_paid') {
      const invoice = invoicePayload;
      let data = {};
      try { data = JSON.parse(invoice.payload || '{}'); } catch (e) {}
      if (data.type === 'tournament_entry') {
        const { userId, tournamentId } = data;
        const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
        if (tournament && userId) {
          const alreadyIn = db.prepare('SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ?').get(tournamentId, userId);
          if (!alreadyIn) {
            db.prepare('INSERT INTO tournament_entries (tournament_id, user_id, paid_amount, payment_id) VALUES (?, ?, ?, ?)')
              .run(tournamentId, userId, invoice.amount, invoice.invoice_id);
            db.prepare('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?')
              .run(parseFloat(invoice.amount) * TOURNAMENT_CONFIG.prizePoolPercent, tournamentId);
            if (BOT_TOKEN) {
              const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
              axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId,
                text: `✅ Вы вошли в турнир TapCrown #${tournamentId}!\n\nВзнос: ${invoice.amount} TON\nВаши TP: ${user?.tp || 0}\n\nУдачи! 🏆`
              }).catch(() => {});
            }
          }
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error('/api/crypto-webhook error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0;
    const totalCoins = db.prepare('SELECT SUM(coins) as s FROM users').get()?.s || 0;
    const totalTp = db.prepare('SELECT SUM(tp) as s FROM users').get()?.s || 0;
    const totalPayments = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status = 'completed'").get()?.c || 0;
    res.json({ success: true, totalUsers, totalCoins, totalTp, totalPayments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, first_name, coins, tp, level, created_at FROM users ORDER BY tp DESC LIMIT 100').all();
    res.json({ success: true, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



app.get('/api/admin/referrals', requireAdmin, (req, res) => {
  try {
    const topReferrers = db.prepare(`
      SELECT u.id, u.username, u.first_name,
             COUNT(r.id) as referral_count,
             COALESCE(u.referral_earnings, 0) as referral_earnings
      FROM users u
      LEFT JOIN users r ON r.referred_by = u.id
      GROUP BY u.id
      HAVING COUNT(r.id) > 0
      ORDER BY COUNT(r.id) DESC
      LIMIT 50
    `).all();
    const totalReferrals = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by IS NOT NULL').get()?.c || 0;
    const recentReferrals = db.prepare(`
      SELECT u.id, u.username, u.first_name, u.created_at,
             r.username as inviter_username, r.first_name as inviter_first_name
      FROM users u
      LEFT JOIN users r ON r.id = u.referred_by
      WHERE u.referred_by IS NOT NULL
      ORDER BY u.created_at DESC
      LIMIT 20
    `).all();
    res.json({ success: true, topReferrers, totalReferrals, recentReferrals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/list-promos', requireAdmin, (req, res) => {
  try {
    const promos = db.prepare('SELECT * FROM promos ORDER BY created_at DESC').all();
    res.json({ success: true, promos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/promos', requireAdmin, (req, res) => {
  try {
    const { action, code, rewardCoins, rewardTp, maxUses } = req.body;
    if (action === 'list' || !action) {
      const promos = db.prepare('SELECT * FROM promos ORDER BY created_at DESC').all();
      return res.json({ success: true, promos });
    }
    if (action === 'create') {
      if (!code) return res.status(400).json({ error: 'Code required' });
      db.prepare('INSERT INTO promos (code, reward_coins, reward_tp, max_uses) VALUES (?, ?, ?, ?)')
        .run(code.toUpperCase(), rewardCoins || 0, rewardTp || 0, maxUses || 100);
      return res.json({ success: true });
    }
    if (action === 'delete') {
      if (!code) return res.status(400).json({ error: 'Code required' });
      db.prepare('DELETE FROM promos WHERE code = ?').run(code.toUpperCase());
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/give-coins', requireAdmin, (req, res) => {
  try {
    const { userId, coins, tp } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    db.prepare('UPDATE users SET coins = coins + ?, tp = tp + ? WHERE id = ?').run(coins || 0, tp || 0, userId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/create-promo', requireAdmin, (req, res) => {
  try {
    const { code, rewardCoins, rewardTp, maxUses } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    db.prepare('INSERT INTO promos (code, reward_coins, reward_tp, max_uses) VALUES (?, ?, ?, ?)')
      .run(code.toUpperCase(), rewardCoins || 0, rewardTp || 0, maxUses || 100);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => { res.json({ status: 'ok', timestamp: Date.now() }); });

app.get('/api/check-webhook', async (req, res) => {
  try {
    const tgWebhook = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    res.json({ success: true, telegramWebhook: tgWebhook.data.result, serverUrl: SERVER_URL, cryptoApiUrl: CRYPTO_API_URL });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Получить текущий турнир для админа
app.get('/api/admin/tournament', requireAdmin, (req, res) => {
  try {
    const tournament = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!tournament) return res.json({ success: true, tournament: null });
    const playersCount = db.prepare('SELECT COUNT(*) as c FROM tournament_entries WHERE tournament_id = ?').get(tournament.id)?.c || 0;
    res.json({ success: true, tournament: { ...tournament, playersCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Создать новый турнир (админ)
app.post('/api/admin/create-tournament', requireAdmin, (req, res) => {
  try {
    const existing = db.prepare("SELECT id FROM tournaments WHERE status = 'active'").get();
    if (existing) return res.status(400).json({ error: 'Уже есть активный турнир. Завершите его сначала.' });
    const { title, entryFee, durationDays } = req.body;
    if (!title) return res.status(400).json({ error: 'Укажите название турнира' });
    const fee = parseFloat(entryFee) || 0.5;
    const days = parseInt(durationDays) || 7;
    const now = Math.floor(Date.now() / 1000);
    const endAt = now + days * 24 * 3600;
    const result = db.prepare(
      "INSERT INTO tournaments (title, status, entry_fee, prize_pool, starts_at, ends_at) VALUES (?, 'active', ?, 0, ?, ?)"
    ).run(title, fee, now, endAt);
    res.json({ success: true, message: 'Турнир создан', id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Завершить активный турнир (админ)
app.post('/api/admin/end-tournament', requireAdmin, (req, res) => {
  try {
    const tournament = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!tournament) return res.status(404).json({ error: 'Нет активного турнира' });
    db.prepare("UPDATE tournaments SET status = 'finished' WHERE id = ?").run(tournament.id);
    res.json({ success: true, message: 'Турнир завершён' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, async () => {
  console.log(`🚀 TapCrown server running on port ${PORT}`);
  if (BOT_TOKEN && SERVER_URL) {
    try {
      const webhookUrl = `${SERVER_URL}/api/telegram-webhook`;
      const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        url: webhookUrl, allowed_updates: ['message', 'pre_checkout_query']
      });
      if (response.data.ok) console.log(`✅ Telegram webhook registered: ${webhookUrl}`);
      else console.warn('⚠️ Telegram webhook failed:', response.data.description);
    } catch (e) { console.warn('⚠️ Could not register Telegram webhook:', e.message); }
  }
  if (CRYPTO_BOT_TOKEN && SERVER_URL) {
    try {
      await axios.post(`${CRYPTO_API_URL}/setWebhook`, { url: `${SERVER_URL}/api/crypto-webhook` }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN } });
      console.log(`✅ CryptoBot webhook registered`);
    } catch (e) { console.warn('⚠️ Could not register CryptoBot webhook:', e.message); }
  }
});
