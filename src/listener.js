// The silent member. It reads the groups you choose and never sends anything.
// Uses Baileys, an unofficial WhatsApp Web library. If it breaks after a WhatsApp update,
// run `npm update @whiskeysockets/baileys` and restart.
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import * as B from '@whiskeysockets/baileys';
import { cfg } from './config.js';
import { setKv } from './db.js';
import { groupAllowed } from './filter.js';
import { ingest } from './reader.js';
import { savePoll, pollRaw, recordVote } from './polls.js';

// Baileys ships in two layouts depending on its version, so look in both places.
const pick = k => (B[k] !== undefined ? B[k] : (B.default && B.default[k]));
const makeWASocket = typeof B.default === 'function' ? B.default : ((B.default && B.default.default) || B.makeWASocket);
const useMultiFileAuthState = pick('useMultiFileAuthState'), DisconnectReason = pick('DisconnectReason'), downloadMediaMessage = pick('downloadMediaMessage'),
  fetchLatestBaileysVersion = pick('fetchLatestBaileysVersion'), Browsers = pick('Browsers'),
  BufferJSON = pick('BufferJSON'), getAggregateVotesInPollMessage = pick('getAggregateVotesInPollMessage');
if (typeof makeWASocket !== 'function' || typeof useMultiFileAuthState !== 'function') throw new Error('This version of the WhatsApp library is not one this code knows. Send this message to the developer, with the output of: npm ls @whiskeysockets/baileys');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const logger = pino({ level: 'silent' });

function unwrap(m) {
  let x = m;
  for (let i = 0; i < 5 && x; i++) {
    const n = (x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.documentWithCaptionMessage || x.editedMessage);
    if (!n) break;
    x = n.message || n;
  }
  return x || {};
}

export async function startListener() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(cfg.dataDir, 'wa-auth'));
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { /* use the library's built-in version */ }
  const sock = makeWASocket({ version, auth: state, logger, browser: Browsers.macOS('Chrome'), syncFullHistory: false, markOnlineOnConnect: false, printQRInTerminal: false,
    // Baileys asks for a poll back when a vote arrives, so it can decrypt the vote.
    getMessage: async key => { try { const r = pollRaw(key && key.id); return r ? JSON.parse(r, BufferJSON.reviver) : undefined; } catch (e) { return undefined; } } });
  const names = new Map();
  const warned = new Set();

  async function groupName(jid) {
    if (names.has(jid)) return names.get(jid);
    try { const md = await sock.groupMetadata(jid); names.set(jid, md.subject); return md.subject; } catch (e) { return null; }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async u => {
    if (u.qr) {
      log('Scan this with the spare phone: WhatsApp > Linked devices > Link a device');
      qrcode.generate(u.qr, { small: true });
      setKv('wa', { state: 'waiting for QR scan', at: Date.now() });
    }
    if (u.connection === 'open') {
      log('WhatsApp connected');
      try {
        const all = await sock.groupFetchAllParticipating();
        const list = Object.values(all).map(g => { names.set(g.id, g.subject); return g.subject; });
        setKv('wa', { state: 'connected', at: Date.now(), groups: list });
        log('Groups this number is in:'); list.forEach(n => log('  - ' + n + (groupAllowed(n) ? '   [READING]' : '')));
        if (!cfg.groups.length) log('GROUPS is empty in .env, so nothing is being read. Add words from the group names above.');
      } catch (e) { setKv('wa', { state: 'connected', at: Date.now() }); }
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        setKv('wa', { state: 'LOGGED OUT: delete data/wa-auth and scan the QR again', at: Date.now() });
        log('Logged out of WhatsApp. Delete the data/wa-auth folder, restart, and scan the QR again.');
      } else {
        setKv('wa', { state: 'reconnecting', at: Date.now() });
        log('Connection closed (' + code + '), reconnecting in 5s');
        setTimeout(() => startListener().catch(e => log('reconnect failed:', e.message)), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const jid = msg.key && msg.key.remoteJid;
        if (!jid || !jid.endsWith('@g.us') || msg.key.fromMe || !msg.message) continue;
        const grp = await groupName(jid);
        if (!grp) continue;
        if (!groupAllowed(grp)) { if (!warned.has(grp)) { warned.add(grp); log('ignoring group "' + grp + '" (not in GROUPS)'); } continue; }
        const number = String(msg.key.participant || '').split('@')[0];
        const sender = msg.pushName || number || 'Unknown';
        const ms = Number((msg.messageTimestamp && msg.messageTimestamp.toString && msg.messageTimestamp.toString()) || msg.messageTimestamp) * 1000 || Date.now();
        let c = unwrap(msg.message);
        const base = { grp, ms, sender, number };

        if (c.protocolMessage && c.protocolMessage.editedMessage) {
          const e = unwrap(c.protocolMessage.editedMessage);
          const t = e.conversation || (e.extendedTextMessage && e.extendedTextMessage.text);
          if (t) ingest({ ...base, text: '(edited) ' + t });
          continue;
        }
        if (c.conversation || c.extendedTextMessage) { ingest({ ...base, text: c.conversation || c.extendedTextMessage.text }); continue; }

        const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
        if (poll) {
          const ok = savePoll({ id: msg.key.id, grp, ms, sender, question: poll.name, options: (poll.options || []).map(o => o.optionName), raw: BufferJSON ? JSON.stringify(msg.message, BufferJSON.replacer) : null });
          if (ok) log(grp + ': poll saved, read after ' + cfg.pollWaitMin + ' minutes');
          continue;
        }
        const media = c.imageMessage || c.documentMessage;
        if (!media) continue;   // stickers, video, audio and contacts are skipped on purpose
        const size = Number(media.fileLength && media.fileLength.toString ? media.fileLength.toString() : media.fileLength) || 0;
        if (size > cfg.maxFileBytes) { log('skipping a large file (' + Math.round(size / 1048576) + ' MB)'); continue; }
        let buf;
        try { buf = await downloadMediaMessage({ ...msg, message: msg.message }, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }); }
        catch (e) { log('could not download a file from ' + sender + ': ' + e.message); continue; }
        const fileName = c.documentMessage ? (c.documentMessage.fileName || 'document') : 'IMG-' + ms + '.jpg';
        const r = ingest({ ...base, text: media.caption || '', buf, fileName, mime: media.mimetype || (c.imageMessage ? 'image/jpeg' : '') });
        log(grp + ': ' + fileName + ' -> ' + r.status + (r.why ? ' (' + r.why + ')' : ''));
      } catch (e) { log('message error:', e.message); }
    }
  });
  // Votes arrive as updates to the poll. Each person's latest choice is kept.
  sock.ev.on('messages.update', async events => {
    for (const ev of events || []) {
      try {
        const pu = ev && ev.update && ev.update.pollUpdates;
        if (!pu || !ev.key) continue;
        const raw = pollRaw(ev.key.id); if (!raw) continue;
        const message = JSON.parse(raw, BufferJSON.reviver);
        for (const u of pu) {
          const agg = getAggregateVotesInPollMessage({ message, pollUpdates: [u] }, sock.user && sock.user.id);
          const chosen = agg.filter(o => o.voters && o.voters.length).map(o => o.name);
          const k = u.pollUpdateMessageKey || {};
          recordVote(ev.key.id, k.participant || k.remoteJid || (ev.key.participant), chosen);
        }
      } catch (e) { log('poll vote error:', e.message); }
    }
  });
  return sock;
}
