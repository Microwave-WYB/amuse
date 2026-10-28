/**
 * The network edge: an HTTP server — the built web app, the way in (/setup,
 * /unlock, /lock, /password), the account (/account: the PIN and the devices),
 * /thumb, /files (uploads and the files themselves) and /connected — with three
 * WebSocket routes: /rpc (one shared Session, one Peer per socket),
 * /live?id=<run> (a run's live browser view) and /terminal?cols=<n>&rows=<n>
 * (the sandbox's terminals). Requests authenticate with the HttpOnly session
 * cookie the master password opens on a trusted device (access.ts). Browsers
 * may open the sockets, and post to the way in and the account, only from this
 * origin; anything else is refused. So is every request, whatever it asks, from
 * an address given to `refuse` (the sandbox's network), and every request that
 * carries Amuse's own browsers' mark (AGENT_MARK), however Amuse is reached.
 *
 * A sensitive call on /rpc (sensitive.ts), and the account's sensitive changes
 * here, need the session to be unlocked with the PIN (pin.ts): the server
 * checks it for each, so no client can skip it.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { pipeline } from "node:stream";
import { PREVIEW_WIDTHS, type Session } from "@amuse/protocol";
import type { WebSocket } from "ws";
import { Cols, Rows } from "@amuse/sandbox";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { Call } from "@amuse/protocol";
import { type Access, PasswordRejected, type Seen } from "./access.ts";
import { type Pin, PinRejected, PinRequired, type Tried, type Unlocks, LENGTHS, wellFormed } from "./pin.ts";
import { type FileStore, shownInline } from "./workspace.ts";
import { previews, scalable, scaled } from "./images.ts";
import { type Live, attach, thumbnail } from "./live.ts";
import { serve } from "./rpc.ts";
import { TERMINAL_CLOSED, attachTerminal } from "./terminal.ts";
import { staticFiles } from "./static.ts";

export interface Options {
  session: Session;
  /** Live browser views at /live?id=<run>; off when absent. */
  live?: Live;
  /** The sandbox's terminals at /terminal?cols=<n>&rows=<n>: where the daemon shows one that size; off when absent. */
  terminal?: (cols: number, rows: number) => string;
  /** The user's files: POST /files uploads one, GET /files/<id> serves it; off when absent. */
  files?: FileStore;
  /** Directory of the built web app to serve over HTTP; 404 for everything when absent. */
  web?: string;
  /** The user's browser is back from a connector's hosted page with a one-time key (GET /connected?key=…). */
  returned?: (key: string) => Promise<boolean>;
  access: Access;
  /** The PIN, and the unlocks it opened (pin.ts). */
  pin: Pin;
  unlocks: Unlocks;
  /** Whether an RPC call needs the PIN (sensitive.ts). */
  sensitive: (call: Call) => Promise<boolean>;
  /** Whether the server turns away everything from this remote address (the sandbox's network: it has no business here, signed in or not). */
  refuse?: (address: string | undefined) => boolean;
  /** Speech to text for the composer's mic (POST /transcribe); off when absent. The reason, in words, when it cannot. */
  transcribe?: (audio: Uint8Array, type: string) => Promise<{ text: string } | { reason: string }>;
  port: number;
  host: string;
}

const cookieName = "amuse";
/** the device's own cookie: it stays when the session ends, so a trusted device signs in again without approval */
const deviceCookie = "amuse-device";
/**
 * The header Amuse's own browsers are to put on every request: a request that carries it is turned away, on every route,
 * the way in included, so Amuse never signs in to its own app, and never even asks to. The browsers do not send it yet
 * (compose.browsers.yaml says why); their Chrome policy blocks Amuse's address meanwhile.
 */
export const AGENT_MARK = "x-amuse-agent";
/** how often the open sockets are checked against their sessions (a session ended by `amuse-admin`, in another process) */
const SWEEP_MS = 30_000;

/** decodeURIComponent that never throws: a malformed value is simply no session. */
function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** A cookie the request carries, if any. Hostile input can only fail to match; it never throws. */
function cookieIn(req: IncomingMessage, wanted: string): string | null {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === wanted)?.[1];
  return cookie === undefined ? null : decoded(cookie);
}
/** The session a request carries in its cookie, if any. */
const presented = (req: IncomingMessage) => cookieIn(req, cookieName);

