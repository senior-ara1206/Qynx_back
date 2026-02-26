const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = "mongodb+srv://michaelturner8011_db_user:qynx1234@cluster0.ji1p1jj.mongodb.net/?appName=Cluster0";

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
  },
  { timestamps: true }
);

const Trading = mongoose.model('Trading', tradingSchema);

function safeUser(u) {
  const doc = u.toObject ? u.toObject() : u;
  const { password, ...rest } = doc;
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
  const { name, email, password, role, active } = req.body || {};

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

const PORT = process.argv[2] || process.env.PORT || 3000;

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Auth server listening on port ${PORT} (MongoDB connected)`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
