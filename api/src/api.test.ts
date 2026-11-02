import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHost, type Timers } from "@amuse/core";
import { demoPorts, seed } from "@amuse/demo";
import { type State, apply, empty } from "@amuse/protocol";
import { connect } from "./client.ts";
import { sqliteAccess } from "./access.ts";
import { letIn, noPin } from "./testing.ts";
import { sqlitePin, unlocks } from "./pin.ts";
import { migratedDatabase } from "@amuse/db";
import { listen } from "./server.ts";

/** Lets every request in: for what is not about the way in. */
const anyone = letIn();
/** Demo ports with no delays, so the scripted agent answers at once. */
const instant: Timers<number> = {
  set: (_, fn) => (queueMicrotask(fn), 0),
  clear: () => {},
};
/** The host's own deadlines (approvals timing out) never come in a test. */
const never: Timers<number> = { set: () => 0, clear: () => {} };

let base = "";
let close = () => {};
before(async () => {
  const server = await listen({
    session: createHost(demoPorts(instant), { seed: seed(), timers: never }),
    access: anyone,
    ...noPin,
    port: 0,
    host: "127.0.0.1",
  });
  base = `ws://127.0.0.1:${server.port}/rpc`;
  close = () => void server.close();
});
after(() => close());

/** Raw socket: send one frame, return the first reply that is not an event. */
async function raw(frame: string): Promise<unknown> {
  const ws = new WebSocket(`${base}`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const reply = new Promise<unknown>((resolve) =>
    ws.addEventListener("message", ({ data }) => {
      const msg: unknown = JSON.parse(String(data));
      if (typeof msg === "object" && msg !== null && !("method" in msg)) resolve(msg);
    }),
  );
  ws.send(frame);
  const result = await reply;
  ws.close();
  return result;
}

test("bad frames get the JSON-RPC error they deserve", async () => {
  assert.deepEqual(await raw("{"), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  assert.deepEqual(await raw(JSON.stringify({ id: 1 })), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid request" },
  });
  assert.deepEqual(await raw(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope", params: {} })), {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32601, message: "Method not found" },
  });
  const invalid = await raw(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "chat.send",
      params: { text: "" },
    }),
  );
  assert.ok(typeof invalid === "object" && invalid !== null && "error" in invalid);
  assert.deepEqual(
    await raw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "browser.control",
        params: { id: "b-seed1", action: "handBack" },
      }),
    ),
    {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32000, message: "cannot handBack from completed", data: { kind: "invalid", action: "handBack", from: "completed" } },
    },
  );
});

test("the client syncs, sends, and folds the streamed events into the same state as the server", async () => {
  const session = connect(`${base}`);
  const synced = await session.call("session.sync", {
    chat: "main",
    since: null,
  });
  assert.equal(synced.kind, "snapshot");
  let state: State = synced.kind === "snapshot" ? synced.state : empty;
  const done = new Promise<void>((resolve) =>
    session.subscribe((u) => {
      if (u.kind === "reset") return void (state = u.state);
      if (u.kind !== "event") return;
      state = apply(state, u.envelope);
      if (u.envelope.event.kind === "activity" && u.envelope.event.activity === null) resolve();
    }),
  );
  const { id } = await session.call("chat.send", {
    chat: "main",
    text: "over the wire",
    timezone: "UTC",
    attachments: [],
  });
  await done;
  assert.ok(state.entities.some((e) => e.id === id && e.kind === "prompt"));
  const last = state.entities.at(-1);
  assert.ok(last?.kind === "reply" && !last.streaming && last.text.includes("over the wire"));
  const server = await session.call("session.sync", {
    chat: "main",
    since: null,
  });
  assert.ok(server.kind === "snapshot");
  assert.deepEqual(server.state, state);
  session.close();
});

test("a server that comes back without its log resets the client instead of freezing it", async () => {
  const first = await listen({
    session: createHost(demoPorts(instant), { seed: seed(), timers: never }),
    access: anyone,
    ...noPin,
    port: 0,
    host: "127.0.0.1",
  });
  const url = `ws://127.0.0.1:${first.port}/rpc`;
  const session = connect(url);
  const synced = await session.call("session.sync", {
    chat: "main",
    since: null,
  });
  assert.ok(synced.kind === "snapshot" && synced.state.seq > 1);
  const reset = new Promise<number>((resolve) => session.subscribe((u) => (u.kind === "reset" ? resolve(u.state.seq) : undefined)));
  await first.close();
  // a fresh host with nothing in it, on the same port
  const second = await listen({
    session: createHost(demoPorts(instant), { timers: never }),
    access: anyone,
    ...noPin,
    port: first.port,
    host: "127.0.0.1",
  });
  assert.equal(await reset, 0);
  session.close();
  await second.close();
});

