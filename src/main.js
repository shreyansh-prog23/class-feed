import { cfg } from './config.js';
import { db } from './db.js';
import { seedAliases, seedSubjects, nameByCode, reroute } from './cards.js';
import { startServer } from './server.js';
import { releaseOldHeld } from './cards.js';
import { initPush, notifyChanges, reminderTick } from './push.js';
import { pollTick, setPollOnChange } from './polls.js';
import { setOnChange, flushAll, pendingCount, historyTick } from './reader.js';
import { aiReady } from './ai.js';
import { healthTick, backupTick } from './health.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

seedAliases();
seedSubjects();
try { const n = nameByCode(); if (n) log('Renamed ' + n + ' subjects to their course codes'); } catch (e) { log('rename failed:', e.message); }
try { const n = reroute(); if (n) log('Re-filed ' + n + ' cards under the class subjects'); } catch (e) { log('re-file failed:', e.message); }
await initPush();
setOnChange(out => notifyChanges(out).catch(e => log('push failed:', e.message)));
setPollOnChange(out => notifyChanges(out).catch(e => log('push failed:', e.message)));
const server = startServer();

if (!cfg.classCode) log('WARNING: CLASS_CODE is empty, so anyone with the link can read your class feed.');
if (!cfg.adminCode) log('Note: ADMIN_CODE is empty, so the CR controls are switched off.');
if (!aiReady()) log('WARNING: no AI key set (' + cfg.provider + '). Messages will wait until you add one.');

setInterval(() => { flushAll({ aged: true }); }, 5 * 60 * 1000);                       // retries, and anything left over after a restart
setInterval(() => { historyTick().catch(() => {}); }, 60 * 1000);       // old-chat import, only when nothing live is waiting
setInterval(() => { reminderTick().catch(e => log('reminders failed:', e.message)); }, 10 * 60 * 1000);
setInterval(() => { try { const r = releaseOldHeld(); if (r.length) { log(r.length + ' cards nobody checked went live'); notifyChanges({ added: r }).catch(() => {}); } } catch (e) { log('release failed:', e.message); } }, 10 * 60 * 1000);
setInterval(() => { pollTick().catch(e => log('polls failed:', e.message)); }, 5 * 60 * 1000);
setInterval(() => { healthTick().catch(e => log('health check failed:', e.message)); }, 5 * 60 * 1000);
setInterval(() => { try { backupTick(); } catch (e) { log('backup failed:', e.message); } }, 60 * 60 * 1000);
try { backupTick(); } catch (e) { log('backup failed:', e.message); }
if (pendingCount()) flushAll({ aged: true });

if (process.env.NO_LISTENER !== '1') {
  const { startListener } = await import('./listener.js');
  startListener().catch(e => log('listener failed to start:', e.message));
}
process.on('unhandledRejection', e => log('unhandled:', e && e.message));
process.on('uncaughtException', e => { log('crashed:', e && e.stack || e); process.exit(1); });   // the service restarts itself in 5 seconds
// A clean stop (restart, reboot): finish what is in flight and fold the database log in, so nothing is half-written.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  log('stopping');
  try { server.close(); } catch (e) { /* not listening */ }
  try { db.exec('pragma wal_checkpoint(truncate)'); } catch (e) { /* busy */ }
  setTimeout(() => process.exit(0), 300);
});
