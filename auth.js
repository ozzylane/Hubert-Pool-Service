// Local login. The username and a salted PBKDF2 hash of the password are stored
// on the device (never the password itself, and never in the public source code).
import { db } from './db.js';

const ITERATIONS = 210000;
const REMEMBER_DAYS = 30;
const MAX_FAILS = 5;
const LOCKOUT_MS = 30 * 1000;
const SESSION_FLAG = 'hps-unlocked';

const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const normalize = (u) => u.trim().toLowerCase();

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toB64(bits);
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getAccount() {
  return (await db.get('settings', 'auth'))?.value || null;
}

export async function saveAccount(username, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, ITERATIONS);
  await db.put('settings', {
    key: 'auth',
    value: { username: username.trim(), salt: toB64(salt), hash, iterations: ITERATIONS, updatedAt: new Date().toISOString() },
  });
}

export async function checkPassword(password) {
  const account = await getAccount();
  if (!account) return false;
  const hash = await hashPassword(password, fromB64(account.salt), account.iterations);
  return sameString(hash, account.hash);
}

// Returns { ok } or { ok: false, wait } where wait is seconds until another try is allowed.
export async function verifyLogin(username, password) {
  const lock = (await db.get('settings', 'lockout'))?.value || { fails: 0, until: 0 };
  if (lock.until > Date.now()) return { ok: false, wait: Math.ceil((lock.until - Date.now()) / 1000) };

  const account = await getAccount();
  const passOk = await checkPassword(password);
  const ok = !!account && passOk && normalize(account.username) === normalize(username);

  if (ok) {
    await db.del('settings', 'lockout');
    return { ok: true };
  }
  lock.fails += 1;
  if (lock.fails >= MAX_FAILS) {
    lock.fails = 0;
    lock.until = Date.now() + LOCKOUT_MS;
  }
  await db.put('settings', { key: 'lockout', value: lock });
  return { ok: false, wait: lock.until > Date.now() ? Math.ceil(LOCKOUT_MS / 1000) : 0 };
}

export async function isSignedIn() {
  try { if (sessionStorage.getItem(SESSION_FLAG) === '1') return true; } catch { /* storage blocked */ }
  const session = (await db.get('settings', 'session'))?.value;
  return !!session && session.expires > Date.now();
}

export async function startSession(remember) {
  try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch { /* storage blocked */ }
  if (remember) {
    await db.put('settings', { key: 'session', value: { expires: Date.now() + REMEMBER_DAYS * 86400000 } });
  } else {
    await db.del('settings', 'session');
  }
}

export async function endSession() {
  try { sessionStorage.removeItem(SESSION_FLAG); } catch { /* storage blocked */ }
  await db.del('settings', 'session');
}

export { REMEMBER_DAYS };
