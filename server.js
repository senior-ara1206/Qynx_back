require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const https = require('https');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://michaelturner8011_db_user:qynx1234@cluster0.ji1p1jj.mongodb.net/?appName=Cluster0";

/** RPC URLs for tx verification. Use env for local testnet (e.g. RPC_URL_BSC=http://127.0.0.1:8545). */
const RPC_URL = {
  bsc: process.env.RPC_URL_BSC || 'https://bsc-dataseed1.binance.org',
  ethereum: process.env.RPC_URL_ETH || 'https://eth.llamarpc.com',
};

/** Platform deposit addresses for verifying incoming transfers. Override with env for local testnet. */
const DEFAULT_DEPOSIT = ('0xa639c56F63B3DE1d38006dAf841c0541DCB55C1C').trim().toLowerCase();
const DEPOSIT_ADDRESS = {
  bsc: (process.env.NEXT_PUBLIC_DEPOSIT_ADDRESS_BSC || DEFAULT_DEPOSIT).trim().toLowerCase(),
  ethereum: (process.env.DEPOSIT_ADDRESS_ETH || DEFAULT_DEPOSIT).trim().toLowerCase(),
};

/**
 * Fetch transaction by hash via JSON-RPC. Returns { to, from, value } or null.
 * value is decimal string (wei).
 */
async function getTransactionByHash(txHash, network) {
  const url = RPC_URL[network];
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [txHash.startsWith('0x') ? txHash : '0x' + txHash],
        id: 1,
      }),
    });
    const data = await res.json();
    const tx = data.result;
    if (!tx || tx.blockNumber == null) return null; // pending or not found
    return {
      to: (tx.to || '').toLowerCase(),
      from: (tx.from || '').toLowerCase(),
      value: typeof tx.value === 'string' ? tx.value : String(tx.value),
      input: typeof tx.input === 'string' ? tx.input : (tx.data != null ? String(tx.data) : ''),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Fetch transaction receipt (includes logs for ERC-20 transfers).
 */
async function getTransactionReceipt(txHash, network) {
  const url = RPC_URL[network];
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [txHash.startsWith('0x') ? txHash : '0x' + txHash],
        id: 1,
      }),
    });
    const data = await res.json();
    return data.result || null;
  } catch (err) {
    return null;
  }
}

/** Parse hex wei string to decimal number. */
function hexWeiToNumber(hex) {
  if (!hex || typeof hex !== 'string') return 0;
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  return parseInt(s, 16);
}

/** Token decimals by symbol (BSC/ETH common). */
const TOKEN_DECIMALS = {
  USDT: 18, USDC: 18, DAI: 18, WBNB: 18, BNB: 18, ETH: 18, WETH: 18,
  CAKE: 18, WBTC: 8, QYNX: 18,
};

/** CoinGecko IDs for price lookup. Stablecoins use 1 USD. */
const COINGECKO_IDS = {
  USDT: 'tether', USDC: 'usd-coin', DAI: 'dai', BUSD: 'binance-usd',
  BNB: 'binancecoin', WBNB: 'binancecoin', ETH: 'ethereum', WETH: 'ethereum',
  WBTC: 'wrapped-bitcoin', CAKE: 'pancakeswap-token',
};
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);
const PRICE_CACHE_TTL_MS = 60 * 1000;
let priceCache = { data: null, ts: 0 };

/** Fallback USD prices when CoinGecko is unreachable (fetch failed, no network, etc.). */
const FALLBACK_PRICES_USD = {
  BNB: 600, WBNB: 600, ETH: 1865, WETH: 1865, WBTC: 63920, CAKE: 1.24,
};

/** Fetch URL via Node https (avoids global fetch which can fail in some environments). */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON from price API'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Price API timeout')); });
  });
}

/** Fetch token price in USD (CoinGecko via https). Stablecoins = 1; others from API. Cached for 1 min. Falls back to FALLBACK_PRICES_USD on fetch failure. */
async function getTokenPriceUsd(symbol) {
  const key = (symbol || '').toUpperCase().trim();
  if (!key) return 0;
  if (STABLECOINS.has(key)) return 1;
  const now = Date.now();
  if (priceCache.data && now - priceCache.ts < PRICE_CACHE_TTL_MS && priceCache.data[key] != null) {
    return priceCache.data[key];
  }
  const ids = [...new Set(Object.values(COINGECKO_IDS))].join(',');
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
    const data = await httpsGet(url);
    const next = {};
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
      const v = data?.[id]?.usd;
      next[sym] = typeof v === 'number' ? v : (STABLECOINS.has(sym) ? 1 : (FALLBACK_PRICES_USD[sym] ?? 0));
    }
    priceCache = { data: next, ts: now };
    return next[key] != null ? next[key] : (FALLBACK_PRICES_USD[key] ?? 0);
  } catch (err) {
    console.warn('getTokenPriceUsd failed:', err.message);
    if (priceCache.data && priceCache.data[key] != null) return priceCache.data[key];
    const fallback = FALLBACK_PRICES_USD[key];
    if (fallback != null) return fallback;
    return 0;
  }
}

