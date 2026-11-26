// Settings come from the .env file (or the host's environment variables).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file: use real environment variables */ }

process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);

const subjects = {};
String(process.env.SUBJECTS || '').split(';').forEach(p => {
  const i = p.indexOf('=');
  if (i > 0) subjects[p.slice(0, i).trim().toUpperCase().replace(/\s+/g, ' ')] = p.slice(i + 1).trim();
});

export const cfg = {
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  publicDir: path.join(root, 'public'),
  classCode: process.env.CLASS_CODE || '',
  adminCode: process.env.ADMIN_CODE || '',
  provider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
  geminiKey: process.env.GEMINI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  geminiFallback: String(process.env.GEMINI_FALLBACK_MODEL || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 4),   // backup models, tried in order when the main one is busy (503) or out of calls (429)
  geminiLite: process.env.GEMINI_LITE_MODEL || 'gemini-3-flash-preview',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  anthropicLite: process.env.ANTHROPIC_LITE_MODEL || 'claude-haiku-5-5',
  dailyCallCap: num(process.env.DAILY_CALL_CAP, 300),
  retryWaitMs: num(process.env.RETRY_WAIT_MS, 15000),  // pause before the one retry of a failed AI call
  aiRpm: num(process.env.AI_RPM, 5),                 // requests per minute Google allows this key (free Flash is 5; Flash Lite 15)
  minGapMs: process.env.MIN_GAP_MS === undefined || process.env.MIN_GAP_MS === '' ? null : num(process.env.MIN_GAP_MS, 0),   // optional fixed gap in ms; when not set it is worked out from AI_RPM
  batchWaitMs: num(process.env.BATCH_WAIT_MS, 450000),  // wait for 7.5 quiet minutes, then read the group's messages together (fewer AI calls)
  batchMaxMs: num(process.env.BATCH_MAX_MS, 1200000),    // but never keep a busy group waiting longer than this (20 minutes)
  urgentWaitMs: num(process.env.URGENT_WAIT_MS, 60000),   // a cancelled or moved class is read after one quiet minute
  askReserve: num(process.env.ASK_RESERVE, 0.2),         // share of the daily calls kept for Ask, the CR's fixes and polls; reading messages never touches it
  paceHead: num(process.env.PACE_HEAD, 0.25),            // reading may use this share of the day's calls at the start of the day, then more as the day goes on
  groups: list(process.env.GROUPS),
  classHint: process.env.CLASS_HINT || '',   // e.g. "AI&DS, 3rd semester": tells the date sheet reader which rows are yours
  backupKeep: +process.env.BACKUP_KEEP || 7,
  mainGroups: list(process.env.MAIN_GROUPS),   // words from the name of the whole-branch group(s); every other group is filed as one subject
  pollWaitMin: num(process.env.POLL_WAIT_MIN, 90),            // how long a poll collects votes before it is read
  pollMinVotes: num(process.env.POLL_MIN_VOTES, 5),
  pollMajority: num(process.env.POLL_MAJORITY, 60) / 100,
  holdHours: process.env.HOLD_HOURS === undefined ? 12 : Math.max(0, +process.env.HOLD_HOURS || 0),   // unsure deadlines, exams and class changes wait this long for the CR (0 = never wait)
  senders: list(process.env.SENDERS),
  sections: list(process.env.SECTIONS === undefined ? 'AD-01,AD-02' : process.env.SECTIONS),   // the sub-sections of the class; labs and some instructions are for one of them
  subjects,
  maxFileBytes: num(process.env.MAX_FILE_MB, 25) * 1024 * 1024,
  maxPdfAiBytes: 15 * 1024 * 1024,
  pdfPages: num(process.env.PDF_AI_PAGES, 3),   // long PDFs: only this many first pages go to the AI (0 = whole file)
  historyDailyCalls: num(process.env.HISTORY_DAILY_CALLS, 120),   // AI calls per day the old-chat import may use
  historyReserve: num(process.env.HISTORY_RESERVE, 80),           // calls always kept free for live messages
  historyMaxBytes: num(process.env.HISTORY_MAX_MB, 200) * 1024 * 1024,
  historyMaxFiles: num(process.env.HISTORY_MAX_FILES, 400),
  pushContact: process.env.PUSH_CONTACT || 'mailto:admin@example.com'
};

fs.mkdirSync(path.join(cfg.dataDir, 'files'), { recursive: true });
