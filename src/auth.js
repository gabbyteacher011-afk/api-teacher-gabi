const crypto = require('crypto');
const cfg = require('./config');
const b64 = b => Buffer.from(b).toString('base64url');

/* ---- senha: scrypt (nativo do Node), formato scrypt$N$salt$hash ---- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384, h = crypto.scryptSync(String(pw), salt, 64, { N });
  return ['scrypt', N, salt.toString('base64'), h.toString('base64')].join('$');
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 64, { N: Number(N) });
    const want = Buffer.from(hash, 'base64');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  } catch (e) { return false; }
}

/* ---- JWT HS256 ---- */
function sign(payload) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + cfg.tokenHours * 3600 }));
  const sig = crypto.createHmac('sha256', cfg.jwtSecret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}
function verify(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3) return null;
  const sig = crypto.createHmac('sha256', cfg.jwtSecret).update(p[0] + '.' + p[1]).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(p[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p[1], 'base64url').toString()); return d.exp > Date.now() / 1000 ? d : null; } catch (e) { return null; }
}

/* ---- limite de tentativas de login (em memória) ---- */
const tries = new Map();
function loginAllowed(key) {
  const now = Date.now(), t = (tries.get(key) || []).filter(x => now - x < 15 * 60 * 1000);
  tries.set(key, t); return t.length < 8;
}
const loginFailed = key => { const t = tries.get(key) || []; t.push(Date.now()); tries.set(key, t); };
const loginOk = key => tries.delete(key);

module.exports = { hashPassword, verifyPassword, sign, verify, loginAllowed, loginFailed, loginOk };