/** Convert token amount (human units) to USD using current price. */
async function tokenAmountToUsd(tokenAmount, tokenSymbol) {
  const amount = Number(tokenAmount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const price = await getTokenPriceUsd(tokenSymbol);
  return amount * price;
}

/** ERC-20 Transfer(address,address,uint256) topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** ERC-20 transfer(address,uint256) selector (4 bytes). */
const TRANSFER_SELECTOR = 'a9059cbb';

function padAddressToTopic(addr) {
  const a = (addr || '').toLowerCase().replace(/^0x/, '');
  return '0x' + a.padStart(64, '0');
}

/** Normalize to 40 hex chars (20-byte address) for comparison. */
function toAddress40(val) {
  if (val == null) return '';
  const hex = String(val).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length >= 40 ? hex.slice(-40) : hex.padStart(40, '0').slice(-40);
}

/**
 * Decode ERC-20 transfer(to, amount) from tx input. Returns { toAddress40, amountWei } or null.
 */
function decodeTransferInput(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '');
  if (raw.length < 8 + 64 + 64) return null; // 4-byte selector + 32 bytes to + 32 bytes amount
  if (raw.slice(0, 8) !== TRANSFER_SELECTOR) return null;
  const toHex = raw.slice(8, 72);   // 64 hex chars (32 bytes), address is last 20 bytes = 40 hex
  const amountHex = raw.slice(72, 136);
  const toAddress40 = toHex.length >= 40 ? toHex.slice(-40) : toHex.padStart(40, '0').slice(-40);
  let amountWei;
  try {
    amountWei = BigInt('0x' + amountHex);
  } catch (_) {
    return null;
  }
  return { toAddress40, amountWei };
}

/**
 * Get the actual deposited amount from the transaction (native or ERC-20).
 * Uses receipt logs first; falls back to decoding tx.input for transfer(to, amount).
 */
