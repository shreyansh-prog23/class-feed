// The CR uploads the timetable once; it is read, checked, saved, and reaches every phone through the feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0', GEMINI_API_KEY: 'k', CLASS_HINT: 'AI&DS semester 3', MIN_GAP_MS: '0' });
const { setMock } = await import('../src/ai.js');
const cards = await import('../src/cards.js');
cards.seedAliases(); cards.seedSubjects();
const { startServer } = await import('../src/server.js');
let prompt = '';
setMock(p => { prompt = p; return { slots: [
  { day: 'Mon', start: '9:00', end: '09:50', subject: 'SE', code: '', room: 'LT-2', kind: 'lecture', section: 'AI&DS' },
  { day: 'Tuesday', start: '10:00', end: '11:50', subject: 'Probability', code: 'MAIC 205', room: '', kind: 'lab' },
  { day: 'Sun', start: '10:00', end: '10:50', subject: 'Nope', section: 'x' },
  { day: 'Wed', start: 'late', end: '10:50', subject: 'Bad time' }] }; });
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;
const H = { 'x-class-code': 'class1', 'x-admin-code': 'boss' };

test('an uploaded timetable is read into clean rows under the class\'s own subject names; nothing is saved yet', async () => {
  const r = await fetch(base + '/api/admin/timetable/read?name=tt.png', { method: 'POST', headers: { ...H, 'content-type': 'image/png' }, body: Buffer.from('fake image bytes') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.slots.map(s => [s.day, s.start, s.end, s.subject]), [[1, '09:00', '09:50', 'Software Engineering'], [2, '10:00', '11:50', 'MAIC 205']]);
  assert.equal(j.slots[1].kind, 'lab'); assert.equal(j.slots[0].room, 'LT-2');
  assert.match(prompt, /AI&DS semester 3/); assert.match(prompt, /Software Engineering/);
  assert.deepEqual((await (await fetch(base + '/api/admin/timetable', { headers: H })).json()).slots, [], 'reading does not save');
});

test('saving puts it in the feed for everyone, and only the CR can read or save it', async () => {
  const slots = [{ day: 1, start: '09:00', end: '09:50', subject: 'Software Engineering', room: 'LT-2', kind: 'lecture' }];
  assert.equal((await fetch(base + '/api/admin/timetable', { method: 'POST', headers: { 'x-class-code': 'class1', 'content-type': 'application/json' }, body: JSON.stringify({ slots }) })).status, 401);
  const s = await fetch(base + '/api/admin/timetable', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ slots }) });
  assert.equal((await s.json()).count, 1);
  const feed = await (await fetch(base + '/api/feed', { headers: { 'x-class-code': 'class1' } })).json();
  assert.equal(feed.timetable.slots.length, 1); assert.equal(feed.timetable.slots[0].subject, 'Software Engineering');
  assert.equal((await fetch(base + '/api/admin/timetable/read', { method: 'POST', headers: { 'x-class-code': 'class1' }, body: 'x' })).status, 401);
});

test('a file with no timetable for this class says so plainly', async () => {
  setMock(() => ({ slots: [] }));
  const r = await fetch(base + '/api/admin/timetable/read?name=x.png', { method: 'POST', headers: { ...H, 'content-type': 'image/png' }, body: Buffer.from('x') });
  assert.equal(r.status, 422); assert.match((await r.json()).error, /Could not find a timetable/);
  srv.close();
});

test('the length of a slot decides lecture or lab, and two separate classes in a row are never joined', async () => {
  const { normalizeSlots } = await import('../src/timetable.js');
  const r = normalizeSlots([
    { day: 1, start: '09:00', end: '09:55', subject: 'DAA', kind: 'lab' },              // 55 min: a lecture whatever the AI said
    { day: 1, start: '10:00', end: '10:55', subject: 'SE', kind: 'lecture' },            // right after it: stays a separate lecture
    { day: 2, start: '14:00', end: '15:50', subject: 'MAIC 205', kind: 'lecture', section: 'ad 01' },  // 110 min: a lab
    { day: 3, start: '09:00', end: '09:55', subject: 'FDS', kind: 'tutorial' }
  ], null);
  assert.deepEqual(r.map(x => x.kind), ['lecture', 'lecture', 'lab', 'tutorial']);
  assert.equal(r.length, 4, 'nothing merged');
  assert.equal(r[2].section, 'AD-01'); assert.equal(r[0].section, '');
});

test('the prompt tells the AI not to join separate classes', async () => {
  const { timetablePrompt } = await import('../src/timetable.js');
  assert.ok(/Never merge/.test(timetablePrompt(null)) && /110 minutes is a lab/.test(timetablePrompt(null)));
});
