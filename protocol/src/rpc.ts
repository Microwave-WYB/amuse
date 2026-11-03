/**
 * Client → server: JSON-RPC 2.0 over one WebSocket. Calls are a union on
 * `method`; results are keyed by method and checked for exhaustiveness with
 * `satisfies`. The server pushes `event` notifications (see events.ts).
 * Live browser pixels are not JSON-RPC; they stream on their own channel.
 */
import { z } from "zod";
import { Account, App, AppAccess, BrowserAction, BrowserRule, GivenField, KindRule, Permission, Site, SiteEntry, SiteRule, ToolKind } from "./apps.ts";
import { Approval, Attachment, Id, Resolution, Schedule, TimeZone } from "./entities.ts";
import { FieldName, PlainInput, SecretAnswer, SecretEntry, SecretInput, Use, UseInput } from "./secrets.ts";
import { Envelope, Index, Page, Seq, State } from "./events.ts";
import { Chat, Push } from "./chats.ts";
import { Goal, GoalNote, GoalStatus } from "./goals.ts";
import { SkillInfo, SkillOrigin } from "./skills.ts";
import { KeyTest, KeyWay, KeysState, LocalVoice, LoginStep, ModelRef, ModelRole, ThinkingLevel } from "./keys.ts";

const call = <M extends string, P extends z.ZodObject>(method: M, params: P) =>
  z.object({ method: z.literal(method), params });

/**
 * A folder in the sandbox's home folder, outside the workspace, that a reset would delete: something the user
 * may have put there themselves, and may want kept. What the daemon answers is not taken for trusted, so it is
 * checked here too.
 */
export const AtRiskFolder = z.object({
  /** where it is, from the home folder ("myapp") */
  path: z.string(),
  /** it holds a `.git`: a repository of code */
  repository: z.boolean(),
});
export type AtRiskFolder = z.infer<typeof AtRiskFolder>;

