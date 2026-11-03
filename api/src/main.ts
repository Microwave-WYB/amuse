/**
 * The server: the core host with Pi agents, served on 127.0.0.1. Who may use it
 * is whoever knows the master password, set on the first visit (kept in the
 * database); the model providers' keys, Composio's and the models chosen are
 * set up in the app (keys.json, models.json).
 *   AMUSE_PORT   default 8797
 *   AMUSE_HOST   default 127.0.0.1
 *   AMUSE_DATA   the folder everything is kept in: amuse.db (the journal, chats, rules, password …), the workspace,
 *                 backups/. Without it, AMUSE_JOURNAL's folder; with neither, a temporary folder
 *   AMUSE_JOURNAL  where the older versions kept the journal (a JSONL file): imported once into the database
 *                 and kept as <name>.bak, with the other old files beside it
 *   AMUSE_PI_MODEL, AMUSE_PI_BROWSER_MODEL, <PROVIDER>_API_KEY, AMUSE_PI_AUTH, AMUSE_COMPOSIO_KEY(_FILE)
 *                 read once, when the Vault is new: taken over into it
 *   AMUSE_SECRETS_DIR  where the Vault's key lives (store.key, made on first start), apart from the data
 *                 (compose.yaml: /secrets/amuse-store); without it, beside the data, which is no protection against a leak of it
 *   AMUSE_BROWSERS  the auto-browser pool: name|controller URL|noVNC URL, comma-separated
 *                 (see compose.browsers.yaml); AUTO_BROWSER_TOKEN_FILE holds the controllers' bearer token
 *   AMUSE_PUBLIC_URL  this server's address as the user's browser reaches it (http://host:port);
 *                 lets connectors send the user straight back for an instant "connected"
 *   AMUSE_SANDBOX_URL  the sandbox's control daemon (http://sandbox:7070, see compose.yaml): gives the agent a machine of
 *                 its own to run commands on; without it there are no such tools
 *   AMUSE_SANDBOX_SUBNET  the sandbox network's address range (10.231.250.0/24, as compose.yaml fixes it): the server turns
 *                 away every request from it, whether or not the sandbox is in use; required with AMUSE_SANDBOX_URL
 *   AMUSE_WEB    directory of the built web app to serve (same origin as /rpc and /live)
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SandboxError, masking, sandboxClient, terminalAt } from "@amuse/sandbox";
import { NoComposioKey, composio, composioSaid, composioApps, composioGuide, composioConnector, composioDirectory, keyedComposio } from "@amuse/composio";
import { StartupError, queryOne } from "@amuse/db";
import { z } from "zod";
import { JournalError, sqliteChats } from "./journal.ts";
import { locate, openData } from "./data.ts";
import { serveProblem } from "./startup.ts";
import { sqliteSent } from "./sent.ts";
import { workspace } from "./workspace.ts";
import { browserPool, controller } from "@amuse/browser";
import { type Ports, Rejected, createHost, noLogins, noSandbox, realTimers } from "@amuse/core";
import type { Entity } from "@amuse/protocol";
import { type KeyFile, type PiAuth, LOCAL_VOICE, VoiceUnavailable, adoptEnvironment, builtInSkills, piAgent, piBrowserAgent, piKeys, piScheduleRunner, piTaskRunner, providerNames, skillsPort, storeCredentials, transcriber } from "@amuse/pi";
import { sqliteAccess } from "./access.ts";
import { sqlitePin, unlocks } from "./pin.ts";
import { sensitive } from "./sensitive.ts";
import { sqliteDefaults } from "./defaults.ts";
import { listen } from "./server.ts";
import { sqliteRules } from "./rules.ts";
import { refusing } from "./sandbox.ts";
import { maskingFiles } from "./masked-files.ts";
import { KeyUnavailable } from "./seal.ts";
import { sqliteChoices } from "./choices.ts";
import { sqliteBrowserSessions } from "./browser-sessions.ts";
import { secretStore } from "./secret-store.ts";
import { changelogEntries, news, sqliteAnnounced } from "./whats-new.ts";
import { systemRules } from "./system-prompt.ts";

const port = Number(process.env["AMUSE_PORT"] ?? 8797);
const host = process.env["AMUSE_HOST"] ?? "127.0.0.1";

/**
 * Before anything opens the data: its folders are checked, and the database is opened and migrated (db/). When that cannot
 * be done, this server still answers, with a page that says why and what to do, and nothing else starts.
 */
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
/** Start-up stops here for a reason it can name: the log has the details, and the address answers with the page (startup.ts). */
const stopped = async (error: unknown): Promise<never> => {
  if (!(error instanceof StartupError)) throw error;
  console.error(`amuse could not start: ${error.message}`);
  for (const signal of signals) process.once(signal, () => process.exit(1));
  await serveProblem(error.problem, { port, host });
  return await new Promise<never>(() => {});
};
const where = await (async () => {
  try {
    return locate(process.env);
  } catch (error) {
    return await stopped(error);
  }
})();
const dataDir = where.dir;
const db = await openData(where).catch(stopped);
const access = sqliteAccess(db);
/** the PIN that authorizes sensitive actions, and the sessions it unlocked (in memory: a restart locks them) */
const pin = sqlitePin(db);
const unlocked = unlocks(pin, access.valid);

