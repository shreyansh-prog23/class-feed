// The app never sends more calls per minute than the key allows, even when several start at the same moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-'));
Object.assign(process.env, { DATA_DIR: tmp, AI_RPM: '600', GEMINI_API_KEY: 'k', PROVIDER: 'gemini' });   // 600 a minute = 100 ms apart
delete process.env.MIN_GAP_MS;
const { askJson } = await import('../src/ai.js');

test('calls started together leave at least one gap apart', async () => {
  const times = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { times.push(Date.now()); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 }); };
  try { await Promise.all([askJson('a'), askJson('b'), askJson('c'), askJson('d')]); } finally { globalThis.fetch = realFetch; }
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 95, 'gap ' + (times[i] - times[i - 1]));
});

test('a busy or used-up model passes the call to the next backup, and a model out of calls for the day is skipped afterwards', async () => {
  const cfgMod = await import('../src/config.js');
  cfgMod.cfg.geminiFallback = ['b1', 'b2']; cfgMod.cfg.geminiModel = 'main-model'; cfgMod.cfg.minGapMs = 0; cfgMod.cfg.retryWaitMs = 0;
  const used = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const m = /models\/([^:]+):/.exec(String(url))[1]; used.push(m);
    if (m === 'main-model') return new Response('overloaded', { status: 503 });
    if (m === 'b1') return new Response('{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}]}}', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  };
  try {
    assert.deepEqual(await askJson('x', { tries: 1 }), { ok: true });
    assert.deepEqual(used, ['main-model', 'b1', 'b2']);
    used.length = 0;
    assert.deepEqual(await askJson('y', { tries: 1 }), { ok: true });
    assert.deepEqual(used, ['main-model', 'b2'], 'b1 is out of calls for today, so it is not tried again');
  } finally { globalThis.fetch = realFetch; cfgMod.cfg.geminiFallback = []; }
});
