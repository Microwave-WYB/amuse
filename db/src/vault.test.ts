import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { dataMigrations } from "./data.ts";
import { migrate } from "./migrate.ts";
import { type Context, loadMigrations } from "./migrations.ts";
import { openDatabase, query } from "./open.ts";
import { StartupError } from "./problem.ts";
import { KEY_NAME, forgetSecretFiles, open, restoreSecretFiles } from "./legacy/vault.ts";
import { retireOldFiles } from "./legacy/old-files.ts";

const count = z.object({ n: z.number() });

/** A data folder with the Vault's key folder beside it, as the start makes them. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "amuse-vault-"));
  const secretsDir = join(dir, "secret-key");
  mkdirSync(secretsDir, { mode: 0o700 });
  return { dir, secretsDir };
}

const context = (dir: string, secretsDir: string, said: string[] = []): Omit<Context, "db"> => ({ dataDir: dir, journal: join(dir, "events.jsonl"), secretsDir, log: (m) => void said.push(m) });

async function start(dir: string, secretsDir: string, said: string[] = []) {
  const db = openDatabase(join(dir, "amuse.db"));
  const report = await migrate(db, await loadMigrations(dataMigrations), { backups: join(dir, "backups"), context: context(dir, secretsDir, said) });
  return { db, report };
}

const KEYS = {
  openrouter: { type: "api_key", key: "sk-or-fake-0123456789abcdef0123" },
  composio: { type: "api_key", key: "ak_fake_composio_0123456789" },
  openai: { type: "api_key", key: "sk-fake-openai-0123456789abcdefgh" },
  "local-voice": { type: "api_key", key: "local-fake-speech-key-0123" },
  "cloudflare-ai-gateway": { type: "api_key", key: "cf-fake-0123456789abcdefghij", env: { CLOUDFLARE_ACCOUNT_ID: "acct-9", CLOUDFLARE_GATEWAY_TOKEN: "gw-fake-token-0123456789" } },
};
const MODELS = { chat: "openrouter/fake-model", browser: null, background: null, voice: null, localVoice: null, thinking: { chat: "off", browser: "off", background: "off" } };
const SANDBOX = [
  { id: "k1", name: "GitHub token", deliver: { kind: "env", name: "GH_TOKEN" }, at: "2026-10-21T18:00:00.000Z", value: "ghp_FAKEFIXTURE0000000000000000000000" },
  { id: "k2", name: "Tool config", deliver: { kind: "file", path: "~/.config/tool/key" }, at: "2026-10-21T18:00:00.000Z", value: "line one fake\nline two fake" },
  { id: "k3", name: "Login code", deliver: { kind: "stdin", pane: "w1:p2" }, at: "2026-10-21T18:00:00.000Z", value: "code-fake-998877" },
  { id: "k4", name: "Old code", deliver: { kind: "stdin", service: "login" }, at: "2026-10-21T18:00:00.000Z", value: "code-fake-112233" },
  { id: "k5", name: "Same file", deliver: { kind: "file", path: "/home/amuse/.config/tool/key" }, at: "2026-10-21T18:00:00.000Z", value: "second-fake-0123456789" },
  { id: "k6", name: "In the workspace", deliver: { kind: "file", path: "workspace/x" }, at: "2026-10-21T18:00:00.000Z", value: "workspace-fake-0123456789" },
  { id: "k7", name: "github token", deliver: { kind: "env", name: "GH_TOKEN_2" }, at: "2026-10-21T18:00:00.000Z", value: "ghp_FAKEFIXTURE1111111111111111111111" },
];

function write(dir: string, files: Record<string, unknown>) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content), { mode: 0o600 });
}

const FAKE = /sk-or-fake|ak_fake|sk-fake-openai|local-fake|cf-fake|gw-fake|ghp_FAKE|code-fake|line one fake|second-fake|workspace-fake/;

/** Everything on disk under `dir`, as text, to look for what must not be there. */
function everything(dir: string): string {
  const parts: string[] = [];
  const walk = (folderPath: string) => {
    for (const name of readdirSync(folderPath)) {
      const path = join(folderPath, name);
      if (statSync(path).isDirectory()) walk(path);
      else parts.push(`${path}\n${readFileSync(path).toString("latin1")}`);
    }
  };
  walk(dir);
  return parts.join("\n");
}

