// A file is read together with the messages that explain it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
Object.assign(process.env, { DATA_DIR: tmp, GROUPS: 'MAIC', BATCH_WAIT_MS: '0', PORT: '0', GEMINI_API_KEY: 'x' });
const { setMock } = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const cards = await import('../src/cards.js');
const { db } = await import('../src/db.js');
cards.seedAliases();

const G = 'MAIC 209', T = Date.parse('2026-11-20T15:00:00');
const prompts = [];
setMock((prompt) => { prompts.push(prompt); return prompt.startsWith('You look at a') ? { useful: true, kind: 'assignment', subject: 'Linear Algebra', title: 'Unit 3 worksheet', due: null, time: null, summary: 'worksheet', text: '', unsure: false } : []; });

test('a scan is read with the nearest messages, the sender\'s own first, not the earliest ones', async () => {
  for (let i = 0; i < 8; i++) ingest({ grp: G, ms: T - 9 * 60000 + i * 1000, sender: 'Someone', text: 'unrelated early chatter number ' + i + ' about lunch plans' });
  ingest({ grp: G, ms: T + 60000, sender: 'Amit Sir', text: 'this is the Unit 3 worksheet, solve Q1 to Q5' });
  ingest({ grp: G, ms: T + 120000, sender: 'Mayank', text: 'thanks sir, will do it tonight' });
  ingest({ grp: G, ms: T, sender: 'Amit Sir', text: '', buf: Buffer.from('scan bytes'), fileName: 'Adobe Scan 20 Nov 2026.pdf', mime: 'application/pdf' });
  await flushAll();
  const p = prompts.find(x => x.startsWith('You look at a'));
  assert.ok(p, 'the scan was read');
  assert.match(p, /Amit Sir \(same sender\), 1 min after: this is the Unit 3 worksheet/);
  assert.match(p, /Mayank, 2 min after: thanks sir/);
  assert.ok((p.match(/unrelated early chatter/g) || []).length <= 4, 'the earliest messages no longer crowd out the useful ones');
  assert.match(p, /generic file name such as "Adobe Scan"/);
  assert.match(p, /especially from the person who sent it/);
});

test('existing cards show the name of their file, so a later message can be tied to the right card', () => {
  const c = db.prepare("select grp from cards where deleted=0 limit 1").get();
  const list = cards.existingFor(c.grp);
  assert.ok(list.some(x => x.file === 'Adobe Scan 20 Nov 2026.pdf'));
});

test('the text prompt tells the AI that a short message from the file\'s sender explains it', async () => {
  prompts.length = 0;
  ingest({ grp: G, ms: T + 5 * 60000, sender: 'Amit Sir', text: 'the worksheet above is due on Monday 5pm' });
  await flushAll();
  const p = prompts.find(x => x.startsWith('You read messages'));
  assert.ok(p && /short message from the person who sent a file/.test(p));
  assert.match(p, /"file":"Adobe Scan 20 Nov 2026\.pdf"/);
});