test("a client that reconnects receives the events it missed", async () => {
  const host = createHost(demoPorts(instant), { seed: seed(), timers: never });
  const first = await listen({
    session: host,
    access: anyone,
    ...noPin,
    port: 0,
    host: "127.0.0.1",
  });
  const reader = connect(`ws://127.0.0.1:${first.port}/rpc`);
  const synced = await reader.call("session.sync", {
    chat: "main",
    since: null,
  });
  assert.ok(synced.kind === "snapshot");
  let state: State = synced.state;
  reader.subscribe((u) => {
    if (u.kind === "event") state = apply(state, u.envelope);
    if (u.kind === "reset") state = u.state;
  });
  await first.close(); // the network goes away; the conversation does not
  const { id } = await host.call("chat.send", {
    chat: "main",
    text: "while you were away",
    timezone: "UTC",
    attachments: [],
  });
  const second = await listen({
    session: host,
    access: anyone,
    ...noPin,
    port: first.port,
    host: "127.0.0.1",
  });
  for (let i = 0; i < 60 && !state.entities.some((e) => e.id === id); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    state.entities.some((e) => e.id === id),
    "the missed prompt arrived after the reconnect",
  );
  reader.close();
  await second.close();
});

/** A server whose way in is real: a fresh instance, the password not set yet. */
async function guarded() {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const pin = sqlitePin(db);
  const server = await listen({
    session: createHost(demoPorts(instant), { timers: never }),
    access,
    pin,
    unlocks: unlocks(pin, access.valid),
    sensitive: async () => false,
    port: 0,
    host: "127.0.0.1",
  });
  const http = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${http}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  /** Every cookie a response sets, as a request sends them back. */
  const jar = (response: Response) => response.headers.getSetCookie().map((c) => c.split(";")[0] ?? "").join("; ");
  const { WebSocket: Ws } = await import("ws");
  const opens = (headers: Record<string, string>, path = "/rpc") =>
    new Promise((resolve) => {
      const ws = new Ws(`ws://127.0.0.1:${server.port}${path}`, { headers });
      ws.on("open", () => (ws.close(), resolve("open")));
      ws.on("error", () => resolve("refused"));
    });
  /** How a socket at `path` ended: refused, or the close code the server gave. */
  const ends = (headers: Record<string, string>, path: string) =>
    new Promise((resolve) => {
      const ws = new Ws(`ws://127.0.0.1:${server.port}${path}`, { headers });
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve("refused"));
    });
  return { http, post, cookieOf, jar, opens, ends, close: () => server.close() };
}

