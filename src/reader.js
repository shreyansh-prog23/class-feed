// The heart of it: messages come in, the cheap rules throw most away, the AI reads the rest.
// Everything waits in the database first, so a crash or a daily-limit stop loses nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, getKv, setKv } from './db.js';
import { cfg } from './config.js';
import { isNoiseFile, isJunkText, senderAllowed } from './filter.js';
import { askJson, CapError, aiReady, usageToday, liveAllowed, today as quotaDay } from './ai.js';
import { textPrompt, mediaPrompt, datesheetPrompt, DATESHEET_RE } from './prompts.js';
import { looksLikeNotes, firstPages } from './pdfs.js';
import { hasSignal, isUrgent } from './signals.js';
import { registry, canonSubject, existingFor, applyItems, addFileCard, fileOnAnyCard, routeSubject } from './cards.js';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
export const filePath = id => path.join(cfg.dataDir, 'files', id);

let onChange = () => {};
export const setOnChange = f => { onChange = f; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// m: { grp, ms, sender, number, text, buf?, fileName?, mime? }
export function ingest(m) {
  if (!senderAllowed(m.sender, m.number)) return { status: 'dropped', why: 'sender not on the list' };
  let kind = 'text', fileId = null, hash = '', text = String(m.text || '').trim();

  if (m.buf) {
    const mime = m.mime || '';
    let name = m.fileName || 'file';
    // WhatsApp sometimes sends a document with no extension. Add one from its type so the app knows how to open it.
    if (!/\.[A-Za-z0-9]{1,5}$/.test(name)) name += /pdf/i.test(mime) ? '.pdf' : /jpe?g/i.test(mime) ? '.jpg' : /png/i.test(mime) ? '.png' : '';
    m.fileName = name;
    if (isNoiseFile(name, mime)) return { status: 'dropped', why: 'sticker, video or audio' };
    if (m.buf.length > cfg.maxFileBytes) return { status: 'dropped', why: 'file too big' };
    hash = sha1(m.buf.toString('latin1'));
    fileId = hash.slice(0, 16);
    const seen = db.prepare('select id from files where hash=? and grp=?').get(hash, m.grp);
    if (seen) {
      // The same file forwarded again. Only the caption could be new.
      if (isJunkText(text)) return { status: 'dropped', why: 'same file sent again' };
      kind = 'text'; text = '(sent the same file again: ' + name + ') ' + text; fileId = null;
    } else {
      fs.writeFileSync(filePath(fileId), m.buf);
      db.prepare('insert or ignore into files(id,name,mime,size,grp,ms,sender,hash) values(?,?,?,?,?,?,?,?)').run(fileId, name, mime, m.buf.length, m.grp, m.ms, m.sender, hash);
      kind = /^image\//i.test(mime) || /\.(jpe?g|png)$/i.test(name) ? 'image' : /pdf/i.test(mime) || /\.pdf$/i.test(name) ? 'pdf' : 'file';
    }
  } else if (isJunkText(text)) return { status: 'dropped', why: 'chatter' };

  const fp = sha1([m.grp, m.ms, m.sender, text, m.fileName || '', hash].join('|'));
  const r = db.prepare('insert or ignore into messages(fp,grp,ms,sender,kind,text,file_id,file_name,mime,old) values(?,?,?,?,?,?,?,?,?,?)')
    .run(fp, m.grp, m.ms, m.sender, kind, text, fileId, fileId ? m.fileName : null, m.mime || null, m.old ? 1 : 0);
  if (!r.changes) return { status: 'dropped', why: 'already have it' };
  if (!m.old) { const u = kind === 'text' && isUrgent(text); kick(m.grp, undefined, u); }
  return { status: 'queued', kind };
}

// ---------- reading ----------
let chain = Promise.resolve();
const timers = new Map();
const run = fn => { chain = chain.then(fn).catch(e => log('reader error:', e.message)); return chain; };

// How long to wait before reading a group. A quiet stretch is waited for, but a busy group is never kept waiting past batchMaxMs.
export const batchDelay = (firstAt, now, wait, max = cfg.batchMaxMs) => Math.max(0, Math.min(wait, max - (now - firstAt)));
const firsts = new Map();
const urgentGroups = new Set();
export function kick(grp, wait = cfg.batchWaitMs, urgent = false) {
  if (urgent) urgentGroups.add(grp);
  if (urgentGroups.has(grp)) wait = Math.min(wait, cfg.urgentWaitMs);   // once an urgent message is waiting, the group is read soon
  clearTimeout(timers.get(grp));
  if (!firsts.has(grp)) firsts.set(grp, Date.now());
  timers.set(grp, setTimeout(() => { firsts.delete(grp); const u = urgentGroups.delete(grp); run(() => flushGroup(grp, u)); }, batchDelay(firsts.get(grp), Date.now(), wait)));
}
export const pendingCount = () => db.prepare('select count(*) n from messages where processed=0 and old=0').get().n;
// aged: only groups whose oldest waiting message has already waited the full batch time (used by the timer and after a restart,
// so a restart or a retry never reads things early and wastes calls).
export function flushAll({ aged = false } = {}) {
  return run(async () => {
    if (!aiReady()) return;
    const cut = Date.now() - cfg.batchMaxMs;
    for (const { grp, first } of db.prepare('select grp, min(ms) first from messages where processed=0 and old=0 group by grp').all()) if (!aged || first <= cut) await flushGroup(grp);
  });
}
// Reading messages gets a share of the day's calls that grows through the day. Messages that do not fit simply wait for the next window.
let paceLogged = '';
function pacedOut() {
  if (usageToday() < liveAllowed()) return false;
  const k = quotaDay() + ':' + liveAllowed();
  if (paceLogged !== k) { paceLogged = k; log('holding messages until later: ' + usageToday() + ' AI calls used, ' + liveAllowed() + ' allowed by now (the day\'s calls are spread out)'); }
  return true;
}

function fail(row, e) {
  // A busy or rate-limited AI is not the message's fault: keep it waiting, don't count it against it.
  const busy = /AI error (429|5\d\d)/.test(e.message);
  const attempts = busy ? row.attempts : row.attempts + 1;
  db.prepare('update messages set attempts=?, processed=?, why=? where id=?').run(attempts, attempts >= 4 ? 3 : 0, String(e.message).slice(0, 200), row.id);
}

async function flushGroup(grp, urgent = false) {
  if (!aiReady()) { log('no AI key set, leaving messages waiting'); return; }
  const media = db.prepare("select * from messages where grp=? and processed=0 and old=0 and kind in ('image','pdf') order by ms").all(grp);
  for (const m of media) {
    if (!urgent && pacedOut()) return;
    try { await doMedia(m); } catch (e) { if (e instanceof CapError) { log(e.message); return; } log('photo/pdf failed:', e.message); fail(m, e); }
  }
  const texts = db.prepare("select * from messages where grp=? and processed=0 and old=0 and kind in ('text','file') order by ms").all(grp);
  for (let i = 0; i < texts.length; i += 25) {
    const rows = texts.slice(i, i + 25);
    if (noSignal(rows)) { mark(rows, 4, 'no deadline words'); continue; }
    if (!urgent && pacedOut()) return;
    try { await doText(grp, rows); } catch (e) { if (e instanceof CapError) { log(e.message); return; } log('text failed:', e.message); rows.forEach(r => fail(r, e)); }
  }
}

// A batch of plain chatter (no dates, deadline words or file) is not worth an AI call. processed = 4 keeps it for the CR to review.
const noSignal = rows => rows.every(r => r.kind === 'text' && !r.force && !hasSignal(r.text));
const mark = (rows, p, why) => rows.forEach(r => db.prepare('update messages set processed=?, why=coalesce(?,why) where id=?').run(p, why || null, r.id));

async function doText(grp, rows, quiet = false) {
  const before = db.prepare("select * from messages where grp=? and ms<? and processed in (1,4) order by ms desc limit 6").all(grp, rows[0].ms).reverse();
  const { prompt, idMap } = textPrompt(grp, rows, before, existingFor(grp), getKv('fixes', []), registry());
  const res = await askJson(prompt, { tier: 'main', tries: quiet ? 1 : 2 });
  const out = applyItems(grp, res, idMap, { quiet });
  // A document with no card of its own still goes in the library, filed by its name.
  for (const m of rows) {
    if (m.kind === 'file' && m.file_id && !fileOnAnyCard(grp, m.file_id)) {
      const reg = registry();
      const hint = routeSubject({ group: grp, title: m.file_name, files: [{ name: m.file_name }], sources: [] }, reg);
      out.added.push(addFileCard({ grp, sender: m.sender, ms: m.ms, file: { id: m.file_id, name: m.file_name }, subjectHint: hint }));
    }
  }
  mark(rows, 1);
  if (out.added.length || out.updated.length || out.held.length) { log(grp + ': ' + out.added.length + ' new, ' + out.updated.length + ' changed' + (out.held.length ? ', ' + out.held.length + ' waiting for the CR' : '') + (quiet ? ' (old chat)' : '')); if (!quiet) onChange(out); }
}

const KIND = { assignment: 'assignment', exam: 'exam', syllabus: 'syllabus', notice: 'notice', timetable: 'notice', notes: 'material', other: 'material' };

async function doMedia(m, quiet = false, skipDs = false) {
  const p = filePath(m.file_id);
  if (!fs.existsSync(p)) { mark([m], 3, 'file missing'); return; }
  const buf = fs.readFileSync(p);
  if (m.kind === 'pdf' && buf.length > cfg.maxPdfAiBytes) {
    // Too large to send to the AI: keep it in the library by name.
    const card = addFileCard({ grp: m.grp, sender: m.sender, ms: m.ms, file: { id: m.file_id, name: m.file_name }, subjectHint: null });
    mark([m], 1, 'large PDF filed by name'); if (!quiet) onChange({ added: [card], updated: [] }); return;
  }
  // The messages that explain a file are usually the nearest ones in time, most of all from the person who sent it.
  const around = db.prepare("select sender,text,ms from messages where grp=? and kind='text' and id!=? and ms between ? and ? order by (sender=?) desc, abs(ms-?) asc limit 6")
    .all(m.grp, m.id, m.ms - 600000, m.ms + 600000, m.sender, m.ms).sort((a, b) => a.ms - b.ms)
    .map(x => { const d = Math.round((x.ms - m.ms) / 60000); return x.sender + (x.sender === m.sender ? ' (same sender)' : '') + ', ' + (d === 0 ? 'at the same time' : Math.abs(d) + ' min ' + (d < 0 ? 'before' : 'after')) + ': ' + String(x.text).slice(0, 250); });
  const isDs = !skipDs && (m.force === 2 || DATESHEET_RE.test([m.file_name, m.text].concat(around).join(' ')));
  if (isDs) { await doDatesheet(m, buf, around, quiet); return; }
  if (m.kind === 'pdf' && looksLikeNotes(m.file_name, m.text, around)) {
    // Lecture notes with no deadline hint around them: file by name, no AI call at all.
    const hint = routeSubject({ group: m.grp, title: m.file_name, files: [{ name: m.file_name }], sources: [] }, registry());
    const card = addFileCard({ grp: m.grp, sender: m.sender, ms: m.ms, file: { id: m.file_id, name: m.file_name }, subjectHint: hint });
    mark([m], 1, 'notes filed by name'); if (!quiet) onChange({ added: [card], updated: [] }); log(m.grp + ': filed "' + m.file_name + '" by name (no AI call)'); return;
  }
  let data = buf, note = '';
  if (m.kind === 'pdf') {
    // A long PDF: the first pages are enough to tell what it is and whether it has a deadline.
    const cut = await firstPages(buf, cfg.pdfPages);
    if (cut.buf) { data = cut.buf; note = 'Only the first ' + cfg.pdfPages + ' of ' + cut.total + ' pages are attached. Judge from these pages, the file name and the messages around it.'; }
  }
  const mime = m.kind === 'pdf' ? 'application/pdf' : (/png/i.test(m.mime || m.file_name || '') ? 'image/png' : 'image/jpeg');
  const res = await askJson(mediaPrompt(m, around, registry(), note), { files: [{ mime, data }], tier: 'main', tries: quiet ? 1 : 2 });
  const r = Array.isArray(res) ? res[0] : res;
  if (!r || typeof r !== 'object') throw new Error('unreadable AI answer');
  const summary = String(r.summary || '').slice(0, 300);
  if (r.useful === false) { mark([m], 2, summary || 'not study related'); log(m.grp + ': skipped a photo (' + (summary || 'not study related') + ')'); return; }
  const fallback = String(m.file_name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || (m.kind === 'pdf' ? 'PDF' : 'Photo');
  const out = applyItems(m.grp, [{
    op: 'new', type: KIND[r.kind] || 'material', subject: r.subject, title: r.title || fallback,
    due: r.due, time: r.time, details: summary.slice(0, 200), body: r.text, unsure: !!r.unsure, src: ['m1']
  }], { m1: m }, { quiet });
  mark([m], 1, summary || 'read');
  if (out.added.length || out.updated.length || out.held.length) { log(m.grp + ': read a ' + (m.kind === 'pdf' ? 'PDF' : 'photo') + ' -> ' + (out.added[0] || out.held[0] || out.updated[0].card).title + (out.held.length ? ' (waiting for the CR)' : '')); if (!quiet) onChange(out); }
}


// A date sheet: one file, many papers. Each paper for this class becomes its own exam card.
const EXAM_LABEL = { mid: 'Mid sem', end: 'End sem', practical: 'Practical', other: 'Exam' };
async function doDatesheet(m, buf, around, quiet) {
  let data = buf;
  if (m.kind === 'pdf') { const cut = await firstPages(buf, 12); if (cut.buf) data = cut.buf; }
  const mime = m.kind === 'pdf' ? 'application/pdf' : (/png/i.test(m.mime || m.file_name || '') ? 'image/png' : 'image/jpeg');
  const res = await askJson(datesheetPrompt(m, around, registry(), m.dsKind), { files: [{ mime, data }], tier: 'main', tries: quiet ? 1 : 2 });
  const r = Array.isArray(res) ? res[0] : res;
  if (!r || typeof r !== 'object') throw new Error('unreadable AI answer');
  const exams = (Array.isArray(r.exams) ? r.exams : []).filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.due || '')));
  if (r.datesheet === false || !exams.length) {
    // Not a date sheet after all (or nothing for this class): let the normal reader look at it.
    if (m.force === 2) { mark([m], 2, 'no exam rows found for this class'); return; }
    return doMedia(m, quiet, true);
  }
  const items = exams.slice(0, 40).map(e => {
    const label = EXAM_LABEL[e.kind] || 'Exam', sub = String(e.subject || e.code || 'General').slice(0, 40);
    const title = label + ' exam';
    const subj = canonSubject(sub, registry());
    const had = db.prepare("select id,due,time from cards where type='exam' and deleted=0 and title=? and subject=?").get(title, subj);
    if (had) {   // the same paper again: a changed date or time updates the card, anything else is left alone
      const time = /^\d\d:\d\d$/.test(e.time || '') ? e.time : null;
      return had.due === e.due && (had.time || null) === time ? null : { op: 'update', card: had.id, due: e.due, time, why: 'date sheet changed: ' + e.due + (time ? ' ' + time : ''), src: ['m1'] };
    }
    return { op: 'new', type: 'exam', subject: sub, title, due: e.due, time: /^\d\d:\d\d$/.test(e.time || '') ? e.time : null,
      details: [e.code, e.venue, e.until ? 'till ' + e.until : ''].filter(Boolean).join(', ').slice(0, 200), unsure: !!r.unsure, src: ['m1'] };
  });
  const out = applyItems('Date sheet', items.filter(Boolean), { m1: m });
  mark([m], 1, 'date sheet: ' + exams.length + ' papers');
  log(m.grp + ': date sheet read -> ' + out.added.length + ' new, ' + out.updated.length + ' updated');
  if (!quiet && (out.added.length || out.updated.length)) onChange(out);
}

