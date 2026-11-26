// Cards: create, update, route to the right subject. Ported from the app's own logic.
import crypto from 'node:crypto';
import { db, getKv, setKv } from './db.js';
import { cfg } from './config.js';
import { isMainGroup, groupOverride, subjectOverride, groupSection, normSection, sectionList, MAIN, IGNORE } from './filter.js';

// What a class_change card says happened to a class.
export const CHANGES = new Set(['cancelled', 'cancelled_all', 'rescheduled', 'extra', 'restored', 'other']);
export const TYPES = new Set(['assignment', 'exam', 'class_change', 'syllabus', 'material', 'notice']);
export const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const J = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };

export function codesIn(text) {
  const out = [], re = /\b([A-Za-z]{2,5})[\s-]?(\d{3})\b/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push((m[1] + ' ' + m[2]).toUpperCase());
  return out;
}

export function rowToCard(r) {
  return {
    id: r.id, group: r.grp, subject: r.subject, type: r.type, title: r.title, due: r.due, time: r.time,
    details: r.details || '', body: r.body || '', uncertain: !!r.uncertain, note: r.note || '', pinned: !!r.pinned,
    sources: J(r.sources), files: J(r.files), history: J(r.history), moved: r.moved || null,
    flags: r.flags || 0, change: r.chg || '', section: r.section || null, hold: !!r.hold, createdAt: r.created, updatedAt: r.updated, deleted: !!r.deleted
  };
}

// A phone gets the cards for its own section plus the ones for everyone, unless it asks for all. Cards the CR is still checking are not sent.
export function listCards(since = 0, opts = {}) {
  let rows = db.prepare('select * from cards where updated > ?' + (opts.admin ? '' : ' and hold=0') + ' order by updated').all(since);
  if (opts.section && !opts.all) rows = rows.filter(r => !r.section || r.section === opts.section);
  return rows.map(rowToCard);
}
// "AD-01", "ad 01", "AD1" in a message mean the same section. A message that names exactly one section is for that section.
const secRegex = s => { const m = /^([A-Za-z]+)[\s-]*0*(\d+)$/.exec(s); return m ? new RegExp('\\b' + m[1] + '[\\s-]*0*' + m[2] + '\\b', 'i') : null; };
export function sectionsMentioned(text) { return sectionList().filter(s => { const r = secRegex(s); return r && r.test(text); }); }
export const getCard = id => { const r = db.prepare('select * from cards where id=?').get(id); return r ? rowToCard(r) : null; };

// Cards the AI should know about, so it can update them instead of duplicating.
export function existingFor(grp) {
  const cutoff = Date.now() - 90 * 864e5;
  return db.prepare('select id,type,subject,title,due,time,files from cards where grp=? and deleted=0 and updated>? order by updated desc limit 40').all(grp, cutoff).map(r => {
    let f = []; try { f = JSON.parse(r.files || '[]'); } catch (e) { /* no files */ }
    const o = { id: r.id, type: r.type, subject: r.subject, title: r.title, due: r.due, time: r.time };
    if (f[0] && f[0].name) o.file = f[0].name;
    return o;
  });
}

// ---------- subject routing ----------
export function seedAliases() {
  for (const [code, subject] of Object.entries(cfg.subjects)) {
    db.prepare('insert into aliases(code,subject) values(?,?) on conflict(code) do update set subject=excluded.subject').run(code, subject);
  }
}