export const Call = z.discriminatedUnion("method", [
  /** Catch up on a chat from `since` (null: from nothing). */
  call("session.sync", z.object({ chat: Id, since: Seq.nullable() })),
  /** Up to `limit` of a chat's entities just before feed index `before`, for a state holding only the recent end. */
  call("session.history", z.object({ chat: Id, before: Index, limit: z.int().min(1).max(200) })),
  /** `timezone`: the device's (Intl), so times are the user's own; `replyTo`: an item (a message of either side, or a card) this answers; `suggested`: the option tapped under a reply (the text sent is that option's); `about`: an error the user asks about (what it said, and its technical detail, for the agent only) */
  call(
    "chat.send",
    z
      .object({ chat: Id, text: z.string(), timezone: TimeZone, attachments: z.array(Attachment).max(10), replyTo: Id.optional(), suggested: z.object({ reply: Id, index: z.int().nonnegative() }).optional(), about: z.object({ message: z.string().max(500), detail: z.string().max(2000) }).optional() })
      .refine((p) => p.text.trim() !== "" || p.attachments.length > 0, "Say something or attach a file"),
  ),
  /** Stop the agent's current reply in a chat. */
  call("chat.stop", z.object({ chat: Id })),
  /** Try again the turn Muse could not reply to (a Failure, by id). */
  call("chat.retry", z.object({ id: Id })),
  /** The chats there are: the main chat first, then side chats, most recently used first. */
  call("chats.list", z.object({})),
  /** Open a side chat; it is named after its first message. */
  call("chats.create", z.object({})),
  call("chats.rename", z.object({ id: Id, title: z.string().trim().min(1).max(80) })),
  /** Delete a side chat for good, stopping whatever runs in it. */
  call("chats.delete", z.object({ id: Id })),
  call("approval.resolve", z.object({ id: Id, resolution: Resolution })),
  /** Start connecting: returns the provider's hosted auth link. */
  call("connection.begin", z.object({ id: Id })),
  call("connection.dismiss", z.object({ id: Id })),
  /** take: → paused (user in control); handBack: → working; stop: → stopped. */
  call("browser.control", z.object({ id: Id, action: z.enum(["take", "handBack", "stop"]) })),
  /** While the user views a browser: shape its desktop like their view (CSS px); null: back to the standard size. */
  call(
    "browser.fit",
    z.object({ id: Id, view: z.object({ width: z.int().min(200).max(8000), height: z.int().min(200).max(8000) }).nullable() }),
  ),
  /** Open a browser of the user's own, held by them from the start, in a chat; it counts against the browsers there are. */
  call("browser.open", z.object({ chat: Id, url: z.url() })),
  call("task.stop", z.object({ id: Id })),
  /** Every schedule there is (the feed a client holds may not reach back to them), newest first. */
  call("schedules.list", z.object({})),
  /** pause: stop running it until resumed; resume: run it again from now on; cancel: for good. */
  call("schedule.control", z.object({ id: Id, action: z.enum(["pause", "resume", "cancel"]) })),
  /** Apps to connect: the most used first; `query` narrows them; `cursor` (from a result) goes on. */
  call("apps.search", z.object({ query: z.string().max(100), cursor: z.string().nullable() })),
  /** The accounts connected so far. */
  call("apps.accounts", z.object({})),
  /** Start connecting `app`: returns the provider's hosted auth link. */
  call("apps.connect", z.object({ app: Id })),
  /** How `app` is connected: a hosted link, or the user's own key. */
  call("apps.access", z.object({ app: Id })),
  /** Connect `app` with the user's own key, typed in the app; Composio holds it, Amuse keeps it nowhere. */
  call("apps.connectKey", z.object({ app: Id, values: z.array(GivenField).min(1) })),
  call("apps.disconnect", z.object({ account: Id })),
  /** What the agent may do with an app: reading, changing, destroying (its tools sorted by their own hints). */
  call("apps.permissions", z.object({ app: Id })),
  /** Set what the agent may do with an app's tools of one kind; null: back to the default. */
  call("apps.permit", z.object({ app: Id, kind: ToolKind, permission: Permission.nullable() })),
  /** The browser's rules by kind of action: visit, submit, download, upload. */
  call("browser.rules", z.object({})),
  /** Set what the browser may do for a kind of action, everywhere; null: back to the default. Uploads are asked about or denied, never allowed. */
  call(
    "browser.permit",
    z.object({ action: BrowserAction, permission: Permission.nullable() }).refine((p) => !(p.action === "upload" && p.permission === "allow"), "Uploads are always asked about: they can be asked or denied."),
  ),
  /** The sites the user has set exceptions for (a site with none follows the browser's rules). */
  call("sites.rules", z.object({})),
  /** Set a site's exceptions (it and its subdomains): never visited, and actions set for it; null: none (the site follows the browser's rules). */
  call("sites.permit", z.object({ site: Site, rule: SiteEntry.nullable() })),
  /** The sites the browsers keep logins for (from the user's own sign-ins), with how many cookies. */
  call("logins.list", z.object({})),
  /** Sign the browsers out of a site: its kept logins go, from every open browser too. */
  call("logins.forget", z.object({ site: z.string().min(1).max(253) })),
  /** Every approval asked in any chat, newest first, with the chat it is in: what was allowed or denied, and when. */
  call("approvals.list", z.object({})),
  /** The user's goals, active first, newest first. */
  call("goals.list", z.object({})),
  /** A goal in full: what it is, and its log, newest first. */
  call("goals.get", z.object({ id: z.string().min(1).max(100) })),
  /** Add a goal: what the user wants, and anything more about it. */
  call("goals.add", z.object({ title: z.string().trim().min(1).max(200), about: z.string().max(4000) })),
  /** Answer a card that asks for a secret: the code (typed into its terminal, kept nowhere), or the fields of a long-term secret (kept in the Vault); null declines. */
  call("secret.answer", z.object({ id: Id, answer: SecretAnswer.nullable() })),
  /** The Vault: every entry, plain fields in full, secret fields never. */
  call("secrets.list", z.object({})),
  /** Add an entry, with the uses (the user's own word for them). */
  call("secrets.add", z.object({ name: z.string().trim().min(1).max(100), note: z.string().max(2000), plain: z.array(PlainInput).max(20), secret: z.array(SecretInput).min(1).max(20), uses: z.array(UseInput).max(20) })),
  /** Change an entry's name, its note and its plain fields (the whole list: one left out is taken away, unless it has uses). */
  call("secrets.edit", z.object({ id: Id, name: z.string().trim().min(1).max(100), note: z.string().max(2000), plain: z.array(PlainInput).max(20) })),
  /** Set a secret field: a new one is added, one of that name has its value replaced (never read back). */
  call("secrets.setSecret", z.object({ id: Id, field: SecretInput })),
  /** One secret field's value, as text, for the user to see or copy (the Vault's only way to read a secret back; a sign-in's tokens are refused). */
  call("secrets.reveal", z.object({ id: Id, field: FieldName })),
  /** Take a secret field away, with its uses; an entry keeps at least one. */
  call("secrets.removeSecret", z.object({ id: Id, name: FieldName })),
  /** Add a use to an entry. */
  call("secrets.use", z.object({ id: Id, use: UseInput })),
  /** Take a use away (from the sandbox too). */
  call("secrets.unuse", z.object({ id: Id, use: Id })),
  /** Remove an entry, with its uses (from the sandbox too). */
  call("secrets.remove", z.object({ id: Id })),
  /** Every skill: the user's first, then the built-in ones. */
  call("skills.list", z.object({})),
  /** A skill in full: what it says, and the files in its folder (the user's own). */
  call("skills.get", z.object({ name: z.string().min(1).max(100), origin: SkillOrigin })),
  /** Remove one of the user's skills (its folder in skills/); a built-in one stays. */
  call("skills.remove", z.object({ name: z.string().min(1).max(100) })),
  /** Finish a goal or take it up again (its schedules rest while it is done), or mute it or not. */
  call("goals.update", z.object({ id: z.string().min(1).max(100), status: GoalStatus.optional(), muted: z.boolean().optional() })),
  /** The providers there are for keys, which are set up, the models they offer and the ones chosen. */
  call("keys.list", z.object({})),
  /**
   * The same list once the providers' own model catalogs have been fetched over the network (what opening Settings ›
   * Models does, so a model a provider added since this version shows up). A provider that cannot be fetched keeps the
   * models it has, and nothing is said about it.
   */
  call("keys.refresh", z.object({})),
  /** Start setting up a provider: with its key (the default), or by signing in with the user's account there. Its first step. */
  call("keys.login", z.object({ provider: z.string().min(1).max(100), way: KeyWay.optional() })),
  /** Answer a sign-in's prompt: the next step. */
  call("keys.answer", z.object({ login: z.string().min(1).max(100), value: z.string().max(8192) })),
  /** A sign-in's next step once the user has finished on the provider's page; after about 20 seconds without one, the step as it stands. */
  call("keys.wait", z.object({ login: z.string().min(1).max(100) })),
  call("keys.cancel", z.object({ login: z.string().min(1).max(100) })),
  /** Try a provider's key: one short request with it (a model of theirs; the apps' directory for Composio). */
  call("keys.test", z.object({ provider: z.string().min(1).max(100) })),
  /** Forget a provider's key. */
  call("keys.logout", z.object({ provider: z.string().min(1).max(100) })),
  /** Choose the model Muse chats with, or the one that works in the browser (it must see pictures). */
  /** null: back to the default (only the background's: the chat's model) */
  call("models.choose", z.object({ role: ModelRole, model: ModelRef.nullable() })),
  /** How much the chat's or the browser's model thinks (one of the levels its model takes). */
  call("models.think", z.object({ role: ModelRole, level: ThinkingLevel })),
  /** Which speech service turns the mic into text (by provider); null: the first one with a key. */
  call("models.voice", z.object({ provider: z.string().min(1).max(100).nullable() })),
  /** Set up (or, null, remove) a speech server the user runs themselves; `key` only if it wants one. */
  call("models.localVoice", z.object({ service: LocalVoice.extend({ key: z.string().max(8192).nullable() }).nullable() })),
  /** Stop what runs in the sandbox and wipe its home folder; the workspace is kept, and system-wide installs stay until the container is recreated. */
  call("sandbox.reset", z.object({})),
  /** Folders in the sandbox's home folder, outside the workspace, that a reset would delete: what the confirmation names, so work kept there can be moved out first. */
  call("sandbox.atRisk", z.object({})),
]);

