// Class cancellations: stored with their meaning, shown as alerts, and updated when a class is on again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'MAIC', SUBJECTS: 'MAIC 209=Linear Algebra', BATCH_WAIT_MS: '0', PORT: '0' });
const cards = await import('../src/cards.js');
const { classAlert, alertsFor } = await import('../src/push.js');
const { textPrompt } = await import('../src/prompts.js');
const { startServer } = await import('../src/server.js');
cards.seedAliases();

const G = 'MAIC 209 AI&DS 2026-27';
const ymd = d => new Date(d).toLocaleDateString('en-CA');
const day = n => ymd(Date.now() + n * 864e5);
const msg = (text, ms = Date.now()) => ({ ms, sender: 'Prof', text, file_id: null, file_name: null, kind: 'text' });

test('the AI is told how to describe cancelled, moved, extra and restored classes', () => {
  const { prompt } = textPrompt(G, [msg('x')], [], [], [], cards.registry());
  for (const w of ['cancelled_all', 'rescheduled', 'extra', 'restored', 'later date']) assert.match(prompt, new RegExp(w));
  assert.match(prompt, /"change":"cancelled\|cancelled_all/);
});

test('a cancellation is stored with its meaning and reaches phones through the feed', async () => {
  const out = cards.applyItems(G, [
    { op: 'new', type: 'class_change', subject: 'Linear Algebra', title: 'Linear Algebra class cancelled', due: day(1), time: '10:00', change: 'cancelled', src: ['m1'] },
    { op: 'new', type: 'class_change', subject: 'General', title: 'No classes, college holiday', due: day(3), change: 'cancelled_all', src: ['m1'] },
    { op: 'new', type: 'class_change', subject: 'Linear Algebra', title: 'Extra class', due: day(2), time: '16:00', change: 'bogus', src: ['m1'] },
    { op: 'new', type: 'assignment', subject: 'Linear Algebra', title: 'Assignment 4', due: day(5), change: 'cancelled', src: ['m1'] }
  ], { m1: msg('x') });
  assert.equal(out.added[0].change, 'cancelled');
  assert.equal(out.added[1].change, 'cancelled_all');
  assert.equal(out.added[2].change, '', 'an unknown value is dropped');
  assert.equal(out.added[3].change, '', 'only class changes carry one');
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const feed = await (await fetch('http://localhost:' + srv.address().port + '/api/feed', { headers: { 'x-class-code': 'class1' } })).json();
  srv.close();
  assert.equal(feed.cards.find(c => c.title === 'Linear Algebra class cancelled').change, 'cancelled');
});

test('alerts say what happened and when, and stay quiet about classes that are already over', () => {
  const base = { id: 'x', subject: 'Linear Algebra', title: 'Linear Algebra class cancelled', details: '', time: '10:00' };
  const a = classAlert({ ...base, due: day(0), change: 'cancelled' });
  assert.equal(a.title, 'Linear Algebra class cancelled today');
  assert.match(a.body, /at 10:00/);
  assert.equal(classAlert({ ...base, due: day(1), change: 'cancelled' }).title, 'Linear Algebra class cancelled tomorrow');
  assert.match(classAlert({ ...base, due: day(4), change: 'cancelled' }).title, /cancelled \w{3}, \d+ \w{3}/, 'a later date is spelled out');
  assert.equal(classAlert({ ...base, due: day(-1), change: 'cancelled' }), null, 'yesterday is not worth an alert');
  assert.equal(classAlert({ ...base, subject: 'General', title: 'Holiday', time: null, due: day(1), change: 'cancelled_all' }).title, 'No classes tomorrow');
  assert.match(classAlert({ ...base, due: day(1), change: 'rescheduled', time: '14:00', details: 'moved to 14:00, room 301' }).title, /class moved/);
  assert.match(classAlert({ ...base, due: day(1), change: 'extra', time: '16:00', title: 'Extra class' }).title, /^Extra Linear Algebra tomorrow/);
  assert.match(classAlert({ ...base, due: day(1), change: 'restored' }).title, /on again/);
});

test('a new cancellation alerts; a withdrawn one alerts "on again"; ordinary updates keep their old wording', () => {
  const out = cards.applyItems(G, [{ op: 'new', type: 'class_change', subject: 'Linear Algebra', title: 'Class off tomorrow', due: day(1), change: 'cancelled', src: ['m1'] }], { m1: msg('x') });
  const m = alertsFor(out);
  assert.equal(m.length, 1);
  assert.match(m[0].title, /cancelled tomorrow/);
  const id = out.added[0].id;
  const out2 = cards.applyItems(G, [{ op: 'update', card: id, change: 'restored', why: 'class will be held', src: ['m1'] }], { m1: msg('y') });
  assert.equal(out2.updated[0].card.change, 'restored');
  assert.match(alertsFor(out2)[0].title, /on again tomorrow/);
  const a = cards.applyItems(G, [{ op: 'new', type: 'assignment', subject: 'Linear Algebra', title: 'Assignment 9', due: day(6), src: ['m1'] }], { m1: msg('z') });
  assert.match(alertsFor(a)[0].title, /new assignment/);
  const old = cards.applyItems(G, [{ op: 'new', type: 'class_change', subject: 'Linear Algebra', title: 'Class off yesterday', due: day(-2), change: 'cancelled', src: ['m1'] }], { m1: msg('w') });
  assert.deepEqual(alertsFor(old), [], 'no alert for a date that has passed');
});