test("the keys, the model choice and the sandbox's credentials become entries with their uses, every secret sealed; typed codes are dropped", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS, "models.json": MODELS, "sandbox-secrets.json": SANDBOX });
  const said: string[] = [];
  const { db } = await start(dir, secretsDir, said);

  const entries = query(db, z.object({ id: z.string(), name: z.string(), managed: z.number() }), "select id, name, managed from secrets order by name");
  // a provider's key is named by its id until the server gives it its proper name; names are one each, however cased
  assert.deepEqual(entries.map((e) => e.name), ["Composio", "GitHub token", "Tool config", "Your speech server", "cloudflare-ai-gateway", "github token (2)", "openai", "openrouter"]);
  assert.ok(entries.every((e) => e.managed === 0));
  const uses = (name: string) =>
    query(db, z.object({ kind: z.string(), name: z.string().nullable(), path: z.string().nullable(), service: z.string().nullable(), target: z.string().nullable() }), "select u.kind, u.name, u.path, u.service, u.target from secret_uses u join secrets s on s.id = u.entry where s.name = ? order by u.position", name).map((u) =>
      u.kind === "server" ? `${u.service}:${u.target}` : u.kind === "env" ? `$${u.name}` : `file ${u.path}`,
    );
  assert.deepEqual(uses("openrouter"), ["model:openrouter"]);
  assert.deepEqual(uses("openai"), ["model:openai", "voice:openai"]);
  assert.deepEqual(uses("Composio"), ["apps:composio"]);
  assert.deepEqual(uses("Your speech server"), ["voice:local"]);
  assert.deepEqual(uses("GitHub token"), ["$GH_TOKEN"]);
  assert.deepEqual(uses("Tool config"), ["file .config/tool/key"], "the path as the sandbox keeps it, in its home");
  // settings that are not secret are plain
  const plain = query(db, z.object({ name: z.string(), value: z.string() }), "select p.name, p.value from secret_plain p join secrets s on s.id = p.entry where s.name = 'cloudflare-ai-gateway'");
  assert.deepEqual(plain, [{ name: "CLOUDFLARE_ACCOUNT_ID", value: "acct-9" }]);
  // a credential of several lines is a file; a long one has its end as a hint, a short one has none
  const fields = query(db, z.object({ entry: z.string(), name: z.string(), kind: z.string(), hint: z.string().nullable(), size: z.number() }), "select f.entry, f.name, f.kind, f.hint, f.size from secret_fields f");
  const field = (name: string) => fields.find((f) => f.entry === entries.find((e) => e.name === name)?.id);
  assert.deepEqual([field("Tool config")?.kind, field("Tool config")?.hint], ["file", null]);
  assert.deepEqual([field("openrouter")?.kind, field("openrouter")?.hint], ["text", "…0123"]);
  // the credentials that clashed or could not be kept are said, by name, and not imported
  assert.ok(said.some((m) => /"Same file" was left out of the Vault/.test(m)));
  assert.ok(said.some((m) => /"In the workspace" was left out of the Vault/.test(m)));
  assert.ok(said.some((m) => /5 keys, 3 sandbox credentials, 2 typed codes dropped/.test(m)));
  assert.equal(query(db, count, "select count(*) as n from secrets")[0]?.n, 8);
  // the model choice is a row
  assert.equal(JSON.parse(query(db, z.object({ choice: z.string() }), "select choice from model_choice")[0]?.choice ?? "{}").chat, "openrouter/fake-model");
});

