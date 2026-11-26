// The day's AI calls are spread out so a busy morning cannot use them all up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bud-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'c', ADMIN_CODE: 'a', GROUPS: 'MAIC', BATCH_WAIT_MS: '99999999', DAILY_CALL_CAP: '20', ASK_RESERVE: '0.2', PACE_HEAD: '0.25', PORT: '0', MIN_GAP_MS: '0', URGENT_WAIT_MS: '50' });
const ai = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const { db } = await import('../src/db.js');

let calls = 0;
ai.setMock(prompt => { calls++; const out = []; const re = /^\[(m\d+)\] .*? \| .*?: (.*)$/gm; let m; while ((m = re.exec(prompt))) out.push({ op: 'new', type: 'notice', subject: 'General', title: m[2].slice(0, 40), src: [m[1]] }); return out; });

test('the allowance grows through the day and never passes the live share of the cap', () => {
  const day = h => Date.parse('2026-11-26T00:00:00-08:00') + h * 36e5;   // Pacific time
  assert.equal(ai.dayFraction(day(0)), 0); assert.equal(ai.dayFraction(day(12)), 0.5);
  assert.equal(ai.liveAllowed(day(0)), 4);      // 20 calls, 16 for reading, a quarter of it at the start
  assert.equal(ai.liveAllowed(day(12)), 12);
  assert.equal(ai.liveAllowed(day(23.9)), 16);  // 4 are always left for Ask and the CR
});

test('messages wait, and are not lost, once the allowance for now is used', async () => {
  const allowed = ai.liveAllowed();
  db.prepare('insert into usage(day,calls) values(?,?) on conflict(day) do update set calls=excluded.calls').run(ai.today(), allowed);
  ingest({ grp: 'MAIC', ms: Date.now(), sender: 'Prof', text: 'Assignment 3 due on 5 December' });
  await flushAll();
  assert.equal(calls, 0, 'no call while over the allowance');
  assert.equal(db.prepare("select count(*) n from messages where processed=0").get().n, 1, 'still waiting');
  db.prepare('update usage set calls=0 where day=?').run(ai.today());
  await flushAll();
  assert.equal(calls, 1); assert.equal(db.prepare("select count(*) n from messages where processed=0").get().n, 0);
});

test('the timer only reads groups that have already waited the full time', async () => {
  calls = 0;
  ingest({ grp: 'MAIC', ms: Date.now(), sender: 'Prof', text: 'Quiz tomorrow at 10 am' });
  await flushAll({ aged: true });
  assert.equal(calls, 0, 'a fresh message is not read early');
  db.prepare('update messages set ms=? where processed=0').run(Date.now() - 2 * 3600000);
  await flushAll({ aged: true });
  assert.equal(calls, 1);
});

test('a cancelled or moved class is recognised, and ordinary chatter is not', async () => {
  const { isUrgent } = await import('../src/signals.js');
  for (const t of ['Tomorrow\'s DAA class is cancelled', 'maths class postponed to Friday', 'No class today', 'Extra class on Saturday 10 am', 'SE lecture rescheduled', 'class is off', 'venue changed to LH2', 'URGENT: submit now'])
    assert.ok(isUrgent(t), t);
  for (const t of ['Assignment 3 due 5 December', 'thanks sir', 'notes uploaded', 'Which class is it?'.replace('class', 'room')])
    assert.ok(!isUrgent(t), t);
});

test('an urgent message is read within a minute even when the day\'s allowance is used up', async () => {
  calls = 0;
  db.prepare('insert into usage(day,calls) values(?,?) on conflict(day) do update set calls=excluded.calls').run(ai.today(), ai.liveAllowed());
  const { flushAll: fa } = await import('../src/reader.js');
  ingest({ grp: 'MAIC', ms: Date.now(), sender: 'Prof', text: 'DAA class cancelled tomorrow' });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(calls, 1, 'read without waiting for the window');
  assert.equal(db.prepare("select count(*) n from messages where processed=0").get().n, 0);
});
