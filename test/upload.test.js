// A big chat zip goes up in pieces and can carry on after a refresh or a dropped connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'MAIC 209', PORT: '0', SENDERS: '' });
const { startServer } = await import('../src/server.js');
const { historyJob } = await import('../src/history.js');
const { db } = await import('../src/db.js');
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;
const H = { 'x-class-code': 'class1', 'x-admin-code': 'boss' };
const id = crypto.randomBytes(12).toString('hex');
const lines = []; for (let i = 0; i < 60; i++) lines.push('27/10/26, 10:' + String(i % 60).padStart(2, '0') + ' - Prof Sir: Assignment ' + i + ' must be submitted by Friday, deadline is strict');
const data = Buffer.from(lines.join('\n') + '\n');

const size = () => fetch(base + '/api/admin/upload?id=' + id, { headers: H }).then(r => r.json()).then(j => j.size);
const piece = (off, buf) => fetch(base + '/api/admin/upload?id=' + id + '&offset=' + off, { method: 'POST', headers: H, body: buf }).then(async r => ({ s: r.status, j: await r.json() }));

test('pieces are added in order; a piece at the wrong place is refused and tells where to carry on', async () => {
  assert.equal(await size(), 0);
  const a = await piece(0, data.subarray(0, 1000)); assert.equal(a.s, 200); assert.equal(a.j.size, 1000);
  const dup = await piece(0, data.subarray(0, 1000));   // the same piece sent twice (a retry after a timeout)
  assert.equal(dup.s, 409); assert.equal(dup.j.size, 1000);
  const skip = await piece(5000, data.subarray(1000, 2000)); assert.equal(skip.s, 409); assert.equal(skip.j.size, 1000);
  assert.equal(await size(), 1000, 'nothing was added by the refused pieces');
});

test('after a "refresh" the server still knows how far it got, and the upload completes and is read', async () => {
  let have = await size();
  while (have < data.length) { const r = await piece(have, data.subarray(have, Math.min(have + 700, data.length))); assert.equal(r.s, 200); have = r.j.size; }
  const bad = await fetch(base + '/api/admin/upload/finish?id=' + id + '&total=' + (data.length + 1) + '&group=MAIC%20209&since=2026-08-01', { method: 'POST', headers: H });
  assert.equal(bad.status, 409, 'an incomplete upload is not started');
  const ok = await fetch(base + '/api/admin/upload/finish?id=' + id + '&total=' + data.length + '&group=MAIC%20209&since=2026-08-01', { method: 'POST', headers: H });
  assert.equal(ok.status, 200);
  for (let i = 0; i < 100 && historyJob().state !== 'done'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(historyJob().state, 'done');
  assert.ok(historyJob().stats.queued >= 50, JSON.stringify(historyJob().stats));
  assert.ok(db.prepare("select count(*) n from messages where grp='MAIC 209'").get().n >= 50);
  assert.equal(fs.existsSync(path.join(tmp, 'tmp', 'up-' + id + '.part')), false, 'the temp file is gone');
});

test('bad ids, a wrong group and a missing upload are refused; the admin code is needed', async () => {
  assert.equal((await fetch(base + '/api/admin/upload?id=../../etc', { headers: H })).status, 400);
  assert.equal((await fetch(base + '/api/admin/upload?id=' + id, { headers: { 'x-class-code': 'class1' } })).status, 401);
  const nid = crypto.randomBytes(12).toString('hex');
  assert.equal((await fetch(base + '/api/admin/upload/finish?id=' + nid + '&total=5&group=MAIC%20209&since=2026-08-01', { method: 'POST', headers: H })).status, 404);
  assert.equal((await fetch(base + '/api/admin/upload/finish?id=' + nid + '&total=5&group=Nope&since=2026-08-01', { method: 'POST', headers: H })).status, 400);
  srv.close();
});
