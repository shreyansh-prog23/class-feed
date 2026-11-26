// Phone alerts: when something new or changed arrives, and 24h / 12h before a deadline.
// Works on Android and on iPhones that have added the app to the home screen.
import { db, getKv, setKv } from './db.js';
import { cfg } from './config.js';

let wp = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function initPush() {
  try { wp = (await import('web-push')).default; } catch (e) { log('web-push is not installed, alerts are off'); return false; }
  let keys = getKv('vapid');
  if (!keys) { keys = wp.generateVAPIDKeys(); setKv('vapid', keys); }
  wp.setVapidDetails(cfg.pushContact, keys.publicKey, keys.privateKey);
  return true;
}
export const publicKey = () => (getKv('vapid') || {}).publicKey || null;

export function markAdmin(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  subscribe(sub);
  db.prepare('update subs set admin=1 where endpoint=?').run(sub.endpoint);
  return true;
}

export function subscribe(sub, pid = null) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  pid = pid ? String(pid).replace(/[^\w-]/g, '').slice(0, 40) : null;
  db.prepare('insert into subs(endpoint,json,created,pid) values(?,?,?,?) on conflict(endpoint) do update set json=excluded.json, pid=coalesce(excluded.pid, subs.pid)').run(sub.endpoint, JSON.stringify(sub), Date.now(), pid);
  return true;
}

// section: only phones whose owner is in that section (or has not said) get it. Admin phones always do.
export async function sendAll(payload, adminOnly = false, section = null) {
  if (!wp) return 0;
  let n = 0;
  const rows = db.prepare('select s.*, p.section psec from subs s left join people p on p.id=s.pid' + (adminOnly ? ' where s.admin=1' : '')).all()
    .filter(s => !section || s.admin || !s.psec || s.psec === section);
  for (const s of rows) {
    try { await wp.sendNotification(JSON.parse(s.json), JSON.stringify(payload)); n++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('delete from subs where endpoint=?').run(s.endpoint); }
  }
  return n;
}

const fmtDue = c => c.due ? new Date(c.due + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) + (c.time ? ' ' + c.time : '') : '';

const todayStr = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA');
const dayWord = (due, now = Date.now()) => {
  const d = Math.round((new Date(due + 'T00:00:00') - new Date(todayStr(now) + 'T00:00:00')) / 864e5);
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : new Date(due + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const at = c => (c.time ? ' at ' + c.time : '');

// What to tell phones about one changed class. Returns null when nothing is worth an alert (for example a class that already happened).
export function classAlert(c, now = Date.now()) {
  if (!c.due || c.due < todayStr(now)) return null;
  const subj = c.subject && c.subject !== 'General' ? c.subject : '';
  const when = dayWord(c.due, now);
  if (c.change === 'cancelled_all') return { title: 'No classes ' + when, body: c.title + (c.details ? ' - ' + c.details : ''), tag: c.id };
  if (c.change === 'cancelled') return { title: (subj ? subj + ' class' : 'A class') + ' cancelled ' + when, body: (c.title + at(c)).trim() + (c.details ? ' - ' + c.details : ''), tag: c.id };
  if (c.change === 'rescheduled') return { title: (subj ? subj + ' class' : 'A class') + ' moved', body: (c.details || c.title) + ' (' + when + at(c) + ')', tag: c.id };
  if (c.change === 'extra') return { title: 'Extra ' + (subj || 'class') + ' ' + when, body: (c.title + at(c)).trim(), tag: c.id };
  if (c.change === 'restored') return { title: (subj ? subj + ' class' : 'Class') + ' is on again ' + when, body: c.title, tag: c.id };
  return { title: (subj || 'Class') + ': class update', body: c.title + ' (' + when + at(c) + ')', tag: c.id };
}

// Everything that should be sent for a batch of new and changed cards.
export function alertsFor(out, now = Date.now()) {
  const msgs = [];
  (out.added || []).filter(c => ['assignment', 'exam', 'class_change', 'notice'].includes(c.type)).forEach(c => {
    if (c.type === 'class_change') { const m = classAlert(c, now); if (m) msgs.push({ ...m, section: c.section || null }); return; }
    msgs.push({ title: c.subject + ': new ' + c.type, body: c.title + (c.due ? ' (' + fmtDue(c) + ')' : ''), tag: c.id, section: c.section || null });
  });
  (out.updated || []).forEach(u => {
    if (u.card.type === 'class_change') { const m = /class:/.test(u.what || '') || /date|time/.test(u.what || '') ? classAlert(u.card, now) : null; if (m) msgs.push({ ...m, section: u.card.section || null }); return; }
    msgs.push({ title: u.card.subject + ': changed', body: u.card.title + ' - ' + u.what, tag: u.card.id, section: u.card.section || null });
  });
  return msgs;
}

// Called whenever the reader adds or changes cards.
export async function notifyChanges(out) {
  const msgs = alertsFor(out);
  if (!msgs.length) return;
  // Cancellations are urgent and always sent one by one, even in a busy moment.
  const urgent = msgs.filter(m => /cancel|No classes|moved|on again/i.test(m.title)), rest = msgs.filter(m => !urgent.includes(m));
  const go = m => { const { section, ...p } = m; return sendAll(p, false, section); };
  for (const m of urgent) await go(m);
  if (rest.length > 3) return sendAll({ title: rest.length + ' updates in your class feed', body: 'Open the app to see them.', tag: 'batch' });
  for (const m of rest) await go(m);
}

// Run every few minutes. Deadlines with a time: 24h and 12h before.
// Deadlines with only a date: 6 pm the day before and 9 am on the day.
export async function reminderTick(now = Date.now()) {
  const cards = db.prepare("select id,subject,title,due,time,section from cards where deleted=0 and hold=0 and due is not null and type in ('assignment','exam')").all();
  for (const c of cards) {
    const dueMs = new Date(c.due + 'T' + (c.time || '23:59') + ':00').getTime();
    const plan = c.time
      ? [['24h', dueMs - 24 * 36e5], ['12h', dueMs - 12 * 36e5]]
      : [['eve', new Date(c.due + 'T00:00:00').getTime() - 6 * 36e5], ['morn', new Date(c.due + 'T09:00:00').getTime()]];
    for (const [kind, at] of plan) {
      if (now < at || now > at + 3 * 36e5 || now > dueMs) continue;   // not yet, too stale, or already past
      const key = kind + ':' + c.due + ':' + (c.time || '');
      if (db.prepare('select 1 from notified where card=? and kind=?').get(c.id, key)) continue;
      db.prepare('insert into notified(card,kind,at) values(?,?,?)').run(c.id, key, now);
      await sendAll({ title: c.subject + ' due ' + (kind === '24h' || kind === 'eve' ? 'soon' : 'today'), body: c.title + ' (' + fmtDue(c) + ')', tag: c.id }, false, c.section || null);
    }
  }
}
