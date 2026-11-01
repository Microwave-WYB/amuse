import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applied, dataMigrations, loadMigrations, migrate, migratedDatabase, openDatabase, query, revert, tempFolder } from "@amuse/db";
import { z } from "zod";
import { LATER_MS, LOCKOUT_MS, PinRejected, PinRequired, REMIND_MS, TRIES, UNLOCK_CAP_MS, resetPin, sqlitePin, unlocks } from "./pin.ts";

const MINUTE = 60_000;
/** a clock the test moves */
function clock(start = Date.parse("2026-11-01T09:00:00Z")) {
  let at = start;
  return { now: () => at, pass: (ms: number) => void (at += ms) };
}
const Row = z.object({ salt: z.string().nullable(), hash: z.string().nullable() });

test("the PIN is kept as a slow hash only, six digits, and checked against it", async () => {
  const db = await migratedDatabase();
  const pin = sqlitePin(db);
  assert.equal(pin.isSet(), false);
  for (const bad of ["12345", "1234567", "12345a", "١٢٣٤٥٦", ""]) await assert.rejects(pin.set(bad), PinRejected, bad);
  await pin.set("204816");
  assert.equal(pin.isSet(), true);
  const [row] = query(db, Row, "select salt, hash from pin");
  assert.ok(row?.salt && row.hash);
  assert.equal(row.hash.length, 128, "scrypt's 64 bytes");
  assert.ok(!JSON.stringify(row).includes("204816"), "never the PIN itself");
  assert.deepEqual(await pin.check("204816"), { kind: "right" });
  assert.deepEqual(await pin.check("204817"), { kind: "wrong", left: 4 });
  // a new PIN has a new salt
  await pin.set("204816");
  assert.notEqual(query(db, Row, "select salt, hash from pin")[0]?.salt, row.salt);
});

test("five wrong tries lock the PIN for 15 minutes, then each lockout is twice the one before; a right try starts over", async () => {
  const db = await migratedDatabase();
  const time = clock();
  const pin = sqlitePin(db, { now: time.now });
  await pin.set("111111");
  const wrongFive = async () => {
    for (let left = 4; left > 0; left--) assert.deepEqual(await pin.check("999999"), { kind: "wrong", left });
    return pin.check("999999");
  };
  const first = await wrongFive();
  assert.deepEqual(first, { kind: "locked", until: new Date(time.now() + LOCKOUT_MS).toISOString() });
  // locked: even the right PIN waits, and is not even tried
  assert.equal((await pin.check("111111")).kind, "locked");
  assert.equal(pin.locked(), new Date(time.now() + LOCKOUT_MS).toISOString());
  time.pass(LOCKOUT_MS);
  assert.equal(pin.locked(), null);
  assert.deepEqual(await wrongFive(), { kind: "locked", until: new Date(time.now() + 2 * LOCKOUT_MS).toISOString() }, "30 minutes");
  time.pass(2 * LOCKOUT_MS);
  assert.deepEqual(await wrongFive(), { kind: "locked", until: new Date(time.now() + 4 * LOCKOUT_MS).toISOString() }, "an hour");
  // the count is the database's: another reader (a restart) sees the same lockout
  assert.equal(sqlitePin(db, { now: time.now }).locked(), pin.locked());
  time.pass(4 * LOCKOUT_MS);
  assert.deepEqual(await pin.check("111111"), { kind: "right" });
  assert.deepEqual(await wrongFive(), { kind: "locked", until: new Date(time.now() + LOCKOUT_MS).toISOString() }, "back to 15 minutes");
});

test("wrong tries made at once still lock after five", async () => {
  const db = await migratedDatabase();
  const pin = sqlitePin(db);
  await pin.set("111111");
  const tried = await Promise.all(Array.from({ length: 8 }, () => pin.check("000000")));
  assert.deepEqual(tried.map((t) => t.kind), ["wrong", "wrong", "wrong", "wrong", "locked", "locked", "locked", "locked"]);
});

