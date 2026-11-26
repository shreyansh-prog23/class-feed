// Fewer AI calls: the signal filter, the CR review list, shared backoff, and the batch wait limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-'));
Object.assign(process.env, { DATA_DIR: tmp, CLASS_CODE: 'class1', ADMIN_CODE: 'boss', GROUPS: 'MAIC', BATCH_WAIT_MS: '0', PORT: '0', MIN_GAP_MS: '0', RETRY_WAIT_MS: '0', GEMINI_API_KEY: 'test-key' });

const { hasSignal, addSignalWord } = await import('../src/signals.js');
const { setMock, askJson, resetCooldown, usageToday } = await import('../src/ai.js');
const { ingest, flushAll, batchDelay } = await import('../src/reader.js');
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
(await import('../src/cards.js')).seedAliases();

const G = 'MAIC 209';
let aiCalls = 0;
const mockOk = () => setMock(() => { aiCalls++; return []; });
let t = Date.now();
const say = (text, o = {}) => ingest({ grp: G, ms: t += 1000, sender: 'Mayank', text, ...o });
const status = text => db.prepare('select processed,force from messages where text=?').get(text);

test('the signal filter catches dates, deadline words and Hinglish, and ignores plain chatter', () => {
  ['Submit it by Friday', 'quiz at 10', 'kal class nahi hoga', 'Assignment 3 uploaded', 'Mid sem on 5th', 'bring your ID cards tomorrow', 'LAB TEST', 'meet link?'].forEach(x => assert.ok(hasSignal(x), x));
  ['that was a really funny joke bro', 'who is coming to canteen with me', 'lol same here honestly', 'good luck everyone for whatever'].forEach(x => assert.ok(!hasSignal(x), x));
  assert.equal(hasSignal('we have a fascinating discussion about everything else'), false);
  assert.ok(addSignalWord('fascinating') && hasSignal('a fascinating thing'), 'a word added by the CR counts from then on');
  assert.equal(addSignalWord('x'), false);
});

test('a batch of chatter is not sent to the AI and is kept for review; a batch with a signal or a file is', async () => {
  mockOk();
  say('honestly nobody here cares about the weather anymore dude');
  say('i think the canteen food has become so much worse lately');
  await flushAll();
  assert.equal(aiCalls, 0, 'no call for chatter');
  assert.equal(status('i think the canteen food has become so much worse lately').processed, 4);
  say('Submit assignment 2 by Monday');
  say('and also the canteen thing again nobody cares');
  await flushAll();
  assert.equal(aiCalls, 1, 'one call for a batch that has a signal');
  assert.equal(db.prepare("select count(*) n from messages where processed=1 and text like 'and also the canteen%'").get().n, 1, 'chatter that arrives with a signal is read with it, for context');
  const n = aiCalls;
  ingest({ grp: G, ms: t += 1000, sender: 'Prof', text: '', buf: Buffer.from('notes bytes'), fileName: 'randomfile.docx', mime: 'application/octet-stream' });
  await flushAll();
  assert.equal(aiCalls, n + 1, 'a file always counts as a signal');
});

test('CR review: skipped messages are listed, "Read this" sends one to the AI and teaches a word, "Fine to skip" clears it', async () => {
  mockOk();
  const longChatter = 'that surprise about the ceremony thing is turning out to be remarkable honestly';
  say(longChatter); say('a different lengthy musing about how remarkable everything around here is turning out');
  await flushAll();
  const srv = startServer(); await new Promise(r => srv.once('listening', r));
  const base = 'http://localhost:' + srv.address().port, H = { 'x-class-code': 'class1', 'x-admin-code': 'boss', 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/admin/maybe', { headers: { 'x-class-code': 'class1' } })).status, 401);
  const list = await (await fetch(base + '/api/admin/maybe', { headers: H })).json();
  const a = list.maybe.find(m => m.text === longChatter), b = list.maybe.find(m => /different lengthy/.test(m.text));
  assert.ok(a && b && list.skippedWeek >= 2);
  const c0 = aiCalls;
  assert.equal((await fetch(base + '/api/admin/maybe', { method: 'POST', headers: H, body: JSON.stringify({ id: a.id, action: 'read', word: 'ceremony' }) })).status, 200);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(aiCalls, c0 + 1, 'the confirmed message was read');
  assert.equal(status(longChatter).processed, 1);
  assert.ok(hasSignal('is there a ceremony'), 'and the word was learned');
  await fetch(base + '/api/admin/maybe', { method: 'POST', headers: H, body: JSON.stringify({ id: b.id, action: 'skip' }) });
  assert.equal(db.prepare('select processed from messages where id=?').get(b.id).processed, 5);
  assert.equal((await fetch(base + '/api/admin/maybe', { method: 'POST', headers: H, body: JSON.stringify({ id: b.id, action: 'skip' }) })).status, 404, 'already handled');
  srv.close();
});

test('when the AI says too many requests, one pause is shared: no more calls until it is over', async () => {
  setMock(null); resetCooldown();
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = async () => { hits++; return { ok: false, status: 429, text: async () => 'quota exceeded' }; };
  try {
    const u0 = usageToday();
    await assert.rejects(askJson('hello'), /AI error 429/);
    assert.ok(hits >= 1 && hits <= 2, 'at most one retry: ' + hits);
    const h1 = hits, u1 = usageToday();
    await assert.rejects(askJson('hello again'), /backing off/);
    await assert.rejects(askJson('and again'), /backing off/);
    assert.equal(hits, h1, 'no requests were sent during the pause');
    assert.equal(usageToday(), u1, 'and none were counted');
    assert.ok(u1 > u0);
    resetCooldown();
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '["fine"]' }] } }] }) });
    assert.deepEqual(await askJson('works now'), ['fine']);
  } finally { globalThis.fetch = realFetch; resetCooldown(); }
});

test('a busy group is read at the latest after the maximum wait', () => {
  assert.equal(batchDelay(1000, 1000, 180000, 600000), 180000, 'a fresh batch waits the normal time');
  assert.equal(batchDelay(0, 500000, 180000, 600000), 100000, 'close to the limit, wait only what is left');
  assert.equal(batchDelay(0, 700000, 180000, 600000), 0, 'past the limit, read now');
});
