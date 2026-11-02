import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dataMigrations } from "./data.ts";
import { applied, describePending, migrate, plan } from "./migrate.ts";
import { type Context, loadMigrations } from "./migrations.ts";
import { MEMORY, openDatabase, openReadOnly, query } from "./open.ts";
import { oldFilesBeside, retireOldFiles } from "./legacy/old-files.ts";
import { preflight } from "./preflight.ts";
import { StartupError } from "./problem.ts";
import { dumpSchema } from "./schema.ts";
import { migratedDatabase, tempFolder } from "./testing.ts";

const folder = () => tempFolder("amuse-state-");
const count = z.object({ n: z.number() });
const context = (dir: string, said: string[] = []): Omit<Context, "db"> => ({ dataDir: dir, journal: join(dir, "events.jsonl"), secretsDir: join(dir, "secret-key"), log: (m) => void said.push(m) });
const event = (seq: number) => JSON.stringify({ seq, event: { kind: "activity", activity: null } });
const journal = (n: number) => Array.from({ length: n }, (_, i) => `${event(i + 1)}\n`).join("");
const chat = (id: string) => ({ id, title: id === "main" ? "" : "Side", at: "2026-10-22T10:00:00.000Z", updated: "2026-10-22T11:00:00.000Z" });
const start = async (dir: string, said: string[] = []) => {
  const db = openDatabase(join(dir, "amuse.db"));
  const report = await migrate(db, await loadMigrations(dataMigrations), { backups: join(dir, "backups"), context: context(dir, said) });
  return { db, report };
};

test("the database is opened the one way: WAL, foreign keys, a wait for locks, every commit on disk, owner only", () => {
  const dir = folder();
  const file = join(dir, "x", "amuse.db");
  const db = openDatabase(file);
  const pragma = (name: string) => Object.values(db.prepare(`pragma ${name}`).get() ?? {})[0];
  assert.equal(pragma("journal_mode"), "wal");
  assert.equal(pragma("foreign_keys"), 1);
  assert.equal(pragma("busy_timeout"), 5000);
  assert.equal(pragma("synchronous"), 2, "full");
  db.exec("create table t (x); insert into t values (1)");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "x")).mode & 0o777, 0o700);
  db.close();
  // a file left wider by something else is put right
  chmodSync(file, 0o644);
  openDatabase(file).close();
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("the preflight makes the folders it may, and says in values what is wrong with the rest", () => {
  const dir = folder();
  preflight([{ folder: "data", path: join(dir, "a", "b"), create: true, hint: "data-volume" }]);
  assert.ok(statSync(join(dir, "a", "b")).isDirectory());
  const problem = (requirements: Parameters<typeof preflight>[0]) => {
    try {
      preflight(requirements);
    } catch (error) {
      return error instanceof StartupError ? error.problem : error;
    }
    return null;
  };
  assert.deepEqual(problem([{ folder: "workspace", path: join(dir, "missing"), create: false, hint: "compose-up" }]), { kind: "folder", folder: "workspace", path: join(dir, "missing"), trouble: "missing", hint: "compose-up" });
  writeFileSync(join(dir, "file"), "");
  assert.deepEqual(problem([{ folder: "data", path: join(dir, "file"), create: true, hint: "data-volume" }]), { kind: "folder", folder: "data", path: join(dir, "file"), trouble: "not-a-folder", hint: "data-volume" });
  if (process.getuid?.() !== 0) {
    mkdirSync(join(dir, "locked"));
    chmodSync(join(dir, "locked"), 0o500);
    assert.deepEqual(problem([{ folder: "backups", path: join(dir, "locked"), create: true, hint: "compose-up" }]), { kind: "folder", folder: "backups", path: join(dir, "locked"), trouble: "not-writable", hint: "compose-up" });
    assert.deepEqual(problem([{ folder: "backups", path: join(dir, "locked", "inside"), create: true, hint: "compose-up" }]), { kind: "folder", folder: "backups", path: join(dir, "locked", "inside"), trouble: "not-writable", hint: "compose-up" });
    chmodSync(join(dir, "locked"), 0o700);
  }
});

test("db/schema.sql is what the migrations leave, in dbmate's shape, and loads on its own", async () => {
  const file = fileURLToPath(new URL("../schema.sql", import.meta.url));
  const written = readFileSync(file, "utf8");
  const migrated = await migratedDatabase();
  assert.equal(dumpSchema(migrated), written, "run `amuse-admin schema` (in development: `node api/src/admin.ts schema`) to write it again");
  const loaded = openDatabase(MEMORY);
  loaded.exec(written);
  assert.equal(dumpSchema(loaded), written);
  assert.deepEqual(applied(loaded), (await loadMigrations(dataMigrations)).map((m) => m.version));
  assert.match(written, /-- Dbmate schema migrations\nINSERT INTO schema_migrations \(version\) VALUES\n/);
});

