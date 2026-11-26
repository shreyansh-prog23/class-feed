// The old-chat import: zip reading, the semester start date, waiting behind live messages,
// no alerts, and the upload endpoint. Uses a pretend AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXP = process.env.EXPORT_DIR || '/tmp/t/exp2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
process.env.DATA_DIR = tmp;
process.env.CLASS_CODE = 'class1';
process.env.ADMIN_CODE = 'boss';
process.env.GROUPS = 'MAIC 209';
process.env.SUBJECTS = 'MAIC 209=Linear Algebra';
process.env.BATCH_WAIT_MS = '0';
process.env.PORT = '0';

const { cfg } = await import('../src/config.js');
const { setMock } = await import('../src/ai.js');
const { ingest, flushAll, historyTick, historyPending, pendingCount, setOnChange, resetHistoryCooldown, historyProblem } = await import('../src/reader.js');
const { importZip } = await import('../src/history.js');
const { openZip } = await import('../src/zip.js');
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const cards = await import('../src/cards.js');
cards.seedAliases();

const GROUP = 'MAIC 209 AI&DS 2026-27';
let calls = 0, alerts = 0;
setOnChange(() => { alerts++; });
setMock((prompt) => {
  calls++;
  if (prompt.startsWith('You look at a')) {
    const name = (/File name: "(.+?)"/.exec(prompt) || [])[1] || '';
    return { useful: true, kind: /syllabus/i.test(name) ? 'syllabus' : 'notes', subject: 'Linear Algebra', title: name.replace(/\.[^.]+$/, ''), due: null, time: null, summary: 'pretend', text: 'pretend', unsure: false };
  }
  const items = [];
  const re = /^\[(m\d+)\] .*? \| (.*?): (.*)$/gm; let m;
  while ((m = re.exec(prompt))) if (/(assignment|submit|deadline|quiz|exam)/i.test(m[3])) items.push({ op: 'new', type: 'assignment', subject: 'Linear Algebra', title: m[3].slice(0, 40), due: null, time: null, src: [m[1]] });
  return items;
});

const zipDeflate = path.join(tmp, 'export.zip'), zipStored = path.join(tmp, 'stored.zip');
execFileSync('zip', ['-q', '-j', '-r', zipDeflate, EXP]);
execFileSync('zip', ['-q', '-0', '-j', '-r', zipStored, EXP]);
const since = new Date('2026-09-01T00:00:00').getTime();

test('the zip reader opens deflated and stored zips and returns the real file bytes', () => {
  for (const f of [zipDeflate, zipStored]) {
    const z = openZip(f);
    const pdf = z.entries.find(e => /syllabus\.pdf$/i.test(e.base));
    assert.ok(pdf, 'finds the syllabus entry');
    const got = z.extract(pdf, 50e6);
    assert.ok(got.equals(fs.readFileSync(path.join(EXP, pdf.base))), 'bytes match the original');
    assert.throws(() => z.extract(pdf, 10), /too big/);
    z.close();
  }
  fs.writeFileSync(path.join(tmp, 'bad.zip'), 'definitely not a zip file at all, just text');
  assert.throws(() => openZip(path.join(tmp, 'bad.zip')), /not a zip/);
});

test('a plain .txt export (Android, without media) imports as text only', () => {
  const txt = path.join(EXP, fs.readdirSync(EXP).find(f => /\.txt$/i.test(f)));
  const before = db.prepare('select count(*) n from messages').get().n;
  const s = importZip(txt, GROUP, 0);
  assert.ok(s.found > 0 && s.files === 0);
  assert.ok(db.prepare("select count(*) n from messages where kind in ('pdf','image')").get().n === 0 || before > 0);
  db.exec('delete from messages; delete from files');
});

test('import keeps only messages since the semester start, files included, and queues them as old', () => {
  const all = importZip(zipStored, GROUP, 0);
  const rowsAll = db.prepare('select count(*) n from messages where old=1').get().n;
  assert.ok(all.queued > 0 && rowsAll === all.queued);
  db.exec('delete from messages; delete from files');
  const s = importZip(zipDeflate, GROUP, since);
  assert.ok(s.inRange < s.found, 'some messages are older than the start date: ' + JSON.stringify({ found: s.found, inRange: s.inRange }));
  assert.ok(s.queued <= s.inRange);
  const minMs = db.prepare('select min(ms) m from messages').get().m;
  assert.ok(minMs >= since, 'nothing before the start date was queued');
  assert.ok(db.prepare("select count(*) n from messages where kind='pdf' and old=1").get().n >= 1, 'PDFs are queued');
  assert.equal(pendingCount(), 0, 'old messages do not count as live');
  assert.equal(historyPending(), s.queued);
  console.log('   ', JSON.stringify({ found: s.found, inRange: s.inRange, queued: s.queued, files: s.files }));
});

