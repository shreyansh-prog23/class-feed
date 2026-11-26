// Guessing codes is slowed down, and a file sent in a group can never run as a web page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', PORT: '0' });
const { startServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { filePath } = await import('../src/reader.js');
const srv = startServer(); await new Promise(r => srv.once('listening', r));
const base = 'http://localhost:' + srv.address().port;

test('html and svg files are only ever downloaded, never opened in the page; pictures and PDFs open', async () => {
  const put = (id, name, mime, body) => { fs.writeFileSync(filePath(id), body); db.prepare('insert into files(id,name,mime,size,grp,ms,sender,hash) values(?,?,?,?,?,?,?,?)').run(id, name, mime, body.length, 'g', 1, 'x', id); };
  put('aa11aa11aa11aa11', 'evil.html', 'text/html', '<script>alert(1)</script>');
  put('bb22bb22bb22bb22', 'x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>');
  put('cc33cc33cc33cc33', 'ok.pdf', 'application/pdf', '%PDF-1.4');
  const H = { 'x-class-code': 'class1' };
  for (const id of ['aa11aa11aa11aa11', 'bb22bb22bb22bb22']) {
    const r = await fetch(base + '/api/files/' + id, { headers: H });
    assert.equal(r.headers.get('content-type'), 'application/octet-stream'); assert.match(r.headers.get('content-disposition'), /^attachment/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  const ok = await fetch(base + '/api/files/cc33cc33cc33cc33', { headers: H });
  assert.equal(ok.headers.get('content-type'), 'application/pdf'); assert.match(ok.headers.get('content-disposition'), /^inline/);
});

test('the app pages carry basic safety headers and cannot be read outside the public folder', async () => {
  const r = await fetch(base + '/'); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/..%2fsrc%2fmain.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});

test('thirty wrong codes lock that address out for a while; the right code is then refused too, until it passes', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await fetch(base + '/api/feed', { headers: { 'x-class-code': 'nope' + i } })).status, 401);
  const r = await fetch(base + '/api/feed', { headers: { 'x-class-code': 'class1' } });
  assert.equal(r.status, 429);
  assert.equal((await fetch(base + '/api/health')).status, 200, 'health checks are never blocked');
  srv.close();
});
