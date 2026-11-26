// Cuts the cost of reading PDFs: lecture notes are filed by name without any AI call,
// and long PDFs are read from their first pages only.

const READ_IT = /\b(assign\w*|quiz\w*|test|exam\w*|mid\s*-?\s*sem\w*|end\s*-?\s*sem\w*|syllabus|schedule|time\s*-?\s*table|notice|circular|deadline|submit\w*|submission|due|worksheet|problem\s*sets?|homework|hw|lab|project|viva|presentation|result|marks|seating|date\s*sheet|datesheet)\b/i;
const NOTES = [/\b(lecture|lec|notes?|slides?|ppt|chapter|chap|unit|module|topic|book|textbook|reference)\b/i, /^l[\s\-.]*\d/i, /\bpart[\s\-.]*([ivx]+|\d+)\b/i];

// True when the file name looks like course material and nothing around it hints at a deadline,
// a test or a notice. Such a file is filed under its subject without reading it.
export function looksLikeNotes(name, caption, around) {
  const n = String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  if (!NOTES.some(r => r.test(n))) return false;
  return !READ_IT.test([n, caption || '', ...(around || [])].join(' | '));
}

let lib;
async function pdfLib() {
  if (lib === undefined) {
    try { lib = await import('pdf-lib'); }
    catch (e) { lib = null; console.log('pdf-lib is not installed, so long PDFs are sent whole. Run: npm install'); }
  }
  return lib;
}

// Returns { total, buf }. buf is a PDF of the first n pages, or null when the file is short enough
// (or cannot be cut) and should be sent whole.
export async function firstPages(buf, n) {
  const L = await pdfLib();
  if (!L || !(n > 0)) return { total: 0, buf: null };
  try {
    const src = await L.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    const total = src.getPageCount();
    if (total <= n) return { total, buf: null };
    const out = await L.PDFDocument.create();
    (await out.copyPages(src, Array.from({ length: n }, (_, i) => i))).forEach(p => out.addPage(p));
    return { total, buf: Buffer.from(await out.save()) };
  } catch (e) { return { total: 0, buf: null }; }
}