test("no plaintext is left anywhere: the two files with secrets are deleted, the database holds them sealed, and the model choice's file is kept as a .bak", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS, "models.json": MODELS, "sandbox-secrets.json": SANDBOX });
  const original = readFileSync(join(dir, "sandbox-secrets.json"));
  const { db } = await start(dir, secretsDir);
  assert.equal(existsSync(join(dir, "keys.json")), false);
  assert.equal(existsSync(join(dir, "sandbox-secrets.json")), false);
  assert.equal(existsSync(join(dir, "models.json")), false);
  assert.ok(existsSync(join(dir, "models.json.bak")));
  assert.deepEqual(readdirSync(dir).filter((n) => /keys|sandbox-secrets/.test(n)), [], "not even as a .bak");
  db.close();
  assert.doesNotMatch(everything(dir), FAKE, "nowhere on disk, in the database, its log or the backups, in the open");
  // the key is apart, and owner-only; the sealed copies open with it, to the very bytes
  assert.equal(statSync(join(secretsDir, KEY_NAME)).mode & 0o777, 0o600);
  const again = openDatabase(join(dir, "amuse.db"));
  const key = readFileSync(join(secretsDir, KEY_NAME));
  const sealed = query(again, z.object({ name: z.string(), sealed: z.string() }), "select name, sealed from imported_secret_files order by name");
  assert.deepEqual(sealed.map((s) => s.name), ["keys.json", "sandbox-secrets.json"]);
  assert.ok(open(key, sealed[1]?.sealed ?? "", "imported-file", "sandbox-secrets.json")?.equals(original));
  assert.equal(open(key, sealed[1]?.sealed ?? "", "imported-file", "keys.json"), null, "sealed to its own name");
  assert.equal(query(again, count, "select count(*) as n from imported_files")[0]?.n, 3, "the three files are recorded with what they were");
});

test("a second start imports nothing and changes nothing; the check value is there and opens", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS });
  const first = await start(dir, secretsDir);
  const rows = (db: typeof first.db) => JSON.stringify(query(db, z.object({ id: z.string(), sealed: z.string() }), "select entry as id, sealed from secret_fields order by entry, name"));
  const before = rows(first.db);
  assert.equal(query(first.db, count, "select count(*) as n from vault_check")[0]?.n, 1);
  first.db.close();
  const second = await start(dir, secretsDir);
  assert.equal(second.report.ran.length, 0);
  assert.equal(rows(second.db), before);
  const check = query(second.db, z.object({ sealed: z.string() }), "select sealed from vault_check")[0];
  assert.equal(open(readFileSync(join(secretsDir, KEY_NAME)), check?.sealed ?? "", "store", "check")?.toString("utf8"), "amuse secret store");
});

test("a sign-in's tokens become a managed entry: tokens secret, expiry and the rest plain", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": { openai: { type: "oauth", access: "acc-fake-0123456789abcdef01", refresh: "ref-fake-0123456789abcdef01", expires: 1777777777000, accountId: "acct-42", scopes: ["a", "b"] } } });
  const { db } = await start(dir, secretsDir);
  assert.equal(query(db, count, "select count(*) as n from secrets where managed = 1 and name = 'openai'")[0]?.n, 1);
  assert.deepEqual(
    query(db, z.object({ name: z.string(), value: z.string() }), "select name, value from secret_plain order by position"),
    [
      { name: "expires", value: "1777777777000" },
      { name: "accountId", value: "acct-42" },
      { name: "scopes:json", value: '["a","b"]' },
    ],
  );
  assert.deepEqual(query(db, z.object({ name: z.string() }), "select name from secret_fields order by position").map((f) => f.name), ["access", "refresh"]);
  assert.deepEqual(query(db, z.object({ field: z.string() }), "select field from secret_uses").map((u) => u.field), ["access", "access"], "models and speech, both for the access token");
});

test("a new instance with none of these files makes no key and no row; models.json alone makes the choice and no key", async () => {
  const empty = folder();
  const { db } = await start(empty.dir, empty.secretsDir);
  assert.equal(readdirSync(empty.secretsDir).length, 0);
  assert.equal(query(db, count, "select count(*) as n from vault_check")[0]?.n, 0);
  const only = folder();
  write(only.dir, { "models.json": MODELS });
  const second = await start(only.dir, only.secretsDir);
  assert.equal(readdirSync(only.secretsDir).length, 0, "nothing was sealed, so no key was made");
  assert.equal(query(second.db, count, "select count(*) as n from model_choice")[0]?.n, 1);
  assert.ok(existsSync(join(only.dir, "models.json.bak")));
});

