// Keeps the system honest: warns the CR when WhatsApp stops listening, and keeps daily backups.
import fs from 'node:fs';
import path from 'node:path';
import { db, getKv, setKv } from './db.js';
import { cfg } from './config.js';
import { sendAll } from './push.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// What is wrong with WhatsApp right now, or null when it is fine.
export function waProblem(wa, now = Date.now(), graceMs = 20 * 60 * 1000) {
  wa = wa || {};
  const s = String(wa.state || '');
  if (/^LOGGED OUT/.test(s)) return { key: 'out', title: 'WhatsApp logged out', body: 'The class feed stopped reading. Scan the QR code again on the server.' };
  if (/QR/.test(s) && now - (wa.at || 0) > 5 * 60 * 1000) return { key: 'qr', title: 'WhatsApp needs a QR scan', body: 'The class feed is waiting for you to link the spare phone again.' };
  if (s && s !== 'connected' && !/QR/.test(s) && now - (wa.at || 0) > graceMs) return { key: 'down', title: 'WhatsApp has been disconnected', body: 'The class feed has not been reading messages for ' + Math.round((now - wa.at) / 60000) + ' minutes.' };
  return null;
}

// Runs every few minutes. Warns once per problem, and says so when it is fixed.
export async function healthTick(now = Date.now()) {
  const wa = getKv('wa', {}), prob = waProblem(wa, now), last = getKv('wa_warned', null);
  if (prob && (!last || last.key !== prob.key)) {
    setKv('wa_warned', { key: prob.key, at: now });
    const n = await sendAll({ title: prob.title, body: prob.body, tag: 'wa-health' }, true);
    log('WhatsApp problem (' + prob.key + '): warned ' + n + ' CR phone(s)');
  } else if (!prob && last && wa.state === 'connected') {
    setKv('wa_warned', null);
    await sendAll({ title: 'WhatsApp is back', body: 'The class feed is reading messages again.', tag: 'wa-health' }, true);
  }
}

// One copy of the database (and the WhatsApp login) per day, the newest few kept. Uploaded files are not copied, they are large.
export function backupTick(now = Date.now()) {
  const day = new Date(now + 5.5 * 36e5).toISOString().slice(0, 10);
  const dir = path.join(cfg.dataDir, 'backups');
  if (getKv('backup_day') === day && fs.existsSync(path.join(dir, 'feed-' + day + '.db'))) return null;
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'feed-' + day + '.db');
  try { fs.unlinkSync(out); } catch (e) { /* none yet */ }
  db.exec("vacuum into '" + out.replace(/'/g, "''") + "'");
  const wa = path.join(cfg.dataDir, 'wa-auth');
  if (fs.existsSync(wa)) { const to = path.join(dir, 'wa-auth-' + day); fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(wa, to, { recursive: true }); }
  const old = fs.readdirSync(dir).filter(f => /^(feed-\d{4}-\d{2}-\d{2}\.db|wa-auth-\d{4}-\d{2}-\d{2})$/.test(f));
  const stamps = Array.from(new Set(old.map(f => f.match(/\d{4}-\d{2}-\d{2}/)[0]))).sort().reverse().slice(cfg.backupKeep);
  for (const f of old) if (stamps.includes(f.match(/\d{4}-\d{2}-\d{2}/)[0])) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  setKv('backup_day', day);
  log('Backup saved: ' + path.basename(out));
  return out;
}