export type Call = z.infer<typeof Call>;
export type Method = Call["method"];

const done = z.null();

export const results = {
  /** Events since `since` when the server still has them, else a snapshot of the recent end of the feed. */
  "session.sync": z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("events"), events: z.array(Envelope) }),
    z.object({ kind: z.literal("snapshot"), state: State }),
  ]),
  "session.history": Page,
  "chat.send": z.object({ id: Id }),
  "chat.stop": done,
  "chat.retry": done,
  "chats.list": z.object({ chats: z.array(Chat) }),
  "chats.create": Chat,
  "chats.rename": done,
  "chats.delete": done,
  "approval.resolve": done,
  "connection.begin": z.object({ url: z.url() }),
  "connection.dismiss": done,
  "browser.control": done,
  "browser.fit": done,
  "browser.open": z.object({ id: Id }),
  "task.stop": done,
  "schedules.list": z.object({ schedules: z.array(Schedule) }),
  "schedule.control": done,
  "apps.search": z.object({ apps: z.array(App), cursor: z.string().nullable() }),
  "apps.accounts": z.object({ accounts: z.array(Account) }),
  "apps.connect": z.object({ url: z.url() }),
  "apps.access": z.object({ access: AppAccess }),
  "apps.connectKey": done,
  "apps.disconnect": done,
  "apps.permissions": z.object({ rules: z.array(KindRule) }),
  "apps.permit": done,
  "browser.rules": z.object({ rules: z.array(BrowserRule) }),
  "browser.permit": done,
  "sites.rules": z.object({ rules: z.array(SiteRule) }),
  "sites.permit": done,
  "logins.list": z.object({ sites: z.array(z.object({ site: z.string(), cookies: z.int() })) }),
  "logins.forget": done,
  "approvals.list": z.object({ approvals: z.array(z.object({ chat: Chat, approval: Approval })) }),
  "goals.list": z.object({ goals: z.array(Goal) }),
  "goals.get": z.object({ goal: Goal, log: z.array(GoalNote) }),
  "goals.add": Goal,
  "goals.update": done,
  "secret.answer": done,
  "secrets.list": z.object({ entries: z.array(SecretEntry) }),
  "secrets.add": z.object({ id: Id }),
  "secrets.edit": done,
  "secrets.setSecret": done,
  "secrets.reveal": z.object({ value: z.string() }),
  "secrets.removeSecret": done,
  "secrets.use": z.object({ use: Use }),
  "secrets.unuse": done,
  "secrets.remove": done,
  "skills.list": z.object({ skills: z.array(SkillInfo) }),
  "skills.get": z.object({ skill: SkillInfo, body: z.string(), files: z.array(z.string()) }),
  "skills.remove": done,
  "keys.list": KeysState,
  "keys.refresh": KeysState,
  "keys.login": LoginStep,
  "keys.answer": LoginStep,
  "keys.wait": LoginStep,
  "keys.cancel": done,
  "keys.test": KeyTest,
  "keys.logout": done,
  "models.choose": done,
  "models.think": done,
  "models.voice": done,
  "models.localVoice": done,
  "sandbox.reset": done,
  "sandbox.atRisk": z.object({ folders: z.array(AtRiskFolder) }),
} satisfies Record<Method, z.ZodType>;

