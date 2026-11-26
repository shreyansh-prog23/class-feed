// A student can report a wrong Ask answer. The CR sees it in the status and can clear it. Anonymous callers can do neither.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askrep-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0' });
const { startServer } = await import('../src/server.js');
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;
const S = { 'x-class-code': 'class1', 'content-type': 'application/json' };
const A = { ...S, 'x-admin-code': 'boss' };

test('report, list, clear', async () => {
  try {
    const bad = await fetch(base + '/api/ask-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok(bad.status === 401 || bad.status === 403);
    const ok = await fetch(base + '/api/ask-report?me=abc', { method: 'POST', headers: S, body: JSON.stringify({ q: 'when is the exam', a: 'Friday', cards: ['c1'] }) });
    assert.equal((await ok.json()).ok, true);
    const st = await (await fetch(base + '/api/admin/status', { headers: A })).json();
    assert.equal(st.askReports.length, 1); assert.equal(st.askReports[0].q, 'when is the exam');
    const denied = await fetch(base + '/api/admin/ask-report', { method: 'POST', headers: S, body: JSON.stringify({ t: st.askReports[0].t }) });
    assert.ok(denied.status === 401 || denied.status === 403);
    await fetch(base + '/api/admin/ask-report', { method: 'POST', headers: A, body: JSON.stringify({ t: st.askReports[0].t }) });
    const st2 = await (await fetch(base + '/api/admin/status', { headers: A })).json();
    assert.equal(st2.askReports.length, 0);
  } finally { srv.close(); }
});