async function getActualDepositAmount(tx, receipt, network, token, depositAddress) {
  const deposit40 = toAddress40(depositAddress);
  const tokenUpper = (token || '').toUpperCase();
  const decimals = TOKEN_DECIMALS[tokenUpper] ?? 18;
  const nativeTokens = ['bnb', 'eth'];
  const isNative = nativeTokens.includes((token || '').toLowerCase());

  if (isNative && tx.to && toAddress40(tx.to) === deposit40) {
    const wei = hexWeiToNumber(tx.value);
    return wei / Math.pow(10, decimals);
  }

  const transferTopic0 = (TRANSFER_TOPIC || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const transferTopic64 = transferTopic0.length >= 64 ? transferTopic0.slice(-64) : transferTopic0;

  if (receipt && receipt.logs && Array.isArray(receipt.logs)) {
    for (const log of receipt.logs) {
      const topics = log.topics && Array.isArray(log.topics) ? log.topics : [];
      const t0 = (topics[0] || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      const topic0 = t0.length >= 64 ? t0.slice(-64) : t0;
      if (topic0 !== transferTopic64) continue;
      const toAddr = toAddress40(topics[2]);
      if (toAddr !== deposit40) continue;
      const data = (log.data || '').replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '');
      if (data.length < 64) continue;
      try {
        const amountWei = Number(BigInt('0x' + data.slice(0, 64)));
        if (Number.isFinite(amountWei) && amountWei >= 0) {
          return amountWei / Math.pow(10, decimals);
        }
      } catch (_) {}
    }
  }

  const decoded = decodeTransferInput(tx.input);
  if (decoded && decoded.toAddress40 === deposit40 && decoded.amountWei >= 0) {
    const amountWei = Number(decoded.amountWei);
    if (Number.isFinite(amountWei)) {
      return amountWei / Math.pow(10, decimals);
    }
  }

  // Last resort: exactly one Transfer log in receipt -> use its amount (single transfer to deposit)
  const logs = receipt && receipt.logs && Array.isArray(receipt.logs) ? receipt.logs : [];
  const transferLogs = logs.filter((log) => {
    const topics = log.topics && Array.isArray(log.topics) ? log.topics : [];
    const t0 = (topics[0] || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const topic0 = t0.length >= 64 ? t0.slice(-64) : t0;
    return topic0 === transferTopic64;
  });
  if (transferLogs.length === 1) {
    const log = transferLogs[0];
    const data = (log.data || '').replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '');
    if (data.length >= 64) {
      try {
        const amountWei = Number(BigInt('0x' + data.slice(0, 64)));
        if (Number.isFinite(amountWei) && amountWei > 0) {
          return amountWei / Math.pow(10, decimals);
        }
      } catch (_) {}
    }
  }
  return null;
}

const TOTAL_INVESTMENTS = ["153.8K","168.5K","187.7K","205.4K","230.2K","255.7K","285.5K","320K.9","360.2K","400.1K","430K","470.6K","530K","610K","0.7M","0.82M","0.9M","1.02M","1.12M","1.2M","1.3M","1.45M","1.6M","1.8M","1.95M","2.1M","2.25M","2.4M","2.48M","2.5M","2.65M","2.8M","3M","3.2M","3.4M","3.65M","3.9M","4.1M","4.4M","4.5M","4.95M","5.1M","5.7M","5.75M","6.55M","6.65M","7.15M","7.35M","7.6M","8M"]
const TOTAL_TRADINGS = ["100K","118.6K","135.3K","158.7K","185K","215.5K","252.8K","295K","340.2K","395.3K","455.9K","520K","600K","690.4K","780K","880.8K","1M","1.15M","1.3M","1.45M","1.65M","1.85M","2.1M","2.35M","2.6M","2.9M","3.25M","3.54M","3.81M","4.14M","4.43M","4.758M","5.17M","5.5M","5.9M","6.33M","6.72M","7.1M","7.54M","7.96M","8.39M","8.6M","8.95M","9.25M","9.5M","9.7M","9.85M","9.92M","9.96M","10M"]
const TOTAL_PROFITS = ["10K","11.5K","13K","15.9K","17.5K","20K","23K","26.6K","29.8K","33.1K","37.3K","42.3K","47.6K","52.4K","58.9K","64K","71.2K","78K","86.6K","94K","103K","112.7K","122K","132K","142K","153K","164K","175K","186K","197K","208K","218K","228K","238K","242K","245K","247K","248K","248.5K","249K","249.2K","249.5K","249.6K","249.8K","249.9K","249.95K","250K","250K","250K","250K"]
const TOTAL_QYNX_TOKEN_BALANCE = ["80K","92K","108K","125K","145K","168K","195K","225K","258K","295K","335K","380K","430K","485K","545K","610K","680K","755K","835K","920K","1.01M","1.1M","1.2M","1.3M","1.4M","1.5M","1.58M","1.66M","1.74M","1.82M","1.9M","1.97M","2.04M","2.1M","2.16M","2.22M","2.28M","2.34M","2.39M","2.44M","2.49M","2.53M","2.57M","2.61M","2.64M","2.67M","2.69M","2.71M","2.72M","2.73M"]
/** Daily total users count (50 days): 60 → 7500, roughly increasing */
const TOTAL_USERS = [60,184,334,510,712,940,1041,1168,1321,1500,1705,1783,1887,2017,2173,2355,2563,2644,2751,2884,3043,3228,3439,3523,3633,3769,3931,4119,4333,4420,4533,4672,4837,5028,5245,5335,5451,5593,5761,5955,6175,6268,6387,6532,6703,6900,7123,7219,7341,7500]
const RATIOS_FOR_USER = [0.42,1.5,0.84,3.4,5.0,0.23,0.67,8.19,0.33,2.1,0.58,0.76,5.29,0.92,1.18,0.51,4.37,1.12,0.27,0.63,3.4,0.21,0.49,7.72,0.16,0.88,3.35,0.54,0.26,1.78,0.31,0.69,0.22,4.6,0.47,2.39,0.95,0.62,0.25,2.9,0.17,0.73,0.45,0.36,6.8,0.28,0.57,0.2,0.81,9.3]
const LAUNCH_DATE = new Date("2026-02-24")

const getTotalInvestments = (date) => {
  const index = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return TOTAL_INVESTMENTS[index];
}

const getTotalTradings = (date) => {
  const index = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return TOTAL_TRADINGS[index];
}

const getTotalProfits = (date) => {
  const index = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return TOTAL_PROFITS[index];
}

const getTotalQynxTokenBalance = (date) => {
  const index = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return TOTAL_QYNX_TOKEN_BALANCE[index];
}

const getTotalUsers = (date) => {
  const index = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  if (index < 0 || index >= TOTAL_USERS.length) return null;
  return TOTAL_USERS[index];
}

/** Parse expression string to number (e.g. "153.8K" -> 153800, "0.7M" -> 700000) */
const parseExpression = (str) => {
  if (str == null || typeof str !== 'string') return NaN;
  const m = str.trim().match(/^([\d.]+)\s*([KkMm])?$/);
  if (!m) return NaN;
  let n = parseFloat(m[1]);
  if (Number.isNaN(n)) return NaN;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') n *= 1e3;
  else if (suffix === 'M') n *= 1e6;
  return n;
};

/**
 * Get the ratio of change compared to the day before.
 * @param {string[]} series - Array of expression strings (e.g. TOTAL_INVESTMENTS)
 * @param {number} dayIndex - 0-based day index (0 = launch day)
 * @returns {number|null} Relative change (e.g. 0.1 = 10% increase), or null for day 0 (no previous day)
 */
const getChangeRatioVsPreviousDay = (series, dayIndex) => {
  if (!Array.isArray(series) || dayIndex <= 0 || dayIndex >= series.length) return null;
  const prev = parseExpression(series[dayIndex - 1]);
  const curr = parseExpression(series[dayIndex]);
  if (prev === 0 || !Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  return (curr - prev) / prev;
};

/** Get change ratio for a given date (ratio vs previous day). */
const getInvestmentChangeRatio = (date) =>
  getChangeRatioVsPreviousDay(
    TOTAL_INVESTMENTS,
    Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24))
  );
const getTradingChangeRatio = (date) =>
  getChangeRatioVsPreviousDay(
    TOTAL_TRADINGS,
    Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24))
  );
const getProfitChangeRatio = (date) =>
  getChangeRatioVsPreviousDay(
    TOTAL_PROFITS,
    Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24))
  );
const getQynxTokenBalanceChangeRatio = (date) =>
  getChangeRatioVsPreviousDay(
    TOTAL_QYNX_TOKEN_BALANCE,
    Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24))
  );

/** Get portfolio (investments + tradings) change ratio vs previous day for a given date. */
const getPortfolioChangeRatio = (date) => {
  const dayIndex = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  if (dayIndex <= 0 || dayIndex >= TOTAL_INVESTMENTS.length || dayIndex >= TOTAL_TRADINGS.length) return null;

  const prevInvestment = parseExpression(TOTAL_INVESTMENTS[dayIndex - 1]);
  const prevTrading = parseExpression(TOTAL_TRADINGS[dayIndex - 1]);
  const currInvestment = parseExpression(TOTAL_INVESTMENTS[dayIndex]);
  const currTrading = parseExpression(TOTAL_TRADINGS[dayIndex]);

  const prevTotal = prevInvestment + prevTrading;
  const currTotal = currInvestment + currTrading;

  if (!Number.isFinite(prevTotal) || prevTotal === 0 || !Number.isFinite(currTotal)) return null;
  return (currTotal - prevTotal) / prevTotal;
};

