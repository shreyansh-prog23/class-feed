// Date sheets (chat and CR upload), the WhatsApp warning, and the daily backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'MAIC,Main', MAIN_GROUPS: 'Artificial Intelligence', SUBJECTS: 'MAIC 209=Linear Algebra', BATCH_WAIT_MS: '0', PORT: '0', MIN_GAP_MS: '0', GEMINI_API_KEY: 'k', CLASS_HINT: 'AI&DS semester 3' });
const { setMock } = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const { db, getKv, setKv } = await import('../src/db.js');
const cards = await import('../src/cards.js');
const { waProblem, healthTick, backupTick } = await import('../src/health.js');
const { startServer } = await import('../src/server.js');
const { datesheetPrompt } = await import('../src/prompts.js');
cards.seedAliases();

const day = n => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');
const prompts = [];
const sheet = { datesheet: true, unsure: false, exams: [
  { subject: 'Linear Algebra', code: 'MAIC 209', due: day(10), time: '10:00', until: '13:00', venue: 'LT-2', kind: 'end' },
  { subject: 'Operating Systems', code: 'MAIC 205', due: day(12), time: '14:00', until: null, venue: null, kind: 'end' },
  { subject: 'No date paper', due: null, kind: 'end' }
] };
setMock(prompt => { prompts.push(prompt); return prompt.startsWith('You read an exam date sheet') ? sheet : []; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('the prompt tells the AI to keep only this class and to read many papers', () => {
  const p = datesheetPrompt({ grp: 'g', sender: 'x', ms: Date.now(), file_name: 'datesheet.pdf' }, [], { codes: { 'MAIC 209': 'Linear Algebra' }, names: {} }, '');
  for (const w of ['ONLY the papers for this class', 'AI&DS semester 3', 'MAIC 209', 'One entry per paper', 'mid|end|practical']) assert.match(p, new RegExp(w.replace(/[|&]/g, '\\$&')));
});

test('a date sheet in a group becomes one exam card per paper, sorted by course, not by the group it was posted in', async () => {
  ingest({ grp: 'MAIC 205', ms: Date.now(), sender: 'CR', text: 'End sem date sheet', buf: png, fileName: 'datesheet-end-sem.png', mime: 'image/png' });
  await flushAll();
  const ex = db.prepare("select subject,title,due,time,details,type from cards where type='exam' and deleted=0 order by due").all();
  assert.equal(ex.length, 2, 'the paper with no date is skipped');
  assert.equal(ex[0].subject, 'Linear Algebra', 'filed by course code even though posted in MAIC 205');
  assert.equal(ex[0].title, 'End sem exam');
  assert.equal(ex[0].time, '10:00');
  assert.match(ex[0].details, /LT-2/);
  assert.equal(prompts.filter(p => p.startsWith('You read an exam date sheet')).length, 1);
});

test('an ordinary photo does not use the date sheet reader', async () => {
  prompts.length = 0;
  ingest({ grp: 'MAIC 205', ms: Date.now() + 5, sender: 'Mayank', text: 'tomorrow', buf: Buffer.concat([png, Buffer.from('x')]), fileName: 'IMG-1.png', mime: 'image/png' });
  await flushAll();
  assert.ok(prompts.every(p => !p.startsWith('You read an exam date sheet')));
});

test('the CR can upload a date sheet', async () => {
  prompts.length = 0; sheet.exams = [{ subject: 'Software Engineering', code: null, due: day(14), time: null, kind: 'mid' }];
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const url = 'http://localhost:' + srv.address().port + '/api/admin/datesheet?kind=mid&name=ds2.png';
  const H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'image/png' };
  const bad = await fetch(url, { method: 'POST', headers: { ...H, 'x-admin-code': 'no' }, body: Buffer.concat([png, Buffer.from('y')]) });
  assert.equal(bad.status, 401);
  const ok = await fetch(url, { method: 'POST', headers: H, body: Buffer.concat([png, Buffer.from('z')]) });
  assert.equal(ok.status, 200);
  await new Promise(r => setTimeout(r, 1500)); await flushAll();
  srv.close();
  assert.ok(db.prepare("select 1 from cards where type='exam' and title='Mid sem exam' and subject='Software Engineering'").get(), 'card made from the upload');
  assert.ok(prompts.some(p => /mid sem date sheet/.test(p)));
});

test('a date change posted later updates rather than duplicates', async () => {
  const before = db.prepare("select count(*) n from cards where type='exam' and deleted=0").get().n;
  sheet.exams = [{ subject: 'Linear Algebra', code: 'MAIC 209', due: day(11), time: '10:00', kind: 'end' }];
  ingest({ grp: 'MAIC 209', ms: Date.now() + 9, sender: 'CR', text: 'revised date sheet', buf: Buffer.concat([png, Buffer.from('rev')]), fileName: 'revised-datesheet.png', mime: 'image/png' });
  await flushAll();
  const after = db.prepare("select count(*) n from cards where type='exam' and deleted=0").get().n;
  assert.equal(after, before, 'same paper is one card');
  assert.equal(db.prepare("select due from cards where type='exam' and title='End sem exam' and subject='Linear Algebra' and deleted=0").get().due, day(11));
});

test('WhatsApp problems are named, and only after a grace period', () => {
  const now = Date.now();
  assert.equal(waProblem({ state: 'connected', at: now }, now), null);
  assert.equal(waProblem({ state: 'reconnecting', at: now - 60000 }, now), null, 'brief reconnects are normal');
  assert.equal(waProblem({ state: 'reconnecting', at: now - 30 * 60000 }, now).key, 'down');
  assert.equal(waProblem({ state: 'LOGGED OUT: delete data/wa-auth', at: now }, now).key, 'out');
  assert.equal(waProblem({ state: 'waiting for QR scan', at: now - 10 * 60000 }, now).key, 'qr');
});

test('the warning is recorded once per problem and cleared when WhatsApp is back', async () => {
  setKv('wa', { state: 'LOGGED OUT: x', at: Date.now() });
  await healthTick(); assert.equal(getKv('wa_warned').key, 'out');
  const at = getKv('wa_warned').at; await healthTick(); assert.equal(getKv('wa_warned').at, at, 'not repeated');
  setKv('wa', { state: 'connected', at: Date.now() });
  await healthTick(); assert.equal(getKv('wa_warned'), null);
});

test('a daily backup is made once a day and only the newest few are kept', () => {
  fs.mkdirSync(path.join(tmp, 'wa-auth'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'wa-auth', 'creds.json'), '{}');
  const dir = path.join(tmp, 'backups'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(dir, 'feed-2020-01-0' + i + '.db'), 'old');
  const out = backupTick(Date.now());
  assert.ok(out && fs.statSync(out).size > 1000, 'a real database copy');
  assert.equal(backupTick(Date.now()), null, 'not again the same day');
  assert.ok(fs.existsSync(path.join(dir, 'wa-auth-' + path.basename(out).slice(5, 15), 'creds.json')));
  assert.equal(fs.readdirSync(dir).filter(f => /^feed-/.test(f)).length, 7);
});

test('the CR can name a group\'s cards, and remove a group\'s cards', async () => {
  const { setKv: sk } = await import('../src/db.js');
  sk('wa', { state: 'connected', at: Date.now(), groups: ['MAIC 205', 'Main Branch Chat'] });
  const G = 'MAIC 205';
  cards.applyItems(G, [{ op: 'new', type: 'assignment', subject: 'Whatever', title: 'Sheet 1', due: day(20), src: ['m'] }], { m: { ms: Date.now(), sender: 'x', text: 'x', kind: 'text' } });
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  try {
    const base = 'http://localhost:' + srv.address().port, H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));
    assert.equal((await post('/api/admin/groupmap', { group: 'Nope', mode: 'subject', subject: 'X' })).s, 400);
    assert.equal((await post('/api/admin/groupmap', { group: G, mode: 'subject', subject: '' })).s, 400);
    const r = await post('/api/admin/groupmap', { group: G, mode: 'subject', subject: 'Operating Systems' });
    assert.equal(r.s, 200);
    assert.equal(db.prepare("select subject from cards where title='Sheet 1'").get().subject, 'Operating Systems');
    cards.applyItems(G, [{ op: 'new', type: 'notice', subject: 'General', title: 'Quiz room', src: ['m'] }], { m: { ms: Date.now(), sender: 'x', text: 'x', kind: 'text' } });
    assert.equal(db.prepare("select subject from cards where title='Quiz room'").get().subject, 'Operating Systems', 'new cards follow the CR\'s choice');
    const st = await (await fetch(base + '/api/admin/status', { headers: H })).json();
    assert.equal(st.groupKinds.find(g => g.name === G).subject, 'Operating Systems');
    assert.ok(st.groupKinds.find(g => g.name === G).cards >= 2);
    assert.equal((await post('/api/admin/groupcards', { group: G })).s, 400, 'needs confirmation');
    // a saved message and file for this group, and one file that another group's live card still uses
    const { filePath } = await import('../src/reader.js');
    fs.writeFileSync(filePath('aaaa1111aaaa1111'), 'x'); fs.writeFileSync(filePath('bbbb2222bbbb2222'), 'y');
    db.prepare("insert into files(id,name,mime,size,grp,ms,sender,hash) values('aaaa1111aaaa1111','a.pdf','application/pdf',1,?,1,'x','h1'),('bbbb2222bbbb2222','b.pdf','application/pdf',1,?,1,'x','h2')").run(G, G);
    db.prepare("insert into messages(fp,grp,ms,sender,kind,text) values('fp-del',?,1,'x','text','hello')").run(G);
    cards.applyItems('Other group', [{ op: 'new', type: 'notice', subject: 'General', title: 'Keeps a file', src: ['m'] }], { m: { ms: Date.now(), sender: 'x', text: 'x', kind: 'text' } });
    db.prepare("update cards set files=? where title='Keeps a file'").run('[{"id":"bbbb2222bbbb2222","name":"b.pdf"}]');
    const d = await post('/api/admin/groupcards', { group: G, confirm: 'yes' });
    assert.ok(d.j.removed >= 2);
    assert.equal(d.j.messages >= 1, true);
    assert.equal(db.prepare("select count(*) n from messages where grp=?").get(G).n, 0, 'messages are gone, so a re-upload is not skipped');
    assert.equal(fs.existsSync(filePath('aaaa1111aaaa1111')), false, 'its own file is deleted');
    assert.equal(fs.existsSync(filePath('bbbb2222bbbb2222')), true, 'a file another group still shows is kept');
    assert.equal(db.prepare("select count(*) n from files where id='aaaa1111aaaa1111'").get().n, 0);
    assert.equal(db.prepare("select count(*) n from files where id='bbbb2222bbbb2222'").get().n, 1);
    assert.equal(db.prepare("select count(*) n from cards where grp=? and deleted=0").get(G).n, 0);
    const back = await post('/api/admin/groupmap', { group: G, mode: '' });
    assert.equal(back.s, 200);
  } finally { srv.close(); }
});