test("every SQL migration's down undoes its up", async () => {
  const db = await migratedDatabase();
  const known = await loadMigrations(dataMigrations);
  for (const m of known.filter((k) => k.kind === "sql").reverse()) {
    assert.ok(m.kind === "sql" && m.down, `${m.version}_${m.name} has a down`);
    db.exec(m.down);
  }
  assert.deepEqual(query(db, z.object({ name: z.string() }), "select name from sqlite_master where name not like 'sqlite_%' and name != 'schema_migrations'"), []);
});

test("a new instance: no old files, and a main chat to write to at once", async () => {
  const dir = folder();
  const { db, report } = await start(dir);
  assert.equal(report.backup, null);
  assert.deepEqual(query(db, z.object({ id: z.string() }), "select id from chats").map((c) => c.id), ["main"]);
  assert.throws(() => db.prepare("insert into events (chat, seq, event) values ('nobody', 1, '{}')").run(), /FOREIGN KEY/);
  const pending = describePending(plan([], await loadMigrations(dataMigrations)), context(dir));
  assert.deepEqual(pending.find((m) => m.name === "import_json")?.touches, ["no old files to import: a new instance"]);
  assert.deepEqual(pending.find((m) => m.name === "import_secrets")?.touches, ["no old keys, model choice or sandbox credentials to import"]);
});

test("the old files are imported, renamed to .bak and not deleted, and a second start does not import again", async () => {
  const dir = folder();
  mkdirSync(join(dir, "chats"));
  writeFileSync(join(dir, "events.jsonl"), journal(5));
  writeFileSync(join(dir, "chats", "c-1.jsonl"), journal(3));
  writeFileSync(join(dir, "chats.json"), JSON.stringify([chat("main"), chat("c-1")]));
  writeFileSync(join(dir, "defaults.json"), JSON.stringify({ set: ["memory"] }));
  const said: string[] = [];
  const first = await start(dir, said);
  const events = (id: string) => query(first.db, count, "select count(*) as n from events where chat = ?", id)[0]?.n;
  assert.deepEqual([events("main"), events("c-1")], [5, 3]);
  assert.deepEqual(query(first.db, z.object({ title: z.string() }), "select title from chats where id = 'c-1'"), [{ title: "Side" }]);
  assert.deepEqual(readdirSync(dir).sort(), ["amuse.db", "amuse.db-shm", "amuse.db-wal", "chats", "chats.json.bak", "defaults.json.bak", "events.jsonl.bak"].sort());
  assert.deepEqual(readdirSync(join(dir, "chats")), ["c-1.jsonl.bak"]);
  assert.equal(readFileSync(join(dir, "events.jsonl.bak"), "utf8"), journal(5));
  assert.ok(said.some((m) => /Imported the old files: 8 events in 2 chats/.test(m)));
  assert.equal(query(first.db, count, "select count(*) as n from imported_files")[0]?.n, 4);
  first.db.close();

  // even with the old files put back (a restore, a mistake), the next start does not take them in again
  renameSync(join(dir, "events.jsonl.bak"), join(dir, "events.jsonl"));
  const second = await start(dir);
  assert.equal(second.report.ran.length, 0);
  assert.equal(query(second.db, count, "select count(*) as n from events where chat = 'main'")[0]?.n, 5);
});

test("a torn last write is left out of the import, and stays in the kept file", async () => {
  const dir = folder();
  writeFileSync(join(dir, "events.jsonl"), `${journal(2)}{"seq":`);
  const said: string[] = [];
  const { db } = await start(dir, said);
  assert.equal(query(db, count, "select count(*) as n from events")[0]?.n, 2);
  assert.equal(readFileSync(join(dir, "events.jsonl.bak"), "utf8"), `${journal(2)}{"seq":`);
  assert.ok(said.some((m) => /last 7 bytes were a write cut short/.test(m)));
});