test("an import that cannot be done leaves every old file as it was, makes no key, and says which file, never what is in it", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS, "models.json": MODELS });
  writeFileSync(join(dir, "sandbox-secrets.json"), '[{"id": "k1", "name": "x", sk-fake-leak-0001');
  const before = everything(dir);
  const db = openDatabase(join(dir, "amuse.db"));
  const known = await loadMigrations(dataMigrations);
  await assert.rejects(migrate(db, known, { backups: join(dir, "backups"), context: context(dir, secretsDir) }), (error) => {
    assert.ok(error instanceof StartupError && error.problem.kind === "migration-failed");
    assert.match(error.message, /sandbox-secrets\.json: not valid JSON/);
    assert.doesNotMatch(error.message, /sk-fake/);
    return true;
  });
  assert.equal(everything(dir).includes("sk-or-fake-0123456789abcdef0123"), true, "the files are where they were");
  assert.equal(readFileSync(join(dir, "keys.json"), "utf8"), JSON.stringify(KEYS));
  assert.equal(existsSync(join(dir, "models.json")), true);
  assert.deepEqual(readdirSync(secretsDir), []);
  assert.equal(query(db, count, "select count(*) as n from secrets")[0]?.n, 0);
  assert.ok(before.length > 0);
  // put right, it is tried again
  writeFileSync(join(dir, "sandbox-secrets.json"), JSON.stringify(SANDBOX.slice(0, 1)));
  const again = await migrate(db, known, { backups: join(dir, "backups"), context: context(dir, secretsDir) });
  assert.deepEqual(again.ran.map((m) => m.name), ["import_secrets", "account_security", "browser_sessions", "announced_changes", "optional_pin", "no_device_approval"], "the import, and the migrations that come after it");
  assert.equal(query(db, count, "select count(*) as n from secrets")[0]?.n, 6);
});

test("without the folder for the Vault's key, secrets are not imported, in words, and the files are as they were", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amuse-vault-"));
  write(dir, { "keys.json": KEYS });
  const db = openDatabase(join(dir, "amuse.db"));
  await assert.rejects(
    migrate(db, await loadMigrations(dataMigrations), { backups: join(dir, "backups"), context: context(dir, join(dir, "not-there")) }),
    /the folder for the Vault's key is not there/,
  );
  assert.equal(existsSync(join(dir, "keys.json")), true);
});

test("the sealed copies come back as the files they were, on request, and are forgotten on request; a file already there is not written over", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS, "sandbox-secrets.json": SANDBOX });
  const keys = readFileSync(join(dir, "keys.json"));
  const sandbox = readFileSync(join(dir, "sandbox-secrets.json"));
  const { db } = await start(dir, secretsDir);
  const restored = restoreSecretFiles(db, { dataDir: dir, secretsDir });
  assert.deepEqual(restored, { written: ["keys.json", "sandbox-secrets.json"], there: [] });
  assert.ok(readFileSync(join(dir, "keys.json")).equals(keys) && readFileSync(join(dir, "sandbox-secrets.json")).equals(sandbox));
  assert.equal(statSync(join(dir, "keys.json")).mode & 0o777, 0o600);
  assert.deepEqual(restoreSecretFiles(db, { dataDir: dir, secretsDir }), { written: [], there: ["keys.json", "sandbox-secrets.json"] });
  // with the key gone they cannot be opened
  assert.throws(() => restoreSecretFiles(db, { dataDir: join(dir, "x"), secretsDir: join(dir, "nowhere") }), /key is not there/);
  assert.equal(forgetSecretFiles(db), 2);
  assert.equal(query(db, count, "select count(*) as n from imported_secret_files")[0]?.n, 0);
  assert.equal(forgetSecretFiles(db), 0);
});

test("the old files turning up again beside a Vault that took them are deleted, not kept as a plaintext copy, and only if they are what was imported", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS, "models.json": MODELS });
  const { db } = await start(dir, secretsDir);
  writeFileSync(join(dir, "keys.json"), JSON.stringify(KEYS));
  writeFileSync(join(dir, "models.json"), JSON.stringify(MODELS));
  const result = retireOldFiles(db, context(dir, secretsDir));
  assert.deepEqual(result.renamed.map((r) => r.name).sort(), ["keys.json", "models.json"]);
  assert.deepEqual(result.renamed.find((r) => r.name === "keys.json")?.to, null);
  assert.equal(existsSync(join(dir, "keys.json")), false);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("keys")), [], "no keys.json.bak");
  assert.ok(existsSync(join(dir, "models.json.bak.2")), "the model choice holds no secret: renamed, as the others are");
  // one that is not what was imported is kept, and not touched
  writeFileSync(join(dir, "keys.json"), JSON.stringify({ other: { type: "api_key", key: "someone-else" } }));
  assert.deepEqual(retireOldFiles(db, context(dir, secretsDir)), { renamed: [], kept: ["keys.json"] });
  assert.equal(existsSync(join(dir, "keys.json")), true);
});