/** Amuse's own machine, where there is one: commands run there by the agents, and wiped by the user in Settings */
const sandboxUrl = process.env["AMUSE_SANDBOX_URL"];
const sandboxDirect = sandboxUrl ? sandboxClient(sandboxUrl) : undefined;

/**
 * The Vault: every secret Amuse keeps for the user, in the database, sealed, with its key apart from the data (a folder of its
 * own, checked at start). The keys of the models, speech and Composio are in it too, with a use for what they serve
 * (pi/src/credentials.ts), and so are the credentials given for the sandbox. A key that is missing, damaged or not the one the
 * secrets were sealed with stops the start here, and the address says so.
 */
if (!where.secretsMounted) console.warn("AMUSE_SECRETS_DIR is not set: the Vault's key is kept beside the data, so a copy of the data carries it too. Give it a folder of its own (compose.yaml does).");
const newVault = queryOne(db, z.object({ n: z.number() }), "select (select count(*) from vault_check) + (select count(*) from model_choice) as n")?.n === 0;
const vault = await (async () => {
  try {
    return secretStore({ db, keyPath: join(where.secrets, "store.key"), sandbox: sandboxDirect });
  } catch (error) {
    if (error instanceof KeyUnavailable) return await stopped(new StartupError({ kind: "vault-key", trouble: error.trouble }, error.message));
    throw error;
  }
})();

// what the sandbox could not be told to forget while it was out of reach is taken out now, and what it should hold is given again
void vault.sweep().catch((error: unknown) => console.warn(`The sandbox could not be brought up to date with the Vault: ${error instanceof Error ? error.message : "an error"}`));

/** The user's keys and models, set up in the app; what the environment held before is taken over once, into a Vault that is new. */
const choices = sqliteChoices(db);
const keyFile = process.env["AMUSE_COMPOSIO_KEY_FILE"];
const providerLabels = await providerNames();
const keyNames = (id: string) => (id === "composio" ? "Composio" : id === LOCAL_VOICE ? "Your speech server" : (providerLabels.get(id) ?? id));
const appKeyIds = ["composio"];
// keys the old files held came in under their provider's plain id: they are given the names they are known by
await vault.relabel(keyNames);
const credentials: KeyFile = storeCredentials(vault, { apps: appKeyIds, names: keyNames });
const adopted = newVault
  ? await adoptEnvironment({
      keys: credentials,
      choices,
      apps: {
        composio: keyFile ? readFileSync(keyFile, "utf8").trim() : process.env["AMUSE_COMPOSIO_KEY"],
      },
      env: process.env,
      ...(process.env["AMUSE_PI_AUTH"] ? { authFile: process.env["AMUSE_PI_AUTH"] } : {}),
    })
  : [];
if (adopted.length > 0) console.log(`Keys taken over from the environment: ${adopted.join(", ")}. Set them in the app from now on.`);
/**
 * Where Pi keeps the providers' catalogs it learns, beside the rest of the data: its models.json (which Amuse leaves
 * empty) and the store a refresh writes next to it. Settings › Models fetches them; a restart finds them here.
 */
const piCatalogs = { modelsPath: join(dataDir, "pi", "models.json"), modelsStorePath: join(dataDir, "pi", "models-store.json") };

