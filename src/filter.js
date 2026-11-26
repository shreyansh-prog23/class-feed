// Cheap rules that run before any AI, so most messages cost nothing.
import { cfg } from './config.js';
import { getKv } from './db.js';

// The CR can say, per group, which subject its cards belong to, or that it is the whole-branch group.
export const MAIN = '__main__', IGNORE = '__ignore__';
const SEC = 'sec:';
export const groupOverride = name => { const m = getKv('group_map', {}) || {}; return m[String(name || '')] || ''; };

// Stickers, GIFs, voice notes and videos can't carry a deadline.
export function isNoiseFile(name, mime) {
  const n = String(name || '');
  if (/^(STK|GIF|PTT|AUD|VID)-/i.test(n) || /sticker/i.test(n)) return true;
  if (/\.(webp|gif|mp4|mov|mkv|avi|webm|3gp|m4v|opus|ogg|oga|m4a|mp3|aac|amr|wav)$/i.test(n)) return true;
  return /^(video|audio)\//i.test(mime || '');
}

// Emoji-only messages and one-word replies are not worth reading.
export function isJunkText(t) {
  const x = String(t || '').trim();
  if (!x) return true;
  if (!x.replace(/[^\p{L}\p{N}]+/gu, '')) return true;
  return /^(ok(ay)?|thanks?|thanx|thank\s*(you|u)|thankyou|yes|no|sir|ji|haan|done|noted|hi+|hello|hey|gm|good\s*(morning|evening|night|afternoon)|lol|haha+|hmm+|k)(\s+(sir|mam|ma'am|madam|you|so much|a lot|bhai|everyone|all|guys))*[\s.!]*$/i.test(x);
}

// The sub-sections of the class (AD-01, AD-02). Any spelling like "ad02" or "AD 2" is matched to the list.
export const sectionList = () => cfg.sections;
export const normSection = x => {
  const t = String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sectionList().find(s => s.toUpperCase().replace(/[^A-Z0-9]/g, '') === t) || sectionList().find(s => { const k = s.toUpperCase().replace(/[^A-Z0-9]/g, ''); return k.replace(/0+(\d)/, '$1') === t.replace(/0+(\d)/, '$1'); }) || null;
};
// The CR's pick for a group is one of: whole class, ignore, a section's group ("sec:AD-01"), or a subject name.
export const groupSection = name => { const o = groupOverride(name); return o.startsWith(SEC) ? normSection(o.slice(SEC.length)) : null; };
export const subjectOverride = name => { const o = groupOverride(name); return o && o !== MAIN && o !== IGNORE && !o.startsWith(SEC) ? o : ''; };
export const sectionOverrideValue = s => SEC + s;

export function groupAllowed(name) {
  const ov = groupOverride(name);
  if (ov) return ov !== IGNORE;
  const g = String(name || '').toLowerCase();
  return cfg.groups.some(w => g.includes(w.toLowerCase()));
}

// The main group of the whole class or branch: its messages are sorted into subjects by what they say.
export function isMainGroup(name) {
  const ov = groupOverride(name);
  if (ov) return ov === MAIN || ov.startsWith(SEC);   // a section's group is sorted by content too, and its cards are tagged with the section
  const g = String(name || '').toLowerCase();
  if (g.startsWith('date sheet')) return true;   // exam cards from a date sheet are sorted by course, never by the group they were posted in
  return cfg.mainGroups.some(w => g.includes(w.toLowerCase()));
}

// SENDERS can hold part of a saved name or a phone number. Empty means everyone.
export function senderAllowed(sender, number) {
  if (!cfg.senders.length || number === 'cr-upload') return true;
  const s = String(sender || '').toLowerCase(), n = String(number || '').replace(/\D/g, '');
  return cfg.senders.some(w => {
    const x = w.toLowerCase();
    return (x && s.includes(x)) || (n && x.replace(/\D/g, '') && n.endsWith(x.replace(/\D/g, '')));
  });
}