export type Params = { [C in Call as C["method"]]: C["params"] };
export type Results = { [M in Method]: z.infer<(typeof results)[M]> };

/**
 * Result parsers keyed by method. The mapped type keeps each method's own
 * result type, so a client generic over M gets Results[M] back without casts.
 */
export const parseResult: { [M in Method]: (raw: unknown) => Results[M] } = {
  "session.sync": (raw) => results["session.sync"].parse(raw),
  "session.history": (raw) => results["session.history"].parse(raw),
  "chat.send": (raw) => results["chat.send"].parse(raw),
  "chat.stop": (raw) => results["chat.stop"].parse(raw),
  "chat.retry": (raw) => results["chat.retry"].parse(raw),
  "chats.list": (raw) => results["chats.list"].parse(raw),
  "chats.create": (raw) => results["chats.create"].parse(raw),
  "chats.rename": (raw) => results["chats.rename"].parse(raw),
  "chats.delete": (raw) => results["chats.delete"].parse(raw),
  "approval.resolve": (raw) => results["approval.resolve"].parse(raw),
  "connection.begin": (raw) => results["connection.begin"].parse(raw),
  "connection.dismiss": (raw) => results["connection.dismiss"].parse(raw),
  "browser.control": (raw) => results["browser.control"].parse(raw),
  "browser.fit": (raw) => results["browser.fit"].parse(raw),
  "browser.open": (raw) => results["browser.open"].parse(raw),
  "task.stop": (raw) => results["task.stop"].parse(raw),
  "schedules.list": (raw) => results["schedules.list"].parse(raw),
  "schedule.control": (raw) => results["schedule.control"].parse(raw),
  "apps.search": (raw) => results["apps.search"].parse(raw),
  "apps.accounts": (raw) => results["apps.accounts"].parse(raw),
  "apps.connect": (raw) => results["apps.connect"].parse(raw),
  "apps.access": (raw) => results["apps.access"].parse(raw),
  "apps.connectKey": (raw) => results["apps.connectKey"].parse(raw),
  "apps.disconnect": (raw) => results["apps.disconnect"].parse(raw),
  "apps.permissions": (raw) => results["apps.permissions"].parse(raw),
  "apps.permit": (raw) => results["apps.permit"].parse(raw),
  "browser.rules": (raw) => results["browser.rules"].parse(raw),
  "browser.permit": (raw) => results["browser.permit"].parse(raw),
  "sites.rules": (raw) => results["sites.rules"].parse(raw),
  "sites.permit": (raw) => results["sites.permit"].parse(raw),
  "logins.list": (raw) => results["logins.list"].parse(raw),
  "logins.forget": (raw) => results["logins.forget"].parse(raw),
  "approvals.list": (raw) => results["approvals.list"].parse(raw),
  "goals.list": (raw) => results["goals.list"].parse(raw),
  "goals.get": (raw) => results["goals.get"].parse(raw),
  "goals.add": (raw) => results["goals.add"].parse(raw),
  "goals.update": (raw) => results["goals.update"].parse(raw),
  "secret.answer": (raw) => results["secret.answer"].parse(raw),
  "secrets.list": (raw) => results["secrets.list"].parse(raw),
  "secrets.add": (raw) => results["secrets.add"].parse(raw),
  "secrets.edit": (raw) => results["secrets.edit"].parse(raw),
  "secrets.setSecret": (raw) => results["secrets.setSecret"].parse(raw),
  "secrets.reveal": (raw) => results["secrets.reveal"].parse(raw),
  "secrets.removeSecret": (raw) => results["secrets.removeSecret"].parse(raw),
  "secrets.use": (raw) => results["secrets.use"].parse(raw),
  "secrets.unuse": (raw) => results["secrets.unuse"].parse(raw),
  "secrets.remove": (raw) => results["secrets.remove"].parse(raw),
  "skills.list": (raw) => results["skills.list"].parse(raw),
  "skills.get": (raw) => results["skills.get"].parse(raw),
  "skills.remove": (raw) => results["skills.remove"].parse(raw),
  "keys.list": (raw) => results["keys.list"].parse(raw),
  "keys.refresh": (raw) => results["keys.refresh"].parse(raw),
  "keys.login": (raw) => results["keys.login"].parse(raw),
  "keys.answer": (raw) => results["keys.answer"].parse(raw),
  "keys.wait": (raw) => results["keys.wait"].parse(raw),
  "keys.cancel": (raw) => results["keys.cancel"].parse(raw),
  "keys.test": (raw) => results["keys.test"].parse(raw),
  "keys.logout": (raw) => results["keys.logout"].parse(raw),
  "models.choose": (raw) => results["models.choose"].parse(raw),
  "models.think": (raw) => results["models.think"].parse(raw),
  "models.voice": (raw) => results["models.voice"].parse(raw),
  "models.localVoice": (raw) => results["models.localVoice"].parse(raw),
  "sandbox.reset": (raw) => results["sandbox.reset"].parse(raw),
  "sandbox.atRisk": (raw) => results["sandbox.atRisk"].parse(raw),
};