const keys = piKeys({
  keys: credentials,
  choices,
  ...piCatalogs,
  apps: [
    {
      id: "composio",
      name: "Composio",
      message: "Your Composio API key (starts with ak_)",
      // per Composio's docs
      where: "Sign in at dashboard.composio.dev, open Settings › Project Settings, and copy the key under API Keys.",
      link: { url: "https://dashboard.composio.dev/", label: "Open dashboard.composio.dev" },
      // a key that lists the user's accounts works
      test: async (key) => void (await composio(key).accounts(composioUser)),
    },
  ],
});
const auth: PiAuth = { kind: "keys", keys: credentials, ...piCatalogs };
/** what the sandbox says to the agents comes back with the secrets that are in it masked (the Vault knows which) */
const sandbox = sandboxDirect && masking(sandboxDirect, () => vault.masked());
const model = () => keys.model("chat");
const browserModel = () => keys.model("browser");
const system = systemRules(sandbox !== undefined).join("\n");
/** connections go through Composio, with the key set up now (none: each use says it is needed) */
const composioClient = keyedComposio(() => keys.appKey("composio"));
const composioUser = "owner";
/** what the agent may do with connections (core/policy.ts) */
const rules = sqliteRules(db);
// Muse's workspace, and the index of sent files kept in the database
const files = workspace(join(dataDir, "workspace"), sqliteSent(db), dataDir);
/** what the agents read of it comes back with the secrets that are in the sandbox masked (the user's own view of their files is the workspace itself) */
const agentFiles = maskingFiles(files, () => vault.masked());
const publicUrl = process.env["AMUSE_PUBLIC_URL"];
const connector = composioConnector(composioClient, {
  userId: composioUser,
  timers: realTimers,
  ...(publicUrl
    ? {
        callbackUrl: (key: string) => `${new URL("/connected", publicUrl)}?key=${key}`,
      }
    : {}),
});
/**
 * "name|http://controller:8000|http://node:6080|/handoff/name, …" → nodes whose noVNC websocket is
 * …/websockify; the last part, if there, is the folder shared with that controller for uploads
 * (it sees it as its upload root, /data/uploads).
 */
/** The controllers' bearer token, made on first start by compose.browsers.yaml's `secrets`. */
const tokenFile = process.env["AUTO_BROWSER_TOKEN_FILE"];
const browserToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
const nodes = (process.env["AMUSE_BROWSERS"] ?? "")
  .split(",")
  .map((entry) => entry.trim().split("|"))
  .flatMap(([name, api, novnc, handoff]) => {
    if (!name || !api || !novnc) return [];
    const vnc = new URL("/websockify", novnc);
    vnc.protocol = vnc.protocol === "https:" ? "wss:" : "ws:";
    return [
      {
        name,
        controller: controller(api, browserToken),
        vnc: vnc.toString(),
        ...(handoff ? { handoff: { local: handoff, remote: "/data/uploads" } } : {}),
      },
    ];
  });
const browsers = nodes.length > 0 ? browserPool(nodes, { sessions: sqliteBrowserSessions(db) }) : undefined;
/**
 * Every port is real and chosen here on purpose; a capability that is not
 * set up (no model, no Composio key, no browsers) fails plainly, saying what
 * is needed, instead of falling back to a script.
 */
const apps = composioApps(composioClient, composioUser, rules);
const directory = composioDirectory(composioClient, {
  userId: composioUser,
  rules,
  ...(publicUrl ? { callbackUrl: new URL("/connected", publicUrl).href } : {}),
});
const said =
  <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw composioSaid(error);
    }
  };
