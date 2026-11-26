// Sections AD-01 / AD-02, and cards the AI was unsure about waiting for the CR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0', HOLD_HOURS: '12' });
const { startServer } = await import('../src/server.js');
const { db, setKv } = await import('../src/db.js');
const cards = await import('../src/cards.js');
const { alertsFor } = await import('../src/push.js');
const { setMock } = await import('../src/ai.js');
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;
const H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
const post = (p, b) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));
const get = p => fetch(base + p, { headers: H }).then(r => r.json());
const msg = (id, text) => ({ ms: Date.now(), sender: 'Teacher', text, file_name: null });

test('a person picks a section, and older users without one can add it later', async () => {
  await post('/api/me', { id: 'user-aaaa1111', name: 'Asha' });
  assert.equal((await get('/api/feed?me=user-aaaa1111')).section, null);
  assert.equal((await post('/api/section', { id: 'user-aaaa1111', section: 'ad 02' })).j.ok, true);
  const f = await get('/api/feed?me=user-aaaa1111');
  assert.equal(f.section, 'AD-02'); assert.deepEqual(f.sections, ['AD-01', 'AD-02']);
  assert.equal((await post('/api/section', { id: 'user-aaaa1111', section: 'AD-09' })).s, 400);
  await post('/api/me', { id: 'user-aaaa1111', name: 'Asha K' });          // renaming keeps the section
  assert.equal((await get('/api/feed?me=user-aaaa1111')).section, 'AD-02');
});

test('a card names its section: a lab for one, a notice for both, the section group for its own', () => {
  const out = cards.applyItems('Ai & DATA SCIENCE', [
    { op: 'new', type: 'assignment', subject: 'MAIC 205', title: 'AD-01 lab report', due: '2026-12-01', src: ['m1'] },
    { op: 'new', type: 'notice', subject: 'General', title: 'Both AD-01 and AD-02 meet at 10', src: ['m2'] },
    { op: 'new', type: 'notice', subject: 'General', title: 'Library fine notice', src: ['m3'] }
  ], { m1: msg(1, 'AD-01 lab report due Monday'), m2: msg(2, 'Both AD-01 and AD-02 meet at 10'), m3: msg(3, 'Library fine notice') });
  const by = t => out.added.find(c => c.title === t);
  assert.equal(by('AD-01 lab report').section, 'AD-01');
  assert.equal(by('Both AD-01 and AD-02 meet at 10').section, null);
  assert.equal(by('Library fine notice').section, null);
  const f = cards.listCards(0, { section: 'AD-02' }).map(c => c.title);
  assert.ok(!f.includes('AD-01 lab report') && f.includes('Library fine notice'));
  assert.ok(cards.listCards(0, { section: 'AD-02', all: true }).some(c => c.title === 'AD-01 lab report'));
});

test('a section group marks what it reads as that section', () => {
  setKv('group_map', { 'AD 02 section chat': 'sec:AD-02' });
  const out = cards.applyItems('AD 02 section chat', [{ op: 'new', type: 'notice', subject: 'General', title: 'Bring ID for lab', src: ['m1'] }], { m1: msg(1, 'Bring ID for lab') });
  assert.equal(out.added[0].section, 'AD-02');
});

test('an unsure deadline waits for the CR, can be corrected and published, then everyone gets it', async () => {
  const out = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'exam', subject: 'MAIC 209', title: 'Quiz maybe Friday', due: '2026-12-04', unsure: true, src: ['m1'] }], { m1: msg(1, 'quiz maybe friday??') });
  assert.equal(out.held.length, 1); assert.equal(out.added.length, 0);
  assert.equal(alertsFor(out).length, 0, 'no phone alert for a card that is still waiting');
  assert.ok(!(await get('/api/feed')).cards.some(c => c.title === 'Quiz maybe Friday'), 'not in the feed');
  const st = await get('/api/admin/status');
  assert.equal(st.held.length, 1); assert.equal(st.held[0].title, 'Quiz maybe Friday');
  const r = await post('/api/admin/release', { id: out.held[0].id, patch: { title: 'MAIC 209 quiz', due: '2026-12-05' } });
  assert.equal(r.j.ok, true);
  const c = (await get('/api/feed')).cards.find(x => x.id === out.held[0].id);
  assert.equal(c.title, 'MAIC 209 quiz'); assert.equal(c.due, '2026-12-05'); assert.equal(c.hold, false);
  assert.equal((await post('/api/admin/release', { id: out.held[0].id })).s, 404, 'cannot be published twice');
});

