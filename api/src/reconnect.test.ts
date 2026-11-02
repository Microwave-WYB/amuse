/**
 * The link coming back to the foreground (#89): the app opened again after the phone had it in the background showed
 * no new messages until it was quit and started again. A socket left in the background may be closed, or open on this
 * side and gone on the other (half-open: nothing says so but a call that is never answered); and one taken up again
 * must fetch what was said meanwhile. The rules (`step`) as a table, then each case against a real socket.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { z } from "zod";
import type { Envelope, Update } from "@amuse/protocol";
import { type Link, type Signal, connect, step } from "./client.ts";

test("the link's rules", () => {
  const table: [Link, Signal, Link, string][] = [
    // coming back: a live socket is asked whether it still answers; a gone one is taken up now
    ["live", "returned", "checking", "probe"],
    ["down", "returned", "connecting", "open"],
    ["checking", "returned", "checking", "none"],
    ["connecting", "returned", "connecting", "none"],
    // the probe: answered, the link is live and catches up; silent, the socket is let go of and another opened
    ["checking", "answered", "live", "catchUp"],
    ["checking", "silent", "connecting", "reopen"],
    ["live", "silent", "live", "none"],
    ["connecting", "answered", "connecting", "none"],
    // a socket up catches up; one lost waits out the backoff, then opens
    ["connecting", "opened", "live", "catchUp"],
    ["live", "lost", "down", "wait"],
    ["checking", "lost", "down", "wait"],
    ["connecting", "lost", "down", "wait"],
    ["down", "lost", "down", "none"],
    ["down", "retry", "connecting", "open"],
    ["live", "retry", "live", "none"],
  ];
  for (const [from, signal, link, then] of table)
    assert.deepEqual(step(from, signal), { link, then }, `${from} + ${signal}`);
});

const Asked = z.object({ id: z.number(), method: z.string(), params: z.object({ chat: z.string().optional(), since: z.number().nullable().optional() }).passthrough() });

/**
 * A server with one chat's journal: it answers chats.list and session.sync, and pushes each new event to the sockets
 * that are up. It can drop everyone (closed), or go deaf (half-open: the sockets stay open, and nothing reaches them
 * or comes back); `say` adds an event whether anyone hears it or not.
 */
