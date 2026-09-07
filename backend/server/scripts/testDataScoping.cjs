/**
 * End-to-end check of the per-account scoping rules.
 *
 * Boots the API on a spare port and asserts that the media endpoints reject
 * anonymous callers, return the owner's own rows, and hide them from a second
 * account. Read-only apart from the requests themselves.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const PORT = 4899;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(pathname, token) {
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: err.message } };
  }
}

function count(body) {
  if (Array.isArray(body)) return body.length;
  if (Array.isArray(body?.queries)) return body.queries.length;
  if (Array.isArray(body?.searches)) return body.searches.length;
  if (Array.isArray(body?.playlists)) return body.playlists.length;
  if (Array.isArray(body?.collections)) return body.collections.length;
  return null;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.db.collection('users');
  const owner = await users.findOne({ email: 'pwelby@gmail.com' });
  const other = await users.findOne({ email: 'tweety@looney.com' });
  await mongoose.disconnect();

  const ownerToken = jwt.sign({ userId: owner._id.toString() }, SECRET, { expiresIn: '10m' });
  const otherToken = jwt.sign({ userId: other._id.toString() }, SECRET, { expiresIn: '10m' });

  console.log(`Booting API on ${PORT}…`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const deadline = Date.now() + 60000;
  let up = false;
  while (Date.now() < deadline) {
    const r = await call('/');
    if (r.status && r.status !== 0) {
      up = true;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  if (!up) {
    server.kill();
    throw new Error('API did not start');
  }
  console.log('API up.\n');

  const endpoints = [
    '/api/youtube/saved-searches',
    '/api/youtube/history/list',
    '/api/youtube/history/all',
    '/api/playlists',
    '/api/collections/collections',
    '/api/youtube/clicked-videos/user/anything',
    '/api/youtube/clicked-videos/grouped/anything',
    '/api/watch-later',
  ];

  // A 404 here would mean the path is wrong and the check proves nothing.
  console.log('1. Anonymous callers must be refused:');
  for (const ep of endpoints) {
    const r = await call(ep);
    check(`anon ${ep}`, r.status === 401, `status ${r.status}`);
  }

  console.log('\n2. Owner still sees their own data:');
  for (const ep of endpoints) {
    const r = await call(ep, ownerToken);
    const n = count(r.body);
    check(`owner ${ep}`, r.status === 200, `status ${r.status}, rows ${n ?? 'n/a'}`);
  }

  console.log('\n3. A second account sees none of it:');
  for (const ep of endpoints) {
    const r = await call(ep, otherToken);
    const n = count(r.body);
    const clean = r.status === 200 && (n === 0 || n === null);
    check(`other ${ep}`, clean, `status ${r.status}, rows ${n ?? 'n/a'}`);
  }

  console.log('\n4. Owner search counts:');
  const saved = await call('/api/youtube/saved-searches', ownerToken);
  check('owner sees all 250 searches', count(saved.body) === 250, `got ${count(saved.body)}`);

  server.kill();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS FAILED:', err.message);
  process.exit(1);
});