test("the first visit sets the master password and the PIN, and trusts its device; then the password opens a session there, an HttpOnly cookie that alone opens the socket", async () => {
  const { http, post, cookieOf, jar, opens, close } = await guarded();
  try {
    const before = await fetch(`${http}/unlock`);
    assert.equal(before.status, 401);
    assert.deepEqual(await before.json(), { ready: false });
    assert.equal(await opens({}), "refused");

    assert.equal((await post("/setup", { password: "short", pin: "135790" })).status, 400);
    assert.equal((await post("/setup", { password: "correct horse", pin: "1357" })).status, 400, "a PIN is six digits");
    assert.equal((await post("/setup", { password: "correct horse" })).status, 400, "the PIN is set with the password");
    const set = await post("/setup", { password: "correct horse", pin: "135790" });
    assert.equal(set.status, 204);
    assert.match(set.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    const first = cookieOf(set);
    const device = jar(set);
    assert.equal((await post("/setup", { password: "someone else", pin: "135790" })).status, 400, "set once only");

    assert.equal((await fetch(`${http}/unlock`, { headers: { cookie: first } })).status, 204);
    assert.equal(await opens({ cookie: first }), "open");
    assert.equal(await opens({}), "refused");
    assert.deepEqual(await (await fetch(`${http}/unlock`)).json(), {
      ready: true,
    });

    assert.equal((await post("/unlock", { password: "wrong one!" })).status, 401);
    // locked, the device signs in again with the password
    assert.equal((await post("/lock", {}, { cookie: device })).status, 204);
    const again = await post("/unlock", { password: "correct horse" }, { cookie: device });
    assert.equal(again.status, 204);
    assert.equal(await opens({ cookie: cookieOf(again) }), "open");
  } finally {
    await close();
  }
});

test("changing the password needs the PIN and ends every other session, the devices staying listed; locking ends this one", async () => {
  const { http, post, cookieOf, jar, opens, close } = await guarded();
  try {
    const set = await post("/setup", { password: "correct horse", pin: "135790" });
    const mine = cookieOf(set);
    // a second device is in with the password alone
    const entered = await post("/unlock", { password: "correct horse" });
    assert.equal(entered.status, 204);
    const otherDevice = jar(entered).split("; ").find((c) => c.startsWith("amuse-device=")) ?? "";
    assert.ok(otherDevice, "with a cookie of its own");
    const other = cookieOf(entered);
    assert.equal(await opens({ cookie: other }), "open");
    assert.equal((await (await fetch(`${http}/account`, { headers: { cookie: mine } })).json()).devices.length, 2);

    assert.equal((await post("/password", { current: "wrong one!", next: "battery staple" }, { cookie: mine })).status, 401);
    assert.equal(
      (
        await post("/password", {
          current: "correct horse",
          next: "battery staple",
        })
      ).status,
      401,
      "a session is needed",
    );
    const locked = await post("/password", { current: "correct horse", next: "battery staple" }, { cookie: other });
    assert.deepEqual([locked.status, (await locked.json()).pin], [403, "locked"], "the PIN first, on that device");
    const changed = await post("/password", { current: "correct horse", next: "battery staple" }, { cookie: mine });
    assert.equal(changed.status, 204);
    const now = cookieOf(changed);
    assert.equal(await opens({ cookie: other }), "refused");
    assert.equal(await opens({ cookie: mine }), "refused");
    assert.equal(await opens({ cookie: now }), "open");
    assert.equal((await post("/unlock", { password: "correct horse" }, { cookie: otherDevice })).status, 401);
    assert.equal((await post("/unlock", { password: "battery staple" }, { cookie: otherDevice })).status, 204, "the new password is enough on it");

    assert.equal((await post("/lock", {}, { cookie: now })).status, 204);
    assert.equal(await opens({ cookie: now }), "refused");
  } finally {
    await close();
  }
});

test("the way in takes JSON from this origin only, and wrong passwords are throttled", async () => {
  const { http, post, close } = await guarded();
  try {
    assert.equal(
      (
        await fetch(`${http}/setup`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: '{"password":"correct horse","pin":"135790"}',
        })
      ).status,
      403,
    );
    assert.equal((await post("/setup", { password: "correct horse", pin: "135790" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/setup", { password: "correct horse", pin: "135790" })).status, 204);
    for (let i = 0; i < 10; i++) assert.equal((await post("/unlock", { password: `wrong ${i}!!` })).status, 401);
    const throttled = await post("/unlock", { password: "correct horse" });
    assert.equal(throttled.status, 429, "even the right one waits");
  } finally {
    await close();
  }
});

test("a malformed cookie is no session — it can never take the server down", async () => {
  const { post, cookieOf, opens, close } = await guarded();
  try {
    const good = cookieOf(await post("/setup", { password: "correct horse", pin: "135790" }));
    assert.equal(await opens({ cookie: "amuse=%E0%A4%A" }), "refused");
    assert.equal(await opens({ cookie: "amuse=%" }), "refused");
    assert.equal(await opens({ cookie: "amuse=wrong" }), "refused");
    assert.equal(await opens({ cookie: good }), "open"); // still alive
  } finally {
    await close();
  }
});

test("pages from another origin cannot open the sockets, even with a valid session", async () => {
  const { post, cookieOf, opens, http, close } = await guarded();
  try {
    const cookie = cookieOf(await post("/setup", { password: "correct horse", pin: "135790" }));
    assert.equal(await opens({ cookie, origin: "https://evil.example" }), "refused");
    assert.equal(await opens({ cookie, origin: http }), "open"); // same origin
  } finally {
    await close();
  }
});

test("the terminals' socket is the session's and this origin's alone; without a sandbox it says there are none", async () => {
  const { post, cookieOf, ends, http, close } = await guarded();
  try {
    const cookie = cookieOf(await post("/setup", { password: "correct horse", pin: "135790" }));
    assert.equal(await ends({}, "/terminal?cols=80&rows=24"), "refused");
    assert.equal(await ends({ cookie, origin: "https://evil.example" }, "/terminal"), "refused");
    assert.equal(await ends({ cookie, origin: http }, "/terminal?cols=80&rows=24"), 4404);
  } finally {
    await close();
  }
});

test("speech becomes text for a session, from this origin, audio only; when it cannot, the reason comes back", async () => {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const pin = sqlitePin(db);
  const heard: string[] = [];
  const server = await listen({
    session: createHost(demoPorts(instant), { timers: never }),
    access,
    pin,
    unlocks: unlocks(pin, access.valid),
    sensitive: async () => false,
    transcribe: async (audio, type) => (heard.push(`${audio.length} ${type}`), audio.length > 2 ? { text: "hello" } : { reason: "Voice needs a key" }),
    port: 0,
    host: "127.0.0.1",
  });
  const http = `http://127.0.0.1:${server.port}`;
  try {
    const set = await fetch(`${http}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse", pin: "135790" }) });
    const cookie = (set.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const say = (body: Uint8Array<ArrayBuffer>, type: string, headers: Record<string, string> = { cookie }) =>
      fetch(`${http}/transcribe`, { method: "POST", headers: { "content-type": type, ...headers }, body });
    assert.equal((await say(new Uint8Array([1, 2, 3]), "audio/webm", {})).status, 401);
    assert.equal((await say(new Uint8Array([1, 2, 3]), "text/plain")).status, 415);
    const said = await say(new Uint8Array([1, 2, 3]), "audio/ogg;codecs=opus");
    assert.deepEqual([said.status, await said.json()], [200, { text: "hello" }]);
    const cannot = await say(new Uint8Array([1]), "audio/webm");
    assert.deepEqual([cannot.status, await cannot.json()], [400, { reason: "Voice needs a key" }]);
    assert.deepEqual(heard, ["3 audio/ogg;codecs=opus", "1 audio/webm"]);
  } finally {
    await server.close();
  }
});
