// Polls: votes are counted, and 1-2 hours later a clear winner becomes a live card that the CR can remove.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0', POLL_WAIT_MIN: '90', POLL_MIN_VOTES: '5' });
const { setMock } = await import('../src/ai.js');
const polls = await import('../src/polls.js');
const { db } = await import('../src/db.js');
const cards = await import('../src/cards.js');
const { startServer } = await import('../src/server.js');

let calls = 0, reply = { card: true, type: 'class_change', subject: 'MAIC 205', title: 'Poll: extra class Saturday', due: '2026-11-28', time: '10:00', change: 'extra', details: 'Most voted yes' };
setMock(() => { calls++; return reply; });
const T0 = Date.parse('2026-11-25T10:00:00');
const vote = (id, n, opt) => { for (let i = 0; i < n; i++) polls.recordVote(id, 'v' + opt + i + id, [opt]); };

test('a vote replaces the same person\'s earlier vote, and can be taken back', () => {
  polls.savePoll({ id: 'p0', grp: 'AIDS', ms: T0, sender: 'CR', question: 'Extra class on Saturday?', options: ['Yes', 'No'] });
  polls.recordVote('p0', 'a', ['Yes']); polls.recordVote('p0', 'a', ['No']); polls.recordVote('p0', 'b', ['Yes']); polls.recordVote('p0', 'b', []);
  assert.deepEqual(polls.tally('p0').counts, { Yes: 0, No: 1 });
  assert.equal(polls.recordVote('nope', 'a', ['Yes']), false);
});

test('nothing is read before the wait is over, and a clear winner becomes a live card marked for the CR', async () => {
  polls.savePoll({ id: 'p1', grp: 'AIDS', ms: T0, sender: 'CR', question: 'Extra class on Saturday?', options: ['Yes', 'No'] });
  vote('p1', 23, 'Yes'); vote('p1', 4, 'No');
  await polls.pollTick(T0 + 60 * 60000); assert.equal(calls, 0, 'too early');
  await polls.pollTick(T0 + 100 * 60000); assert.equal(calls, 1, 'one AI call');
  const c = db.prepare("select * from cards where title like 'Poll:%' and deleted=0").get();
  assert.ok(c, 'card made'); assert.equal(c.hold, 0, 'live right away'); assert.equal(c.uncertain, 1, 'sits in the CR list');
  assert.ok(/Yes 23, No 4/.test(c.note));
  assert.equal(db.prepare('select status from polls where id=?').get('p1').status, 1);
});

test('the CR list says it is from a poll, and the CR can remove it', async () => {
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port, H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
  try {
    const st = await (await fetch(base + '/api/admin/status', { headers: H })).json();
    const r = st.review.find(x => /^Poll:/.test(x.title)); assert.ok(r && /From a poll/.test(r.why));
    await fetch(base + '/api/admin/card', { method: 'POST', headers: H, body: JSON.stringify({ id: r.id, delete: true }) });
    assert.equal(db.prepare("select count(*) n from cards where title like 'Poll:%' and deleted=0").get().n, 0);
  } finally { srv.close(); }
});

test('too few votes, no clear winner, or a poll about nothing study related cost no AI call', async () => {
  calls = 0;
  polls.savePoll({ id: 'p2', grp: 'AIDS', ms: T0, sender: 'X', question: 'Extra class on Saturday?', options: ['Yes', 'No'] }); vote('p2', 3, 'Yes');
  polls.savePoll({ id: 'p3', grp: 'AIDS', ms: T0, sender: 'X', question: 'Extra class on Saturday?', options: ['Yes', 'No'] }); vote('p3', 10, 'Yes'); vote('p3', 9, 'No');
  polls.savePoll({ id: 'p4', grp: 'AIDS', ms: T0, sender: 'X', question: 'Best biryani place?', options: ['A', 'B'] }); vote('p4', 12, 'A');
  await polls.pollTick(T0 + 120 * 60000);
  assert.equal(calls, 0);
  assert.deepEqual(['p2', 'p3', 'p4'].map(i => db.prepare('select status from polls where id=?').get(i).status), [3, 3, 2]);
});

test('if the AI says the winning option is not a class or deadline, no card is made; an AI outage tries again later', async () => {
  reply = { card: false };
  polls.savePoll({ id: 'p5', grp: 'AIDS', ms: T0, sender: 'X', question: 'Extra class on Saturday?', options: ['Yes', 'No'] }); vote('p5', 9, 'No'); vote('p5', 1, 'Yes');
  await polls.pollTick(T0 + 120 * 60000);
  assert.equal(db.prepare('select status from polls where id=?').get('p5').status, 2);
  setMock(() => { throw new (class extends Error {})('x'); });
  polls.savePoll({ id: 'p6', grp: 'AIDS', ms: T0, sender: 'X', question: 'Extra class on Saturday?', options: ['Yes', 'No'] }); vote('p6', 9, 'Yes');
  await polls.pollTick(T0 + 120 * 60000);
  assert.equal(db.prepare('select status from polls where id=?').get('p6').status, 0, 'still waiting, not lost');
});