// The class's own subject list (set on the CR page). When it exists, it is the only list of subjects there is.
export function subjectList() {
  const l = getKv('subjects', []);
  return Array.isArray(l) ? l.filter(s => s && s.name) : [];
}
export function saveSubjects(list) {
  const isCode = k => /^[A-Za-z]{2,5}[\s-]?\d{3}$/.test(k.trim());
  const clean = (Array.isArray(list) ? list : []).slice(0, 12).map(s => {
    const all = [].concat(String((s && s.code) || ''), Array.isArray(s && s.keys) ? s.keys : String((s && s.keys) || '').split(','))
      .flatMap(x => String(x).split(',')).map(k => k.trim().slice(0, 30)).filter(k => k.length >= 2);
    const code = all.find(isCode);
    return { name: String((s && s.name) || '').trim().slice(0, 40), code: code ? code.toUpperCase().replace(/[\s-]+/, ' ') : '', keys: all.filter(k => !isCode(k)).slice(0, 8), was: String((s && s.was) || '').trim() };
  }).filter(s => s.name);
  if (clean.length) setKv('subjects', clean.map(({ was, ...rest }) => rest));   // an empty list never replaces the saved one
  return clean;
}
// First start: six subjects, using the names the app already knows for course codes.
export function seedSubjects() {
  if (getKv('subjects', null)) return;
  const al = {}; db.prepare('select code,subject from aliases').all().forEach(a => { al[a.code] = a.subject; });
  saveSubjects([
    { name: 'Design & Analysis of Algorithm', keys: ['DAA', 'Design and Analysis'] },
    { name: 'Software Engineering', keys: ['SE', 'SoftEng'] },
    { name: 'Foundations of Data Science', keys: ['FDS'] },
    { name: 'Computer Organization & Architecture', keys: ['COA'] },
    { name: 'MAIC 205', code: 'MAIC 205', keys: al['MAIC 205'] ? [al['MAIC 205']] : [] },
    { name: 'MAIC 209', code: 'MAIC 209', keys: al['MAIC 209'] ? [al['MAIC 209']] : [] }
  ]);
}
// A subject that is named after its own course code's nickname ("Probability" for MAIC 205) is renamed to the code,
// and the nickname is kept as another name for it. Cards and group choices follow. Safe to run on every start.
export function nameByCode() {
  const list = subjectList(); if (!list.length) return 0;
  const al = {}; db.prepare('select code,subject from aliases').all().forEach(a => { al[a.code] = a.subject; });
  let n = 0; const gm = { ...(getKv('group_map', {}) || {}) };
  const out = list.map(x => {
    if (!x.code || !al[x.code] || norm(x.name) !== norm(al[x.code]) || norm(x.name) === norm(x.code)) return x;
    n++;
    db.prepare('update cards set subject=?, updated=? where subject=?').run(x.code, Date.now(), x.name);
    Object.keys(gm).forEach(g => { if (gm[g] === x.name) gm[g] = x.code; });
    return { ...x, name: x.code, keys: Array.from(new Set([x.name].concat(x.keys || []))).slice(0, 8) };
  });
  if (n) { setKv('subjects', out); setKv('group_map', gm); }
  return n;
}
// A subject name from the AI becomes one of the class's own subjects, or General.
export function canonSubject(s, reg) {
  if (!reg || !reg.fixed) return s;
  const n = norm(s);
  if (!n || n === 'general') return 'General';
  for (const x of reg.list) if (norm(x.name) === n) return x.name;
  for (const c of codesIn(s)) if (reg.codes[c]) return reg.codes[c];
  const hit = reg.names[n]; if (hit) return hit;
  return 'General';
}

// Every spelling that means one of the class's subjects, for the phones to tidy up what they already hold.
export function subjectMap() {
  const reg = registry(); if (!reg.fixed) return {};
  const m = { ...reg.names }; Object.entries(reg.codes).forEach(([c, n]) => { m[norm(c)] = n; });
  return m;
}

export function registry() {
  const list = subjectList();
  if (list.length) {
    const reg = { codes: {}, names: {}, fixed: true, list };
    const al = {}; db.prepare('select code,subject from aliases').all().forEach(a => { al[a.code] = a.subject; });
    list.forEach(s => {
      if (s.code) {
        reg.codes[s.code] = s.name; reg.names[norm(s.code)] = s.name;
        if (al[s.code] && norm(al[s.code]).length > 1) reg.names[norm(al[s.code])] = s.name;   // "MAIC 205" and "Probability" are the same subject
      }
      reg.names[norm(s.name)] = s.name;
      s.keys.forEach(k => { if (norm(k).length > 1) reg.names[norm(k)] = s.name; });
    });
    return reg;
  }
  const reg = { codes: {}, names: {} };
  db.prepare('select code,subject from aliases').all().forEach(a => { reg.codes[a.code] = a.subject; });
  const rows = db.prepare("select grp,subject from cards where deleted=0 and subject is not null and subject!='General'").all();
  rows.forEach(r => { if (codesIn(r.subject).length === 0) reg.names[norm(r.subject)] = r.subject; });
  const byGroup = {};
  rows.forEach(r => { if (codesIn(r.subject).length === 0) { (byGroup[r.grp] = byGroup[r.grp] || {})[r.subject] = ((byGroup[r.grp] || {})[r.subject] || 0) + 1; } });
  db.prepare('select distinct grp from cards').all().forEach(({ grp }) => {
    const cs = codesIn(grp);
    const best = Object.entries(byGroup[grp] || {}).sort((a, b) => b[1] - a[1])[0];
    if (cs.length && best) cs.forEach(c => { if (!reg.codes[c]) reg.codes[c] = best[0]; });
  });
  return reg;
}