// ---------- old chats (the CR's history import) ----------
// These wait behind live messages, use only a slice of the daily AI budget, and never send alerts.
export const historyPending = () => db.prepare('select count(*) n from messages where processed=0 and old=1').get().n;
export function historyUsedToday() { const k = getKv('hist_used', {}); return k.day === quotaDay() ? k.n : 0; }
function addHistoryUse(n) { if (n > 0) setKv('hist_used', { day: quotaDay(), n: historyUsedToday() + n }); }

// When the AI is failing, wait longer each time instead of spending calls on a step that cannot work right now.
let cool = { until: 0, n: 0 };
export const resetHistoryCooldown = () => { cool = { until: 0, n: 0 }; };
function historyFailed(e) {
  cool.n++; cool.until = Date.now() + Math.min(30, 2 * 2 ** (cool.n - 1)) * 60000;
  setKv('hist_err', { msg: String(e.message).slice(0, 160), at: Date.now(), retryAt: cool.until });
}
function historyOk() { cool = { until: 0, n: 0 }; if (getKv('hist_err')) setKv('hist_err', null); }
export const historyProblem = () => getKv('hist_err', null);

export function historyTick(maxSteps = 8) {
  if (!aiReady() || !historyPending() || Date.now() < cool.until) return Promise.resolve();
  return run(async () => {
    const stop = () => cfg.dailyCallCap - usageToday() <= cfg.historyReserve || historyUsedToday() >= cfg.historyDailyCalls ||
      db.prepare('select count(*) n from messages where processed=0 and old=0').get().n > 0;
    let steps = 0;
    const step = async fn => {
      const before = usageToday();
      try { await fn(); } finally { addHistoryUse(usageToday() - before); steps++; }
    };
    for (const { grp } of db.prepare('select distinct grp from messages where processed=0 and old=1').all()) {
      for (const m of db.prepare("select * from messages where grp=? and processed=0 and old=1 and kind in ('image','pdf') order by ms limit 50").all(grp)) {
        if (steps >= maxSteps || stop()) return;
        try { await step(() => doMedia(m, true)); historyOk(); } catch (e) { if (e instanceof CapError) return; log('old photo/pdf failed:', e.message); fail(m, e); historyFailed(e); return; }
      }
      for (;;) {
        if (steps >= maxSteps || stop()) return;
        const rows = db.prepare("select * from messages where grp=? and processed=0 and old=1 and kind in ('text','file') order by ms limit 25").all(grp);
        if (!rows.length) break;
        if (noSignal(rows)) { mark(rows, 4, 'no deadline words'); continue; }
        try { await step(() => doText(grp, rows, true)); historyOk(); } catch (e) { if (e instanceof CapError) return; log('old text failed:', e.message); rows.forEach(r => fail(r, e)); historyFailed(e); return; }
      }
    }
  });
}
