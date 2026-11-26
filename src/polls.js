// Polls in the class groups. The question and the votes are kept, and 1-2 hours later, if one option clearly won,
// one AI call turns it into a card that is live right away but sits in the CR's check list so it can be removed.
import { db } from './db.js';
import { cfg } from './config.js';
import { askJson, CapError } from './ai.js';
import { applyItems } from './cards.js';
import { hasSignal } from './signals.js';
import { sentOn } from './prompts.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let onChange = () => {};
export const setPollOnChange = f => { onChange = f; };

export function savePoll({ id, grp, ms, sender, question, options, raw }) {
  if (!id || !question || !Array.isArray(options) || options.length < 2) return false;
  db.prepare('insert or ignore into polls(id,grp,ms,sender,question,options,raw) values(?,?,?,?,?,?,?)')
    .run(String(id), grp, ms, sender, String(question).slice(0, 300), JSON.stringify(options.map(o => String(o).slice(0, 80)).slice(0, 12)), raw || null);
  return true;
}
export const pollRaw = id => { const r = db.prepare('select raw from polls where id=?').get(String(id)); return r ? r.raw : null; };

// A person's latest vote replaces their earlier one. An empty choice means they took the vote back.
export function recordVote(pollId, voter, chosen) {
  if (!db.prepare('select 1 from polls where id=?').get(String(pollId)) || !voter) return false;
  db.prepare('insert into poll_votes(poll,voter,opts,ms) values(?,?,?,?) on conflict(poll,voter) do update set opts=excluded.opts, ms=excluded.ms')
    .run(String(pollId), String(voter), JSON.stringify(chosen || []), Date.now());
  return true;
}

export function tally(pollId) {
  const p = db.prepare('select options from polls where id=?').get(String(pollId));
  const options = p ? JSON.parse(p.options) : [];
  const counts = Object.fromEntries(options.map(o => [o, 0]));
  let voters = 0;
  for (const v of db.prepare('select opts from poll_votes where poll=?').all(String(pollId))) {
    const ch = JSON.parse(v.opts).filter(o => o in counts);
    if (ch.length) voters++;
    ch.forEach(o => { counts[o]++; });
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = top.reduce((n, x) => n + x[1], 0);
  const win = top[0] && total && top[0][1] / total >= cfg.pollMajority && (!top[1] || top[0][1] > top[1][1]) ? top[0][0] : null;
  return { counts, voters, winner: win };
}

const summary = (counts) => Object.entries(counts).map(([o, n]) => o + ' ' + n).join(', ');

// Run every few minutes. status: 0 collecting, 1 turned into a card, 2 not worth reading, 3 no clear winner or too few votes
export async function pollTick(now = Date.now()) {
  const due = db.prepare('select * from polls where status=0 and ms<?').all(now - cfg.pollWaitMin * 60000);
  for (const p of due) {
    const options = JSON.parse(p.options), t = tally(p.id);
    const set = st => db.prepare('update polls set status=? where id=?').run(st, p.id);
    if (t.voters < cfg.pollMinVotes || !t.winner) { set(3); continue; }
    if (!hasSignal(p.question + ' ' + options.join(' '))) { set(2); continue; }   // "Best movie?" never costs an AI call
    const info = 'Poll: ' + p.question + ' (' + summary(t.counts) + ')';
    const prompt = 'A poll was posted in a college class WhatsApp group "' + p.grp + '" by ' + p.sender + ' on ' + sentOn(p.ms) + '. After ' + cfg.pollWaitMin + ' minutes the votes are: ' + summary(t.counts) + ' (' + t.voters + ' people). The winning option is "' + t.winner + '".\n' +
      'Question: ' + JSON.stringify(p.question) + '\nOptions: ' + JSON.stringify(options) + '\n\n' +
      'If the winning option means a class, exam, quiz, assignment or deadline will happen (an extra class, a date chosen, a time chosen), make one card for it. Work dates out from the day the poll was posted. If it only means something is NOT happening, or it is not about studies, make no card.\n' +
      'Reply with ONLY JSON: {"card":false} or {"card":true,"type":"assignment|exam|class_change|notice","subject":"...","title":"short, starting with Poll:","due":"YYYY-MM-DD or null","time":"HH:MM or null","change":"extra|cancelled|rescheduled|other (class_change only)","details":"under 200 characters"}';
    try {
      let r = await askJson(prompt, { tier: 'lite', tries: 1 });
      if (Array.isArray(r)) r = r[0];
      if (!r || r.card !== true) { set(2); continue; }
      const out = applyItems(p.grp, [{ op: 'new', type: r.type, subject: r.subject, title: r.title, due: r.due, time: r.time, change: r.change, details: r.details,
        unsure: true, note: info.slice(0, 120), src: ['m1'] }], { m1: { ms: p.ms, sender: p.sender, text: info } }, { noHold: true });
      set(1);
      if (out.added.length) { log(p.grp + ': poll became a card -> ' + out.added[0].title); onChange(out); }
    } catch (e) {
      if (e instanceof CapError) return;                                   // out of AI calls: try again next time
      const n = db.prepare('update polls set tries=tries+1 where id=?').run(p.id) && db.prepare('select tries from polls where id=?').get(p.id).tries;
      if (n >= 4) set(3); else log('poll read failed:', e.message);
    }
  }
}