/** without a key, there is nothing connected (rather than an error) */
const none = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NoComposioKey) return [];
    throw composioSaid(error);
  }
};
/** the skills that ship with Amuse (pi/skills/); the user's own are read from the workspace each turn */
const skills = builtInSkills().filter((skill) => sandbox || (skill.name !== "sandbox" && skill.name !== "herdr"));
/** the composer's mic: speech to text with the user's own key (pi/src/voice.ts) */
const toText = transcriber(credentials, () => keys.voiceChoice(), fetch, () => keys.localVoiceService());
const speech = async (audio: Uint8Array, type: string) => {
  try {
    return { text: await toText(audio, type) };
  } catch (error) {
    if (error instanceof VoiceUnavailable) return { reason: error.message };
    throw error;
  }
};
/** How this instance is set up right now, for the agent (`amuse_status`): never a key, only whether there is one. */
const about = async (): Promise<string> => {
  const chat = keys.model("chat");
  const accounts = keys.appKey("composio") ? await directory.accounts().catch(() => null) : null;
  const connected = accounts?.filter((a) => a.status === "active").map((a) => `${a.app.name}${a.label ? ` (${a.label})` : ""}`) ?? [];
  const voice = keys.voiceChoice();
  return [
    `Chat model: ${chat ?? "none chosen yet (Settings › Models)"}, thinking ${keys.thinking("chat")}.`,
    `Browser model: ${keys.model("browser") ?? "none chosen yet"}, thinking ${keys.thinking("browser")}.`,
    `Background model (scheduled work): ${keys.model("background") ?? "the chat model"}, thinking ${keys.thinking("background")}.`,
    `Speech to text: ${voice === "local" ? "the user's own server" : (voice ?? "the first service with a key, if any")}.`,
    `Connections: ${
      !keys.appKey("composio")
        ? "not set up (no Composio key yet: Settings › Connections)"
        : accounts === null
          ? "set up; the connected accounts cannot be read just now"
          : connected.length > 0
            ? `set up; connected: ${connected.join(", ")}`
            : "set up; nothing connected yet"
    }.`,
    `Browsers: ${nodes.length > 0 ? `${nodes.length} at a time` : "none on this instance"}.`,
    `Sandbox: ${sandbox ? "on" : "off on this instance"}.`,
    `Address: ${publicUrl ?? "not set"}.`,
  ].join("\n");
};

/**
 * A call to the sandbox, whose failure the user hears in our own words: what the sandbox said about it (`detail`)
 * is never passed on as ours.
 */
const inOurWords = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw error instanceof SandboxError ? new Rejected({ kind: "unsound", reason: error.message }) : error;
  }
};

const ports: Ports = {
  ...piAgent({ secrets: { secrets: vault, keys }, model, thinking: () => keys.thinking("chat"), auth, system, rules, files: agentFiles, ...(sandbox ? { sandbox } : {}), ...(browsers ? { browsers } : {}), apps, search: apps.search, appsSetup: () => (keys.appKey("composio") ? null : composioGuide), appsFit: async (app) => (keys.appKey("composio") ? await directory.cannotConnect(app) : null), skills, about, defaults: sqliteDefaults(db) }),
  // scheduled work runs on the background model (the chat's when none is chosen)
  ...piScheduleRunner({
    secrets: { secrets: vault, keys },
    model: () => keys.model("background"),
    thinking: () => keys.thinking("background"),
    auth,
    system,
    skills,
    about,
    rules,
    files: agentFiles,
    ...(sandbox ? { sandbox } : {}),
    apps,
    search: apps.search,
  }),
  ...piTaskRunner({
    secrets: { secrets: vault, keys },
    model,
    thinking: () => keys.thinking("chat"),
    auth,
    system,
    skills,
    about,
    rules,
    files: agentFiles,
    ...(sandbox ? { sandbox } : {}),
    apps,
    search: apps.search,
  }),
  files,
  keys,
  // the logins the browsers keep (shared by every browser), to see and sign out of in Settings
  logins: browsers ? { list: () => browsers.logins(), forget: (site) => browsers.forgetLogin(site) } : noLogins,
  // the skills, built in and the user's, for the sidebar's Skills
  skills: skillsPort(skills, files),
  ...(browsers
    ? piBrowserAgent({ model: browserModel, thinking: () => keys.thinking("browser"), auth }, browsers, rules, files)
    : {
        browse: (browser, io) => {
          if (
            io.act({
              kind: "browserEnded",
              id: browser.id,
              status: "failed",
              result: "No browser is configured on this server.",
            }).ok
          )
            io.report(`[browser task "${browser.title}" failed] No browser is configured on this server.`);
          io.act({ kind: "released", id: browser.id });
        },
        job: () => {},
        browser: () => {},
        fit: () => {},
      }),
  sandbox:
    sandbox && sandboxDirect
      ? {
          reset: async () => {
            await inOurWords(() => sandbox.reset());
            // the reset emptied its home, where the secrets were put: given again
            await vault.again();
          },
          atRisk: () => inOurWords(() => sandbox.atRisk()),
        }
      : noSandbox,
  secrets: vault,
  rules,
  approval: () => {}, // waiting agents get the verdict through AgentIO.decision
  // a card from before the key was removed: the user hears where to add one
  connect: said((connection, io) => connector.connect(connection, io)),
  apps: {
    search: said(directory.search),
    connect: said(directory.connect),
    access: said(directory.access),
    cannotConnect: said(directory.cannotConnect),
    connectKey: said(directory.connectKey),
    disconnect: said(directory.disconnect),
    permit: said(directory.permit),
    accounts: () => none(directory.accounts),
    permissions: (app) => none(() => directory.permissions(app)),
  },
};

