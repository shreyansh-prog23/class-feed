// What we ask the AI. Same rules the app already uses, plus one call that reads a photo or PDF.
import { codesIn, groupInfo } from './cards.js';
import { cfg } from './config.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = n => String(n).padStart(2, '0');

export const sentOn = ms => { const d = new Date(ms); return WDL[d.getDay()] + ' ' + d.getDate() + ' ' + MO[d.getMonth()] + ' ' + d.getFullYear(); };

function line(m, id) {
  let t;
  if (m.kind === 'image' || m.kind === 'pdf') t = '(sent ' + (m.kind === 'pdf' ? 'a PDF' : 'a photo') + (m.file_name ? ' named "' + m.file_name + '"' : '') + ')' + (m.text || m.why ? ': ' + String(m.text || m.why).replace(/\s*\n\s*/g, ' / ').slice(0, 300) : '');
  else if (m.kind === 'file') t = '(sent a file named "' + m.file_name + '")' + (m.text ? ' with the caption: ' + String(m.text).replace(/\s*\n\s*/g, ' / ').slice(0, 300) : '');
  else t = String(m.text || '').replace(/\s*\n\s*/g, ' / ').slice(0, 700);
  const d = new Date(m.ms);
  return '[' + id + '] ' + WD[d.getDay()] + ' ' + d.getDate() + ' ' + MO[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' | ' + m.sender + ': ' + t;
}

// Tells the AI how this group is filed: one subject, or sorted by content.
function groupNote(group, reg) {
  const g = groupInfo(group, reg);
  return g.main
    ? 'This is the MAIN group for the whole class, not one subject. Decide each message\'s subject from what it says (course code, subject name, the teacher\'s name in the sender, the file name) and use the exact known name when one fits. Anything meant for everyone, such as college notices, holidays, events, fees, forms, timetable changes or general announcements, gets subject "General" and type notice. If it is about one subject but you cannot tell which, use "General".\n\n'
    : 'This group is for the subject "' + g.subject + '". Use "' + g.subject + '" as the subject of every card from it, including notices and class changes, unless a message clearly names a different course code.\n\n';
}

export function textPrompt(group, chunk, before, existing, fixes, reg) {
  const idMap = {};
  const lines = chunk.map((m, i) => { const id = 'm' + (i + 1); idMap[id] = m; return line(m, id); });
  const ctx = before.map((m, i) => line(m, 'c' + (i + 1)));
  const known = reg && (Object.keys(reg.codes).length || Object.keys(reg.names).length);
  const p = 'You read messages from a college class WhatsApp group and pick out what a student must remember.\n' +
    'Group: "' + group + '". Senders are shown by their saved contact names; a name like "Amit Prakash Sir Maths Sem 3" is a teacher for Maths.\n' +
    'Every message has an id, the date and weekday it was sent, the sender and the text.\n\n' +
    'Reply with ONLY a JSON array. Each element is one of:\n' +
    '{"op":"new","type":"assignment|exam|class_change|syllabus|material|notice","subject":"...","title":"...","due":"YYYY-MM-DD or null","time":"HH:MM or null","details":"...","change":"cancelled|cancelled_all|rescheduled|extra|restored|other (only for class_change)","section":"AD-01 or AD-02 only if the message is clearly for one section, otherwise null","src":["m1"],"unsure":true or false,"note":"..."}\n' +
    '{"op":"update","card":"<id of an existing card>","due":"...","time":"...","title":"...","details":"...","src":["m3"],"why":"short reason"}  (include only the fields that change)\n\n' +
    'Rules:\n' +
    '1. Only extract what a student needs to remember or act on: assignments and deadlines, exams and quizzes, classes cancelled, moved or starting, syllabus, study material, important notices. Skip greetings, thanks, questions, jokes, joins and chatter.\n' +
    '2. Work out dates from the date of the message itself: "tomorrow", "today", "Monday" (the next Monday after the message). Never use today\'s real date. If no day is given, due is null. If no time is stated, time is null. Never guess a time.\n' +
    '3. A message such as "submit above assignment by Monday" refers to the photo or file sent just before it. Update that file\'s existing card if there is one, otherwise make a new card and set unsure true. The same applies to a short message from the person who sent a file, within a few minutes of it, that says what the file is, which unit or subject it covers, or when it is due: update that file\'s card (title, subject, details, due) instead of making a new one. Existing cards list the name of their file as "file".\n' +
    '4. Anything about a lecture, lab or tutorial happening or not happening is type class_change and needs "change", "subject", "due" (the date of that class) and "time" (the start time of that class if the message says it, otherwise null). "change" is: cancelled (one subject\'s class is cancelled, not held, off or skipped, today or on a later date: resolve "today", "tomorrow", "Monday" or "on 3rd" from the message\'s date); cancelled_all (no classes at all for everyone that day, for example a holiday or "no classes tomorrow"; subject "General"); rescheduled (a class moved to another time, room or day: due and time are the NEW ones and details say what moved, and also add a cancelled card for the original date and time if the message gives it); extra (an additional or makeup class); restored (a class that was announced as cancelled will be held after all: update that card); other. title is plain, for example "Maths class cancelled".\n' +
    '5. If a message changes an existing card (new date, extension, cancellation, a modified version of a file), return an update for that card instead of a new card.\n' +
    '6. subject: infer it from the sender name or text (for example Maths); otherwise "General". title: short and plain, under 60 characters. details: one short line, or "".\n' +
    '7. src lists the ids of the message(s) the card comes from, using only ids from the main list.\n' +
    '8. A message that sends a file gives you its name. Use it. A syllabus file is type syllabus. Lecture notes, slides, worksheets and similar files are type material, titled like the file name without the extension, tidied (no underscores). Do not invent a due date for them. The same file sent again under a slightly different name, or "Modified version", means update the earlier card.\n' +
    '9. If nothing qualifies, reply [].\n\n' +
    (known ? (reg.fixed ? 'This class has exactly these subjects and no others: ' + JSON.stringify(reg.list.map(x => x.name)) + '. Short names people use: ' + JSON.stringify(reg.list.map(x => [x.name].concat(x.code ? [x.code] : [], x.keys)))+ '. Always use one of these exact names as the subject. Use "General" only for whole-class news (holidays, fees, college notices, events) or when you truly cannot tell. Never invent a subject. ' : '') + 'Known subjects: ' + JSON.stringify(Array.from(new Set(Object.values(reg.names).concat(Object.values(reg.codes))))) + '. Course codes: ' + JSON.stringify(reg.codes) + '.' + (groupInfo(group, reg).main ? ' Decide each message\'s subject from its own content (course code, subject name, file name, sender) and use the exact names above when one fits. Use "General" only if nothing fits.' : '') + '\n\n' : '') +
    groupNote(group, reg) +
    (fixes && fixes.length ? 'Corrections the class representative made earlier. Learn from them and do the same:\n' + JSON.stringify(fixes) + '\n\n' : '') +
    'Existing cards: ' + JSON.stringify(existing) + '\n\n' +
    (ctx.length ? 'Earlier messages, for context only (never use these ids in src):\n' + ctx.join('\n') + '\n\n' : '') +
    'Messages:\n' + lines.join('\n');
  return { prompt: p, idMap };
}

// One call per photo or PDF: decide whether it matters and read it.
export function mediaPrompt(m, around, reg, note) {
  const isPdf = m.kind === 'pdf';
  return 'You look at a ' + (isPdf ? 'PDF' : 'photo') + ' sent in a college class WhatsApp group, for a student.\n' +
    'Group: "' + m.grp + '". Sent by ' + m.sender + ' on ' + sentOn(m.ms) + '. ' +
    (m.file_name ? 'File name: "' + m.file_name + '". ' : '') + (m.text ? 'Caption: "' + String(m.text).slice(0, 300) + '". ' : 'No caption. ') + '\n' +
    groupNote(m.grp, reg) +
    (around && around.length ? 'Messages around it: ' + around.join(' / ') + '\n' : '') + (note ? note + '\n' : '') +
    'Reply with ONLY one JSON object: {"useful":true or false,"kind":"assignment|exam|syllabus|notice|timetable|notes|other","subject":"...","title":"short title under 60 characters","due":"YYYY-MM-DD or null","time":"HH:MM or null","summary":"one or two plain sentences about what it contains","text":"the key text copied from it, such as the questions or the topic list, up to 800 characters","unsure":true or false}\n' +
    'Rules: the messages around it, especially from the person who sent it, often say what the file is. Use them for the title, subject, summary and any date. A generic file name such as "Adobe Scan", "IMG" or "WhatsApp Image" is never a good title; name it from what it contains or from the messages. useful is false only when it is clearly not about studies (people, memes, food, scenery, unrelated posters, ordinary chat screenshots). If you are not sure, say true. ' +
    'Work out dates from the date it was sent, never from today. Never guess a time. If it is hard to read, set unsure true. ' +
    'Notes, slides and worksheets are kind notes. A PDF of lecture notes is not an assignment unless it asks students to submit something.\n' +
    (reg && (Object.keys(reg.names).length || Object.keys(reg.codes).length) ? 'Known subjects: ' + JSON.stringify(Array.from(new Set(Object.values(reg.names).concat(Object.values(reg.codes))))) + '. Use these exact names when one fits (a course code in the file or group name tells you which), otherwise "General"' + (reg.fixed ? ' (never a subject outside this list)' : '') + '.\n' : '');
}

// A date sheet lists many papers for many branches. Only this class's rows are wanted.
export const DATESHEET_RE = /date\s*-?\s*sheet|exam(ination)?\s*(schedule|time\s*-?\s*table)|(mid|end)\s*-?\s*sem\w*\s*(schedule|time\s*-?\s*table)|schedule of (mid|end|practical)/i;
export function datesheetPrompt(m, around, reg, kindHint) {
  const subjects = reg && (Object.keys(reg.names).length || Object.keys(reg.codes).length) ? Array.from(new Set(Object.values(reg.names).concat(Object.values(reg.codes)))) : [];
  return 'You read an exam date sheet (schedule) for a student. It was ' + (m.sender === 'CR' ? 'uploaded by the class representative' : 'sent in the WhatsApp group "' + m.grp + '" by ' + m.sender) + ' on ' + sentOn(m.ms) + '. ' +
    (m.file_name ? 'File name: "' + m.file_name + '". ' : '') + (m.text ? 'Caption: "' + String(m.text).slice(0, 300) + '". ' : '') + '\n' +
    (around && around.length ? 'Messages around it: ' + around.join(' / ') + '\n' : '') +
    'This class: ' + (cfg.classHint || 'the branch and semester named in the group names') + '. ' +
    (subjects.length ? 'Known subjects of this class: ' + JSON.stringify(subjects) + '. Known course codes: ' + JSON.stringify(Object.keys(reg.codes)) + '. ' : '') + '\n' +
    'A date sheet usually covers many branches and semesters. Keep ONLY the papers for this class: match by course code first, then by subject name, then by the branch and semester columns. If you cannot tell which rows are this class, keep all rows and set "unsure" true.\n' +
    'Exam kind: ' + (kindHint ? 'this is a ' + kindHint + ' sem date sheet. ' : '') + 'use "mid" for mid semester, "end" for end semester, "practical" for practical or lab exams, otherwise "other".\n' +
    'Reply with ONLY one JSON object: {"datesheet":true or false,"unsure":true or false,"exams":[{"subject":"use a known subject name when one fits, otherwise the name printed on the sheet","code":"course code or null","due":"YYYY-MM-DD","time":"HH:MM 24-hour start time or null","until":"HH:MM or null","venue":"room or hall or null","kind":"mid|end|practical|other"}]}.\n' +
    'Rules: datesheet is false if this is not an exam schedule (then exams is []). Dates must be real calendar dates, worked out from the sheet and the year it was sent. Never guess a time or a date that is not printed; skip a paper that has no date. One entry per paper.\n';
}
