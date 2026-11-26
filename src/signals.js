// A cheap check that runs before the AI: does this text look like it could hold anything a student
// must remember? A batch of messages with none of these is not sent to the AI at all.
// The CR sees the longer skipped messages and can add words that should have counted.
import { getKv, setKv } from './db.js';

const BASE = ['assign', 'submit', 'submission', 'deadline', 'due', 'quiz', 'test', 'exam', 'mid', 'endsem', 'viva', 'lab', 'project', 'class', 'lecture',
  'lec', 'tutorial', 'tut', 'cancel', 'postpone', 'prepone', 'resched', 'extend', 'syllabus', 'note', 'ppt', 'slide', 'pdf', 'mark', 'result', 'attendance',
  'today', 'tomorrow', 'tonight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'notice', 'circular', 'form', 'regist', 'fee', 'holiday', 'schedule',
  'timetable', 'time table', 'link', 'meet', 'zoom', 'room', 'hall', 'venue', 'bring', 'compulsory', 'important', 'urgent', 'assessment', 'practical',
  'internal', 'sessional', 'presentation', 'report', 'worksheet', 'homework', 'hw', 'unit', 'chapter', 'topic', 'revision', 'doubt',
  'kal', 'aaj', 'parso', 'jama', 'nahi hoga', 'nahi hogi', 'hoga', 'hogi', 'paper', 'sheet', 'book', 'upload', 'send', 'share', 'bhejo', 'kab', 'kitne baje'];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const build = words => new RegExp('(^|[^\\p{L}])(?:' + words.map(esc).join('|') + ')', 'iu');
let baseRe = build(BASE), customKey = '', customRe = null;

export const customWords = () => getKv('signal_words', []);
function custom() {
  const w = customWords(), k = w.join('|');
  if (k !== customKey) { customKey = k; customRe = w.length ? build(w) : null; }
  return customRe;
}

export function hasSignal(text) {
  const t = String(text || '');
  if (/\d/.test(t)) return true;
  if (baseRe.test(t)) return true;
  const c = custom();
  return !!(c && c.test(t));
}

export function addSignalWord(word) {
  const w = String(word || '').trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 30);
  if (w.length < 2) return false;
  const list = customWords();
  if (!list.includes(w)) setKv('signal_words', list.concat(w).slice(-200));
  return true;
}

// Messages that must reach classmates quickly: a class cancelled, moved or added. These skip the wait and the day's spread.
const URGENT = /\b(cancel(l?ed|s)?|postpone[ds]?|prepone[ds]?|re-?schedul\w*|no\s+class(es)?|class(es)?\s+(is\s+|are\s+|will\s+be\s+)?(off|not\s+(held|there|happening))|extra\s+class|make-?up\s+class|class\s+(is\s+)?shifted|venue\s+(is\s+)?chang\w*|urgent\w*)\b/i;
export const isUrgent = text => URGENT.test(String(text || ''));
