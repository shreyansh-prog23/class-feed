// "MAIC 205" and "Probability" are one subject: no path may ever create a second one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'Probability,Linear Algebra,Main', MAIN_GROUPS: 'Artificial Intelligence', PORT: '0' });
const cards = await import('../src/cards.js');
const { db, setKv } = await import('../src/db.js');
const msg = text => ({ ms: Date.now(), sender: 'x', text, kind: 'text' });
const add = (grp, subject, title, text = 'x') => cards.applyItems(grp, [{ op: 'new', type: 'notice', subject, title, src: ['m'] }], { m: msg(text) }).added[0];

db.prepare("insert into aliases(code,subject) values('MAIC 205','Probability'),('MAIC 209','Linear Algebra')").run();
cards.saveSubjects([{ name: 'Software Engineering', keys: ['SE'] }, { name: 'MAIC 205', code: 'MAIC 205' }, { name: 'MAIC 209', code: 'MAIC 209' }]);

test('a group, an AI guess or a hand edit that says Probability / Linear Algebra lands in MAIC 205 / MAIC 209', () => {
  assert.equal(add('Probability (Sem 3) 2026-27', 'General', 'Unit 1 notes').subject, 'MAIC 205');
  assert.equal(add('Linear Algebra', 'Linear Algebra', 'Sheet 3').subject, 'MAIC 209');
  assert.equal(add('Artificial Intelligence And Data Science', 'Probability', 'Quiz').subject, 'MAIC 205');
  assert.equal(add('Artificial Intelligence And Data Science', 'Totally New Subject', 'Odd').subject, 'General');
});

test('cards that already exist under the old names, even hand-edited ones, are moved in', () => {
  const c = add('Main', 'General', 'Old one');
  db.prepare("update cards set subject='Linear Algebra', pinned=1 where id=?").run(c.id);
  const d = add('Main', 'General', 'Old two');
  db.prepare("update cards set subject='Probability' where id=?").run(d.id);
  assert.ok(cards.reroute() >= 2);
  assert.equal(db.prepare('select subject from cards where id=?').get(c.id).subject, 'MAIC 209');
  assert.equal(db.prepare('select subject from cards where id=?').get(d.id).subject, 'MAIC 205');
  const subs = db.prepare("select distinct subject from cards where deleted=0").all().map(r => r.subject);
  assert.ok(subs.every(s => ['Software Engineering', 'MAIC 205', 'MAIC 209', 'General'].includes(s)), subs.join());
});

test('the phones get a map so cards they already hold are tidied too', () => {
  const m = cards.subjectMap();
  assert.equal(m['probability'], 'MAIC 205'); assert.equal(m['linear algebra'], 'MAIC 209'); assert.equal(m['maic 205'], 'MAIC 205'); assert.equal(m['se'], 'Software Engineering');
});

test('an older list that named subjects after their nicknames is renamed to the course codes, with cards following', () => {
  cards.saveSubjects([{ name: 'Probability', code: 'MAIC 205' }, { name: 'Linear Algebra', code: 'MAIC 209', keys: ['LA'] }, { name: 'Software Engineering', keys: ['SE'] }]);
  setKv('group_map', { 'Probability': 'Probability' });
  db.prepare("insert into cards(id,grp,subject,type,title,created,updated,deleted) values('old1','g','Probability','notice','Old',1,1,0),('old2','g','Linear Algebra','notice','Old2',1,1,0)").run();
  assert.equal(cards.nameByCode(), 2);
  assert.deepEqual(cards.subjectList().map(s => s.name), ['MAIC 205', 'MAIC 209', 'Software Engineering']);
  assert.ok(cards.subjectList()[0].keys.includes('Probability') && cards.subjectList()[1].keys.includes('LA'));
  assert.equal(db.prepare("select subject from cards where id='old1'").get().subject, 'MAIC 205');
  assert.equal(db.prepare("select subject from cards where id='old2'").get().subject, 'MAIC 209');
  assert.equal(cards.nameByCode(), 0, 'running it again changes nothing');
  assert.equal(cards.subjectMap()['probability'], 'MAIC 205');
});