function groupSubject(group, reg) {
  for (const c of codesIn(group)) if (reg.codes[c]) return reg.codes[c];
  const ng = ' ' + norm(group) + ' ';
  let best = null;
  Object.entries(reg.names).forEach(([k, v]) => { if (k.length > (reg.fixed ? 1 : 2) && ng.includes(' ' + k + ' ') && (!best || k.length > best[0].length)) best = [k, v]; });
  if (best) return best[1];
  const cs = codesIn(group);
  return cs.length ? cs[0] : null;
}

// "Computer Organization & Architecture (Sem 3) 2026-27" -> "Computer Organization & Architecture"
export function cleanGroupName(g) {
  const x = String(g || '').replace(/[(\[][^)\]]*[)\]]/g, ' ').replace(/\b20\d\d(\s*[-/]\s*\d{2,4})?\b/g, ' ').replace(/\b(sem(ester)?|section|sec|batch|group)\s*[a-z0-9]{0,2}\b/gi, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}&)]+$/gu, '').replace(/\s+/g, ' ').trim();
  return (x || String(g || '').trim()).slice(0, 40);
}

// How a group is filed: the main group is sorted by content; any other group IS one subject.
export function groupInfo(group, reg) {
  const ov = groupOverride(group), so = subjectOverride(group);
  if (ov === IGNORE) return { ignored: true, set: true };
  if (so) return { subject: so, set: true };
  if (isMainGroup(group)) return { main: true, set: !!ov, section: groupSection(group) };
  return { subject: groupSubject(group, reg || registry()) || cleanGroupName(group) };
}

export function routeSubject(card, reg) {
  const ov = subjectOverride(card.group);   // the CR's own choice for this group wins over everything
  if (ov) return ov;
  const blob = [card.title, card.details, card.body].concat((card.sources || []).map(x => x.text)).concat((card.files || []).map(f => f.name)).join(' ');
  for (const c of codesIn(blob)) if (reg.codes[c]) return reg.codes[c];
  // A subject group files everything under its own subject, whatever the AI guessed. Only a course code that clearly names another subject moves a card.
  if (!isMainGroup(card.group)) {
    const gs = groupSubject(card.group, reg);
    if (gs) return gs;
    if (!reg.fixed) return cleanGroupName(card.group);
    // A group that is none of our subjects (for example the whole-branch group) is sorted by what the message says.
  }
  const unassigned = !card.subject || card.subject === 'General' || codesIn(card.subject).length > 0;
  if (!unassigned) return null;
  const nb = ' ' + norm(blob) + ' ';
  let best = null;
  Object.entries(reg.names).forEach(([k, v]) => { if (k.length > (reg.fixed ? 1 : 2) && nb.includes(' ' + k + ' ') && (!best || k.length > best[0].length)) best = [k, v]; });
  if (best) return best[1];
  return null;   // main group: nothing in it points to a subject, so keep what the AI said (usually General)
}

export function reroute() {
  const reg = registry();
  let n = 0;
  db.prepare('select * from cards where deleted=0').all().map(rowToCard).forEach(c => {
    let s2 = c.subject;
    if (!c.pinned) { const ov = subjectOverride(c.group); s2 = routeSubject(c, reg) || c.subject; if (ov && !reg.fixed) s2 = ov; }
    s2 = canonSubject(s2, reg);   // pinned (hand-edited) cards are also kept inside the list
    if (s2 && s2 !== c.subject) { db.prepare('update cards set subject=?, updated=? where id=?').run(s2, Date.now(), c.id); n++; }
  });
  return n;
}

// ---------- writing cards ----------
const newId = () => 'c' + crypto.randomBytes(5).toString('hex');
const fmt = d => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch (e) { return d; } };

