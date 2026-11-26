// The web server: serves the app, the shared feed, and the saved files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db, getKv, setKv } from './db.js';
import { listCards, releaseCard, flagCard, patchCard, removeCard, reroute, getCard, subjectList, subjectMap, saveSubjects } from './cards.js';
import { filePath, historyPending, historyUsedToday, historyProblem, kick, ingest } from './reader.js';
import { addSignalWord, customWords } from './signals.js';
import { coolingUntil } from './ai.js';
import { groupInfo, registry, canonSubject, norm } from './cards.js';
import { groupAllowed, groupOverride, subjectOverride, sectionList, normSection, sectionOverrideValue, MAIN, IGNORE } from './filter.js';
import { waProblem } from './health.js';
import { startImport, historyJob, jobRunning } from './history.js';
import { pipeline } from 'node:stream/promises';
import { timetablePrompt, normalizeSlots } from './timetable.js';
import { firstPages } from './pdfs.js';
import { usageToday, askText, askJson, aiReady, CapError } from './ai.js';
import { publicKey, subscribe, markAdmin, notifyChanges } from './push.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.ico': 'image/x-icon' };
const hits = new Map();

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };

function body(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const classOk = (req, url) => !cfg.classCode || same(req.headers['x-class-code'] || url.searchParams.get('code'), cfg.classCode);
const adminOk = req => !!cfg.adminCode && same(req.headers['x-admin-code'], cfg.adminCode);
// Guessing the class code or the CR code: thirty wrong tries from one address (a whole hostel can share one) and it is locked out for ten minutes.
const fails = new Map();
const locked = ip => { const f = fails.get(ip); return !!f && f.n >= 30 && Date.now() - f.at < 10 * 60e3; };
const failed = ip => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.at < 10 * 60e3 ? { n: f.n + 1, at: Date.now() } : { n: 1, at: Date.now() }); if (fails.size > 5000) fails.clear(); };
// The AI features cost the class real quota, so one person can't use it all up.
const aiUse = new Map();
const aiTooMany = ip => { const now = Date.now(), r = (aiUse.get(ip) || []).filter(t => now - t < 3600e3); r.push(now); aiUse.set(ip, r); if (aiUse.size > 5000) aiUse.clear(); return r.length > 40; };
const tooMany = ip => {
  const now = Date.now(), r = (hits.get(ip) || []).filter(t => now - t < 60000);
  r.push(now); hits.set(ip, r); if (hits.size > 5000) hits.clear();
  return r.length > 120;
};

