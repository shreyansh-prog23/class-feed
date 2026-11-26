// Feed a WhatsApp export through the same pipeline the live listener uses.
//   npm run replay -- "<folder with the unzipped export>" --group "MAIC 209 AI&DS 2026-27"
// It uses your real AI key from .env. Good for a first fill of the feed, and for testing.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { seedAliases } from './cards.js';
import { ingest, flushAll } from './reader.js';
import { isNoiseFile } from './filter.js';

export function parseChat(raw) {
  const text = raw.replace(/[‎‏‪-‬﻿]/g, '').replace(/ /g, ' ');
  const reA = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?(?:\s?([AaPp])\.?[Mm]\.?)?\s+-\s+(.*)$/;
  const reB = /^\[(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?(?:\s?([AaPp])\.?[Mm]\.?)?\]\s+(.*)$/;
  const entries = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = reA.exec(line) || reB.exec(line);
    if (m) { cur = { a: +m[1], b: +m[2], y: +m[3], h: +m[4], mi: +m[5], ap: m[6] ? m[6].toLowerCase() : '', rest: m[7] }; entries.push(cur); }
    else if (cur) cur.rest += '\n' + line;
  }
  const dmy = entries.some(e => e.a > 12) ? true : !entries.some(e => e.b > 12);
  const msgs = [];
  for (const e of entries) {
    const day = dmy ? e.a : e.b, mon = dmy ? e.b : e.a, year = e.y < 100 ? 2000 + e.y : e.y;
    let h = e.h; if (e.ap === 'p' && h < 12) h += 12; if (e.ap === 'a' && h === 12) h = 0;
    const ms = new Date(year, mon - 1, day, h, e.mi, 0, 0).getTime();
    const nl = e.rest.indexOf('\n'), head = nl < 0 ? e.rest : e.rest.slice(0, nl), ix = head.indexOf(': ');
    if (!(ix > 0 && ix <= 80)) continue;   // system lines: joins, icon changes
    const sender = head.slice(0, ix).replace(/^~[\s ]*/, '').trim();
    let body = e.rest.slice(ix + 2).trim(), file = null;
    const first = body.split('\n')[0].trim();
    const fm = /^(.+?) \(file attached\)$/.exec(first) || /^<attached: (.+)>$/.exec(first);
    if (fm) { file = fm[1].trim(); body = body.split('\n').slice(1).map(x => x.trim()).filter(x => x && x !== file).join('\n'); }
    else if (/^(This message was deleted|You deleted this message)\.?$/i.test(body)) continue;
    else if (/^(<Media omitted>|(image|video|audio|sticker|GIF|document|contact card) omitted)$/i.test(body)) continue;
    msgs.push({ ms, sender, text: body, file });
  }
  return msgs;
}

export async function replay(dir, group, { since } = {}) {
  const txt = fs.readdirSync(dir).find(f => /\.txt$/i.test(f));
  if (!txt) throw new Error('no .txt chat file in ' + dir);
  const msgs = parseChat(fs.readFileSync(path.join(dir, txt), 'utf8')).filter(m => !since || m.ms >= since);
  const stats = { messages: msgs.length, dropped: {}, queued: 0 };
  for (const m of msgs) {
    let r;
    const fp = m.file && path.join(dir, m.file);
    if (m.file && fp && fs.existsSync(fp) && !isNoiseFile(m.file)) {
      const ext = path.extname(m.file).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
      r = ingest({ grp: group, ms: m.ms, sender: m.sender, text: m.text, buf: fs.readFileSync(fp), fileName: m.file, mime });
    } else if (m.file) {
      r = isNoiseFile(m.file) ? { status: 'dropped', why: 'sticker, video or audio' } : { status: 'dropped', why: 'file not in the export' };
    } else r = ingest({ grp: group, ms: m.ms, sender: m.sender, text: m.text });
    if (r.status === 'queued') stats.queued++; else stats.dropped[r.why] = (stats.dropped[r.why] || 0) + 1;
  }
  await flushAll();
  return stats;
}

if (process.argv[1] && process.argv[1].endsWith('replay.js')) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  const gi = args.indexOf('--group'), si = args.indexOf('--since');
  if (!dir || gi < 0) { console.log('Usage: npm run replay -- <unzipped export folder> --group "<exact WhatsApp group name>" [--since 2026-08-01]'); process.exit(1); }
  seedAliases();
  const stats = await replay(dir, args[gi + 1], { since: si >= 0 ? new Date(args[si + 1]).getTime() : 0 });
  console.log(JSON.stringify(stats, null, 2));
}
