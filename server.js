const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Use AUTH_FILE (full path) or DATA_DIR (directory) so cPanel/read-only hosts can point to a writable path
const DATA_FILE = process.env.AUTH_FILE || path.join(process.env.DATA_DIR || __dirname, 'auth.json');

async function loadData() {
  try {
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === 'ENOENT') return { users: [] };
    throw err;
  }
}

async function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

app.get('/api/users', async (req, res) => {
  const data = await loadData();
  res.json(data.users.map(safeUser));
});

app.get('/api/users/:id', async (req, res) => {
  const data = await loadData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(safeUser(user));
});

app.post('/api/register', async (req, res) => {
  const { name, email, active, role, loginCount, password } = req.body || {};
  console.log(req.body);
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const data = await loadData();
  if (data.users.some(u => u.email === email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const user = { 
    id: randomUUID(), 
    name: name || '', 
    email, 
    active: true,
    role: 'user',
    loginCount: 0,
    password: hashed, 
    createdAt: new Date().toISOString() 
  };
  data.users.push(user);
  await saveData(data);

  res.status(201).json(safeUser(user));
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const data = await loadData();
  const user = data.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'You are not registered. Please Sign Up.' });
  if (user.active === false) return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });

  const ok = bcrypt.compareSync(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

  user.loginCount = (user.loginCount || 0) + 1;
  await saveData(data);

  res.json(safeUser(user));
});

app.put('/api/users/:id', async (req, res) => {
  const { name, email, password, role, active } = req.body || {};
  const data = await loadData();
  const idx = data.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  if (email && data.users.some((u, i) => u.email === email && i !== idx)) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  if (typeof name !== 'undefined') data.users[idx].name = name;
  if (typeof email !== 'undefined') data.users[idx].email = email;
  if (typeof password !== 'undefined' && password !== '') data.users[idx].password = bcrypt.hashSync(password, 10);
  if (typeof role !== 'undefined') data.users[idx].role = role;
  if (typeof active !== 'undefined') data.users[idx].active = active;
  data.users[idx].updatedAt = new Date().toISOString();

  await saveData(data);
  res.json(safeUser(data.users[idx]));
});

app.delete('/api/users/:id', async (req, res) => {
  const data = await loadData();
  const idx = data.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const removed = data.users.splice(idx, 1)[0];
  await saveData(data);
  res.json(safeUser(removed));
});

const PORT = process.argv[2] || process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JSON auth server listening on port ${PORT}`));
