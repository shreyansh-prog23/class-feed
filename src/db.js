// One small SQLite file holds everything. Node's built-in sqlite, so nothing extra to install.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cfg } from './config.js';

export const db = new DatabaseSync(path.join(cfg.dataDir, 'feed.db'));
db.exec(`
pragma journal_mode = wal;
pragma busy_timeout = 5000;
pragma synchronous = normal;
create table if not exists messages(
  id integer primary key,
  fp text unique,
  grp text, ms integer, sender text,
  kind text,            -- text | file | image | pdf
  text text, file_id text, file_name text, mime text,
  processed integer default 0,  -- 0 waiting, 1 done, 2 not useful, 3 gave up
  attempts integer default 0, why text
);
create index if not exists messages_pending on messages(processed, grp, ms);
create table if not exists cards(
  id text primary key, grp text, subject text, type text, title text,
  due text, time text, details text, body text,
  uncertain integer default 0, note text, pinned integer default 0,
  sources text, files text, history text, moved text,
  flags integer default 0, created integer, updated integer, deleted integer default 0
);
create index if not exists cards_updated on cards(updated);
create table if not exists files(
  id text primary key, name text, mime text, size integer, grp text, ms integer, sender text, hash text
);
create table if not exists subs(endpoint text primary key, json text, created integer);
create table if not exists notified(card text, kind text, at integer, primary key(card, kind));
create table if not exists usage(day text primary key, calls integer default 0);
create table if not exists people(id text primary key, name text, photo text, created integer, seen integer);
create table if not exists aliases(code text primary key, subject text);
create table if not exists kv(k text primary key, v text);
create table if not exists polls(id text primary key, grp text, ms integer, sender text, question text, options text, raw text, status integer default 0, tries integer default 0);
create table if not exists poll_votes(poll text, voter text, opts text, ms integer, primary key(poll, voter));
`);

// Added later for the chat-history import. Existing rows get 0, nothing is lost.
try { db.exec('alter table messages add column old integer default 0'); } catch (e) { /* already there */ }

try { db.exec('alter table messages add column force integer default 0'); } catch (e) { /* already there */ }

try { db.exec("alter table cards add column chg text default ''"); } catch (e) { /* already there */ }
try { db.exec('alter table subs add column admin integer default 0'); } catch (e) { /* already there */ }
try { db.exec('alter table subs add column pid text'); } catch (e) { /* already there */ }
try { db.exec('alter table people add column section text'); } catch (e) { /* already there */ }
try { db.exec('alter table cards add column section text'); } catch (e) { /* already there */ }
try { db.exec('alter table cards add column hold integer default 0'); } catch (e) { /* already there */ }

export const getKv = (k, d = null) => { const r = db.prepare('select v from kv where k=?').get(k); return r ? JSON.parse(r.v) : d; };
export const setKv = (k, v) => db.prepare('insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v').run(k, JSON.stringify(v));