test("an unlock lasts the chosen minutes after the last sensitive action, 30 minutes at most, for its session only", async () => {
  const db = await migratedDatabase();
  const time = clock();
  const pin = sqlitePin(db, { now: time.now });
  const open = new Set(["mine", "other"]);
  const gate = unlocks(pin, (session) => open.has(session), { now: time.now });
  assert.throws(() => gate.require("mine"), (e) => e instanceof PinRequired && e.need === "unset", "no PIN yet");
  await pin.set("135791");
  assert.throws(() => gate.require("mine"), (e) => e instanceof PinRequired && e.need === "locked");
  gate.open("mine");
  gate.require("mine");
  assert.throws(() => gate.require("other"), PinRequired, "per session");
  // sliding: each action keeps it open five minutes more
  for (let i = 0; i < 5; i++) {
    time.pass(4 * MINUTE);
    gate.require("mine");
  }
  assert.equal(gate.until("mine"), new Date(time.now() + 5 * MINUTE).toISOString());
  time.pass(4 * MINUTE);
  gate.require("mine"); // 24 minutes in
  time.pass(4 * MINUTE);
  gate.require("mine");
  // but never past 30 minutes from when the PIN was entered
  assert.equal(gate.until("mine"), new Date(time.now() - 28 * MINUTE + UNLOCK_CAP_MS).toISOString());
  time.pass(2 * MINUTE);
  assert.throws(() => gate.require("mine"), PinRequired, "30 minutes");
  // five idle minutes lock it
  gate.open("mine");
  time.pass(5 * MINUTE);
  assert.throws(() => gate.require("mine"), PinRequired);
  // another length
  pin.setMinutes(1);
  gate.open("mine");
  time.pass(MINUTE - 1);
  gate.require("mine");
  time.pass(MINUTE);
  assert.throws(() => gate.require("mine"), PinRequired);
  assert.throws(() => pin.setMinutes(10), PinRejected);
  // "Lock now", and an ended session
  pin.setMinutes(5);
  gate.open("mine");
  gate.lock("mine");
  assert.throws(() => gate.require("mine"), PinRequired);
  gate.open("other");
  open.delete("other");
  assert.throws(() => gate.require("other"), PinRequired, "its session ended");
  assert.equal(gate.until("other"), null);
});

test("reminders: set a PIN when there is none; enter it after 7 days without; Later puts either off a day; entering it anywhere restarts the week", async () => {
  const db = await migratedDatabase();
  const time = clock();
  const pin = sqlitePin(db, { now: time.now });
  assert.equal(pin.reminder(), "set");
  pin.later();
  assert.equal(pin.reminder(), null);
  assert.equal(sqlitePin(db, { now: time.now }).reminder(), null, "kept in the database, for every device");
  time.pass(LATER_MS);
  assert.equal(pin.reminder(), "set");
  await pin.set("246802");
  assert.equal(pin.reminder(), null);
  time.pass(REMIND_MS - MINUTE);
  assert.equal(pin.reminder(), null);
  time.pass(MINUTE);
  assert.equal(pin.reminder(), "confirm");
  pin.later();
  assert.equal(pin.reminder(), null);
  time.pass(LATER_MS);
  assert.equal(pin.reminder(), "confirm");
  // a wrong try does not count as remembering it
  await pin.check("000000");
  assert.equal(pin.reminder(), "confirm");
  await pin.check("246802");
  assert.equal(pin.reminder(), null);
  time.pass(REMIND_MS);
  assert.equal(pin.reminder(), "confirm");
});