test("a value left empty is not kept, and does not stop the import: the rest is imported, and what was left out is said", async () => {
  const { dir, secretsDir } = folder();
  write(dir, {
    "keys.json": { openai: { type: "api_key", key: "" }, groq: { type: "api_key", key: "gk-fake-0123456789abcdefghij", env: { REGION: "" } }, blank: { type: "api_key" } },
    "sandbox-secrets.json": [
      { id: "k1", name: "Empty one", deliver: { kind: "env", name: "EMPTY" }, at: "2026-10-21T18:00:00.000Z", value: "" },
      { id: "k2", name: "Fine one", deliver: { kind: "env", name: "FINE" }, at: "2026-10-21T18:00:00.000Z", value: "fine-fake-0123456789abcdef" },
    ],
  });
  // the dry run says what the real one will, before it runs
  const touches = (await import("./migrate.ts")).describePending((await import("./migrate.ts")).plan([], await loadMigrations(dataMigrations)), context(dir, secretsDir)).find((m) => m.name === "import_secrets")?.touches ?? [];
  assert.ok(touches.includes("make 2 entries (1 from keys, 1 from sandbox credentials)"), touches.join("\n"));
  assert.ok(touches.includes('leave out the sandbox credential "Empty one": its value is empty'));
  assert.ok(touches.includes("leave out the key for openai: it has no key and no settings"));
  assert.ok(touches.includes("leave out the key for blank: it has no key and no settings"));
  const said: string[] = [];
  const { db } = await start(dir, secretsDir, said);
  assert.deepEqual(query(db, z.object({ name: z.string() }), "select name from secrets order by name").map((e) => e.name), ["Fine one", "groq"]);
  assert.ok(said.some((m) => /"Empty one" has an empty value/.test(m)));
  assert.ok(said.some((m) => /key for openai has no key and no settings/.test(m)));
  assert.equal(query(db, count, "select count(*) as n from secret_plain")[0]?.n, 0, "an empty setting is not a plain field");
});

test("the dry run says what would stop the import, and changes nothing", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": { openai: { type: "oauth" } } });
  const { describePending, plan } = await import("./migrate.ts");
  const touches = describePending(plan([], await loadMigrations(dataMigrations)), context(dir, secretsDir)).find((m) => m.name === "import_secrets")?.touches ?? [];
  assert.match(touches.join("\n"), /the import would stop, and nothing would be changed: keys\.json: it does not hold what Amuse kept there/);
  assert.deepEqual(readdirSync(secretsDir), []);
  assert.ok(existsSync(join(dir, "keys.json")));
});

test("a plaintext half of a write cut short is deleted with the import; a plaintext .bak copy beside the files is left, and said", async () => {
  const { dir, secretsDir } = folder();
  write(dir, { "keys.json": KEYS });
  writeFileSync(join(dir, "keys.json.tmp"), JSON.stringify(KEYS));
  writeFileSync(join(dir, "sandbox-secrets.json.tmp"), JSON.stringify(SANDBOX));
  writeFileSync(join(dir, "keys.json.bak"), JSON.stringify(KEYS));
  writeFileSync(join(dir, "sandbox-secrets.json.bak.2"), JSON.stringify(SANDBOX));
  const said: string[] = [];
  await start(dir, secretsDir, said);
  assert.deepEqual(readdirSync(dir).filter((n) => /keys|sandbox-secrets/.test(n)).sort(), ["keys.json.bak", "sandbox-secrets.json.bak.2"]);
  assert.ok(said.some((m) => /keys\.json\.bak, sandbox-secrets\.json\.bak\.2 are plaintext copies of what the Vault now holds.*delete them/.test(m)));
  assert.doesNotMatch(said.join("\n"), FAKE);
});
