// Who is using the app: names and small photos for the Class tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0' });
const { startServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;
const H = { 'x-class-code': 'class1', 'content-type': 'application/json' };
const post = (p, b, h = H) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('a person can join with a name and appears in the list, marked as "me" only for themselves', async () => {
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: '  Shubh   K  ' })).s, 200);
  assert.equal((await post('/api/me', { id: 'user-bbbb2222', name: 'Mayank' })).s, 200);
  const j = await (await fetch(base + '/api/people?me=user-aaaa1111', { headers: H })).json();
  assert.equal(j.count, 2);
  assert.deepEqual(j.people.map(p => p.name), ['Shubh K', 'Mayank']);
  assert.deepEqual(j.people.map(p => p.me), [true, false]);
  assert.ok(!JSON.stringify(j).includes('user-bbbb2222'), 'other people\'s ids are never sent');
});

test('names are cleaned, required, and the class code is needed', async () => {
  assert.equal((await post('/api/me', { id: 'user-cccc3333', name: '   ' })).s, 400);
  assert.equal((await post('/api/me', { id: 'x', name: 'Short id' })).s, 400);
  await post('/api/me', { id: 'user-cccc3333', name: '<b>Evil</b>' + 'x'.repeat(60) });
  const j = await (await fetch(base + '/api/people', { headers: H })).json();
  const n = j.people[2].name; assert.ok(!n.includes('<') && n.length <= 30, n);
  assert.equal((await fetch(base + '/api/people', { headers: { 'x-class-code': 'wrong' } })).status, 401);
});

test('a photo is saved, kept when only the name changes, and can be removed; bad photos are refused', async () => {
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: 'Shubh', photo: PIC })).s, 200);
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: 'Shubh K' })).s, 200);
  let j = await (await fetch(base + '/api/people?me=user-aaaa1111', { headers: H })).json();
  assert.equal(j.people[0].photo, PIC); assert.equal(j.people[0].name, 'Shubh K');
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: 'Shubh K', photo: 'http://evil/x.png' })).s, 400);
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: 'Shubh K', photo: 'data:image/jpeg;base64,' + 'A'.repeat(70000) })).s, 400);
  assert.equal((await post('/api/me', { id: 'user-aaaa1111', name: 'Shubh K', photo: null })).s, 200);
  j = await (await fetch(base + '/api/people?me=user-aaaa1111', { headers: H })).json();
  assert.equal(j.people[0].photo, null);
});

test('opening the app is counted per person, and shown to the CR as joined / today / this week', async () => {
  const A = { ...H, 'x-admin-code': 'boss' };
  db.prepare("update people set seen=? where id!='user-aaaa1111'").run(Date.now() - 3 * 864e5);
  await fetch(base + '/api/feed?since=0&me=user-aaaa1111', { headers: H });
  const st = await (await fetch(base + '/api/admin/status', { headers: A })).json();
  assert.equal(st.people.today, 1); assert.equal(st.people.week, st.people.total); assert.ok(st.people.total >= 2);
});

test('the CR can remove a name', async () => {
  const A = { ...H, 'x-admin-code': 'boss' };
  const list = await (await fetch(base + '/api/admin/people', { headers: A })).json();
  assert.ok(list.people.length >= 2);
  assert.equal((await post('/api/admin/people', { id: 'user-cccc3333' }, { ...H, 'x-admin-code': 'no' })).s, 401);
  assert.equal((await post('/api/admin/people', { id: 'user-cccc3333' }, A)).j.ok, true);
  assert.equal((await (await fetch(base + '/api/people', { headers: H })).json()).count, 2);
  srv.close();
});