// what an update brought that the user has not been told about yet (whats-new.ts), from the changelog the image ships
const announced = sqliteAnnounced(db);
const changelog = (() => {
  try {
    return readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    return ""; // no changelog beside the code: there is nothing to tell
  }
})();
// a journal that cannot be replayed stops the start with a page, not a crash loop
const session = await (async () => {
  try {
    return createHost(ports, {
      store: sqliteChats(db),
      // one waking report to the main chat's agent, which tells the user what they can do now; nothing on a first start
      started: (main) => {
        const fresh = news(changelogEntries(changelog), announced);
        if (!fresh) return;
        main.report(fresh.note);
        fresh.delivered();
      },
    });
  } catch (error) {
    if (!(error instanceof JournalError)) throw error;
    return await stopped(new StartupError({ kind: "journal-unreadable", chat: error.chat, event: error.event }, error.message));
  }
})();

// the live channel asks which runs the user holds, in any chat: followed here from the events like any client
const held = new Set<string>();
const follow = (entity: Entity) => {
  if (entity.kind !== "browser") return;
  if (entity.status === "paused") held.add(entity.id);
  else held.delete(entity.id);
};
session.subscribe((update) => {
  if (update.kind === "event" && update.envelope.event.kind === "upserted") follow(update.envelope.event.entity);
});
// the browsers the state lists as open: what a restart reconciles the controllers against (their session is adopted again, or their card closes)
const openBrowsers: string[] = [];
for (const { id } of (await session.call("chats.list", {})).chats) {
  const synced = await session.call("session.sync", { chat: id, since: null });
  if (synced.kind !== "snapshot") continue;
  synced.state.entities.forEach(follow);
  for (const entity of synced.state.entities) if (entity.kind === "browser" && entity.live) openBrowsers.push(entity.id);
}
if (browsers) {
  const { lost, closed } = await browsers.reconcile(openBrowsers);
  if (closed > 0) console.log(`amuse: closed ${closed} browser session${closed === 1 ? "" : "s"} that no browser owned.`);
  for (const { id, reason } of lost) {
    console.warn(`amuse: browser ${id} is closed: ${reason}.`);
    // no dead card stays: the state closes it (its agent is gone with the restart, and nothing waits on it)
    await session.call("browser.control", { id, action: "stop" }).catch(() => {});
  }
}
const live = browsers && { browsers, controlled: (id: string) => held.has(id) };

// the sandbox network is turned away from the first request; a sandbox without one to turn away does not start
const sandboxSubnet = process.env["AMUSE_SANDBOX_SUBNET"];
if (sandboxUrl && !sandboxSubnet) throw new Error("AMUSE_SANDBOX_URL is set without AMUSE_SANDBOX_SUBNET: the server must know the sandbox's network to turn it away.");
const refuse = sandboxSubnet ? refusing(sandboxSubnet) : undefined;

const web = process.env["AMUSE_WEB"];
await listen({
  session,
  files,
  ...(live ? { live } : {}),
  ...(sandboxUrl ? { terminal: (cols: number, rows: number) => terminalAt(sandboxUrl, cols, rows) } : {}),
  ...(web ? { web } : {}),
  returned: connector.returned,
  access,
  pin,
  unlocks: unlocked,
  sensitive: (call) => sensitive(call, rules),
  ...(refuse ? { refuse } : {}),
  transcribe: speech,
  port,
  host,
});
for (const signal of signals)
  process.once(signal, () => {
    db.close(); // folds the write-ahead log into the database file
    process.exit(0);
  });
// the way in: the first visit sets the master password
if (!access.ready()) console.log(`amuse is ready. Open ${publicUrl ?? `http://${host}:${port}`} and set the master password.`);
console.log(
  `amuse api on ws://${host}:${port}/rpc (model: ${model() ?? "none chosen"}, browser model: ${browserModel() ?? "none chosen"}, apps: ${keys.appKey("composio") ? "composio" : "no key"}, browsers: ${nodes.length ? nodes.map((n) => n.name).join(",") : "none"}, sandbox: ${sandboxUrl ?? "none"})`,
);
