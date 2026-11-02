/**
 * The data commands, run beside the server (in Docker: `docker compose exec amuse amuse-admin <command>`; in development: `node api/src/admin.ts <command>`), on the
 * data folder named by AMUSE_DATA (or AMUSE_JOURNAL's folder), or `--data <folder>`:
 *   migrate [--dry-run]   run the pending migrations now (as the server does at start), or say what they would do
 *   rollback --yes        undo the newest migration (it must have a way back), after a copy of the database; never applies pending ones
 *   retire-old-files      rename the old files (events.jsonl, access.json …) that are exactly what was imported, when a start refused for them
 *   export [chat]         the chat's journal as JSONL on stdout (the main chat by default): the format the old events.jsonl had
 *   chats                 the chats, with how many events each has
 *   reset-password        forget the master password and every session: the next visit sets a new one
 *   reset-pin             forget the PIN (a forgotten one) and sign every device out: the PIN is off until one is set
 *   reset-devices         forget every device (one lost, say): every session ends, and each is back with the password
 *   schema                write db/schema.sql from the migrations
 *   restore-secret-files --yes  write keys.json and sandbox-secrets.json back from their sealed copies in the database (to go back to an older Amuse, or to read them)
 *   forget-secret-files --yes   delete those sealed copies, once the Vault is known to hold everything
 *   reset-vault --yes     forget everything in the Vault (when its key is lost for good and nothing can be opened), so that a new key can be made
 */
import { existsSync, lstatSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, MEMORY, StartupError, applied, dataMigrations, describePending, dumpSchema, forgetSecretFiles, KEY_NAME, loadMigrations, migrate, openDatabase, openReadOnly, plan, refuseNewer, restoreSecretFiles, retireOldFiles, revert, snapshot, transaction } from "@amuse/db";
import { MAIN } from "@amuse/protocol";
import { z } from "zod";
import { resetDevices, resetPassword } from "./access.ts";
import { resetPin } from "./pin.ts";
import { type Location, locate, openData, openExisting } from "./data.ts";
import { explain } from "./startup.ts";
import { exported } from "./journal.ts";

const schemaFile = fileURLToPath(new URL("../../db/schema.sql", import.meta.url));

function usage(): never {
  console.error("usage: amuse-admin [--data <folder>] migrate [--dry-run] | rollback --yes | retire-old-files | export [chat] | chats | reset-password | reset-pin | reset-devices | schema | restore-secret-files --yes | forget-secret-files --yes | reset-vault --yes");
  return process.exit(2);
}

