import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applied, dataMigrations, loadMigrations, migrate, migratedDatabase, openDatabase, query, revert, tempFolder } from "@amuse/db";
import { z } from "zod";
import { resetDevices, sqliteAccess } from "./access.ts";

const phone = { agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", address: "100.64.0.7" };
const laptop = { agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0 Safari/537.36", address: "100.64.0.8" };

test("the right password signs any device in, with a cookie of its own; a wrong one opens nothing", async () => {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const first = await access.setup("correct horse", null, laptop);
  assert.ok(first.device, "a session, and the device's own cookie");
  assert.equal(access.valid(first.session), true);

  assert.equal(await access.login("wrong horse", null, phone), null);
  const second = await access.login("correct horse", null, phone);
  assert.ok(second?.device, "a new device is in at once, with its own cookie");
  assert.equal(access.valid(second.session), true);
  assert.deepEqual(
    access.devices().map((d) => ({ agent: d.agent, address: d.address })),
    [laptop, phone],
  );
  // signing in again on it is the same device, not a new one
  const again = await access.login("correct horse", second.device, phone);
  assert.ok(again && again.device === null && access.valid(again.session));
  assert.equal(access.devices().length, 2);
});

test("removing a device ends its sessions, and the password brings it back as a new one; locking keeps it", async () => {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const first = await access.setup("correct horse", null, laptop);
  assert.ok(first.device);
  access.logout(first.session);
  const back = await access.login("correct horse", first.device, laptop);
  assert.ok(back && back.device === null, "a locked device signs in again as itself");
  const mine = access.devices()[0]?.id ?? "";
  access.revoke(mine);
  assert.equal(access.valid(back.session), false);
  assert.deepEqual(access.devices(), []);
  const next = await access.login("correct horse", first.device, laptop);
  assert.ok(next?.device, "the old cookie is nobody's: a new device");
  assert.notEqual(access.devices()[0]?.id, mine);
  resetDevices(db);
  assert.deepEqual(access.devices(), []);
  assert.equal(access.valid(next.session), false);
});

test("a session from before devices were known gets its device's cookie once, and changing the password keeps the devices", async () => {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const first = await access.setup("correct horse", null, laptop);
  assert.deepEqual(access.deviceOf(first.session)?.cookie, null, "it has one already");
  // as the migration leaves a session that was open before
  db.exec("update devices set digest = null");
  const claimed = access.deviceOf(first.session);
  assert.ok(claimed?.cookie);
  assert.equal(access.deviceOf(first.session)?.cookie, null, "made once");
  assert.equal((await access.login("correct horse", claimed.cookie, laptop))?.device, null, "the cookie is that device's");

  const other = await access.login("correct horse", claimed.cookie, laptop);
  assert.ok(other);
  assert.equal(await access.change(first.session, "wrong horse", "battery staple"), null);
  const changed = await access.change(first.session, "correct horse", "battery staple");
  assert.ok(changed && access.valid(changed));
  assert.equal(access.valid(other.session), false, "every other session ends");
  assert.equal(access.devices().length, 1, "the device stays listed");
  assert.equal(await access.matches("battery staple"), true);
});

test("the migration that drops approval keeps the trusted devices and their sessions, and forgets the waiting ones; down undoes it", async () => {
  const dir = tempFolder("amuse-approval-migration-");
  const secretsDir = join(dir, "secret-key");
  mkdirSync(secretsDir, { mode: 0o700 });
  const db = openDatabase(join(dir, "amuse.db"));
  const known = await loadMigrations(dataMigrations);
  const context = { dataDir: dir, journal: join(dir, "events.jsonl"), secretsDir, log: () => {} };
  const version = "20261101040750";
  await migrate(db, known.filter((m) => m.version < version), { backups: join(dir, "backups"), context });
  // what an instance with approval held: a trusted device signed in, and one waiting
  db.exec(`insert into devices (id, digest, trusted, asked, agent, address, at, seen) values
    ('t', 'trusted-cookie', 1, null, 'laptop', '', '', ''),
    ('w', 'waiting-cookie', 0, '2026-11-01T09:00:00Z', 'phone', '', '', '');
    insert into sessions (digest, device) values ('s', 't')`);
  const before = [{ id: "t", digest: "trusted-cookie" }];
  const sessions = [{ digest: "s", device: "t" }];

  await migrate(db, known, { backups: join(dir, "backups"), context });
  assert.ok(applied(db).includes(version));
  assert.deepEqual(query(db, z.object({ id: z.string(), digest: z.string() }), "select id, digest from devices"), before, "the trusted device, as it was");
  assert.deepEqual(query(db, z.object({ digest: z.string(), device: z.string() }), "select digest, device from sessions"), sessions, "its session too");
  const columns = query(db, z.object({ name: z.string() }), "select name from pragma_table_info('devices')").map((c) => c.name);
  assert.deepEqual(columns.filter((c) => c === "trusted" || c === "asked"), []);
  assert.deepEqual(sqliteAccess(db).devices().map((d) => d.id), ["t"], "and listed in Settings");

  revert(db, known, context);
  const back = z.object({ trusted: z.number(), asked: z.string().nullable() });
  assert.deepEqual(query(db, back, "select trusted, asked from devices"), [{ trusted: 1, asked: null }], "every device kept is trusted again");
  db.close();
});