/** What a server implements: one function per method. */
export type Handlers = { [M in Method]: (params: Params[M]) => Promise<Results[M]> };

/** Route a parsed call to its handler. Generic over M, so no casts are needed. */
export function dispatch<M extends Method>(
  handlers: Handlers,
  call: { method: M; params: Params[M] },
): Promise<Results[M]> {
  return handlers[call.method](call.params);
}

/* ---------- JSON-RPC 2.0 framing ---------- */

export const RpcId = z.union([z.int(), z.string()]);

/** Framing only; `Call` parses method + params, so unknown methods and bad params get distinct errors. */
export const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string(),
  params: z.unknown(),
});

/** `data`: for a rejected command, the rejection itself (`{ kind, … }`, core/src/decide.ts), so a client can say it in its own words. */
export const RpcError = z.object({ code: z.int(), message: z.string(), data: z.unknown().optional() });

export const Response = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId.nullable(), error: RpcError }),
]);

/** The only notification, server → client: a chat's event, or the chats as they now are. */
export const Notification = z.object({ jsonrpc: z.literal("2.0"), method: z.literal("push"), params: Push });

export const errors = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  /** A sensitive call (api/src/sensitive.ts) on a session the PIN has not unlocked: the client asks for the PIN, then calls again. */
  /** A command the rules refused (core's `Rejection`): `data` says which, `message` is English for the agent's tools and logs. */
  rejected: { code: -32000, message: "Rejected" },
  pinLocked: { code: -32001, message: "Enter your PIN to do this." },
  /** A sensitive call before any PIN is set: the client asks for one to be set first. */
  pinUnset: { code: -32002, message: "Set a PIN first: it authorizes sensitive actions." },
} as const satisfies Record<string, z.infer<typeof RpcError>>;

export type Request = z.infer<typeof Request>;
export type Response = z.infer<typeof Response>;
export type Notification = z.infer<typeof Notification>;
