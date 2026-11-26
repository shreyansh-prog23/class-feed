// The CR uploads a WhatsApp "Export chat" zip. We read the chat file and the photos/PDFs inside it,
// keep only what was sent since the semester start, and queue it behind live messages.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { getKv, setKv } from './db.js';
import { openZip } from './zip.js';
import { parseChat } from './replay.js';
import { ingest } from './reader.js';
import { isNoiseFile } from './filter.js';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const historyJob = () => getKv('history_job', null);
const setJob = j => setKv('history_job', j);
export const jobRunning = () => { const j = historyJob(); return !!(j && j.state === 'reading' && Date.now() - j.at < 30 * 60 * 1000); };

// Reads the zip and queues the messages. Returns a summary. Throws a plain-English error if the zip is no good.
// Accepts a zip (chat with media) or a plain .txt (Android's "without media" export).
export function importZip(zipPath, group, since) {
  const g = importSteps(zipPath, group, since); let r;
  while (!(r = g.next()).done) { /* run to the end */ }
  return r.value;
}
// The same work in small steps, so a big zip never freezes the server and its progress can be shown.
export function* importSteps(zipPath, group, since) {
  const head = Buffer.alloc(4); const fd = fs.openSync(zipPath, 'r'); try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip && fs.statSync(zipPath).size > 60 * 1024 * 1024) throw new Error('This chat file is too big.');
  const z = isZip ? openZip(zipPath) : { entries: [], close() {} };
  try {
    let raw;
    if (isZip) {
      const chats = z.entries.filter(e => /\.txt$/i.test(e.base)).sort((a, b) => b.usize - a.usize);
      if (!chats.length) throw new Error('No chat file (.txt) found inside this zip. Export the chat from WhatsApp and upload that zip as it is.');
      raw = z.extract(chats[0], 60 * 1024 * 1024).toString('utf8');
    } else raw = fs.readFileSync(zipPath, 'utf8');
    const msgs = parseChat(raw);
    if (!msgs.length) throw new Error('Could not read any messages from this file. Upload the zip or .txt that WhatsApp made when you exported the chat.');
    const byName = new Map(z.entries.map(e => [e.base, e]));
    const inRange = msgs.filter(m => m.ms >= since);
    const stats = { found: msgs.length, inRange: inRange.length, oldest: msgs[0].ms, newest: msgs[msgs.length - 1].ms, queued: 0, files: 0, filesSkipped: 0, dropped: {} };
    let n = 0;
    for (const m of inRange) {
      if (++n % 20 === 0) yield { done: n, total: inRange.length };
      let r;
      const ent = m.file && byName.get(m.file);
      const ext = m.file ? path.extname(m.file).toLowerCase() : '';
      if (m.file && ent && MIME[ext] && !isNoiseFile(m.file)) {
        if (stats.files >= cfg.historyMaxFiles) { stats.filesSkipped++; continue; }
        let buf;
        try { buf = z.extract(ent, cfg.maxFileBytes); } catch (e) { stats.dropped['file too big or damaged'] = (stats.dropped['file too big or damaged'] || 0) + 1; continue; }
        r = ingest({ grp: group, ms: m.ms, sender: m.sender, text: m.text, buf, fileName: m.file, mime: MIME[ext], old: true });
        if (r.status === 'queued') stats.files++;
      } else if (m.file) {
        r = { status: 'dropped', why: isNoiseFile(m.file) ? 'sticker, video or audio' : 'file not in the export' };
      } else r = ingest({ grp: group, ms: m.ms, sender: m.sender, text: m.text, old: true });
      if (r.status === 'queued') stats.queued++; else stats.dropped[r.why] = (stats.dropped[r.why] || 0) + 1;
    }
    return stats;
  } finally { z.close(); }
}

// Runs in the background after the upload finishes, so the CR's phone isn't left waiting.
export function startImport(zipPath, group, since) {
  setJob({ state: 'reading', group, since, at: Date.now() });
  const steps = importSteps(zipPath, group, since);
  const finish = () => { try { fs.unlinkSync(zipPath); } catch (e) { /* already gone */ } };
  const next = () => {
    try {
      const r = steps.next();
      if (r.done) {
        setJob({ state: 'done', group, since, at: Date.now(), stats: r.value });
        log('old chat imported for "' + group + '": ' + r.value.queued + ' messages queued');
        return finish();
      }
      setJob({ state: 'reading', group, since, at: Date.now(), progress: r.value });   // "at" doubles as a heartbeat
    } catch (e) {
      setJob({ state: 'failed', group, since, at: Date.now(), error: String(e.message).slice(0, 300) });
      log('old chat import failed:', e.message);
      return finish();
    }
    setImmediate(next);
  };
  setImmediate(next);
}
