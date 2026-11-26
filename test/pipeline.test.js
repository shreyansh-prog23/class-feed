// Runs the whole pipeline with a pretend AI, so the plumbing is proven without spending anything.
// The pretend AI uses simple keyword rules. It tests routing, filtering, updating, retries and the
// server. It says nothing about how well the real AI reads messages; that needs a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXP = process.env.EXPORT_DIR || '/tmp/t/exp2';   // an unzipped WhatsApp export with media
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
process.env.DATA_DIR = tmp;
process.env.CLASS_CODE = 'class1';
process.env.ADMIN_CODE = 'boss';
process.env.SUBJECTS = 'MAIC 209=Linear Algebra;MAIC 205=Probability';
process.env.BATCH_WAIT_MS = '0';
process.env.PORT = '0';

const { setMock } = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const { replay } = await import('../src/replay.js');
const cards = await import('../src/cards.js');
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { reminderTick } = await import('../src/push.js');

cards.seedAliases();

let failNext = 0;
setMock((prompt, { files }) => {
  if (failNext > 0) { failNext--; throw new Error('pretend outage'); }
  if (prompt.startsWith('You look at a')) {
    const name = (/File name: "(.+?)"/.exec(prompt) || [])[1] || '';
    if (/meme/i.test(name)) return { useful: false, summary: 'a meme' };
    return { useful: true, kind: /syllabus/i.test(name) ? 'syllabus' : /assign/i.test(name) ? 'assignment' : 'notes', subject: 'General', title: name.replace(/\.[^.]+$/, ''), due: null, time: null, summary: 'Pretend summary of ' + name, text: 'pretend text', unsure: false };
  }
  const existing = JSON.parse(/Existing cards: (.*)\n/.exec(prompt)[1]);
  const items = [];
  const re = /^\[(m\d+)\] \w+ (\d+) (\w+) (\d+), (\d\d):(\d\d) \| (.*?): (.*)$/gm;
  let m;
  while ((m = re.exec(prompt))) {
    const [, id, , , , , , , text] = m;
    if (/extend|postpone/i.test(text) && existing.length) items.push({ op: 'update', card: existing[0].id, due: '2026-09-30', src: [id], why: 'extended' });
    else if (/(assignment|submit|deadline|quiz|exam|test)/i.test(text) && !/sent a file/.test(text)) items.push({ op: 'new', type: /exam|quiz|test/i.test(text) ? 'exam' : 'assignment', subject: 'General', title: text.slice(0, 40), due: /monday/i.test(text) ? '2026-09-07' : null, time: null, src: [id] });
    else if (/sent a file named "(.+?)"/.test(text)) items.push({ op: 'new', type: 'material', subject: 'General', title: /sent a file named "(.+?)"/.exec(text)[1].replace(/\.[^.]+$/, ''), src: [id] });
  }
  return items;
});

const GROUP = 'MAIC 209 AI&DS 2026-27';
const active = () => db.prepare('select * from cards where deleted=0').all();

test('replaying a real export: files read, chatter dropped, subject routed by course code', async () => {
  const stats = await replay(EXP, GROUP);
  assert.ok(stats.queued > 0);
  const rows = active();
  assert.ok(rows.length > 0, 'cards were created');
  assert.ok(rows.every(c => c.subject === 'Linear Algebra'), 'every card filed under the group\'s subject: ' + [...new Set(rows.map(c => c.subject))]);
  assert.ok(rows.some(c => /syllabus/i.test(c.title) && c.type === 'syllabus'), 'syllabus pdf became a syllabus card');
  const withFiles = rows.filter(c => JSON.parse(c.files).length);
  assert.ok(withFiles.length >= 4, 'PDF cards carry their files');
  console.log('   ', rows.length, 'cards;', JSON.stringify(stats.dropped));
});

test('running the same export again adds nothing', async () => {
  const before = active().length;
  const stats = await replay(EXP, GROUP);
  assert.equal(stats.queued, 0);
  assert.equal(active().length, before);
});

test('stickers, one-word replies and forwarded duplicates are dropped before the AI', () => {
  assert.equal(ingest({ grp: GROUP, ms: Date.now(), sender: 'A', text: 'ok sir' }).status, 'dropped');
  assert.equal(ingest({ grp: GROUP, ms: Date.now(), sender: 'A', text: '👍' }).status, 'dropped');
  assert.equal(ingest({ grp: GROUP, ms: Date.now(), sender: 'A', text: '', buf: Buffer.from('x'), fileName: 'STK-2026.webp', mime: 'image/webp' }).status, 'dropped');
  assert.equal(ingest({ grp: GROUP, ms: Date.now(), sender: 'A', text: '', buf: Buffer.from('x'), fileName: 'VID-1.mp4', mime: 'video/mp4' }).status, 'dropped');
});

test('a message from another group is filed by that group\'s course, and a mixed-in code goes to the right subject', async () => {
  ingest({ grp: 'MAIC 205 Prob', ms: Date.parse('2026-09-01T10:00:00'), sender: 'Prof P', text: 'Submit assignment 2 by Monday' });
  ingest({ grp: 'General chat', ms: Date.parse('2026-09-01T10:05:00'), sender: 'Prof L', text: 'MAIC 209 quiz is on Friday' });
  await flushAll();
  const a = db.prepare("select * from cards where title like 'Submit assignment 2%'").get();
  const b = db.prepare("select * from cards where title like 'MAIC 209 quiz%'").get();
  assert.equal(a.subject, 'Probability');
  assert.equal(a.due, '2026-09-07');
  assert.equal(b.subject, 'Linear Algebra', 'a MAIC 209 message in the general chat is re-routed');
});

