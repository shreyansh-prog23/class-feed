// One function for "ask the AI, get JSON back". The provider is a setting, so moving from
// the free Gemini tier to Claude later is a one-line change in .env.
import { cfg } from './config.js';
import { db } from './db.js';

let mock = null;
export const setMock = f => { mock = f; };

export class CapError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Google's daily quota resets at midnight Pacific time (1:30 pm in India), so the app counts its day the same way.
export const today = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// How far through Google's quota day (midnight Pacific) it is, 0 to 1.
export function dayFraction(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.min(1, (+p.hour * 60 + +p.minute) / 1440);
}
// How many calls reading messages may have used by now. The day's budget is spread out, so busy mornings cannot use up the whole day.
export const liveAllowed = (ms = Date.now()) => Math.floor(cfg.dailyCallCap * (1 - cfg.askReserve) * Math.min(1, dayFraction(ms) + cfg.paceHead));
export const usageToday = () => (db.prepare('select calls from usage where day=?').get(today()) || { calls: 0 }).calls;
const bump = () => db.prepare('insert into usage(day,calls) values(?,1) on conflict(day) do update set calls=calls+1').run(today());

// When the AI says "too many requests" or is down, every caller waits longer each time
// instead of spending calls that cannot work right now.
const spent = new Map();   // model -> the quota day it ran out of calls
let cool = { until: 0, n: 0 };
export const resetCooldown = () => { cool = { until: 0, n: 0 }; };
export const coolingUntil = () => (cool.until > Date.now() ? cool.until : 0);
function coolDown() { cool.n++; cool.until = Date.now() + Math.min(30, 2 * 2 ** (cool.n - 1)) * 60000; }

// Calls leave one at a time, spaced so the per-minute limit is never passed (free Flash allows 5 a minute).
// Each caller reserves its own slot first, so two calls at the same moment cannot both go out together.
let nextSlot = 0;
const gapMs = () => cfg.minGapMs != null ? cfg.minGapMs : Math.ceil(60000 / Math.max(1, cfg.aiRpm)) + 500;
async function gap() {
  const now = Date.now(), at = Math.max(now, nextSlot);
  nextSlot = at + gapMs();
  if (at > now) await sleep(at - now);
}

export function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('AI did not return JSON');
}

function httpError(status, body) {
  const e = new Error('AI error ' + status + ': ' + String(body).slice(0, 200));
  e.retry = status === 429 || status >= 500;
  e.status = status; e.perDay = status === 429 && /PerDay/i.test(String(body));
  return e;
}

async function gemini(prompt, files, tier, json, useModel) {
  if (!cfg.geminiKey) throw new Error('GEMINI_API_KEY is not set');
  const model = useModel || (tier === 'lite' ? cfg.geminiLite : cfg.geminiModel);
  const parts = files.map(f => ({ inline_data: { mime_type: f.mime, data: f.data.toString('base64') } }));
  parts.push({ text: prompt });
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: json ? { temperature: 0.1, responseMimeType: 'application/json' } : { temperature: 0.2 } })
  });
  const body = await r.text();
  if (!r.ok) throw httpError(r.status, body);
  const j = JSON.parse(body);
  const out = ((j.candidates || [])[0] || {}).content;
  return ((out && out.parts) || []).map(p => p.text || '').join('');
}

async function anthropic(prompt, files, tier) {
  if (!cfg.anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const content = files.map(f => f.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } });
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: tier === 'lite' ? cfg.anthropicLite : cfg.anthropicModel, max_tokens: 3000, messages: [{ role: 'user', content }] })
  });
  const body = await r.text();
  if (!r.ok) throw httpError(r.status, body);
  return (JSON.parse(body).content || []).map(p => p.text || '').join('');
}

// files: [{ mime, data: Buffer }]   tier: 'main' | 'lite'   json: true returns parsed JSON, false returns text
export const askJson = (prompt, o = {}) => ask(prompt, { ...o, json: true });
export const askText = (prompt, o = {}) => ask(prompt, { ...o, json: false });
async function ask(prompt, { files = [], tier = 'main', json = true, tries = 2 } = {}) {
  if (mock) return mock(prompt, { files, tier });
  // Models to try in order: the main one, then the backups. A model that said "out of calls for today" is skipped until Google's day changes.
  const chain = cfg.provider === 'gemini' ? [''].concat(cfg.geminiFallback) : [''];
  let at = 0;
  const usable = i => !(spent.get(chain[i] || (tier === 'lite' ? cfg.geminiLite : cfg.geminiModel)) === today());
  while (at < chain.length - 1 && !usable(at)) at++;
  tries = Math.max(tries, chain.length);
  for (let attempt = 0; attempt < tries; attempt++) {
    if (cool.until > Date.now()) {
      const e = new Error('AI error 429: backing off until ' + new Date(cool.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST');
      e.retry = true; throw e;
    }
    if (usageToday() >= cfg.dailyCallCap) throw new CapError('Daily AI limit reached (' + cfg.dailyCallCap + ' calls)');
    await gap();
    bump();
    try {
      // If the main model is overloaded, the lighter one often still answers (separate capacity).
      const useTier = cfg.provider === 'gemini' && tier === 'main' && attempt >= 2 ? 'lite' : tier;
      const text = cfg.provider === 'anthropic' ? await anthropic(prompt, files, tier) : await gemini(prompt, files, useTier, json, chain[at]);
      cool = { until: 0, n: 0 };
      return json ? parseJson(text) : text;
    } catch (e) {
      if (e.retry && !/backing off/.test(e.message) && attempt === tries - 1) coolDown();
      if (cfg.provider === 'gemini' && (e.status === 503 || e.status === 429)) {
        if (e.perDay) spent.set(chain[at] || (tier === 'lite' ? cfg.geminiLite : cfg.geminiModel), today());
        let n = at + 1; while (n < chain.length && !usable(n)) n++;
        if (n < chain.length && attempt < tries - 1) { console.log('AI model ' + (chain[at] || 'main') + ' is ' + (e.status === 503 ? 'busy' : 'out of calls') + ', trying ' + chain[n]); at = n; continue; }
      }
      const again = e.retry || /did not return JSON|Unexpected token/.test(e.message);
      if (!again || attempt === tries - 1) throw e;
      await sleep(e.retry ? cfg.retryWaitMs * (attempt + 1) : 1000);
    }
  }
}

export const aiReady = () => !!(mock || (cfg.provider === 'anthropic' ? cfg.anthropicKey : cfg.geminiKey));