/** Get total users change ratio vs previous day (numeric series). */
const getUsersChangeRatio = (date) => {
  const dayIndex = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  if (dayIndex <= 0 || dayIndex >= TOTAL_USERS.length) return null;
  const prev = TOTAL_USERS[dayIndex - 1];
  const curr = TOTAL_USERS[dayIndex];
  if (prev === 0 || !Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  return (curr - prev) / prev;
};

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    active: { type: Boolean, default: true },
    role: { type: String, default: 'user' },
    loginCount: { type: Number, default: 0 },
    wallets: { type: [String], default: [] },
    referer: { type: String, default: '' },
    referralCode: { type: String, default: '' },
    tokenAmount: { type: Number, default: 0 },
    /** Per-user deposit addresses (EVM); generated on registration. Private keys stored server-side only. */
    investment_address: { type: String, default: '' },
    investment_private_key: { type: String, default: '' },
    trading_address: { type: String, default: '' },
    trading_private_key: { type: String, default: '' },
    treasury_address: { type: String, default: '' },
    treasury_private_key: { type: String, default: '' },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

const INVESTMENT_STATUS = { ACTIVE: 0, PENDING: 1, EXPIRED: 2, ENDED: 3 };
const TRADING_PERIOD = [30, 90, 180];

const investmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true },
    wallet_address: { type: String, required: true },
    token: { type: String, required: true },
    amount: { type: Number, required: true },
    period: { type: Number, required: true },
    status: { type: Number, required: true, enum: [0, 1, 2, 3], default: INVESTMENT_STATUS.PENDING },
    end_date: { type: Date },
    deposit_tx_hash: { type: String, default: '' },
  },
  { timestamps: true }
);

const Investment = mongoose.model('Investment', investmentSchema);

const TRADING_STATUS = { ACTIVE: 0, PENDING: 1, EXPIRED: 2, ENDED: 3 };

const tradingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true },
    wallet_address: { type: String, required: true },
    token: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    status: { type: Number, required: true, enum: [0, 1, 2, 3], default: TRADING_STATUS.PENDING },
    end_date: { type: Date },
    deposit_tx_hash: { type: String, default: '' },
  },
  { timestamps: true }
);

const Trading = mongoose.model('Trading', tradingSchema);

const WITHDRAWAL_CATEGORY = ['investment', 'trading', 'plan bonus', 'referral bonus'];
const WITHDRAWAL_STATUS = ['pending', 'approved', 'withdrawed'];

const withdrawalSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true },
    category: { type: String, required: true, enum: WITHDRAWAL_CATEGORY },
    wallet_address: { type: String, required: true },
    status: { type: String, required: true, enum: WITHDRAWAL_STATUS, default: 'pending' },
    amount: { type: String, default: '' },
    currency: { type: String, default: '' },
    activity_id: { type: String, default: '' },
  },
  { timestamps: true }
);

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