/** What a request says of its device, for the card that approves it: its browser, and where it came from (through a proxy, what the proxy says). */
function seenOf(req: IncomingMessage): Seen {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return { agent: String(req.headers["user-agent"] ?? ""), address: forwarded || req.socket.remoteAddress || "" };
}

const Password = z.string().min(1).max(1024);
const PinText = z.string().max(64);
const SetUp = z.object({ password: Password, pin: PinText });
const SignIn = z.object({ password: Password });
const Change = z.object({ current: Password, next: Password });
const PinGiven = z.object({ pin: PinText });
const PinSet = z.object({ password: Password, pin: PinText });
/** Turning the PIN off: the password always, and the PIN there is, when there is one. */
const PinOff = z.object({ password: Password, pin: PinText.optional() });
const Minutes = z.object({ minutes: z.int() });
const DeviceGiven = z.object({ id: z.string().min(1).max(100) });

/** The longest recording taken (the services take 25 MB). */
const MAX_SPEECH = 25 * 1024 * 1024;

/** Wrong passwords a client may try in a window before it has to wait. */
const TRIES = 10;
const TRY_WINDOW_MS = 15 * 60_000;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Target = { kind: "rpc" } | { kind: "live"; id: string; live: Live } | { kind: "terminal"; at: string | null };

/** A running server: where it listens, and how to stop it (sockets included). */
export interface Listening {
  port: number;
  close(): Promise<void>;
}