test('the CR can throw a held card away; an unsure note or old chat never waits', async () => {
  const out = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'assignment', subject: 'MAIC 209', title: 'Maybe an assignment', unsure: true, src: ['m1'] }], { m1: msg(1, 'x') });
  assert.equal((await post('/api/admin/release', { id: out.held[0].id, discard: true })).j.ok, true);
  assert.equal((await get('/api/admin/status')).held.length, 0);
  const n = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'notice', subject: 'General', title: 'Unsure notice', unsure: true, src: ['m1'] }], { m1: msg(1, 'x') });
  assert.equal(n.added.length, 1, 'only deadlines, exams and class changes wait');
  const old = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'exam', subject: 'MAIC 209', title: 'Old exam', unsure: true, src: ['m1'] }], { m1: msg(1, 'x') }, { quiet: true });
  assert.equal(old.added.length, 1, 'old chats are never held');
});

test('cards nobody checked go live after the wait', () => {
  const out = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'exam', subject: 'MAIC 205', title: 'Late held exam', due: '2026-12-09', unsure: true, src: ['m1'] }], { m1: msg(1, 'x') });
  assert.equal(cards.releaseOldHeld(Date.now()).length, 0, 'too early');
  const r = cards.releaseOldHeld(Date.now() + 13 * 36e5);
  assert.ok(r.some(c => c.id === out.held[0].id));
  assert.ok(cards.listCards(0).some(c => c.title === 'Late held exam'));
});

test('a phone only gets alerts for its own section', async () => {
  const { subscribe, sendAll } = await import('../src/push.js');
  db.prepare("insert into people(id,name,created,seen,section) values('p1','A',1,1,'AD-01'),('p2','B',1,1,'AD-02'),('p3','C',1,1,null)").run();
  subscribe({ endpoint: 'e1', keys: {} }, 'p1'); subscribe({ endpoint: 'e2', keys: {} }, 'p2'); subscribe({ endpoint: 'e3', keys: {} }, 'p3'); subscribe({ endpoint: 'e4', keys: {} });
  // no push library is set up in tests, so just check who would be picked
  const rows = db.prepare('select s.endpoint, p.section psec from subs s left join people p on p.id=s.pid').all().filter(s => !s.psec || s.psec === 'AD-01').map(s => s.endpoint).sort();
  assert.deepEqual(rows, ['e1', 'e3', 'e4']);
  assert.equal(await sendAll({ title: 'x' }, false, 'AD-01'), 0);
});

test('timetable keeps the section of a lab', async () => {
  const r = await post('/api/admin/timetable', { slots: [{ day: 1, start: '09:00', end: '09:50', subject: 'MAIC 205', kind: 'lecture' }, { day: 2, start: '14:00', end: '16:00', subject: 'MAIC 209', kind: 'lab', section: 'ad-02' }] });
  assert.deepEqual(r.j.slots.map(x => x.section), ['', 'AD-02']);
});

test('the CR types what is wrong, the AI redoes the card, and it goes to the feed', async () => {
  const out = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'assignment', subject: 'MAIC 209', title: 'Lab sheet', unsure: true, src: ['m1'] }], { m1: msg(1, 'lab sheet by friday') });
  let seen = '';
  setMock(p => { seen = p; return { discard: false, type: 'assignment', subject: 'MAIC 205', title: 'Lab sheet 4', due: '2026-12-04', time: '17:00', details: 'for AD-02 only', section: 'AD-02' }; });
  assert.equal((await post('/api/admin/revise', { id: out.held[0].id, note: '' })).s, 400);
  const r = await post('/api/admin/revise', { id: out.held[0].id, note: 'only AD-02, due Friday 5 pm' });
  assert.equal(r.s, 200); assert.ok(seen.includes('only AD-02, due Friday 5 pm'));
  const c = (await get('/api/feed')).cards.find(x => x.id === out.held[0].id);
  assert.equal(c.title, 'Lab sheet 4'); assert.equal(c.section, 'AD-02'); assert.equal(c.due, '2026-12-04'); assert.equal(c.time, '17:00'); assert.equal(c.hold, false);
  assert.equal((await get('/api/admin/status')).held.some(h => h.id === out.held[0].id), false);
});

test('a flagged live card and a held card share one review list; the AI can also discard', async () => {
  const live = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'notice', subject: 'General', title: 'Odd notice', src: ['m1'] }], { m1: msg(1, 'odd') }).added[0];
  await post('/api/flag', { id: live.id }); await post('/api/flag', { id: live.id });
  const held = cards.applyItems('Ai & DATA SCIENCE', [{ op: 'new', type: 'exam', subject: 'MAIC 205', title: 'Held exam', unsure: true, src: ['m1'] }], { m1: msg(1, 'x') }).held[0];
  const rv = (await get('/api/admin/status')).review;
  assert.ok(rv.find(x => x.id === live.id && /2 classmates/.test(x.why)));
  assert.ok(rv.find(x => x.id === held.id && x.hold));
  setMock(() => ({ discard: true }));
  assert.equal((await post('/api/admin/revise', { id: live.id, note: 'this is just a joke' })).j.discarded, true);
  assert.ok(!(await get('/api/feed')).cards.find(x => x.id === live.id && !x.deleted));
});

test.after(() => srv.close());