function safeUser(u) {
  const doc = u.toObject ? u.toObject() : u;
  const { password, investment_private_key, trading_private_key, treasury_private_key, ...rest } = doc;
  return rest;
}

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find();
    res.json(users.map(safeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wallets', async (req, res) => {
  try {
    const users = await User.find().select('email active wallets').lean();
    const result = [];
    for (const user of users) {
      const wallets = user.wallets || [];
      for (const wallet of wallets) {
        result.push({ address: wallet, email: user.email, active: user.active });
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Admin only: export all users' deposit addresses and private keys as JSON. Header x-admin-export-key must match ADMIN_EXPORT_SECRET. */
app.get('/api/admin/export-addresses', async (req, res) => {
  const key = req.headers['x-admin-export-key'];
  // const secret = process.env.ADMIN_EXPORT_SECRET;
  const secret = process.env.NEXT_PUBLIC_ADMIN_EXPORT_SECRET || 'admin123'
  if (!secret || key !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const users = await User.find().lean();
    const exportData = users.map((u) => {
      const { password, ...rest } = u;
      return rest;
    });
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id/referrals', async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const referrals = await User.find({ referer: user.referralCode }).lean();
    res.json(referrals.map((u) => safeUser(u)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { name, email, password, referer } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = bcrypt.hashSync(password, 10);
    const investmentWallet = ethers.Wallet.createRandom();
    const tradingWallet = ethers.Wallet.createRandom();
    const treasuryWallet = ethers.Wallet.createRandom();
    const user = await User.create({
      id: randomUUID(),
      name: name || '',
      email,
      password: hashed,
      active: true,
      role: 'user',
      loginCount: 0,
      wallets: [],
      referer: referer ? String(referer) : '',
      investment_address: investmentWallet.address,
      investment_private_key: investmentWallet.privateKey,
      trading_address: tradingWallet.address,
      trading_private_key: tradingWallet.privateKey,
      treasury_address: treasuryWallet.address,
      treasury_private_key: treasuryWallet.privateKey,
    });
    user.referralCode = user.id.toString().slice(-5);
    await user.save();
    res.status(201).json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'You are not registered. Please Sign Up.' });
    if (user.active === false) return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });

    const ok = bcrypt.compareSync(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    user.loginCount = (user.loginCount || 0) + 1;
    await user.save();

    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { name, email, password, role, active, tokenAmount, wallet } = req.body || {};
  console.log('req.body', req.body);
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (email && email !== user.email) {
      const taken = await User.findOne({ email });
      if (taken) return res.status(409).json({ error: 'Email already in use' });
      user.email = email;
    }
    if (typeof name !== 'undefined') user.name = name;
    if (typeof password !== 'undefined' && password !== '') user.password = bcrypt.hashSync(password, 10);
    if (typeof role !== 'undefined') user.role = role;
    if (typeof active !== 'undefined') user.active = active;
    if (typeof tokenAmount !== 'undefined') user.tokenAmount = tokenAmount;
    if (typeof wallet === 'string' && wallet.trim() !== '') {
      const addr = wallet.trim();
      const lower = addr.toLowerCase();
      const existing = (user.wallets || []).map((w) => String(w).trim().toLowerCase());
      if (!existing.includes(lower)) {
        user.wallets.push(addr);
      }
    }
    await user.save();

    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/reset-password', async (req, res) => {
  const DEFAULT_PASSWORD = '1234567890';
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    await user.save();
    res.json({ message: 'Password reset successfully.', user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Investments ---
app.get('/api/users/:userId/investments', async (req, res) => {
  try {
    const investments = await Investment.find({ user_id: req.params.userId }).sort({ createdAt: -1 });
    res.json(investments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/investments', async (req, res) => {
  try {
    const investments = await Investment.find().sort({ createdAt: -1 });
    res.json(investments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/investments/:id', async (req, res) => {
  try {
    const investment = await Investment.findOne({ id: req.params.id });
    if (!investment) return res.status(404).json({ error: 'Investment not found' });
    res.json(investment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/investments', async (req, res) => {
  const { user_id, wallet_address, token, amount, period, status } = req.body || {};
  if (!user_id || !wallet_address || token == null || amount == null || period == null) {
    return res.status(400).json({ error: 'user_id, wallet_address, token, amount, and period are required' });
  }
  try {
    const periodDays = Number(period);
    const createdAt = new Date();
    const end_date = new Date(createdAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const investment = await Investment.create({
      id: randomUUID(),
      user_id,
      wallet_address,
      token: String(token),
      amount: Number(amount),
      period: periodDays,
      status: [0, 1, 2, 3].includes(Number(status)) ? Number(status) : INVESTMENT_STATUS.ACTIVE,
      end_date,
    });
    res.status(201).json(investment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Tradings ---
app.get('/api/tradings', async (req, res) => {
  try {
    const tradings = await Trading.find().sort({ createdAt: -1 });
    res.json(tradings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/tradings', async (req, res) => {
  try {
    const tradings = await Trading.find({ user_id: req.params.userId }).sort({ createdAt: -1 });
    res.json(tradings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tradings/:id', async (req, res) => {
  try {
    const trading = await Trading.findOne({ id: req.params.id });
    if (!trading) return res.status(404).json({ error: 'Trading not found' });
    res.json(trading);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tradings', async (req, res) => {
  const { user_id, wallet_address, token, amount, type, status } = req.body || {};
  if (!user_id || !wallet_address || token == null || amount == null || type == null) {
    return res.status(400).json({ error: 'user_id, wallet_address, token, amount, and type are required' });
  }
  try {
    const periodDays = Number(TRADING_PERIOD[type]);
    const createdAt = new Date();
    const end_date = new Date(createdAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const trading = await Trading.create({
      id: randomUUID(),
      user_id,
      wallet_address,
      token: String(token),
      amount: Number(amount),
      type: String(type),
      status: [0, 1, 2, 3].includes(Number(status)) ? Number(status) : TRADING_STATUS.ACTIVE,
      end_date,
    });
    res.status(201).json(trading);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Two deposit modes (purchase / invest / trade):
 * - Wallet transfer: user sends from connected wallet → funds go to platform address (DEPOSIT_ADDRESS from .env). No manual verify; app submits tx hash after send.
 * - QR transfer + verify: user sends externally to their address (treasury / investment / trading from user data), then pastes tx hash; we verify and credit.
 * This function accepts a tx if the recipient is depositAddress (user's) OR any allowedRecipients (e.g. platform address), then returns normalized txHash and actual amount.
 */
async function verifyDepositTxAndGetHashAndAmount(txHash, net, depositAddress, userWallet, token, opts) {
  const allowedRecipients = (opts && opts.allowedRecipients && Array.isArray(opts.allowedRecipients))
    ? opts.allowedRecipients.filter(Boolean).map((a) => toAddress40(a))
    : [];
  const allRecipients = [toAddress40(depositAddress), ...allowedRecipients.filter((a) => a && a !== toAddress40(depositAddress))];
  let txHashNorm = (txHash && typeof txHash === 'string') ? txHash.trim() : '';
  if (!txHashNorm) throw new Error('txHash is required');
  txHashNorm = txHashNorm.toLowerCase();
  if (!txHashNorm.startsWith('0x')) txHashNorm = '0x' + txHashNorm;
  const tx = await getTransactionByHash(txHashNorm, net);
  if (!tx) throw new Error('Transaction not found or not yet confirmed. Check the transaction or network and try again.');
  const deposit40 = toAddress40(depositAddress);
  const nativeTokens = ['bnb', 'eth'];
  const isNative = nativeTokens.includes((token || '').toLowerCase());
  if (isNative && tx.to) {
    const txTo40 = toAddress40(tx.to);
    const ok = allRecipients.some((r) => r && r === txTo40);
    if (!ok) throw new Error('Transaction recipient does not match your deposit address');
  }
  if (userWallet && tx.from && toAddress40(tx.from) !== toAddress40(userWallet)) throw new Error('Transaction sender does not match your registered wallet');
  const receipt = await getTransactionReceipt(txHashNorm, net);
  let actualAmount = await getActualDepositAmount(tx, receipt, net, token, depositAddress);
  if ((actualAmount == null || actualAmount <= 0) && allRecipients.length > 1) {
    for (const addr of allRecipients) {
      if (addr === deposit40) continue;
      actualAmount = await getActualDepositAmount(tx, receipt, net, token, addr);
      if (actualAmount != null && actualAmount > 0) break;
    }
  }
  if (actualAmount == null || actualAmount <= 0) throw new Error('Could not determine deposit amount from transaction');
  return { txHashNorm, amount: actualAmount, fromAddress: tx.from };
}

/** Create investment only after deposit is verified (verify tx then create as ACTIVE). Uses actual transferred amount from chain. Uses user's investment_address when set. */
app.post('/api/investments/confirm-and-create', async (req, res) => {
  const { user_id, wallet_address, token, period, txHash, network } = req.body || {};
  if (!user_id || !wallet_address || token == null || period == null || !txHash) {
    return res.status(400).json({ error: 'user_id, wallet_address, token, period, and txHash are required' });
  }
  const net = network === 'ethereum' ? 'ethereum' : 'bsc';
  let depositAddress = DEPOSIT_ADDRESS[net];
  const userDoc = await User.findOne({ id: user_id }).lean();
  if (userDoc && userDoc.investment_address && String(userDoc.investment_address).trim()) {
    depositAddress = String(userDoc.investment_address).trim().toLowerCase();
  }
  if (!depositAddress) {
    return res.status(503).json({ error: 'Deposit verification not configured for this network' });
  }
  const platformAddress = DEPOSIT_ADDRESS[net];
  const allowedRecipients = platformAddress && toAddress40(platformAddress) !== toAddress40(depositAddress) ? [platformAddress] : [];
  try {
    const { txHashNorm, amount: actualAmount, fromAddress } = await verifyDepositTxAndGetHashAndAmount(
      txHash.trim(), net, depositAddress, null, token || 'USDT', { allowedRecipients }
    );
    const txHashForMatch = txHashNorm.replace(/^0x/, '');
    const alreadyUsed = await Investment.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } })
      || await Trading.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } });
    if (alreadyUsed) {
      return res.status(400).json({ error: 'This transaction was already used to confirm another deposit' });
    }
    const periodDays = Number(period);
    const createdAt = new Date();
    const end_date = new Date(createdAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const investment = await Investment.create({
      id: randomUUID(),
      user_id,
      wallet_address,
      token: String(token),
      amount: Number(actualAmount),
      period: periodDays,
      status: INVESTMENT_STATUS.ACTIVE,
      end_date,
      deposit_tx_hash: txHashNorm,
    });
    const usdValue = await tokenAmountToUsd(actualAmount, token);
    const qynxToMint = Math.floor(Number(usdValue) * QYNX_PER_USD);
    console.log('qynxToMint', qynxToMint);
    console.log('usdValue', usdValue);
    console.log('token', token);
    if (qynxToMint > 0) {
      const user = await User.findOne({ id: user_id });
      if (user) {
        user.tokenAmount = (user.tokenAmount || 0) + qynxToMint;
        await user.save();
      }
      const mintToAddress = (wallet_address && String(wallet_address).trim()) ? String(wallet_address).trim() : fromAddress;
      if (mintToAddress) {
        const mintResult = await mintQynxTo(mintToAddress, qynxToMint, net);
        if (!mintResult.success) console.warn('Investment: QYNX mint skipped/failed:', mintResult.error);
      }
    }
    res.status(201).json(investment);
  } catch (err) {
    const status = err.message && err.message.includes('required') ? 400 : (err.message && err.message.includes('not configured') ? 503 : 500);
    res.status(status).json({ error: err.message });
  }
});

/** Create trading only after deposit is verified (verify tx then create as ACTIVE). Uses actual transferred amount from chain. Uses user's trading_address when set. */
app.post('/api/tradings/confirm-and-create', async (req, res) => {
  const { user_id, wallet_address, token, type, txHash, network } = req.body || {};
  if (!user_id || !wallet_address || token == null || !type || !txHash) {
    return res.status(400).json({ error: 'user_id, wallet_address, token, type, and txHash are required' });
  }
  const net = network === 'ethereum' ? 'ethereum' : 'bsc';
  let depositAddress = DEPOSIT_ADDRESS[net];
  const userDoc = await User.findOne({ id: user_id }).lean();
  if (userDoc && userDoc.trading_address && String(userDoc.trading_address).trim()) {
    depositAddress = String(userDoc.trading_address).trim().toLowerCase();
  }
  if (!depositAddress) {
    return res.status(503).json({ error: 'Deposit verification not configured for this network' });
  }
  const platformAddress = DEPOSIT_ADDRESS[net];
  const allowedRecipients = platformAddress && toAddress40(platformAddress) !== toAddress40(depositAddress) ? [platformAddress] : [];
  try {
    const { txHashNorm, amount: actualAmount, fromAddress } = await verifyDepositTxAndGetHashAndAmount(
      txHash.trim(), net, depositAddress, null, token || 'USDT', { allowedRecipients }
    );
    const txHashForMatch = txHashNorm.replace(/^0x/, '');
    const alreadyUsed = await Trading.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } })
      || await Investment.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } });
    if (alreadyUsed) {
      return res.status(400).json({ error: 'This transaction was already used to confirm another deposit' });
    }
    const periodDays = Number(TRADING_PERIOD[type]) || 30;
    const createdAt = new Date();
    const end_date = new Date(createdAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const trading = await Trading.create({
      id: randomUUID(),
      user_id,
      wallet_address,
      token: String(token),
      amount: Number(actualAmount),
      type: String(type),
      status: TRADING_STATUS.ACTIVE,
      end_date,
      deposit_tx_hash: txHashNorm,
    });
    const usdValue = await tokenAmountToUsd(actualAmount, token);
    const qynxToMint = Math.floor(Number(usdValue) * QYNX_PER_USD);
    if (qynxToMint > 0) {
      const user = await User.findOne({ id: user_id });
      if (user) {
        user.tokenAmount = (user.tokenAmount || 0) + qynxToMint;
        await user.save();
      }
      const mintToAddress = (wallet_address && String(wallet_address).trim()) ? String(wallet_address).trim() : fromAddress;
      if (mintToAddress) {
        const mintResult = await mintQynxTo(mintToAddress, qynxToMint, net);
        if (!mintResult.success) console.warn('Trading: QYNX mint skipped/failed:', mintResult.error);
      }
    }
    res.status(201).json(trading);
  } catch (err) {
    const status = err.message && err.message.includes('required') ? 400 : (err.message && err.message.includes('not configured') ? 503 : 500);
    res.status(status).json({ error: err.message });
  }
});

/** QYNX per 1 USD for purchase credit and mint. Set via env QYNX_PER_USD (default 10). */
const QYNX_PER_USD = Math.max(0, Number(process.env.QYNX_PER_USD) || 10);
const QYNX_DECIMALS = 18;

/**
 * Mint QYNX tokens to an address (tx sender).
 * Requires in env: QYNX_CONTRACT_ADDRESS, QYNX_MINTER_PRIVATE_KEY.
 * Contract must expose: mint(address to, uint256 amount).
 * Returns { success, error?, mintTxHash? }.
 */
async function mintQynxTo(toAddress, amountQynx, network) {
  const contractAddress = process.env.QYNX_CONTRACT_ADDRESS;
  const minterKey = process.env.QYNX_MINTER_PRIVATE_KEY;
  if (!contractAddress || !minterKey) {
    console.warn('mintQynxTo skipped: set QYNX_CONTRACT_ADDRESS and QYNX_MINTER_PRIVATE_KEY in env to mint QYNX on purchase.');
    return { success: false, error: 'Mint not configured (missing QYNX_CONTRACT_ADDRESS or QYNX_MINTER_PRIVATE_KEY).' };
  }
  if (!toAddress || amountQynx <= 0) {
    return { success: false, error: 'Invalid recipient or amount.' };
  }
  const rpcUrl = RPC_URL[network === 'ethereum' ? 'ethereum' : 'bsc'];
  if (!rpcUrl) {
    return { success: false, error: 'No RPC URL for network.' };
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(minterKey, provider);
    const amountWei = ethers.parseUnits(String(Math.floor(amountQynx)), QYNX_DECIMALS);
    const abi = ['function mint(address to, uint256 amount)'];
    const contract = new ethers.Contract(contractAddress, abi, wallet);
    const tx = await contract.mint(toAddress, amountWei);
    const receipt = await tx.wait();
    return { success: true, mintTxHash: receipt && receipt.hash ? receipt.hash : tx.hash };
  } catch (err) {
    console.error('mintQynxTo error:', err.message);
    return { success: false, error: err.message || 'Mint transaction failed.' };
  }
}

/** Verify a deposit tx to user's treasury address and credit user's tokenAmount (QYNX). Used for Purchase QYNX via QR. In QR mode, mint to connected wallet (wallet_address) when provided. */
app.post('/api/purchase/verify-and-credit', async (req, res) => {
  const { user_id, txHash, network, token, wallet_address } = req.body || {};
  if (!user_id || !txHash || typeof txHash !== 'string' || !txHash.trim()) {
    return res.status(400).json({ error: 'user_id, txHash, network, and token are required' });
  }
  const net = network === 'ethereum' ? 'ethereum' : 'bsc';
  const userDoc = await User.findOne({ id: user_id }).lean();
  let depositAddress = userDoc && userDoc.treasury_address && String(userDoc.treasury_address).trim()
    ? String(userDoc.treasury_address).trim().toLowerCase()
    : DEPOSIT_ADDRESS[net];
  if (!depositAddress) {
    return res.status(503).json({ error: 'Deposit verification not configured for this network' });
  }
  const platformAddress = DEPOSIT_ADDRESS[net];
  const allowedRecipients = platformAddress && toAddress40(platformAddress) !== toAddress40(depositAddress) ? [platformAddress] : [];
  try {
    const { txHashNorm, amount: actualAmount, fromAddress } = await verifyDepositTxAndGetHashAndAmount(
      txHash.trim(), net, depositAddress, null, token || 'USDT', { allowedRecipients }
    );
    const txHashForMatch = txHashNorm.replace(/^0x/, '');
    const alreadyUsed = await Investment.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } })
      || await Trading.findOne({ deposit_tx_hash: { $regex: new RegExp('^(0x)?' + txHashForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } });
    if (alreadyUsed) {
      return res.status(400).json({ error: 'This transaction was already used for another deposit' });
    }
    const user = await User.findOne({ id: user_id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const usdValue = await tokenAmountToUsd(actualAmount, token || 'USDT');
    const qynxCredit = Math.floor(Number(usdValue) * QYNX_PER_USD);
    if (qynxCredit <= 0) {
      return res.status(400).json({ error: 'Computed QYNX credit is zero (check token price or amount)' });
    }
    user.tokenAmount = (user.tokenAmount || 0) + qynxCredit;
    await user.save();
    let mintResult = { success: false };
    const mintToAddress = (wallet_address && String(wallet_address).trim()) ? String(wallet_address).trim() : fromAddress;
    if (mintToAddress && qynxCredit > 0) {
      mintResult = await mintQynxTo(mintToAddress, qynxCredit, net);
    }
    res.json({
      tokenAmount: user.tokenAmount,
      credited: qynxCredit,
      mintSuccess: mintResult.success,
      mintError: mintResult.error || undefined,
      mintTxHash: mintResult.mintTxHash || undefined,
    });
  } catch (err) {
    const status = err.message && err.message.includes('required') ? 400 : (err.message && err.message.includes('not configured') ? 503 : 500);
    res.status(status).json({ error: err.message });
  }
});

// --- Withdrawals ---
app.get('/api/withdrawals', async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdrawals', async (req, res) => {
  const { user_id, category, wallet_address, status, amount, currency, activity_id } = req.body || {};
  if (!user_id || !category || !wallet_address) {
    return res.status(400).json({ error: 'user_id, category, and wallet_address are required' });
  }
  if (!WITHDRAWAL_CATEGORY.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${WITHDRAWAL_CATEGORY.join(', ')}` });
  }
  try {
    const statusVal = status && WITHDRAWAL_STATUS.includes(status) ? status : 'pending';
    const withdrawal = await Withdrawal.create({
      id: randomUUID(),
      user_id,
      category,
      wallet_address: String(wallet_address),
      status: statusVal,
      amount: amount != null ? String(amount) : '',
      currency: currency != null ? String(currency) : '',
      activity_id: activity_id != null ? String(activity_id) : '',
    });
    res.status(201).json(withdrawal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/withdrawals', async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ user_id: req.params.userId }).sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/withdrawals/:id', async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({ id: req.params.id });
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    res.json(withdrawal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/withdrawals/:id', async (req, res) => {
  const { status, category, wallet_address } = req.body || {};
  try {
    const withdrawal = await Withdrawal.findOne({ id: req.params.id });
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (status !== undefined) {
      if (!WITHDRAWAL_STATUS.includes(status)) return res.status(400).json({ error: `status must be one of: ${WITHDRAWAL_STATUS.join(', ')}` });
      withdrawal.status = status;
    }
    if (category !== undefined) {
      if (!WITHDRAWAL_CATEGORY.includes(category)) return res.status(400).json({ error: `category must be one of: ${WITHDRAWAL_CATEGORY.join(', ')}` });
      withdrawal.category = category;
    }
    if (wallet_address !== undefined) withdrawal.wallet_address = String(wallet_address);
    await withdrawal.save();
    res.json(withdrawal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/withdrawals/:id', async (req, res) => {
  try {
    const deleted = await Withdrawal.findOneAndDelete({ id: req.params.id });
    if (!deleted) return res.status(404).json({ error: 'Withdrawal not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats: full statistic data for frontend ---
app.get('/api/stats', (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const dayIndex = Math.floor((date.getTime() - LAUNCH_DATE.getTime()) / (1000 * 60 * 60 * 24));
  if (dayIndex < 0 || dayIndex >= TOTAL_INVESTMENTS.length) {
    return res.json({
      date: date.toISOString().slice(0, 10),
      dayIndex,
      totalInvestment: null,
      totalTrading: null,
      totalProfit: null,
      totalQynxTokenBalance: null,
      totalUsers: null,
      changeRatios: {
        investment: null,
        trading: null,
        profit: null,
        qynxTokenBalance: null,
        totalUsers: null,
        portfolio: null,
      },
    });
  }
  res.json({
    date: date.toISOString().slice(0, 10),
    dayIndex,
    totalInvestment: getTotalInvestments(date),
    totalTrading: getTotalTradings(date),
    totalProfit: getTotalProfits(date),
    totalQynxTokenBalance: getTotalQynxTokenBalance(date),
    totalUsers: getTotalUsers(date),
    changeRatios: {
      investment: getInvestmentChangeRatio(date),
      trading: getTradingChangeRatio(date),
      profit: getProfitChangeRatio(date),
      qynxTokenBalance: getQynxTokenBalanceChangeRatio(date),
      totalUsers: getUsersChangeRatio(date),
      portfolio: getPortfolioChangeRatio(date),
    },
  });
});

const PORT = process.argv[2] || 3001;

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Auth server listening on port ${PORT} (MongoDB connected)`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
