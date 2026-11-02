CREATE TABLE schema_migrations (version varchar(255) primary key);
CREATE TABLE chats (
  id text primary key,
  title text not null,
  at text not null,
  updated text not null
) strict, without rowid;
CREATE TABLE events (
  chat text not null references chats (id) on delete cascade,
  seq integer not null,
  event text not null,
  primary key (chat, seq)
) strict, without rowid;
CREATE TABLE access (
  id integer primary key check (id = 1),
  salt text not null,
  hash text not null
) strict;
CREATE TABLE app_rules (
  app text not null,
  kind text not null,
  permission text not null check (permission in ('allow', 'ask', 'deny')),
  primary key (app, kind)
) strict, without rowid;
CREATE TABLE browser_rules (
  action text primary key,
  permission text not null check (permission in ('allow', 'ask', 'deny'))
) strict, without rowid;
CREATE TABLE site_rules (
  site text primary key,
  never integer not null check (never in (0, 1)),
  visit text check (visit in ('allow', 'ask', 'deny')),
  submit text check (submit in ('allow', 'ask', 'deny')),
  download text check (download in ('allow', 'ask', 'deny')),
  upload text check (upload in ('allow', 'ask', 'deny'))
) strict, without rowid;
CREATE TABLE defaults_set (
  key text primary key
) strict, without rowid;
CREATE TABLE sent (
  id text primary key,
  by text not null check (by in ('user', 'muse')),
  attachment text not null
) strict, without rowid;
CREATE TABLE imported_files (
  name text primary key,
  bytes integer not null,
  sha256 text not null,
  imported_at text not null
) strict, without rowid;
CREATE TABLE vault_check (
  id integer primary key check (id = 1),
  sealed text not null
) strict;
CREATE TABLE secrets (
  id text primary key,
  name text not null,
  managed integer not null check (managed in (0, 1)),
  note text not null,
  created text not null
) strict, without rowid;
CREATE UNIQUE INDEX secrets_name on secrets (lower(name));
CREATE TABLE secret_plain (
  entry text not null references secrets (id) on delete cascade,
  position integer not null,
  name text not null,
  role text check (role is null or role = 'username'),
  kind text not null check (kind in ('text', 'file')),
  value text not null,
  filename text,
  primary key (entry, name)
) strict, without rowid;
CREATE TABLE secret_fields (
  entry text not null references secrets (id) on delete cascade,
  position integer not null,
  name text not null,
  role text check (role is null or role = 'password'),
  kind text not null check (kind in ('text', 'file')),
  filename text,
  size integer not null check (size >= 0),
  hint text,
  sealed text not null,
  last_at text,
  last_how text check (last_how is null or last_how in ('sandbox', 'server')),
  last_what text,
  primary key (entry, name)
) strict, without rowid;
CREATE TABLE secret_uses (
  id text primary key,
  entry text not null references secrets (id) on delete cascade,
  position integer not null,
  field text not null,
  kind text not null check (kind in ('env', 'file', 'server')),
  name text,
  path text,
  env text,
  service text,
  target text
) strict, without rowid;
CREATE TABLE secret_claims (
  claim text primary key,
  use text not null references secret_uses (id) on delete cascade
) strict, without rowid;
CREATE TABLE model_choice (
  id integer primary key check (id = 1),
  choice text not null
) strict;
CREATE TABLE imported_secret_files (
  name text primary key,
  sealed text not null
) strict, without rowid;
CREATE TABLE sandbox_cleanup (
  kind text not null check (kind in ('env', 'file')),
  target text not null,
  primary key (kind, target)
) strict, without rowid;
CREATE TABLE pin (
  id integer primary key check (id = 1),
  salt text,
  hash text,
  used text,
  later text,
  wrong integer not null default 0,
  lockouts integer not null default 0,
  locked text,
  minutes integer not null default 5 check (minutes in (1, 5, 15, 30)), off integer not null default 0 check (off in (0, 1)),
  check ((salt is null) = (hash is null))
) strict;
CREATE TABLE devices (
  id text primary key,
  digest text unique,
  agent text not null,
  address text not null,
  at text not null,
  seen text not null
) strict, without rowid;
CREATE TABLE sessions (
  position integer primary key autoincrement,
  digest text not null unique,
  device text not null references devices (id) on delete cascade
) strict;
CREATE INDEX sessions_device on sessions (device);
CREATE TABLE browser_sessions (
  id text primary key,
  node text not null,
  session text not null
) strict, without rowid;
CREATE TABLE announced_changes (
  hash text primary key
) strict, without rowid;

-- Dbmate schema migrations
INSERT INTO schema_migrations (version) VALUES
  ('20261023100000'),
  ('20261023100100'),
  ('20261023110000'),
  ('20261023110100'),
  ('20261023120000'),
  ('20261023234842'),
  ('20261024034628'),
  ('20261024120000'),
  ('20261101040750');