test('importing the same zip again adds nothing', () => {
  assert.equal(importZip(zipDeflate, GROUP, since).queued, 0);
});

test('old messages wait while a live message is waiting, and flushAll never touches them', async () => {
  const before = historyPending();
  ingest({ grp: GROUP, ms: Date.now(), sender: 'Prof', text: 'Submit the new assignment by Friday' });
  assert.equal(pendingCount(), 1);
  const c0 = calls;
  await historyTick();
  assert.equal(calls, c0, 'no AI call was spent on old messages while a live one waited');
  await flushAll();
  assert.equal(pendingCount(), 0);
  assert.equal(historyPending(), before, 'flushAll left the old ones alone');
});

test('the daily budget stops the import; with room it reads old messages in the background without alerts', async () => {
  cfg.historyDailyCalls = 0;
  const c0 = calls; await historyTick(); assert.equal(calls, c0, 'budget of zero means no calls');
  cfg.historyDailyCalls = 120;
  alerts = 0;
  const start = historyPending();
  for (let i = 0; i < 20 && historyPending(); i++) await historyTick(50);
  assert.equal(historyPending(), 0, 'all old messages were read (started with ' + start + ')');
  assert.equal(alerts, 0, 'no push alerts for old messages');
  assert.ok(db.prepare("select count(*) n from cards where deleted=0 and subject='Linear Algebra'").get().n >= 4, 'cards were created');
});

test('when the AI is failing, old messages back off instead of burning calls every minute', async () => {
  db.exec('delete from messages; delete from files; delete from cards');
  importZip(zipDeflate, GROUP, since);
  resetHistoryCooldown();
  const prev = calls;
  setMock(() => { calls++; throw new Error('AI error 503: high demand'); });
  await historyTick();
  const first = calls - prev;
  assert.ok(first >= 1 && first <= 2, 'one failed step, not a burst: ' + first);
  assert.match(historyProblem().msg, /503/);
  await historyTick(); await historyTick();
  assert.equal(calls - prev, first, 'no more calls while backing off');
  assert.ok(db.prepare("select count(*) n from messages where old=1 and processed=3").get().n === 0, 'busy errors never give up on a message');
  resetHistoryCooldown();
  setMock((prompt) => { calls++; return prompt.startsWith('You look at a') ? { useful: false, summary: 'x' } : []; });
  for (let i = 0; i < 10 && historyPending(); i++) await historyTick(50);
  assert.equal(historyPending(), 0, 'finishes once the AI recovers');
  assert.equal(historyProblem(), null, 'the problem note clears');
  db.exec('delete from messages; delete from files; delete from cards');
});

test('upload endpoint: needs the admin code, a real group and a date, then imports in the background', async () => {
  db.exec('delete from messages; delete from files; delete from cards');
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port;
  const H = { 'x-class-code': 'class1', 'x-admin-code': 'boss' };
  const zipBytes = fs.readFileSync(zipDeflate);
  const up = (q, h = H) => fetch(base + '/api/admin/history?' + q, { method: 'POST', headers: h, body: zipBytes });
  assert.equal((await up('group=' + encodeURIComponent(GROUP) + '&since=2026-09-01', { 'x-class-code': 'class1' })).status, 401, 'students cannot upload');
  assert.equal((await up('group=Some%20Other%20Group&since=2026-09-01')).status, 400, 'a group that is not being read is refused');
  assert.equal((await up('group=' + encodeURIComponent(GROUP))).status, 400, 'date is required');
  const ok = await up('group=' + encodeURIComponent(GROUP) + '&since=2026-09-01');
  assert.equal(ok.status, 200);
  let st;
  for (let i = 0; i < 50; i++) {
    st = await (await fetch(base + '/api/admin/status', { headers: H })).json();
    if (st.history.job && st.history.job.state !== 'reading') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(st.history.job.state, 'done');
  assert.ok(st.history.job.stats.queued > 0);
  assert.equal(st.waiting, 0, 'the live queue is unaffected');
  assert.ok(fs.readdirSync(path.join(tmp, 'tmp')).length === 0, 'the uploaded zip is deleted after reading');
  const junk = await fetch(base + '/api/admin/history?group=' + encodeURIComponent(GROUP) + '&since=2026-09-01', { method: 'POST', headers: H, body: 'this is not a chat export' });
  assert.equal(junk.status, 200);
  for (let i = 0; i < 50; i++) { st = await (await fetch(base + '/api/admin/status', { headers: H })).json(); if (st.history.job.state !== 'reading') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(st.history.job.state, 'failed');
  assert.match(st.history.job.error, /Could not read any messages/);
  srv.close();
});