function save(c) {
  // The one place every card passes through: with a fixed subject list, nothing outside it is ever stored.
  const reg = registry();
  if (reg.fixed && !c.deleted) c.subject = canonSubject(c.subject, reg);
  db.prepare(`insert into cards(id,grp,subject,type,title,due,time,details,body,uncertain,note,pinned,sources,files,history,moved,flags,chg,section,hold,created,updated,deleted)
    values(@id,@grp,@subject,@type,@title,@due,@time,@details,@body,@uncertain,@note,@pinned,@sources,@files,@history,@moved,@flags,@chg,@section,@hold,@created,@updated,@deleted)
    on conflict(id) do update set grp=excluded.grp,subject=excluded.subject,type=excluded.type,title=excluded.title,due=excluded.due,time=excluded.time,
    details=excluded.details,body=excluded.body,uncertain=excluded.uncertain,note=excluded.note,pinned=excluded.pinned,sources=excluded.sources,files=excluded.files,
    history=excluded.history,moved=excluded.moved,flags=excluded.flags,chg=excluded.chg,section=excluded.section,hold=excluded.hold,updated=excluded.updated,deleted=excluded.deleted`).run({
    id: c.id, grp: c.group, subject: c.subject, type: c.type, title: c.title, due: c.due || null, time: c.time || null,
    details: c.details || '', body: c.body || '', uncertain: c.uncertain ? 1 : 0, note: c.note || '', pinned: c.pinned ? 1 : 0,
    sources: JSON.stringify(c.sources || []), files: JSON.stringify(c.files || []), history: JSON.stringify(c.history || []),
    moved: c.moved || null, flags: c.flags || 0, chg: c.change || '', section: c.section || null, hold: c.hold ? 1 : 0, created: c.createdAt || Date.now(), updated: Date.now(), deleted: c.deleted ? 1 : 0
  });
}

function addFiles(c, fl) {
  fl.forEach(f => { if (f && f.id && !c.files.some(x => x.id === f.id)) c.files.push({ id: f.id, name: f.name }); });
}

// items: what the AI returned. idMap: "m1" -> message row. Returns what changed, for notifications.
export function applyItems(grp, items, idMap, opts = {}) {
  const out = { added: [], updated: [], held: [] };
  if (!Array.isArray(items)) items = items && Array.isArray(items.cards) ? items.cards : [];
  const reg = registry();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const srcMsgs = (Array.isArray(it.src) ? it.src : []).map(id => idMap[id]).filter(Boolean);
    const src = srcMsgs.map(m => ({ ms: m.ms, sender: m.sender, text: (m.file_name ? 'File: ' + m.file_name + (m.text ? ' (' + m.text.slice(0, 200) + ')' : '') : String(m.text || '').slice(0, 500)) }));
    const fl = srcMsgs.filter(m => m.file_id).map(m => ({ id: m.file_id, name: m.file_name }));
    const clean = {
      type: TYPES.has(it.type) ? it.type : undefined,
      subject: typeof it.subject === 'string' && it.subject.trim() ? it.subject.trim().slice(0, 40) : undefined,
      title: typeof it.title === 'string' && it.title.trim() ? it.title.trim().slice(0, 80) : undefined,
      due: isDate(it.due) ? it.due : (it.due === null ? null : undefined),
      time: isTime(it.time) ? it.time : (it.time === null ? null : undefined),
      details: typeof it.details === 'string' ? it.details.trim().slice(0, 200) : undefined,
      change: CHANGES.has(it.change) ? it.change : undefined,
      section: normSection(it.section) || undefined
    };
    if (it.op === 'update') {
      const c = getCard(it.card);
      if (c && c.group === grp && !c.deleted) {
        const bits = [];
        if (clean.due !== undefined && clean.due !== c.due) { if (c.due && clean.due) c.moved = c.due; bits.push('date: ' + (c.due ? fmt(c.due) : 'none') + ' to ' + (clean.due ? fmt(clean.due) : 'none')); c.due = clean.due; }
        if (clean.time !== undefined && clean.time !== c.time) { bits.push('time: ' + (c.time || 'none') + ' to ' + (clean.time || 'none')); c.time = clean.time; }
        if (clean.title && clean.title !== c.title) { bits.push('title changed'); c.title = clean.title; }
        if (clean.details) c.details = clean.details;
        if (clean.change && clean.change !== c.change) { bits.push('class: ' + (c.change || 'update') + ' to ' + clean.change); c.change = clean.change; }
        if (src.length) c.sources = c.sources.concat(src).slice(-6);
        addFiles(c, fl);
        c.history = c.history.concat([{ at: Date.now(), what: (bits.join(', ') || 'updated') + (typeof it.why === 'string' && it.why ? ' (' + it.why.slice(0, 80) + ')' : '') }]).slice(-10);
        save(c);
        out.updated.push({ card: c, what: bits.join(', ') || 'updated' });
        continue;
      }
    }
    if (!clean.title) continue;
    const dup = db.prepare('select * from cards where grp=? and deleted=0 and lower(title)=lower(?) and coalesce(due,\'\')=?').get(grp, clean.title, clean.due || '');
    if (dup) { const c = rowToCard(dup); c.sources = c.sources.concat(src).slice(-6); addFiles(c, fl); save(c); continue; }
    const card = {
      id: newId(), group: grp, type: clean.type || 'notice', subject: clean.subject || 'General', title: clean.title,
      due: clean.due || null, time: clean.time || null, details: clean.details || '', body: typeof it.body === 'string' ? it.body.slice(0, 1500) : '',
      change: (clean.type || 'notice') === 'class_change' ? (clean.change || '') : '',
      uncertain: !!it.unsure, note: typeof it.note === 'string' ? it.note.slice(0, 120) : '', pinned: false,
      sources: src, files: [], history: [], flags: 0, createdAt: Date.now()
    };
    addFiles(card, fl);
    const s2 = routeSubject(card, reg);
    if (s2) card.subject = s2;
    card.subject = canonSubject(card.subject, reg);
    // Which section it is for: a message naming both is for everyone; a section's own group is for that section; otherwise one named section, or the AI's pick.
    const named = sectionsMentioned([card.title, card.details, card.body].concat(src.map(x => x.text)).join(' '));
    card.section = named.length >= 2 ? null : (groupSection(grp) || (named.length === 1 ? named[0] : null) || clean.section || null);
    // A deadline, exam or class change the AI was not sure about waits for the CR to check it. Old chats are never held.
    card.hold = !!(it.unsure && !opts.quiet && !opts.noHold && cfg.holdHours > 0 && ['assignment', 'exam', 'class_change'].includes(card.type));
    save(card);
    (card.hold ? out.held : out.added).push(card);
  }
  return out;
}

