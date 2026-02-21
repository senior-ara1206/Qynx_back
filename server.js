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
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

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
  const { name, email, password } = req.body || {};
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
    });
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

app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(safeUser(user));
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