test('a later message updates the same card instead of making a new one', async () => {
  const c = db.prepare("select * from cards where title like 'Submit assignment 2%'").get();
  const n = active().length;
  ingest({ grp: 'MAIC 205 Prob', ms: Date.parse('2026-09-03T10:00:00'), sender: 'Prof P', text: 'Assignment deadline extended till 30th' });
  await flushAll();
  const u = cards.getCard(c.id);
  assert.equal(u.due, '2026-09-30');
  assert.equal(u.moved, '2026-09-07');
  assert.equal(u.history.length, 1);
  assert.equal(active().length, n);
});

test('a photo that is clearly not study material is skipped and listed; a useful one becomes a card', async () => {
  ingest({ grp: GROUP, ms: Date.now() + 1000, sender: 'Mayank', text: '', buf: Buffer.from('fake-jpeg-1'), fileName: 'meme.jpg', mime: 'image/jpeg' });
  ingest({ grp: GROUP, ms: Date.now() + 2000, sender: 'Prof', text: '', buf: Buffer.from('fake-jpeg-2'), fileName: 'assign3.jpg', mime: 'image/jpeg' });
  await flushAll();
  assert.equal(db.prepare("select count(*) n from messages where file_name='meme.jpg' and processed=2").get().n, 1);
  assert.equal(db.prepare("select count(*) n from cards where title='assign3' and type='assignment'").get().n, 1);
  assert.equal(ingest({ grp: GROUP, ms: Date.now() + 3000, sender: 'Mayank', text: '', buf: Buffer.from('fake-jpeg-2'), fileName: 'fwd.jpg', mime: 'image/jpeg' }).why, 'same file sent again');
});

test('an AI outage leaves messages waiting and they are read on the next try', async () => {
  failNext = 1;
  ingest({ grp: 'MAIC 205 Prob', ms: Date.parse('2026-09-10T09:00:00'), sender: 'Prof P', text: 'Quiz on unit 2 tomorrow' });
  await flushAll();
  const row = db.prepare("select * from messages where text like 'Quiz on unit 2%'").get();
  assert.equal(row.processed, 0);
  assert.equal(row.attempts, 1);
  await flushAll();
  assert.equal(db.prepare("select processed from messages where text like 'Quiz on unit 2%'").get().processed, 1);
});

test('reminders fire once, 24h before a timed deadline', async () => {
  const id = 'creminder';
  db.prepare("insert into cards(id,grp,subject,type,title,due,time,created,updated) values(?,?,?,?,?,?,?,?,?)").run(id, GROUP, 'Linear Algebra', 'assignment', 'Rem test', '2026-12-01', '10:00', 1, 1);
  const due = new Date('2026-12-01T10:00:00').getTime();
  await reminderTick(due - 24 * 36e5 + 60000);
  await reminderTick(due - 24 * 36e5 + 120000);
  assert.equal(db.prepare('select count(*) n from notified where card=?').get(id).n, 1);
  await reminderTick(due - 12 * 36e5 + 60000);
  assert.equal(db.prepare('select count(*) n from notified where card=?').get(id).n, 2);
  await reminderTick(due + 36e5);   // after the deadline: nothing
  assert.equal(db.prepare('select count(*) n from notified where card=?').get(id).n, 2);
});

test('server: class code protects the feed, files download, the CR can fix and remove cards', async () => {
  const srv = startServer();
  await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port;
  assert.equal((await fetch(base + '/api/feed')).status, 401);
  const feed = await (await fetch(base + '/api/feed', { headers: { 'x-class-code': 'class1' } })).json();
  assert.ok(feed.cards.length > 5);
  const withFile = feed.cards.find(c => c.files.length && /pdf/i.test(c.files[0].name));
  const f = await fetch(base + '/api/files/' + withFile.files[0].id + '?code=class1');
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.ok((await f.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(base + '/api/admin/status', { headers: { 'x-class-code': 'class1' } })).status, 401, 'students cannot use CR controls');
  const adm = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
  const st = await (await fetch(base + '/api/admin/status', { headers: adm })).json();
  assert.ok(st.cards > 5);
  const fixed = await (await fetch(base + '/api/admin/card', { method: 'POST', headers: adm, body: JSON.stringify({ id: withFile.id, patch: { title: 'Fixed title', due: '2026-10-01' } }) })).json();
  assert.equal(fixed.card.title, 'Fixed title');
  await fetch(base + '/api/flag', { method: 'POST', headers: { 'x-class-code': 'class1', 'content-type': 'application/json' }, body: JSON.stringify({ id: withFile.id }) });
  await fetch(base + '/api/admin/card', { method: 'POST', headers: adm, body: JSON.stringify({ id: withFile.id, delete: true }) });
  const since = await (await fetch(base + '/api/feed?since=' + feed.now, { headers: { 'x-class-code': 'class1' } })).json();
  assert.ok(since.cards.some(c => c.id === withFile.id && c.deleted), 'deleted cards reach phones on the next sync');
  assert.ok(db.prepare("select v from kv where k='fixes'").get(), 'the fix is remembered for the AI');
  srv.close();
});
