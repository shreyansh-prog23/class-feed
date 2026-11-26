// The class timetable: read from a photo or PDF the CR uploads, checked by the CR, then shared with every phone.
import { cfg } from './config.js';
import { canonSubject } from './cards.js';
import { normSection } from './filter.js';

const DAY = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const fixTime = x => { const m = /^(\d{1,2})[:.](\d{2})/.exec(String(x || '').trim()); if (!m) return null; const v = String(+m[1]).padStart(2, '0') + ':' + m[2]; return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null; };

export function timetablePrompt(reg) {
  const subs = reg && reg.fixed ? 'The class has exactly these subjects: ' + JSON.stringify(reg.list.map(s => ({ name: s.name, code: s.code || '', also: s.keys }))) + '. Use these names for the subject of each slot when one fits.\n' : '';
  return 'You read a college class timetable.\nThis class: ' + (cfg.classHint || 'the branch and semester the CR belongs to') + '.\n' + subs +
    'Reply with ONLY JSON: {"slots":[{"day":"Mon","start":"09:00","end":"09:50","subject":"short subject name","code":"course code or empty","room":"room or empty","kind":"lecture or lab or tutorial","section":"the section or group this slot is for, or empty"}]}\n' +
    'Rules:\n1. Days are Mon, Tue, Wed, Thu, Fri, Sat. Times are 24-hour HH:MM.\n' +
    '2. If the timetable covers several branches, return only the rows for this class. This class has the sections ' + (cfg.sections || []).join(' and ') + '. Lectures (about 55 minutes) are the same for every section, so leave section empty for them. A block of about 110 minutes is a lab. A lab or tutorial for only one section gets that section filled in. If you cannot tell which rows are this class, return every row with its section filled in.\n' +
    '3. Only when the timetable shows ONE class running across two periods (one block, about 110 minutes) is it one slot from its start to its end. Two separate classes, one after the other, stay two separate slots. Never merge them.\n' +
    '4. Copy course codes and rooms exactly. Do not invent classes. Skip empty cells, lunch and breaks.\n5. If you cannot read a timetable, reply {"slots":[]}.';
}

// The length of the slot decides: a block of 100 minutes or more is a lab, a shorter one is a lecture (a tutorial stays a tutorial).
// Two separate 55-minute classes in a row are never joined and never become a lab.
const mins = t => { const m = /^(\d\d):(\d\d)$/.exec(fixTime(t) || ''); return m ? +m[1] * 60 + +m[2] : null; };
function kindOf(x) {
  const a = mins(x && x.start), b = mins(x && x.end);
  if (a === null || b === null || b <= a) return ['lab', 'tutorial'].includes(x && x.kind) ? x.kind : 'lecture';
  if (b - a >= 100) return 'lab';
  return x && x.kind === 'tutorial' ? 'tutorial' : 'lecture';
}

// Anything the AI or the CR typed becomes a clean slot, filed under the class's own subject names.
export function normalizeSlots(list, reg) {
  return (Array.isArray(list) ? list : []).slice(0, 200).map(x => {
    const subject = String((x && x.subject) || '').trim().slice(0, 60), code = String((x && x.code) || '').trim().slice(0, 20);
    const day = typeof (x && x.day) === 'number' ? x.day : (DAY[String((x && x.day) || '').slice(0, 3).toLowerCase()] || +(x && x.day));
    const canon = reg && reg.fixed ? canonSubject(code ? code + ' ' + subject : subject, reg) : subject;
    return { day, start: fixTime(x && x.start), end: fixTime(x && x.end), subject: canon && canon !== 'General' ? canon : subject, code, room: String((x && x.room) || '').trim().slice(0, 20), kind: kindOf(x), section: normSection(x && x.section) || '' };
  }).filter(x => x.day >= 1 && x.day <= 6 && x.start && x.end && x.subject);
}