// ---------- the CR's controls ----------
export function patchCard(id, patch) {
  const c = getCard(id);
  if (!c) return null;
  const fixes = getKv('fixes', []);
  ['title', 'subject', 'type', 'due', 'time', 'details'].forEach(k => {
    if (!(k in patch)) return;
    let v = patch[k];
    if (k === 'type' && !TYPES.has(v)) return;
    if (k === 'due' && v !== null && !isDate(v)) return;
    if (k === 'time' && v !== null && !isTime(v)) return;
    if (c[k] !== v) { fixes.push({ field: k, was: c[k], now: v, card: c.title }); c[k] = v; if (k === 'subject') c.pinned = true; }
  });
  if ('section' in patch) { const sec = patch.section ? normSection(patch.section) : null; if (!patch.section || sec) c.section = sec; }
  c.uncertain = false; c.flags = 0;
  save(c);
  setKv('fixes', fixes.slice(-15));
  return c;
}
export function removeCard(id) {
  const c = getCard(id);
  if (!c) return false;
  const fixes = getKv('fixes', []);
  fixes.push({ field: 'removed', was: c.title, now: null, card: c.title });
  setKv('fixes', fixes.slice(-15));
  c.deleted = true; save(c);
  return true;
}
export function flagCard(id) {
  const c = getCard(id);
  if (!c) return false;
  c.flags = (c.flags || 0) + 1; save(c);
  return true;
}

export function addFileCard({ grp, sender, ms, file, subjectHint }) {
  const raw = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || file.name;
  const card = {
    id: newId(), group: grp, type: /syllabus/i.test(raw) ? 'syllabus' : 'material', subject: subjectHint || 'General',
    title: raw.slice(0, 80), due: null, time: null, details: '', body: '', uncertain: false, note: '', pinned: false,
    sources: [{ ms, sender, text: 'File: ' + file.name }], files: [{ id: file.id, name: file.name }], history: [], flags: 0, createdAt: Date.now()
  };
  const s2 = routeSubject(card, registry());
  if (s2) card.subject = s2;
  save(card);
  return card;
}
export const fileOnAnyCard = (grp, fileId) =>
  db.prepare('select 1 from cards where grp=? and deleted=0 and files like ?').get(grp, '%"' + fileId + '"%');

// The CR checked a held card (possibly corrected it): it goes live for everyone.
export function releaseCard(id, patch = {}) {
  const c = patchCard(id, patch);
  if (!c) return null;
  c.hold = false; save(c);
  return c;
}
// Cards nobody checked for a while go live anyway, still marked as unconfirmed, so a real deadline is never lost.
export function releaseOldHeld(now = Date.now()) {
  if (!cfg.holdHours) return db.prepare('select id from cards where hold=1').all().map(r => releaseCard(r.id)).filter(Boolean);
  const rows = db.prepare('select id from cards where hold=1 and created<?').all(now - cfg.holdHours * 36e5);
  return rows.map(r => { const c = getCard(r.id); c.hold = false; save(c); return c; });
}