async function server() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const sockets = new Set<ServerSocket>();
  const deafTo = new WeakSet<ServerSocket>();
  const journal: Envelope[] = [];
  const asks: string[] = [];
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      if (deafTo.has(ws)) return;
      const asked = Asked.parse(JSON.parse(data.toString()));
      asks.push(asked.method);
      const answer = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: asked.id, result }));
      if (asked.method === "chats.list") return answer({ chats: [] });
      if (asked.method === "session.sync") {
        // as the host does: from nothing, the state as it stands; from a seq, the events since
        const since = asked.params.since ?? null;
        if (since === null) return answer({ kind: "snapshot", state: { seq: journal.length, earlier: 0, entities: [], activity: null } });
        return answer({ kind: "events", events: journal.filter((e) => e.seq > since) });
      }
      answer({ accounts: [] }); // apps.accounts, the one other call the tests make
    });
  });
  const address = wss.address();
  return {
    url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/rpc`,
    connections: () => connections,
    asks,
    say() {
      const envelope: Envelope = { seq: journal.length + 1, event: { kind: "activity", activity: null } };
      journal.push(envelope);
      const push = JSON.stringify({ jsonrpc: "2.0", method: "push", params: { kind: "event", chat: "main", envelope } });
      for (const ws of sockets) if (!deafTo.has(ws)) ws.send(push);
    },
    /** every socket goes, as when the phone's browser froze the page or the network went */
    drop: () => sockets.forEach((ws) => ws.terminate()),
    /** every socket that is up now stays open and is never heard from again (the far side gone, no close) */
    deafen: () => sockets.forEach((ws) => deafTo.add(ws)),
    close: () => new Promise((resolve) => wss.close(() => resolve(undefined))),
  };
}

/** A connected session, and the seqs of the events it has delivered, and every link it went through. */
async function client(url: string) {
  const session = connect(url, { probe: 200 });
  const seen: number[] = [];
  const links: Link[] = [];
  session.subscribe((u: Update) => void (u.kind === "event" && seen.push(u.envelope.seq)));
  session.watch((link) => links.push(link));
  await session.call("session.sync", { chat: "main", since: null }); // the chat on screen
  return { session, seen, links };
}

const until = async (what: () => boolean, ms = 3_000) => {
  const by = Date.now() + ms;
  while (!what()) {
    if (Date.now() > by) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("coming back with a socket that is live: it is checked, kept, and nothing is missed", async () => {
  const at = await server();
  const { session, seen, links } = await client(at.url);
  try {
    at.say();
    await until(() => seen.length === 1);
    const opened = at.connections();
    links.length = 0;
    session.resume();
    assert.equal(session.link(), "checking");
    await until(() => session.link() === "live");
    assert.equal(at.connections(), opened, "no second socket");
    assert.deepEqual(links, ["checking", "live"]);
    at.say();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, [1, 2]);
  } finally {
    session.close();
    await at.close();
  }
});

test("coming back to a closed socket: taken up at once, and what was said meanwhile arrives", async () => {
  const at = await server();
  const { session, seen } = await client(at.url);
  try {
    at.say();
    await until(() => seen.length === 1);
    at.drop();
    await until(() => session.link() === "down");
    // said while the app was away: no socket heard it
    at.say();
    at.say();
    session.resume();
    assert.equal(session.link(), "connecting", "the page shows it is connecting");
    await until(() => seen.length === 3);
    assert.deepEqual(seen, [1, 2, 3], "caught up from the last event seen, with no restart");
    assert.equal(session.link(), "live");
  } finally {
    session.close();
    await at.close();
  }
});

test("coming back to a half-open socket: the unanswered check lets it go, a new one comes up and catches up", async () => {
  const at = await server();
  const { session, seen, links } = await client(at.url);
  try {
    at.say();
    await until(() => seen.length === 1);
    at.deafen(); // the far side is gone; this side's socket still says it is open
    at.say(); // and what is said now never reaches it
    assert.equal(session.link(), "live", "nothing tells it so");
    links.length = 0;
    session.resume();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(links, ["checking", "connecting", "live"]);
    assert.equal(at.connections(), 2, "a second socket");
    at.say();
    await until(() => seen.length === 3, 1_000);
  } finally {
    session.close();
    await at.close();
  }
});

test("a call carried by the half-open socket is not left hanging: a repeatable one goes again on the new socket", async () => {
  const at = await server();
  const { session } = await client(at.url);
  try {
    at.deafen();
    const read = session.call("apps.accounts", {}); // sent into the dead socket
    session.resume();
    assert.deepEqual(await read, { accounts: [] }, "answered over the socket that replaced it");
  } finally {
    session.close();
    await at.close();
  }
});

test("a network change (the 'online' signal) while the socket died with it: caught, reconnected, caught up", async () => {
  const at = await server();
  const { session, seen } = await client(at.url);
  try {
    // Wi-Fi to mobile data: the old path dies silently, and the page hears only that the network changed
    at.deafen();
    at.say();
    session.resume();
    await until(() => seen.length === 1);
    assert.equal(session.link(), "live");
    // and again with the socket closed outright this time
    at.drop();
    at.say();
    session.resume();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, [1, 2]);
  } finally {
    session.close();
    await at.close();
  }
});

test("a socket the server closes is taken up again by itself, and catches up", async () => {
  const at = await server();
  const { session, seen } = await client(at.url);
  try {
    at.drop();
    at.say();
    await until(() => seen.length === 1); // the backoff's first retry, no page coming back needed
    assert.ok(at.asks.includes("session.sync"));
  } finally {
    session.close();
    await at.close();
  }
});
