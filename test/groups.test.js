// How cards are filed by group: a subject group is one subject, the main group is sorted by content.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'AIDS,Software,Computer,MAIC,Misc', MAIN_GROUPS: 'AIDS 2026',
  SUBJECTS: 'MAIC 209=Linear Algebra;MAIC 205=Probability', BATCH_WAIT_MS: '0', PORT: '0' });
const { setMock } = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const cards = await import('../src/cards.js');
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
cards.seedAliases();

let aiSubject = 'General', aiType = 'notice', prompts = [];
setMock((prompt) => {
  prompts.push(prompt);
  if (prompt.startsWith('You look at a')) return { useful: true, kind: 'notes', subject: aiSubject, title: 'A scan', due: null, time: null, summary: 's', text: '', unsure: false };
  const out = []; const re = /^\[(m\d+)\] .*? \| .*?: (.*)$/gm; let m;
  while ((m = re.exec(prompt))) out.push({ op: 'new', type: aiType, subject: aiSubject, title: m[2].slice(0, 40), src: [m[1]] });
  return out;
});
let t = Date.parse('2026-11-20T10:00:00');
const post = async (grp, text, subject = 'General', type = 'notice') => {
  aiSubject = subject; aiType = type; prompts = [];
  ingest({ grp, ms: t += 60000, sender: 'Prof', text });
  await flushAll();
  return db.prepare('select * from cards where grp=? and title=? and deleted=0').get(grp, text.slice(0, 40));
};

test('cleaning a group name gives a tidy subject', () => {
  assert.equal(cards.cleanGroupName('Computer Organization & Architecture (Sem 3) 2026-27'), 'Computer Organization & Architecture');
  assert.equal(cards.cleanGroupName('Software Engineering'), 'Software Engineering');
  assert.equal(cards.cleanGroupName('OS - 2026'), 'OS');
});

test('a group named after a subject files everything under that subject, whatever the AI guessed', async () => {
  const a = await post('Software Engineering', 'Submit SRS document by Friday 5pm', 'General', 'assignment');
  assert.equal(a.subject, 'Software Engineering');
  const b = await post('Software Engineering', 'Class cancelled tomorrow, please note', 'Maths', 'class_change');
  assert.equal(b.subject, 'Software Engineering', 'a notice in a subject group stays in that subject');
  const c = await post('Computer Organization & Architecture (Sem 3) 2026-27', 'Quiz on pipelining next Monday', 'General', 'exam');
  assert.equal(c.subject, 'Computer Organization & Architecture');
  const d = await post('MAIC 205 Prob', 'Submit assignment 2 by Monday', 'General', 'assignment');
  assert.equal(d.subject, 'Probability', 'a group with a course code uses the mapped subject');
});

test('in a subject group, a course code that names another subject still moves the card', async () => {
  const x = await post('Software Engineering', 'MAIC 209 quiz is on Friday at 10', 'General', 'exam');
  assert.equal(x.subject, 'Linear Algebra');
});

test('the main group is sorted by what each message says; general notices stay General', async () => {
  const g = 'AIDS 2026 Main Group';
  assert.equal((await post(g, 'MAIC 209 assignment 3 due Friday', 'General', 'assignment')).subject, 'Linear Algebra', 'a course code files it');
  assert.equal((await post(g, 'Holiday on Friday for Diwali, college closed', 'General', 'notice')).subject, 'General', 'a general notice stays General');
  assert.equal((await post(g, 'Submit the Probability worksheet by Monday', 'Probability', 'assignment')).subject, 'Probability', 'the AI\'s subject from the content is kept');
  assert.equal((await post(g, 'Submit the Compiler Design report by Tuesday', 'Compiler Design', 'assignment')).subject, 'Compiler Design', 'a new subject named in the content is kept');
});

test('files follow the same rule', () => {
  const sub = cards.addFileCard({ grp: 'Software Engineering', sender: 'P', ms: Date.now(), file: { id: 'f1', name: 'L-3 Design.pdf' }, subjectHint: null });
  assert.equal(sub.subject, 'Software Engineering');
  const main = cards.addFileCard({ grp: 'AIDS 2026 Main Group', sender: 'P', ms: Date.now(), file: { id: 'f2', name: 'Exam form.pdf' }, subjectHint: null });
  assert.equal(main.subject, 'General', 'nothing points to a subject');
  const mainCode = cards.addFileCard({ grp: 'AIDS 2026 Main Group', sender: 'P', ms: Date.now(), file: { id: 'f3', name: 'MAIC 205 Unit 2.pdf' }, subjectHint: null });
  assert.equal(mainCode.subject, 'Probability');
});

test('the AI is told how each group is filed', async () => {
  await post('Software Engineering', 'Submit design doc by Friday', 'General', 'assignment');
  assert.match(prompts.find(p => p.startsWith('You read')), /This group is for the subject "Software Engineering"/);
  await post('AIDS 2026 Main Group', 'Submit the lab file by Friday', 'General', 'assignment');
  const p = prompts.find(x => x.startsWith('You read'));
  assert.match(p, /This is the MAIN group for the whole class/);
  assert.match(p, /holidays, events, fees/);
});

test('re-filing fixes cards that were filed under the old rule, but leaves the CR\'s own edits', () => {
  db.prepare("update cards set subject='General' where grp='Software Engineering' and title like 'Submit SRS%'").run();
  db.prepare("update cards set subject='Custom', pinned=1 where grp='Software Engineering' and title like 'Class cancelled%'").run();
  assert.ok(cards.reroute() >= 1);
  assert.equal(db.prepare("select subject from cards where title like 'Submit SRS%'").get().subject, 'Software Engineering');
  assert.equal(db.prepare("select subject from cards where title like 'Class cancelled%'").get().subject, 'Custom');
});

test('the CR page shows how each group is filed', async () => {
  db.prepare('insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v').run('wa', JSON.stringify({ state: 'connected', groups: ['Software Engineering', 'AIDS 2026 Main Group', 'Random Memes'] }));
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const st = await (await fetch('http://localhost:' + srv.address().port + '/api/admin/status', { headers: { 'x-class-code': 'class1', 'x-admin-code': 'boss' } })).json();
  try {
    assert.deepEqual(st.groupKinds.map(g => [g.name, g.kind, g.subject]), [['Software Engineering', 'subject', 'Software Engineering'], ['AIDS 2026 Main Group', 'main', null], ['Random Memes', 'ignore', 'Random Memes']]);
  } finally { srv.close(); }
});