export function listen({ session, live, terminal, files: uploads, web, returned, access, pin, unlocks, sensitive, refuse, transcribe, port, host }: Options): Promise<Listening> {
  const route = (url: URL): Target | null => {
    if (url.pathname === "/rpc") return { kind: "rpc" };
    // without a sandbox the socket opens only to say so (the viewer shows "no terminals here")
    if (url.pathname === "/terminal") {
      const cols = Cols.safeParse(Number(url.searchParams.get("cols")));
      const rows = Rows.safeParse(Number(url.searchParams.get("rows")));
      return { kind: "terminal", at: terminal ? terminal(cols.success ? cols.data : 80, rows.success ? rows.data : 24) : null };
    }
    const id = url.searchParams.get("id");
    return url.pathname === "/live" && live && id ? { kind: "live", id, live } : null;
  };
  const files = web ? staticFiles(web) : null;
  /** a request with no session carries "", which is never one */
  const allowed = (req: IncomingMessage) => access.valid(presented(req) ?? "");
  /** The open sockets, with the session each was opened with. */
  const held = new Map<WebSocket, string>();
  /** Close the sockets whose session has ended (signed out, a device revoked, the password changed). */
  const sweep = () => {
    for (const [ws, mine] of held) if (!access.valid(mine)) ws.terminate();
  };
  /** A page of this origin (or no page: a script); a page elsewhere may not. */
  const ours = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  };

  /** Wrong passwords lately, by client address. */
  const tries = new Map<string, number[]>();
  const recent = (req: IncomingMessage) => {
    const now = Date.now();
    const key = req.socket.remoteAddress ?? "";
    const kept = (tries.get(key) ?? []).filter((t) => now - t < TRY_WINDOW_MS);
    tries.set(key, kept);
    return { count: kept.length, miss: () => kept.push(now) };
  };

  const cookie = (req: IncomingMessage, session: string | null, name = cookieName) => {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return session === null
      ? `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
      : `${name}=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${name === deviceCookie ? 10 * 31536000 : 31536000}${secure}`;
  };
  /** The cookies an entry gives: its session, and the device's own when it has a new one. */
  const entered = (req: IncomingMessage, entry: { device: string | null; session?: string }) => [
    ...(entry.session !== undefined ? [cookie(req, entry.session)] : []),
    ...(entry.device !== null ? [cookie(req, entry.device, deviceCookie)] : []),
  ];
  const body = async (req: IncomingMessage): Promise<unknown> => {
    let text = "";
    for await (const chunk of req) {
      text += String(chunk);
      if (text.length > 4096) return null;
    }
    return parseJson(text);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    void res
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(value));

  /**
   * The way in. GET /unlock → 204 when this browser is in, 202 { waiting } while
   * this device waits for a trusted one's approval (the poll that finds it
   * approved gets its session), else 401 with whether the password is set yet.
   * POST /setup {password, pin} sets both (the first time only), and trusts this
   * device; POST /unlock {password} opens a session on a trusted device, or makes
   * this one wait (202); POST /lock ends this session; POST /password {current,
   * next} changes it (behind the PIN), ending every other session. Posts come as
   * JSON from this origin only, so no other page can send them.
   */
  const way = async (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const device = cookieIn(req, deviceCookie);
    if (url.pathname === "/unlock" && req.method === "GET") {
      if (allowed(req)) {
        // a device signed in before devices were known gets its own cookie now
        const claimed = access.deviceOf(presented(req) ?? "")?.cookie ?? null;
        return void res.writeHead(204, { "cache-control": "no-store", ...(claimed ? { "set-cookie": cookie(req, claimed, deviceCookie) } : {}) }).end();
      }
      const admitted = access.admitted(device, seenOf(req));
      if (admitted?.kind === "in") return void res.writeHead(204, { "cache-control": "no-store", "set-cookie": entered(req, admitted) }).end();
      if (access.waiting(device)) return json(res, 202, { waiting: true });
      return json(res, 401, { ready: access.ready() });
    }
    if (req.method !== "POST") return void res.writeHead(405).end();
    if (!ours(req) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return void res.writeHead(403).end();
    if (url.pathname === "/lock") {
      const session = presented(req);
      if (session !== null) {
        unlocks.lock(session);
        access.logout(session);
        sweep();
      }
      return void res.writeHead(204, { "set-cookie": cookie(req, null) }).end();
    }
    const tried = recent(req);
    if (tried.count >= TRIES)
      return json(res, 429, {
        reason: "Too many wrong passwords. Try again in a few minutes.",
      });
    try {
      if (url.pathname === "/setup") {
        const given = SetUp.safeParse(await body(req));
        if (!given.success) return void res.writeHead(400).end();
        if (!wellFormed(given.data.pin)) return json(res, 400, { reason: "A PIN is 6 digits." });
        const entry = await access.setup(given.data.password, device, seenOf(req));
        if (entry.kind !== "in") return void res.writeHead(500).end();
        await pin.set(given.data.pin);
        unlocks.open(entry.session);
        return void res.writeHead(204, { "set-cookie": entered(req, entry) }).end();
      }
      if (url.pathname === "/unlock") {
        const given = SignIn.safeParse(await body(req));
        if (!given.success) return void res.writeHead(400).end();
        const entry = await access.login(given.data.password, device, seenOf(req));
        if (entry === null) {
          tried.miss();
          return json(res, 401, { reason: "That is not the password." });
        }
        if (entry.kind === "waiting") return void res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", "set-cookie": entered(req, entry) }).end(JSON.stringify({ waiting: true }));
        return void res.writeHead(204, { "set-cookie": entered(req, entry) }).end();
      }
      if (url.pathname === "/password") {
        const session = presented(req);
        if (session === null || !access.valid(session)) return void res.writeHead(401).end();
        const given = Change.safeParse(await body(req));
        if (!given.success) return void res.writeHead(400).end();
        unlocks.require(session);
        const next = await access.change(session, given.data.current, given.data.next);
        if (next === null) {
          tried.miss();
          return json(res, 401, {
            reason: "That is not the current password.",
          });
        }
        sweep();
        return void res.writeHead(204, { "set-cookie": cookie(req, next) }).end();
      }
    } catch (error) {
      if (error instanceof PasswordRejected) return json(res, 400, { reason: error.message });
      if (error instanceof PinRequired) return json(res, 403, { pin: error.need, reason: error.message });
      throw error;
    }
    return void res.writeHead(404).end();
  };

  /**
   * The account, for a session (JSON from this origin, as the way in):
   *   GET  /account                    the PIN's state (set, reminder, locked until, unlock length, this session's unlock) and the devices
   *   POST /account/pin                {password, pin}: set the PIN; a new one also needs the PIN unlocked. Unlocks this session
   *   POST /account/pin/unlock         {pin}: unlock this session; 401 { left } for a wrong one, 429 { until } while it is locked
   *   POST /account/pin/check          {pin}: the weekly reminder: as unlock, but it opens nothing
   *   POST /account/pin/lock           lock this session now ("Lock now", or the app going to the background)
   *   POST /account/pin/later          put the reminder off for a day, for every device
   *   POST /account/pin/minutes        {minutes}: how long an unlock lasts; a longer one needs the PIN
   *   POST /account/pin/off            {password, pin?}: turn the PIN off (the password, and the PIN there is when there is one);
   *                                    sensitive actions then go through and nothing is asked, until a PIN is set again
   *   POST /account/devices/approve    {id}: let a waiting device in (needs the PIN)
   *   POST /account/devices/deny       {id}: turn a waiting device away
   *   POST /account/devices/revoke     {id}: stop trusting a device, ending its sessions (needs the PIN)
   * A change that needs the PIN without an unlock is 403 { pin: "unset" | "locked" }.
   */
  const account = async (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const session = presented(req);
    if (session === null || !access.valid(session)) return void res.writeHead(401).end();
    if (url.pathname === "/account" && req.method === "GET")
      return json(res, 200, {
        pin: { set: pin.isSet(), reminder: pin.reminder(), locked: pin.locked(), minutes: pin.minutes(), unlocked: unlocks.until(session) },
        device: access.deviceOf(session)?.id ?? null,
        devices: access.devices(),
      });
    if (req.method !== "POST") return void res.writeHead(405).end();
    if (!ours(req) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return void res.writeHead(403).end();
    const done = () => void res.writeHead(204, { "cache-control": "no-store" }).end();
    /** a try at the PIN, said as the app shows it */
    const answer = (tried: Tried, right: () => void) => {
      if (tried.kind === "right") return (right(), done());
      if (tried.kind === "locked") return json(res, 429, { until: tried.until, reason: "Too many wrong tries: the PIN is locked for now." });
      return json(res, 401, { left: tried.left, reason: "That is not the PIN." });
    };
    try {
      const data = await body(req);
      switch (url.pathname) {
        case "/account/pin": {
          const given = PinSet.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          if (!wellFormed(given.data.pin)) return json(res, 400, { reason: "A PIN is 6 digits." });
          if (pin.isSet()) unlocks.require(session);
          const tried = recent(req);
          if (tried.count >= TRIES) return json(res, 429, { reason: "Too many wrong passwords. Try again in a few minutes." });
          if (!(await access.matches(given.data.password))) {
            tried.miss();
            return json(res, 401, { reason: "That is not the password." });
          }
          await pin.set(given.data.pin);
          unlocks.open(session);
          return done();
        }
        case "/account/pin/off": {
          const given = PinOff.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          const tried = recent(req);
          if (tried.count >= TRIES) return json(res, 429, { reason: "Too many wrong passwords. Try again in a few minutes." });
          if (!(await access.matches(given.data.password))) {
            tried.miss();
            return json(res, 401, { reason: "That is not the password." });
          }
          // turning off what is there is a loosening: the PIN itself has to be entered, and a wrong one counts as a try
          if (pin.isSet()) {
            if (given.data.pin === undefined) return json(res, 400, { reason: "Enter your PIN to turn it off." });
            const outcome = await pin.check(given.data.pin);
            if (outcome.kind === "locked") return json(res, 429, { until: outcome.until, reason: "Too many wrong tries: the PIN is locked for now." });
            if (outcome.kind === "wrong") return json(res, 401, { left: outcome.left, reason: "That is not the PIN." });
          }
          pin.turnOff();
          return done();
        }
        case "/account/pin/unlock":
        case "/account/pin/check": {
          const given = PinGiven.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          if (!pin.isSet()) return json(res, 403, { pin: "unset", reason: new PinRequired("unset").message });
          return answer(await pin.check(given.data.pin), () => {
            if (url.pathname === "/account/pin/unlock") unlocks.open(session);
          });
        }
        case "/account/pin/lock":
          unlocks.lock(session);
          return done();
        case "/account/pin/later":
          pin.later();
          return done();
        case "/account/pin/minutes": {
          const given = Minutes.safeParse(data);
          if (!given.success || !LENGTHS.includes(given.data.minutes)) return void res.writeHead(400).end();
          // a shorter unlock only takes away
          if (given.data.minutes > pin.minutes()) unlocks.require(session);
          pin.setMinutes(given.data.minutes);
          return done();
        }
        case "/account/devices/approve": {
          const given = DeviceGiven.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          unlocks.require(session);
          return access.approve(given.data.id) ? done() : json(res, 404, { reason: "That device is no longer waiting." });
        }
        case "/account/devices/deny": {
          const given = DeviceGiven.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          access.deny(given.data.id);
          return done();
        }
        case "/account/devices/revoke": {
          const given = DeviceGiven.safeParse(data);
          if (!given.success) return void res.writeHead(400).end();
          unlocks.require(session);
          access.revoke(given.data.id);
          sweep();
          return done();
        }
      }
    } catch (error) {
      if (error instanceof PinRequired) return json(res, 403, { pin: error.need, reason: error.message });
      if (error instanceof PinRejected) return json(res, 400, { reason: error.message });
      throw error;
    }
    return void res.writeHead(404).end();
  };

  /** POST /transcribe (the recording as the body, its type in Content-Type) → { text } or, when it cannot be, { reason }. */
  const speech = async (req: IncomingMessage, res: ServerResponse) => {
    if (!transcribe) return void res.writeHead(404).end();
    if (req.method !== "POST" || !ours(req) || !allowed(req)) return void res.writeHead(req.method === "POST" ? 401 : 405).end();
    const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    if (!type.startsWith("audio/") && type !== "video/webm") return void res.writeHead(415).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += piece.length;
      if (size > MAX_SPEECH) return void res.writeHead(413).end();
      chunks.push(piece);
    }
    const said = await transcribe(new Uint8Array(Buffer.concat(chunks)), String(req.headers["content-type"] ?? ""));
    json(res, "text" in said ? 200 : 400, said);
  };

  /** GET /thumb?id=<run> → a screenshot of the run's page, for its card. */
  const thumb = async (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const id = url.searchParams.get("id");
    const image = live && id && allowed(req) ? await thumbnail(live, id) : null;
    if (!image) return void res.writeHead(404).end();
    res
      .writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      })
      .end(image);
  };
  /**
   * POST /files (the bytes as the body; the name in X-File-Name, URI-encoded; the
   * type in Content-Type) → the Attachment, to send with a message.
   * GET /files/<id> → the file. Images and videos are shown in the page; anything
   * else only downloads. Nothing served runs: no sniffing, and a sandbox for
   * whatever is opened on its own.
   * GET /files/<id>?w=<one of PREVIEW_WIDTHS> → a picture scaled down to that width, as WebP, for the chat (images.ts);
   * anything that is not a picture to scale, or one that cannot be read, comes as it is.
   */
  const copies = previews();
  const file = async (req: IncomingMessage, url: URL, res: ServerResponse) => {
    if (!uploads || !allowed(req)) return void res.writeHead(uploads ? 401 : 404).end();
    if (url.pathname === "/files" && req.method === "POST") {
      const name = decoded(String(req.headers["x-file-name"] ?? "")) ?? "";
      const type =
        String(req.headers["content-type"] ?? "")
          .split(";")[0]
          ?.trim() ?? "";
      const saved = await uploads.save(name, type, req);
      if (!saved) return void res.writeHead(413).end();
      return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(saved));
    }
    // opened by the workspace, never through a link; the size is as it is now (Amuse may have rewritten it)
    const found = req.method === "GET" ? await uploads.serve(url.pathname.slice("/files/".length)) : null;
    if (!found) return void res.writeHead(404).end();
    const { attachment, size, handle } = found;
    const inline = shownInline(attachment.type);
    const headers = {
      "content-type": inline ? attachment.type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=31536000, immutable",
      "accept-ranges": "bytes",
    };
    const width = Number(url.searchParams.get("w"));
    if (PREVIEW_WIDTHS.some((w) => w === width) && scalable(attachment.type)) {
      const { mtimeMs } = await handle.stat();
      let original: Buffer | undefined;
      // a copy of the file as it is now: one Amuse has rewritten is scaled again
      const copy = await copies
        .get(`${attachment.id} ${size} ${mtimeMs} ${width}`, async () => scaled((original = await handle.readFile()), width))
        .catch(() => null);
      // not a picture after all: its bytes as they are, if they were read
      const sent = copy ?? original;
      if (sent) {
        await handle.close();
        const name = copy ? `${attachment.name.replace(/\.[^.]*$/, "")}.webp` : attachment.name;
        return void res
          .writeHead(200, {
            ...headers,
            "content-type": copy ? "image/webp" : attachment.type,
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            "accept-ranges": "none",
            "content-length": sent.length,
          })
          .end(sent);
      }
    }
    // a video seeks by asking for a range of it
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        await handle.close();
        return void res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      }
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      return void pipeline(handle.createReadStream({ start, end }), res, () => {});
    }
    res.writeHead(200, { ...headers, "content-length": size });
    pipeline(handle.createReadStream(), res, () => {});
  };
  /** GET /connected?key=… → check the connection now, then tell the user they can go back. */
  const back = async (url: URL, res: ServerResponse) => {
    const key = url.searchParams.get("key");
    const connected = key && returned ? await returned(key) : false;
    const message = connected ? "Connected — you can close this tab and go back to Amuse." : "Thanks — you can close this tab and go back to Amuse.";
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>Amuse</title><p style="font:16px system-ui;text-align:center;margin-top:30vh">${message}</p><script>setTimeout(()=>window.close(),1500)</script>`,
    );
  };
  /** Turned away whatever it asks: the sandbox's network, or a request from Amuse's own browsers. */
  const turnedAway = (req: IncomingMessage) => refuse?.(req.socket.remoteAddress) === true || req.headers[AGENT_MARK] !== undefined;
  const http = createServer((req, res) => {
    if (turnedAway(req)) return void res.writeHead(403).end();
    const url = new URL(req.url ?? "/", "http://local");
    const handled = ["/setup", "/unlock", "/lock", "/password"].includes(url.pathname)
      ? way(req, url, res)
      : url.pathname === "/account" || url.pathname.startsWith("/account/")
        ? account(req, url, res)
      : url.pathname === "/thumb"
        ? thumb(req, url, res)
        : url.pathname === "/transcribe"
        ? speech(req, res)
        : url.pathname === "/files" || url.pathname.startsWith("/files/")
          ? file(req, url, res)
          : url.pathname === "/connected"
            ? back(url, res)
            : files
              ? files(req, res)
              : Promise.resolve(void res.writeHead(404).end());
    handled.catch(() => res.writeHead(500).end());
  });
  // noVNC viewers ask for the "binary" subprotocol; the RPC client asks for none
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (offered.has("binary") ? "binary" : false),
  });

  http.on("upgrade", (req, socket, head) => {
    if (turnedAway(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    const target = route(url);
    // a page elsewhere (even a sibling subdomain carrying the cookie) may not open our sockets
    if (!target || !ours(req) || !allowed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const mine = presented(req) ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      held.set(ws, mine);
      ws.on("close", () => held.delete(ws));
      if (target.kind === "live") return attach(ws, target.id, target.live);
      if (target.kind === "terminal") return target.at === null ? ws.close(TERMINAL_CLOSED.none, "no terminals") : attachTerminal(ws, target.at);
      // a sensitive call needs this socket's session unlocked, checked as it comes
      const peer = serve(session, (frame) => ws.send(frame), async (call) => {
        if (await sensitive(call)) unlocks.require(mine);
      });
      ws.on("message", (data, binary) => void (binary ? undefined : peer.receive(data.toString())));
      ws.on("close", peer.close);
    });
  });
  const swept = setInterval(sweep, SWEEP_MS);
  swept.unref();

  /** Upgraded sockets are no longer the HTTP server's to close: end them first, then stop listening. */
  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(swept);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      http.close(() => resolve());
    });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      const address = http.address();
      resolve({
        port: address !== null && typeof address === "object" ? address.port : port,
        close,
      });
    });
  });
}