export function startServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type,x-class-code,x-admin-code');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (tooMany(ip)) return send(res, 429, { error: 'slow down' });
        if (p === '/api/health') { try { db.prepare('select 1').get(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 500, { ok: false }); } }
        if (locked(ip)) return send(res, 429, { error: 'Too many wrong codes. Try again in a few minutes.' });
        if (!classOk(req, url)) { failed(ip); return send(res, 401, { error: 'wrong class code' }); }

        if (p === '/api/feed' && req.method === 'GET') {
          const since = +url.searchParams.get('since') || 0;
          // Which person's phone is asking, so the CR can see how many actually use the app. Counted at most once a minute per person.
          const who = String(url.searchParams.get('me') || '').replace(/[^\w-]/g, '').slice(0, 40);
          if (who) db.prepare('update people set seen=? where id=? and seen<?').run(Date.now(), who, Date.now() - 60000);
          return send(res, 200, { now: Date.now(), cards: listCards(since), subjects: db.prepare("select distinct subject from cards where deleted=0").all().map(r => r.subject), subjectList: subjectList().map(s => s.name), subjectMap: subjectMap(), timetable: getKv('timetable', null), sections: sectionList(), section: who ? ((db.prepare('select section from people where id=?').get(who) || {}).section || null) : null });
        }
        if (p.startsWith('/api/files/') && req.method === 'GET') {
          const id = p.slice(11).replace(/[^a-f0-9]/g, '');
          const f = db.prepare('select * from files where id=?').get(id);
          if (!f || !fs.existsSync(filePath(id))) return send(res, 404, { error: 'no such file' });
          // Only pictures and PDFs open in the browser. Anything else, whatever it says it is, can only be downloaded, so a file sent in a group can never run as a web page.
          const safe = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i.test(f.mime || '');
          res.writeHead(200, { 'content-type': safe ? f.mime : 'application/octet-stream', 'content-length': f.size, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'content-disposition': (safe ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(f.name) });
          return fs.createReadStream(filePath(id)).pipe(res);
        }
        // The app's own AI features (Ask, read this file, study checklist) go through here.
        if (p === '/api/ai' && req.method === 'POST') {
          if (aiTooMany(ip)) { req.resume(); return send(res, 429, { error: 'That is a lot of questions for one hour. Try again a little later.' }); }
          const b = await body(req, 14e6);
          if (typeof b.prompt !== 'string' || !b.prompt || b.prompt.length > 200000) return send(res, 400, { error: 'bad prompt' });
          const imgs = Array.isArray(b.images) ? b.images.slice(0, 4) : [];
          const files = [];
          for (const im of imgs) {
            if (!im || !/^image\/(jpeg|png|webp|gif)$/.test(im.media_type) || typeof im.data !== 'string' || im.data.length > 6e6) return send(res, 400, { error: 'bad image' });
            files.push({ mime: im.media_type, data: Buffer.from(im.data, 'base64') });
          }
          try { return send(res, 200, { text: await askText(b.prompt, { files, tier: b.tier === 'quick' ? 'lite' : 'main' }) }); }
          catch (e) { return send(res, e instanceof CapError ? 429 : 502, { error: String(e.message).slice(0, 120) }); }
        }
        // Who is using the app: a name and an optional small photo, shown to classmates on the Class tab.
        if (p === '/api/me' && req.method === 'POST') {
          const b = await body(req, 3e5);
          const id = String(b.id || '').replace(/[^\w-]/g, '').slice(0, 40);
          const name = String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
          if (id.length < 8) return send(res, 400, { error: 'bad id' });
          if (!name) return send(res, 400, { error: 'Type your name' });
          const row = db.prepare('select photo from people where id=?').get(id);
          let photo = row ? row.photo : null;
          if (b.photo === null) photo = null;
          else if (typeof b.photo === 'string') {
            if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+\/=]+$/.test(b.photo) || b.photo.length > 60000) return send(res, 400, { error: 'That photo is too big' });
            photo = b.photo;
          }
          const sec = b.section ? normSection(b.section) : null;
          db.prepare('insert into people(id,name,photo,created,seen,section) values(?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, photo=excluded.photo, seen=excluded.seen, section=coalesce(excluded.section, people.section)').run(id, name, photo, Date.now(), Date.now(), sec);
          return send(res, 200, { ok: true });
        }
        // Which section a person is in. Also works for people who joined before sections existed.
        if (p === '/api/section' && req.method === 'POST') {
          const b = await body(req, 2e4);
          const id = String(b.id || '').replace(/[^\w-]/g, '').slice(0, 40);
          const sec = normSection(b.section);
          if (!sec) return send(res, 400, { error: 'Pick your section' });
          return send(res, 200, { ok: db.prepare('update people set section=? where id=?').run(sec, id).changes > 0 });
        }
        if (p === '/api/people' && req.method === 'GET') {
          const me = String(url.searchParams.get('me') || '');
          const rows = db.prepare('select id,name,photo,section from people order by created asc limit 300').all();
          return send(res, 200, { count: rows.length, people: rows.map(r => ({ name: r.name, photo: r.photo, section: r.section || null, me: !!me && r.id === me })) });
        }
        if (p === '/api/flag' && req.method === 'POST') { const b = await body(req); return send(res, 200, { ok: flagCard(String(b.id)) }); }
        if (p === '/api/push/key') return send(res, 200, { key: publicKey() });
        if (p === '/api/push/subscribe' && req.method === 'POST') { const b = await body(req); return send(res, 200, { ok: subscribe(b.subscription, b.me) }); }

        // ---- the CR's controls ----
        if (p.startsWith('/api/admin/')) {
          if (!adminOk(req)) { failed(ip); return send(res, 401, { error: 'wrong admin code' }); }
          if (p === '/api/admin/status') {
            return send(res, 200, {
              whatsapp: getKv('wa', { state: 'not started' }), aiCallsToday: usageToday(), aiCap: cfg.dailyCallCap, provider: cfg.provider,
              waiting: db.prepare('select count(*) n from messages where processed=0 and old=0').get().n,
              readingGroups: ((getKv('wa', {}) || {}).groups || []).filter(groupAllowed),
              groupKinds: ((getKv('wa', {}) || {}).groups || []).map(n => { const i = groupInfo(n, registry()); return { name: n, reading: groupAllowed(n), kind: i.ignored || !groupAllowed(n) ? 'ignore' : i.section ? 'section' : i.main ? 'main' : 'subject', subject: i.subject || null, section: i.section || null, set: !!groupOverride(n), cards: db.prepare('select count(*) n from cards where grp=? and deleted=0').get(n).n }; }),
              sections: sectionList(), subjects: subjectList().map(x => x.name),
              aiPausedUntil: coolingUntil() || null,
              waProblem: waProblem(getKv('wa', {})),
              lastBackup: getKv('backup_day', null), people: (() => { const t = Date.now(), n = ms => db.prepare('select count(*) n from people where seen>?').get(t - ms).n; return { total: db.prepare('select count(*) n from people').get().n, today: n(864e5), week: n(7 * 864e5) }; })(), crPhones: db.prepare('select count(*) n from subs where admin=1').get().n,
              history: { job: historyJob(), problem: historyProblem(), pending: historyPending(), usedToday: historyUsedToday(), dailyLimit: cfg.historyDailyCalls },
              gaveUp: db.prepare('select count(*) n from messages where processed=3').get().n,
              cards: db.prepare('select count(*) n from cards where deleted=0').get().n,
              flagged: db.prepare('select id,title,subject,flags from cards where deleted=0 and hold=0 and (flags>0 or uncertain=1)').all(),
              held: db.prepare('select * from cards where deleted=0 and hold=1 order by created').all().map(r => { const c = getCard(r.id); return { id: c.id, group: c.group, type: c.type, subject: c.subject, title: c.title, due: c.due, time: c.time, details: c.details, note: c.note, section: c.section, createdAt: c.createdAt, said: (c.sources || []).slice(0, 3).map(x => ({ sender: x.sender, text: x.text })) }; }), holdHours: cfg.holdHours,
              review: db.prepare('select id from cards where deleted=0 and (hold=1 or flags>0 or uncertain=1) order by hold desc, flags desc, created').all().map(r => { const c = getCard(r.id); return { id: c.id, group: c.group, type: c.type, subject: c.subject, title: c.title, due: c.due, time: c.time, details: c.details, note: c.note, section: c.section, hold: !!c.hold, flags: c.flags || 0, why: /^Poll:/.test(c.note || '') ? 'From a poll. It is already in the feed, but the teacher has not confirmed it. Remove it if it is wrong' : c.hold ? 'Waiting: the AI was not sure, so classmates cannot see it yet' : c.flags ? c.flags + ' classmate' + (c.flags > 1 ? 's' : '') + ' said this looks wrong' : 'The AI was not sure about this one', said: (c.sources || []).slice(0, 3).map(x => ({ sender: x.sender, text: x.text })) }; })
            });
          }
          if (p === '/api/admin/skipped') {
            return send(res, 200, { skipped: db.prepare("select grp,ms,sender,kind,file_name,why from messages where processed in (2,3) and kind in ('image','pdf') order by ms desc limit 100").all() });
          }
          // The CR checks a card the AI was not sure about: publish it (with corrections) or throw it away.
          if (p === '/api/admin/release' && req.method === 'POST') {
            const b = await body(req);
            const id = String(b.id || '');
            const c0 = getCard(id);
            if (!c0 || !c0.hold) return send(res, 404, { error: 'That one was already handled' });
            if (b.discard) return send(res, 200, { ok: removeCard(id) });
            const c = releaseCard(id, b.patch || {});
            notifyChanges({ added: [c] }).catch(() => {});
            return send(res, 200, { ok: true, card: c });
          }
          // The CR types what is wrong ("this is only for AD-02, due Friday 5 pm"). The AI redoes the card with that and the original messages, and it goes live.
          if (p === '/api/admin/revise' && req.method === 'POST') {
            const b = await body(req, 2e4);
            const c0 = getCard(String(b.id || '')), note = String(b.note || '').trim().slice(0, 500);
            if (!c0 || c0.deleted) return send(res, 404, { error: 'That card was already handled' });
            if (!note) return send(res, 400, { error: 'Type what is wrong first' });
            if (aiTooMany(ip)) return send(res, 429, { error: 'Too many AI calls this hour' });
            const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const dated = (c0.sources || []).slice(0, 4).map(x => ({ sent: x.ms ? WD[new Date(x.ms).getDay()] + ' ' + new Date(x.ms).toLocaleDateString('en-CA') : null, sender: x.sender, text: x.text }));
            const prompt = 'A class CR is correcting a card that was read from a WhatsApp group by mistake. Redo the card using the CR\'s note. The CR is right.\n' +
              'Today is ' + WD[new Date().getDay()] + ' ' + new Date().toLocaleDateString('en-CA') + '. Work out days like "Friday" from today unless the note says otherwise.\n' +
              'Subjects: ' + JSON.stringify(subjectList().map(x => x.name).concat(['General'])) + '. Sections: ' + JSON.stringify(sectionList()) + '.\n' +
              'Card now: ' + JSON.stringify({ type: c0.type, subject: c0.subject, title: c0.title, due: c0.due, time: c0.time, details: c0.details, section: c0.section }) + '\n' +
              'Original messages: ' + JSON.stringify(dated) + '\nCR\'s note: ' + JSON.stringify(note) + '\n\n' +
              'Reply with ONLY JSON: {"discard":true or false,"type":"assignment|exam|class_change|syllabus|material|notice","subject":"one of the subjects","title":"under 80 characters","due":"YYYY-MM-DD or null","time":"HH:MM or null","details":"under 200 characters","section":"AD-01, AD-02 or null for everyone"}. Set discard true only if the note says this should not be a card at all.';
            let r;
            try { r = await askJson(prompt, { tier: 'main', tries: 1 }); }
            catch (e) { return send(res, e instanceof CapError ? 429 : 502, { error: e instanceof CapError ? 'The AI is over its limit right now. Edit the fields yourself, or try again later.' : 'The AI could not answer. Try again, or edit the fields yourself.' }); }
            if (Array.isArray(r)) r = r[0];
            if (!r || typeof r !== 'object') return send(res, 502, { error: 'The AI gave an unreadable answer. Try again.' });
            if (r.discard === true) return send(res, 200, { ok: removeCard(c0.id), discarded: true });
            const patch = {};
            ['type', 'title', 'due', 'time', 'details'].forEach(k => { if (k in r) patch[k] = r[k]; });
            if (typeof r.subject === 'string') { const reg = registry(); patch.subject = reg.fixed ? canonSubject(r.subject, reg) : r.subject; }
            if ('section' in r) patch.section = r.section || null;
            const c = c0.hold ? releaseCard(c0.id, patch) : patchCard(c0.id, patch);
            notifyChanges(c0.hold ? { added: [c] } : { added: [], updated: [{ card: c, what: 'corrected by the CR' }] }).catch(() => {});
            return send(res, 200, { ok: true, card: { title: c.title, subject: c.subject, type: c.type, due: c.due, time: c.time, section: c.section } });
          }
          if (p === '/api/admin/card' && req.method === 'POST') {
            const b = await body(req);
            if (b.delete) return send(res, 200, { ok: removeCard(String(b.id)) });
            const c = patchCard(String(b.id), b.patch || {});
            return send(res, c ? 200 : 404, { card: c });
          }
          // Messages the cheap filter skipped without reading. The CR can send one to the AI and teach the filter a word.
          if (p === '/api/admin/maybe' && req.method === 'GET') {
            const week = Date.now() - 7 * 864e5;
            return send(res, 200, {
              maybe: db.prepare("select id,grp,ms,sender,substr(text,1,300) text from messages where processed=4 and kind='text' and length(text)>=30 and ms>? order by ms desc limit 40").all(week),
              skippedWeek: db.prepare('select count(*) n from messages where processed=4 and ms>?').get(week).n,
              words: customWords()
            });
          }
          if (p === '/api/admin/maybe' && req.method === 'POST') {
            const b = await body(req);
            const row = db.prepare('select id,grp,old from messages where id=? and processed=4').get(+b.id);
            if (!row) return send(res, 404, { error: 'That message was already handled' });
            if (b.action === 'read') {
              if (b.word) addSignalWord(b.word);
              db.prepare('update messages set processed=0, force=1, why=null where id=?').run(row.id);
              if (!row.old) kick(row.grp, 1000);
              return send(res, 200, { ok: true });
            }
            db.prepare("update messages set processed=5, why='CR: fine to skip' where id=?").run(row.id);
            return send(res, 200, { ok: true });
          }
          // Upload of a WhatsApp export zip, sent as the raw request body.
          if (p === '/api/admin/history' && req.method === 'POST') {
            const group = String(url.searchParams.get('group') || ''), sinceStr = String(url.searchParams.get('since') || '');
            const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceStr) ? new Date(sinceStr + 'T00:00:00').getTime() : NaN;
            if (!group || !groupAllowed(group)) { req.resume(); return send(res, 400, { error: 'Pick one of the groups this app is reading' }); }
            if (isNaN(since)) { req.resume(); return send(res, 400, { error: 'Pick the date your semester started' }); }
            if (jobRunning()) { req.resume(); return send(res, 409, { error: 'An import is already running. Wait for it to finish.' }); }
            const len = +req.headers['content-length'] || 0;
            if (!len) { req.resume(); return send(res, 411, { error: 'Empty upload' }); }
            if (len > cfg.historyMaxBytes) { req.resume(); return send(res, 413, { error: 'That zip is bigger than ' + Math.round(cfg.historyMaxBytes / 1048576) + ' MB. Export without media, or export again.' }); }
            const tmpDir = path.join(cfg.dataDir, 'tmp'); fs.mkdirSync(tmpDir, { recursive: true });
            const tmp = path.join(tmpDir, 'upload-' + Date.now() + '.zip');
            let got = 0;
            try {
              req.on('data', c => { got += c.length; if (got > cfg.historyMaxBytes) req.destroy(new Error('too big')); });
              await pipeline(req, fs.createWriteStream(tmp));
            } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* nothing saved */ } return send(res, 400, { error: 'Upload was cut off. Try again.' }); }
            startImport(tmp, group, since);
            return send(res, 200, { ok: true });
          }
          // Big chat zips go up in small pieces, so a refresh or a dropped connection only costs the piece in flight.
          // GET says how many bytes of this upload the server already has; POST adds the next piece at that exact offset.
          if (p === '/api/admin/upload') {
            const id = String(url.searchParams.get('id') || '');
            if (!/^[a-f0-9]{16,32}$/.test(id)) { req.resume(); return send(res, 400, { error: 'bad upload id' }); }
            const tmpDir = path.join(cfg.dataDir, 'tmp'); fs.mkdirSync(tmpDir, { recursive: true });
            for (const f of fs.readdirSync(tmpDir)) { try { if (/^up-/.test(f) && Date.now() - fs.statSync(path.join(tmpDir, f)).mtimeMs > 48 * 3600e3) fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { /* skip */ } }
            const part = path.join(tmpDir, 'up-' + id + '.part');
            const have = () => { try { return fs.statSync(part).size; } catch (e) { return 0; } };
            if (req.method === 'GET') return send(res, 200, { size: have() });
            if (req.method === 'POST') {
              const offset = +url.searchParams.get('offset'), len = +req.headers['content-length'] || 0, cur = have();
              if (!(offset >= 0)) { req.resume(); return send(res, 400, { error: 'bad offset' }); }
              if (offset !== cur) { req.resume(); return send(res, 409, { size: cur }); }
              if (!len || len > 8e6) { req.resume(); return send(res, 413, { error: 'piece too big' }); }
              if (cur + len > cfg.historyMaxBytes) { req.resume(); return send(res, 413, { error: 'That file is bigger than ' + Math.round(cfg.historyMaxBytes / 1048576) + ' MB. Export without media, or export again.' }); }
              try { await pipeline(req, fs.createWriteStream(part, { flags: 'a' })); } catch (e) { try { fs.truncateSync(part, cur); } catch (x) { /* nothing to undo */ } return send(res, 400, { error: 'cut off', size: cur }); }
              if (have() !== cur + len) { try { fs.truncateSync(part, cur); } catch (x) { /* nothing to undo */ } return send(res, 400, { error: 'cut off', size: cur }); }
              return send(res, 200, { size: cur + len });
            }
          }
          if (p === '/api/admin/upload/finish' && req.method === 'POST') {
            const id = String(url.searchParams.get('id') || ''), total = +url.searchParams.get('total');
            const group = String(url.searchParams.get('group') || ''), sinceStr = String(url.searchParams.get('since') || '');
            const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceStr) ? new Date(sinceStr + 'T00:00:00').getTime() : NaN;
            if (!/^[a-f0-9]{16,32}$/.test(id)) return send(res, 400, { error: 'bad upload id' });
            if (!group || !groupAllowed(group)) return send(res, 400, { error: 'Pick one of the groups this app is reading' });
            if (isNaN(since)) return send(res, 400, { error: 'Pick the date your semester started' });
            if (jobRunning()) return send(res, 409, { error: 'An import is already running. Wait for it to finish.' });
            const part = path.join(cfg.dataDir, 'tmp', 'up-' + id + '.part');
            let size = 0; try { size = fs.statSync(part).size; } catch (e) { return send(res, 404, { error: 'That upload is gone. Choose the file again.' }); }
            if (size !== total) return send(res, 409, { error: 'The upload is incomplete', size });
            const zip = path.join(cfg.dataDir, 'tmp', 'upload-' + Date.now() + '.zip');
            fs.renameSync(part, zip);
            startImport(zip, group, since);
            return send(res, 200, { ok: true });
          }
          // The CR uploads a date sheet (PDF or photo). It is read like one sent in a group, and only this class's papers become exam cards.
          if (p === '/api/admin/datesheet' && req.method === 'POST') {
            const len = +req.headers['content-length'] || 0;
            if (!len || len > 12e6) { req.resume(); return send(res, 400, { error: 'Choose a PDF or photo under 12 MB' }); }
            const parts = []; for await (const c of req) parts.push(c);
            const buf = Buffer.concat(parts);
            const kind = ['mid', 'end', 'practical'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : '';
            const name = String(url.searchParams.get('name') || 'datesheet').replace(/[^\w .()-]/g, '').slice(0, 80) || 'datesheet';
            const mime = String(req.headers['content-type'] || '');
            if (!/^image\/(jpeg|png)|application\/pdf/.test(mime) && !/\.(pdf|jpe?g|png)$/i.test(name)) return send(res, 400, { error: 'Only a PDF, JPG or PNG' });
            const r = ingest({ grp: 'Date sheet (CR upload)', ms: Date.now(), sender: 'CR', number: 'cr-upload', text: (kind ? kind + ' sem ' : '') + 'date sheet', buf, fileName: name, mime });
            if (r.status !== 'queued') return send(res, 409, { error: r.why === 'same file sent again' ? 'You already uploaded this exact file.' : 'Could not use that file: ' + r.why });
            db.prepare("update messages set force=2 where grp='Date sheet (CR upload)' and processed=0").run();
            kick('Date sheet (CR upload)', 500);
            return send(res, 200, { ok: true });
          }
          // The class timetable: the CR sets it once and everyone's Today uses it.
          if (p === '/api/admin/timetable' && req.method === 'POST') {
            const b = await body(req, 3e5);
            const slots = normalizeSlots(b.slots, registry());
            if (Array.isArray(b.slots) && b.slots.length && !slots.length) return send(res, 400, { error: 'None of those classes had a day, a start and end time, and a subject.' });
            setKv('timetable', slots.length ? { slots, at: Date.now() } : null);
            return send(res, 200, { ok: true, count: slots.length, slots });
          }
          if (p === '/api/admin/timetable' && req.method === 'GET') return send(res, 200, { slots: (getKv('timetable', null) || {}).slots || [] });
          // Reads an uploaded timetable (photo or PDF) into a list the CR checks before saving. Nothing is saved here.
          if (p === '/api/admin/timetable/read' && req.method === 'POST') {
            const len = +req.headers['content-length'] || 0;
            if (!len || len > 12e6) { req.resume(); return send(res, 400, { error: 'Choose a PDF or photo under 12 MB' }); }
            const parts = []; for await (const c of req) parts.push(c);
            let buf = Buffer.concat(parts);
            const name = String(url.searchParams.get('name') || '');
            const mime = /pdf/i.test(req.headers['content-type'] || '') || /\.pdf$/i.test(name) ? 'application/pdf' : /png/i.test(req.headers['content-type'] || '') || /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
            if (!aiReady()) return send(res, 503, { error: 'No AI key is set on the server yet.' });
            try {
              if (mime === 'application/pdf') { const cut = await firstPages(buf, 6); if (cut.buf) buf = cut.buf; }
              const out = await askJson(timetablePrompt(registry()), { files: [{ mime, data: buf }], tier: 'main', tries: 2 });
              const r = Array.isArray(out) ? out[0] : out;
              const slots = normalizeSlots(r && r.slots, registry());
              if (!slots.length) return send(res, 422, { error: 'Could not find a timetable for this class in that file. Try a clearer photo or a PDF.' });
              return send(res, 200, { slots, sections: Array.from(new Set((r.slots || []).map(x => x && x.section).filter(Boolean))).slice(0, 12) });
            } catch (e) { return send(res, e instanceof CapError ? 429 : 502, { error: e instanceof CapError ? 'The AI is over its limit right now. Try again later.' : 'Could not read that file: ' + String(e.message).slice(0, 100) }); }
          }
          if (p === '/api/admin/pushme' && req.method === 'POST') { const b = await body(req); return send(res, 200, { ok: markAdmin(b.subscription) }); }
          // The class's subjects: name, course code and short names. Cards are only ever filed under these (or General).
          if (p === '/api/admin/subjects' && req.method === 'GET') return send(res, 200, { subjects: subjectList().map(x => ({ ...x, alias: [x.code].concat(x.keys).filter(Boolean).join(', ') })) });
          if (p === '/api/admin/subjects' && req.method === 'POST') {
            const b = await body(req);
            const list = saveSubjects(b.subjects);
            if (!list.length) return send(res, 400, { error: 'Add at least one subject' });
            // A renamed subject takes all its cards with it, for everyone.
            const now = Date.now(), gm = { ...(getKv('group_map', {}) || {}) };
            let renamed = 0;
            for (const x of list) if (x.was && x.was !== x.name) {
              renamed += db.prepare('update cards set subject=?, updated=? where subject=? and deleted=0').run(x.name, now, x.was).changes;
              for (const g of Object.keys(gm)) if (gm[g] === x.was) gm[g] = x.name;
            }
            setKv('group_map', gm);
            return send(res, 200, { ok: true, renamed, moved: reroute() });
          }
          // The CR decides how one group is filed: under a subject name, as the whole-branch group, or back to automatic.
          if (p === '/api/admin/groupmap' && req.method === 'POST') {
            const b = await body(req);
            const g = String(b.group || '');
            if (!g || !((getKv('wa', {}) || {}).groups || []).includes(g)) return send(res, 400, { error: 'Pick one of the groups the app can see' });
            const map = { ...(getKv('group_map', {}) || {}) };
            let v = b.mode === 'main' ? MAIN : b.mode === 'ignore' ? IGNORE : b.mode === 'subject' ? String(b.subject || '').trim().slice(0, 40) : '';
            if (b.mode === 'section') { const sec = normSection(b.section); if (!sec) return send(res, 400, { error: 'Pick one of the sections: ' + sectionList().join(', ') }); v = sectionOverrideValue(sec); }
            if (b.mode === 'subject' && !v) return send(res, 400, { error: 'Type the subject name' });
            if (b.mode === 'subject') {
              const reg = registry();
              if (reg.fixed) { v = canonSubject(v, reg); if (v === 'General' && norm(b.subject) !== 'general') return send(res, 400, { error: 'That is not one of your subjects. Pick one from the Subjects list.' }); }
            }
            if (v) map[g] = v; else delete map[g];
            setKv('group_map', map);
            return send(res, 200, { ok: true, moved: v && b.mode === 'subject' ? db.prepare("update cards set subject=?, updated=? where grp=? and deleted=0 and pinned=0 and type!='exam'").run(v, Date.now(), g).changes : reroute() });
          }
          // Deletes everything that came from one group: its cards (for everyone), the messages we kept, and the saved files.
          // Nothing is left behind, so uploading the chat again starts clean and makes no duplicates.
          if (p === '/api/admin/groupcards' && req.method === 'POST') {
            const b = await body(req);
            if (b.confirm !== 'yes' || !b.group) return send(res, 400, { error: 'send {"group":"...","confirm":"yes"}' });
            if (jobRunning()) return send(res, 409, { error: 'An old-chat upload is still being read. Wait until it finishes.' });
            const g = String(b.group), now = Date.now();
            const cards = db.prepare('update cards set deleted=1, updated=? where grp=? and deleted=0').run(now, g).changes;
            const msgs = db.prepare('delete from messages where grp=?').run(g).changes;
            // A saved file goes unless a live card from another group still shows it.
            const others = db.prepare('select files from cards where deleted=0 and grp!=?').all(g).map(r => r.files || '').join(' ');
            let files = 0;
            for (const f of db.prepare('select id from files where grp=?').all(g)) {
              if (others.includes('"' + f.id + '"')) continue;
              try { fs.unlinkSync(filePath(f.id)); } catch (e) { /* already gone */ }
              db.prepare('delete from files where id=?').run(f.id); files++;
            }
            return send(res, 200, { ok: true, removed: cards, messages: msgs, files });
          }
          if (p === '/api/admin/people' && req.method === 'GET') return send(res, 200, { people: db.prepare('select id,name,created from people order by created asc').all() });
          if (p === '/api/admin/people' && req.method === 'POST') { const b = await body(req); return send(res, 200, { ok: db.prepare('delete from people where id=?').run(String(b.id || '')).changes > 0 }); }
          if (p === '/api/admin/reroute' && req.method === 'POST') return send(res, 200, { moved: reroute() });
          if (p === '/api/admin/newsemester' && req.method === 'POST') {
            const b = await body(req);
            if (b.confirm !== 'yes') return send(res, 400, { error: 'send {"confirm":"yes"}' });
            const now = Date.now();
            db.prepare('update cards set deleted=1, updated=? where deleted=0').run(now);
            return send(res, 200, { ok: true });
          }
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---- the app itself ----
      let rel = p === '/' ? '/index.html' : decodeURIComponent(p);
      const full = path.join(cfg.publicDir, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
      if (!full.startsWith(path.resolve(cfg.publicDir) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' || path.basename(full) === 'sw.js' ? 'no-cache' : 'public, max-age=3600' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      send(res, 500, { error: String(e.message).slice(0, 100) });
    }
  });
  server.requestTimeout = 20 * 60 * 1000;   // big uploads on slow phone data
  server.listen(cfg.port, () => console.log('Feed server on http://localhost:' + cfg.port));
  return server;
}
