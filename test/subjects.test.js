// The class's own subject list: cards go under one of them, or General.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'MAIC,Main', MAIN_GROUPS: 'Artificial Intelligence', SUBJECTS: 'MAIC 209=Linear Algebra', PORT: '0' });
const cards = await import('../src/cards.js');
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { textPrompt } = await import('../src/prompts.js');
cards.seedAliases(); cards.seedSubjects();
const MAIN = 'Artificial Intelligence And Data Science';
const msg = text => ({ ms: Date.now(), sender: 'x', text, kind: 'text' });
const add = (grp, subject, title, text = 'x') => cards.applyItems(grp, [{ op: 'new', type: 'notice', subject, title, src: ['m'] }], { m: msg(text) }).added[0];

test('the six subjects exist from the start, using names the app already knew', () => {
  const names = cards.subjectList().map(s => s.name);
  assert.equal(names.length, 6);
  assert.ok(names.includes('Design & Analysis of Algorithm') && names.includes('MAIC 209'), names.join());
});

test('in the main group, a short name or a course code files the card under the right subject', () => {
  assert.equal(add(MAIN, 'General', 'COA sheet uploaded').subject, 'Computer Organization & Architecture');
  assert.equal(add(MAIN, 'General', 'Quiz tomorrow', 'MAIC 209 quiz tomorrow').subject, 'MAIC 209');
  assert.equal(add(MAIN, 'General', 'DAA assignment 2').subject, 'Design & Analysis of Algorithm');
});

test('a subject the AI invents becomes General; one of ours stays; whole-class news stays General', () => {
  assert.equal(add(MAIN, 'Quantum Basket Weaving', 'Odd one').subject, 'General');
  assert.equal(add(MAIN, 'Software Engineering', 'SRS review').subject, 'Software Engineering');
  assert.equal(add(MAIN, 'general', 'Holiday on Friday').subject, 'General');
});

test('the prompt names exactly the six subjects and forbids new ones', () => {
  const { prompt } = textPrompt(MAIN, [msg('hello')], [], [], [], cards.registry());
  assert.match(prompt, /exactly these subjects and no others/);
  assert.match(prompt, /Foundations of Data Science/);
  assert.match(prompt, /Never invent a subject/);
});

test('the CR can change the list, and the feed carries it so empty subjects still show', async () => {
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port, H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
  const cur = (await (await fetch(base + '/api/admin/subjects', { headers: H })).json()).subjects;
  assert.equal(cur.length, 6);
  const next = cur.concat([{ name: 'Economics', code: 'HUM 101', keys: 'Eco, Econ' }]);
  const r = await (await fetch(base + '/api/admin/subjects', { method: 'POST', headers: H, body: JSON.stringify({ subjects: next }) })).json();
  assert.ok(r.ok); assert.equal(cards.subjectList().length, 7); assert.deepEqual(cards.subjectList()[6].keys, ['Eco', 'Econ']); assert.equal(cards.subjectList()[6].code, 'HUM 101');
  assert.equal(add(MAIN, 'General', 'Econ notes posted').subject, 'Economics');
  const feed = await (await fetch(base + '/api/feed', { headers: { 'x-class-code': 'class1' } })).json();
  assert.equal(feed.subjectList.length, 7);
  assert.equal((await fetch(base + '/api/admin/subjects', { method: 'POST', headers: H, body: JSON.stringify({ subjects: [] }) })).status, 400);
  assert.equal(cards.subjectList().length, 7, 'a bad save does not wipe the list');
  srv.close();
});

test('existing cards are re-filed when the list changes', () => {
  db.prepare("update cards set subject='Old Name' where title='SRS review'").run();
  cards.reroute();
  assert.equal(db.prepare("select subject from cards where title='SRS review'").get().subject, 'General');
});

test('cards filed under a nickname move to the course code\'s subject when the list is applied', () => {
  const c = add('MAIC 209 AI&DS 2026-27', 'MAIC 209', 'Sheet 5');
  assert.equal(c.subject, 'MAIC 209');
  db.prepare("update cards set subject='Linear Algebra' where id=?").run(c.id);   // the old nickname
  assert.ok(cards.reroute() >= 1);
  assert.equal(db.prepare('select subject from cards where id=?').get(c.id).subject, 'MAIC 209');
});

test('renaming a subject on the CR page renames it on every card, and in the feed', async () => {
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port, H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
  const cur = (await (await fetch(base + '/api/admin/subjects', { headers: H })).json()).subjects;
  assert.ok(cur.every(x => 'alias' in x));
  const c = add(MAIN, 'Software Engineering', 'Design review notes');
  const next = cur.map(x => ({ was: x.name, name: x.name === 'Software Engineering' ? 'Software Engg' : x.name, keys: x.alias }));
  const r = await (await fetch(base + '/api/admin/subjects', { method: 'POST', headers: H, body: JSON.stringify({ subjects: next }) })).json();
  assert.ok(r.renamed >= 1, 'cards moved with the name: ' + r.renamed);
  assert.equal(db.prepare('select subject from cards where id=?').get(c.id).subject, 'Software Engg');
  const feed = await (await fetch(base + '/api/feed', { headers: { 'x-class-code': 'class1' } })).json();
  assert.ok(feed.subjectList.includes('Software Engg') && !feed.subjectList.includes('Software Engineering'));
  assert.equal(add(MAIN, 'General', 'SE quiz moved').subject, 'Software Engg', 'short names still work after a rename');
  srv.close();
});