test("an import that fails is rolled back whole; the files are as they were, nothing is renamed, and it is tried again once they are right", async () => {
  const dir = folder();
  mkdirSync(join(dir, "chats"));
  writeFileSync(join(dir, "events.jsonl"), journal(4));
  writeFileSync(join(dir, "chats.json"), JSON.stringify([chat("main"), chat("c-1")]));
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ apps: { gmail: { write: "ask" } }, browser: {}, sites: {} }));
  const broken = `${journal(2)}{"seq":3,"event":{"kind":"renamed"}}\n`;
  writeFileSync(join(dir, "chats", "c-1.jsonl"), broken); // the last file read: the main chat's rows are already in when it fails
  const before = readdirSync(dir).sort();
  const db = openDatabase(join(dir, "amuse.db"));
  const known = await loadMigrations(dataMigrations);
  await assert.rejects(migrate(db, known, { backups: join(dir, "backups"), context: context(dir) }), (error) => {
    assert.ok(error instanceof StartupError && error.problem.kind === "migration-failed");
    assert.match(error.message, /c-1\.jsonl: line 3 is not the next event/);
    return true;
  });
  assert.deepEqual(readdirSync(dir).filter((n) => n !== "amuse.db" && !n.startsWith("amuse.db-")).sort(), before.filter((n) => n !== "amuse.db"));
  assert.equal(readFileSync(join(dir, "chats", "c-1.jsonl"), "utf8"), broken);
  assert.equal(query(db, count, "select count(*) as n from events")[0]?.n, 0, "none of the main chat's rows stayed");
  assert.equal(query(db, count, "select count(*) as n from app_rules")[0]?.n, 0);
  assert.deepEqual(applied(db), ["20261023100000"], "the schema step was whole and stays; the import is not recorded");

  writeFileSync(join(dir, "chats", "c-1.jsonl"), journal(3));
  const again = await migrate(db, known, { backups: join(dir, "backups"), context: context(dir) });
  assert.deepEqual(again.ran.map((m) => m.name), ["import_json", "vault", "import_secrets", "account_security", "browser_sessions", "announced_changes", "optional_pin", "no_device_approval"]);
  assert.ok(again.backup && existsSync(again.backup), "a copy is made, as the database now has a step applied");
  assert.equal(query(db, count, "select count(*) as n from events")[0]?.n, 7);
  assert.equal(query(db, count, "select count(*) as n from app_rules")[0]?.n, 1);
});

test("a journal it cannot read stops the import, with the line, and the history is not cut to fit", async () => {
  const dir = folder();
  writeFileSync(join(dir, "events.jsonl"), `${journal(2)}${event(4)}\n`); // a gap
  await assert.rejects(start(dir), /events\.jsonl: line 3 is not the next event/);
  writeFileSync(join(dir, "events.jsonl"), "not json\n");
  await assert.rejects(start(dir), /line 1 is not the next event/);
  assert.ok(existsSync(join(dir, "events.jsonl")));
});

test("an earlier .bak is never written over; an orphan side-chat journal is left where it is", async () => {
  const dir = folder();
  mkdirSync(join(dir, "chats"));
  writeFileSync(join(dir, "events.jsonl.bak"), "an earlier import");
  writeFileSync(join(dir, "events.jsonl"), journal(1));
  writeFileSync(join(dir, "chats", "gone.jsonl"), journal(2));
  await start(dir);
  assert.equal(readFileSync(join(dir, "events.jsonl.bak"), "utf8"), "an earlier import");
  assert.equal(readFileSync(join(dir, "events.jsonl.bak.2"), "utf8"), journal(1));
  assert.ok(existsSync(join(dir, "chats", "gone.jsonl")));
});

test("the old files are kept as they were written: unknown fields stay, and so does the text of each event", async () => {
  const dir = folder();
  const lines = [
    '{"seq":1,"event":{"kind":"activity","activity":null,"fromTheFuture":{"a":[1,2,{"b":null}]}}}',
    '{"seq": 2, "event": {"kind": "activity", "activity": null}}',
    '{"seq":3,"event":{"kind":"appended","id":"r-1","text":"caf\\u00e9 \\ud83d\\ude00"}}',
  ];
  writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
  const { db } = await start(dir);
  const stored = query(db, z.object({ event: z.string() }), "select event from events order by seq").map((r) => r.event);
  assert.equal(stored[0], '{"kind":"activity","activity":null,"fromTheFuture":{"a":[1,2,{"b":null}]}}', "as written, nothing dropped");
  assert.equal(stored[1], '{"kind":"activity","activity":null}', "a line of another shape: the event, written again");
  assert.equal(stored[2], '{"kind":"appended","id":"r-1","text":"caf\\u00e9 \\ud83d\\ude00"}', "escapes as they were");
});

