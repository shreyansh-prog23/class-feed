// Cheaper PDF reading: notes filed by name without AI, long PDFs cut to their first pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXP = process.env.EXPORT_DIR || '/tmp/t/exp2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfs-'));
process.env.DATA_DIR = tmp; process.env.BATCH_WAIT_MS = '0'; process.env.PORT = '0';

const { looksLikeNotes, firstPages } = await import('../src/pdfs.js');
const { setMock } = await import('../src/ai.js');
const { ingest, flushAll } = await import('../src/reader.js');
const { db } = await import('../src/db.js');
const { PDFDocument } = await import('pdf-lib');
(await import('../src/cards.js')).seedAliases();

test('lecture-note names are filed without reading; anything hinting at a deadline or test is read', () => {
  const yes = [['L-1 Field and Vector Space.pdf'], ['Lecture_5_Eigenvalues.pdf'], ['PROBABILITY PART-I.pdf'], ['Unit 3 Notes.pdf'], ['Chapter 2 slides.pdf']];
  const no = [['Assignment 2.pdf'], ['scan 0042.pdf'], ['MAIC 209 Syllabus.pdf'], ['Unit 2 Practice Problem Set.pdf'],
    ['Unit 3 Notes.pdf', 'submit questions by Friday'], ['L-3 Basis.pdf', '', ['Sir: quiz on this next class']], ['Lecture 4 timetable change.pdf']];
  yes.forEach(([n, c, a]) => assert.equal(looksLikeNotes(n, c, a), true, n));
  no.forEach(([n, c, a]) => assert.equal(looksLikeNotes(n, c, a), false, n + ' ' + (c || '')));
});

test('a long PDF is cut to its first pages; a short one is left alone', async () => {
  const long = fs.readFileSync(path.join(EXP, 'L-1 Field and Vector Space.pdf'));   // 24 pages
  const cut = await firstPages(long, 3);
  assert.equal(cut.total, 24);
  assert.equal((await PDFDocument.load(cut.buf)).getPageCount(), 3);
  assert.ok(cut.buf.length < long.length);
  const short = await firstPages(fs.readFileSync(path.join(EXP, 'MAIC 209 Syllabus.pdf')), 3);   // 1 page
  assert.equal(short.buf, null);
  assert.equal((await firstPages(Buffer.from('not a pdf'), 3)).buf, null, 'a damaged file falls back to sending it whole');
});

test('end to end: notes cost no AI call, an unclear long PDF sends 3 pages, a short one goes whole', async () => {
  const seen = [];
  setMock(async (prompt, { files }) => {
    seen.push({ prompt, pages: files.length ? (await PDFDocument.load(files[0].data)).getPageCount() : 0 });
    return { useful: true, kind: 'notes', subject: 'General', title: 'x', due: null, time: null, summary: 's', text: 't', unsure: false };
  });
  const G = 'Some class';
  const send = (name, file, ms) => ingest({ grp: G, ms, sender: 'Prof', text: '', buf: fs.readFileSync(path.join(EXP, file)), fileName: name, mime: 'application/pdf' });
  send('Lecture 1.pdf', 'L-2 Subspaces.pdf', 1e12);                    // notes by name
  send('scan 0042.pdf', 'L-1 Fields and Vector Space.pdf', 1e12 + 1);  // long, unclear name
  send('Handout.pdf', 'MAIC 209 Syllabus.pdf', 1e12 + 2);              // 1 page, unclear name
  await flushAll();
  assert.equal(seen.length, 2, 'the notes file was not sent to the AI');
  const longCall = seen.find(s => /scan 0042/.test(s.prompt)), shortCall = seen.find(s => /Handout/.test(s.prompt));
  assert.equal(longCall.pages, 3);
  assert.match(longCall.prompt, /first 3 of 25 pages/);
  assert.equal(shortCall.pages, 1);
  assert.doesNotMatch(shortCall.prompt, /Only the first/);
  assert.equal(db.prepare("select count(*) n from cards where title='Lecture 1' and type='material' and deleted=0").get().n, 1, 'notes still get a card with the file');
});