async function dryRun(where: Location): Promise<void> {
  const known = await loadMigrations(dataMigrations);
  // looked at and left exactly as it is: not made if it is not there, and no -wal or -shm made beside it if it is
  const db = existsSync(where.database) ? openReadOnly(where.database) : null;
  try {
    const found = plan(db ? applied(db) : [], known);
    refuseNewer(found, known);
    console.log(`${where.database}: ${db ? `${found.applied.length} migration${found.applied.length === 1 ? "" : "s"} applied` : "not there yet"}`);
    if (found.pending.length === 0) return void console.log("Nothing to run.");
    console.log(found.applied.length > 0 ? `A copy of the database is made in ${where.backups} first.` : "A new database: nothing to copy first.");
    for (const m of describePending(found, { dataDir: where.dir, journal: where.journal, secretsDir: where.secrets, log: console.log })) {
      console.log(`would run ${m.version}_${m.name} (${m.kind === "sql" ? "SQL" : "TypeScript"}):`);
      for (const touch of m.touches) console.log(`  ${touch}`);
    }
  } finally {
    db?.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const flag = args.indexOf("--data");
  const env = { ...process.env };
  if (flag !== -1) {
    const folder = args[flag + 1];
    if (!folder) usage();
    env["AMUSE_DATA"] = folder;
    delete env["AMUSE_JOURNAL"]; // the folder named is the one meant
    args.splice(flag, 2);
  }
  const [command, ...rest] = args;
  if (!command || !["migrate", "rollback", "retire-old-files", "export", "chats", "reset-password", "reset-pin", "reset-devices", "schema", "restore-secret-files", "forget-secret-files", "reset-vault"].includes(command)) usage();
  if (command === "schema") {
    // from the migrations alone, in a database that is only in memory
    const db = openDatabase(MEMORY);
    
    await migrate(db, await loadMigrations(dataMigrations), { backups: "", context: { dataDir: "", journal: "", secretsDir: "", log: () => {} } });
    writeFileSync(schemaFile, dumpSchema(db));
    return void console.log(`wrote ${schemaFile}`);
  }
  if (!env["AMUSE_DATA"] && !env["AMUSE_JOURNAL"]) {
    console.error("Say which data: --data <folder>, or AMUSE_DATA.");
    return process.exit(2);
  }
  const where = locate(env);
  if (command === "migrate" && rest.includes("--dry-run")) return dryRun(where);
  if (command === "migrate") {
    const db = await openData(where);
    db.close();
    return void console.log("The database is up to date.");
  }
  const context = { dataDir: where.dir, journal: where.journal, secretsDir: where.secrets, log: console.log };
  // the rest work on a database that is there as it is: nothing is made, checked or migrated
  const db: Db = await openExisting(where, { allowPending: command === "rollback" });
  try {
    switch (command) {
      case "rollback": {
        if (!rest.includes("--yes")) {
          console.error("rollback undoes the newest migration and can lose what it made. Run it again with --yes to go on; a copy of the database is made first.");
          return process.exit(2);
        }
        const known = await loadMigrations(dataMigrations);
        const newest = known.find((m) => m.version === applied(db).at(-1));
        if (newest && newest.down === null) throw new Error(`${newest.version}_${newest.name} has no way back (no migrate:down); nothing was changed.`);
        const copy = await snapshot(db, where.backups, "pre-rollback");
        console.log(`a copy of the database is ${copy}`);
        const undone = revert(db, known, context);
        return void console.log(undone ? `undid ${undone.version}_${undone.name}` : "Nothing to undo.");
      }
      case "retire-old-files": {
        const { renamed, kept } = retireOldFiles(db, context);
        for (const { name, to } of renamed) console.log(to === null ? `deleted ${name} (it held secrets in the open; the database has them sealed)` : `renamed ${name} to ${to}`);
        for (const name of kept) console.error(`kept ${name}: it is not what was imported (it differs, or was never imported); an older version may have written it`);
        if (renamed.length === 0 && kept.length === 0) console.log("There are no old files.");
        if (kept.length > 0) {
          console.error("What the kept files hold has not been taken in, and Amuse will not start beside them. To set them aside, move them into a folder of their own (for example `mkdir ../newer-files && mv <the files> ../newer-files/` from the data folder), then start Amuse; what they hold stays there, untaken.");
          return process.exit(1);
        }
        return;
      }
      case "export": {
        const chat = rest[0] ?? MAIN;
        for (const line of exported(db, chat)) process.stdout.write(line);
        return;
      }
      case "chats": {
        const rows = db.prepare("select id, title, (select count(*) from events where chat = chats.id) as events from chats order by at, id").all();
        for (const row of rows.map((r) => z.object({ id: z.string(), title: z.string(), events: z.number() }).parse(r))) console.log(`${row.id}\t${row.events} events\t${row.title}`);
        return;
      }
      case "restore-secret-files": {
        if (!rest.includes("--yes")) {
          console.error(
            "restore-secret-files writes keys.json and sandbox-secrets.json, which hold your secrets in the open, back into the data folder. Amuse will not start again until they are removed (it refuses to run beside them): use it to go back to an older Amuse, or to read them, and delete them when you are done. Run it again with --yes to go on.",
          );
          return process.exit(2);
        }
        const { written, there } = restoreSecretFiles(db, context);
        for (const name of written) console.log(`wrote ${name}, as it was when the Vault took it in (it holds secrets in the open: delete it when you are done)`);
        if (written.length > 0) console.log("The next start of this version will refuse, saying old files are beside the database, until they are removed (amuse-admin retire-old-files deletes them)."); 
        for (const name of there) console.error(`kept ${name}: there is a file by that name already`);
        if (written.length === 0 && there.length === 0) console.log("There are no sealed copies.");
        return;
      }
      case "forget-secret-files": {
        if (!rest.includes("--yes")) {
          console.error("forget-secret-files deletes the sealed copies of keys.json and sandbox-secrets.json kept in the database: after it, they cannot be restored. Run it again with --yes to go on.");
          return process.exit(2);
        }
        return void console.log(`${forgetSecretFiles(db)} sealed copies deleted.`);
      }
      case "reset-vault": {
        if (!rest.includes("--yes")) {
          console.error("reset-vault forgets every entry in the Vault (and the sealed copies of the old files), with no way back. Use it only when the Vault's key is lost for good. Run it again with --yes to go on; a copy of the database is made first.");
          return process.exit(2);
        }
        console.log(`a copy of the database is ${await snapshot(db, where.backups, "pre-reset-vault")}`);
        // a key file that is not a key (cut short, or not 32 bytes) is moved aside, not deleted: a new key is then made, and the old one is there to look at
        const key = join(where.secrets, KEY_NAME);
        if (existsSync(key) && !(lstatSync(key).isFile() && statSync(key).size === 32)) {
          const aside = `${key}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          renameSync(key, aside);
          console.log(`the Vault's key file was not a key, so it was moved aside as ${aside}; a new key is made when Amuse starts`);
        }
        transaction(db, () => db.exec("delete from secrets; delete from vault_check; delete from imported_secret_files"));
        return void console.log("The Vault is empty. Start Amuse: a new key is made if there is none, and you add your keys and secrets again.");
      }
      case "reset-password":
        resetPassword(db);
        return void console.log("The password is forgotten. The next visit sets a new one.");
      case "reset-pin":
        resetPin(db);
        return void console.log("The PIN is forgotten, and every device is signed out. Sign in with the password: the PIN is off until you set one in Settings › Security.");
      case "reset-devices":
        resetDevices(db);
        return void console.log("Every device is forgotten and signed out. Sign in again with the password.");
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof StartupError) console.error(`${explain(error.problem, "en").what}\n${explain(error.problem, "en").todo}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