test("migration 1 reads the old files as they were at 0.1.0: it imports no live schema, and nothing of core or the protocol", () => {
  const sources = [fileURLToPath(new URL("../migrations/20261023100100_import_json.ts", import.meta.url)), ...readdirSync(fileURLToPath(new URL("./legacy/", import.meta.url)), { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".ts") && !f.name.endsWith(".test.ts")).map((f) => join(f.parentPath, f.name))];
  assert.ok(sources.length >= 5);
  for (const source of sources) assert.doesNotMatch(readFileSync(source, "utf8"), /from "@amuse\//, source);
});

test("an old file that is a lone line of garbage or an event of no known kind stops the import", async () => {
  const dir = folder();
  writeFileSync(join(dir, "events.jsonl"), `${event(1)}\n{"seq":2,"event":{"kind":"renamed"}}\n`);
  await assert.rejects(start(dir), /line 2 is not the next event/);
});

test("old files beside a database that has taken them in are found; they are renamed only if they are exactly what was taken in", async () => {
  const dir = folder();
  mkdirSync(join(dir, "chats"));
  writeFileSync(join(dir, "events.jsonl"), journal(2));
  writeFileSync(join(dir, "chats.json"), JSON.stringify([chat("main"), chat("c-1")]));
  writeFileSync(join(dir, "chats", "c-1.jsonl"), journal(1));
  writeFileSync(join(dir, "chats", "orphan.jsonl"), journal(1));
  writeFileSync(join(dir, "access.json"), JSON.stringify({ password: { salt: "00", hash: "00" }, sessions: [] }));
  const { db } = await start(dir);
  const ctx = context(dir);
  assert.deepEqual(oldFilesBeside(db, ctx), [], "a finished import leaves none (the orphan is not one of the chats)");

  // a crash between the commit and the rename: the files are back as they were
  for (const name of ["events.jsonl", "chats.json", "access.json"]) renameSync(join(dir, `${name}.bak`), join(dir, name));
  renameSync(join(dir, "chats", "c-1.jsonl.bak"), join(dir, "chats", "c-1.jsonl"));
  assert.deepEqual(oldFilesBeside(db, ctx).sort(), ["access.json", "chats.json", "chats/c-1.jsonl", "events.jsonl"]);
  // an older version ran and wrote another password, and a file the import never saw
  writeFileSync(join(dir, "access.json"), JSON.stringify({ password: { salt: "11", hash: "11" }, sessions: [] }));
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ apps: {}, browser: {}, sites: {} }));
  const result = retireOldFiles(db, ctx);
  assert.deepEqual(result.renamed.map((r) => r.name).sort(), ["chats.json", "chats/c-1.jsonl", "events.jsonl"]);
  assert.ok(result.renamed.every((r) => r.to !== null && r.to.startsWith(r.name) && r.to.includes(".bak")));
  assert.deepEqual(result.kept.sort(), ["access.json", "rules.json"], "what differs, or was never imported, is not touched");
  assert.equal(readFileSync(join(dir, "access.json"), "utf8"), JSON.stringify({ password: { salt: "11", hash: "11" }, sessions: [] }));
  assert.ok(existsSync(join(dir, "events.jsonl.bak.2")) || existsSync(join(dir, "events.jsonl.bak")));
});

test("the dry run takes the side chats chats.json lists, and says it leaves the others", async () => {
  const dir = folder();
  mkdirSync(join(dir, "chats"));
  writeFileSync(join(dir, "chats.json"), JSON.stringify([chat("main"), chat("c-1")]));
  writeFileSync(join(dir, "chats", "c-1.jsonl"), journal(1));
  writeFileSync(join(dir, "chats", "gone.jsonl"), journal(1));
  const touches = describePending(plan([], await loadMigrations(dataMigrations)), context(dir)).find((m) => m.name === "import_json")?.touches ?? [];
  assert.ok(touches.some((t) => t.startsWith("import chats/c-1.jsonl")));
  assert.ok(touches.includes("leave chats/gone.jsonl where it is (it is not a chat in chats.json)"));
  assert.ok(!touches.some((t) => t.startsWith("import chats/gone.jsonl")));
});

test("looking at a database leaves it exactly as it is: no -wal or -shm made, and the server's writes are seen when it runs", async () => {
  const dir = folder();
  const { db } = await start(dir);
  db.close();
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("amuse.db")), ["amuse.db"]);
  const look = openReadOnly(join(dir, "amuse.db"));
  assert.deepEqual(applied(look), (await loadMigrations(dataMigrations)).map((m) => m.version));
  look.close();
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("amuse.db")), ["amuse.db"], "nothing made by looking");
  // a running server: its -wal is there, and what it has written is seen
  const running = openDatabase(join(dir, "amuse.db"));
  running.exec("insert into defaults_set (key) values ('memory')");
  const beside = openReadOnly(join(dir, "amuse.db"));
  assert.equal(query(beside, z.object({ n: z.number() }), "select count(*) as n from defaults_set")[0]?.n, 1);
});