test("the PIN can be turned off: the gate asks nothing and there are no reminders until one is set again", async () => {
  const db = await migratedDatabase();
  const time = clock();
  const pin = sqlitePin(db, { now: time.now });
  const gate = unlocks(pin, () => true, { now: time.now });
  await pin.set("246810");
  assert.equal(pin.off(), false);
  assert.throws(() => gate.require("mine"), PinRequired, "a PIN is set: it has to be entered");
  // off: what it had is forgotten, and every session is unlocked, locked or not
  pin.turnOff();
  assert.equal(pin.isSet(), false);
  assert.equal(pin.off(), true);
  assert.equal(pin.reminder(), null, "no reminder to set one");
  assert.equal(query(db, Row, "select salt, hash from pin")[0]?.hash, null, "the hash goes with it");
  gate.lock("mine");
  gate.require("mine");
  gate.require("another device");
  assert.equal(gate.until("mine"), null, "nothing to count as unlocked");
  assert.deepEqual(await pin.check("246810"), { kind: "wrong", left: TRIES }, "nothing is there to try");
  time.pass(REMIND_MS * 2);
  assert.equal(pin.reminder(), null, "still none, however long it is off");
  // setting one again turns it on, and the gate holds from scratch
  await pin.set("112233");
  assert.equal(pin.off(), false);
  assert.equal(pin.isSet(), true);
  assert.throws(() => gate.require("mine"), (e) => e instanceof PinRequired && e.need === "locked");
  gate.open("mine");
  gate.require("mine");
  time.pass(REMIND_MS);
  assert.equal(pin.reminder(), "confirm", "the week without one is counted again");
});

test("resetting the PIN forgets it and its lockout, and signs every device out", async () => {
  const db = await migratedDatabase();
  const pin = sqlitePin(db);
  await pin.set("112233");
  for (let i = 0; i < 5; i++) await pin.check("000000");
  db.exec("insert into devices (id, digest, agent, address, at, seen) values ('d', 'x', '', '', '', '')");
  db.exec("insert into sessions (digest, device) values ('s', 'd')");
  resetPin(db);
  assert.equal(pin.isSet(), false);
  assert.equal(pin.locked(), null);
  assert.equal(pin.off(), true, "it is off until one is set");
  assert.equal(pin.reminder(), null);
  assert.equal(query(db, z.object({ n: z.number() }), "select count(*) as n from sessions")[0]?.n, 0);
  assert.equal(query(db, z.object({ n: z.number() }), "select count(*) as n from devices")[0]?.n, 1, "the device stays listed");
});

test("the migration makes the PIN's row with no PIN, and every session from before a device of its own; down undoes it", async () => {
  const dir = tempFolder("amuse-pin-migration-");
  const secretsDir = join(dir, "secret-key");
  mkdirSync(secretsDir, { mode: 0o700 });
  const db = openDatabase(join(dir, "amuse.db"));
  const known = await loadMigrations(dataMigrations);
  const context = { dataDir: dir, journal: join(dir, "events.jsonl"), secretsDir, log: () => {} };
  const before = known.filter((m) => m.version < "20261023120000");
  await migrate(db, before, { backups: join(dir, "backups"), context });
  db.exec("insert into sessions (digest) values ('one'), ('two')");
  await migrate(db, known, { backups: join(dir, "backups"), context });
  assert.ok(applied(db).includes("20261023120000"));
  assert.equal(sqlitePin(db).isSet(), false);
  const Session = z.object({ digest: z.string(), device: z.string(), cookie: z.string().nullable() });
  const rows = query(db, Session, "select s.digest, s.device, d.digest as cookie from sessions s join devices d on d.id = s.device order by s.position");
  assert.deepEqual(rows, [
    { digest: "one", device: "before-1", cookie: null },
    { digest: "two", device: "before-2", cookie: null },
  ]);
  // a device goes with its sessions
  db.exec("delete from devices where id = 'before-1'");
  assert.deepEqual(query(db, z.object({ digest: z.string() }), "select digest from sessions").map((r) => r.digest), ["two"]);
  // the PIN's is not the newest: what came after it is undone first, then the PIN and the devices
  while (applied(db).at(-1) !== "20261023120000") revert(db, known, context);
  revert(db, known, context);
  assert.deepEqual(query(db, z.object({ digest: z.string() }), "select digest from sessions").map((r) => r.digest), ["two"], "sessions are kept");
  assert.equal(query(db, z.object({ n: z.number() }), "select count(*) as n from sqlite_master where name in ('pin', 'devices')")[0]?.n, 0);
  db.close();
});
