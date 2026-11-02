/**
 * The session a page talks over: what a socket that drops does to the calls it was carrying, and what taking it up
 * again does. A phone's browser freezes a backgrounded page — and its timers — so the page says when it is back and
 * `resume()` reconnects at once, rather than waiting out a retry that was frozen with it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { z } from "zod";
import { Dropped, connect } from "./client.ts";

const Asked = z.object({ id: z.number().optional(), method: z.string().optional() });

/** A server that answers every call, unless told to keep quiet (so a call is left in flight), and can drop anyone. */
async function server() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const sockets = new Set<ServerSocket>();
  let quiet = false;
  let connections = 0;
  const asks: string[] = [];
  wss.on("connection", (ws) => {
    connections++;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      const asked = Asked.parse(JSON.parse(data.toString()));
      if (asked.method) asks.push(asked.method);
      if (quiet || asked.id === undefined) return;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: { accounts: [] } }));
    });
  });
  const address = wss.address();
  return {
    url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/rpc`,
    connections: () => connections,
    asks,
    quiet: (on: boolean) => void (quiet = on),
    /** the socket goes, as it does when the browser freezes the page */
    drop: () => sockets.forEach((ws) => ws.terminate()),
    close: () => new Promise((resolve) => wss.close(() => resolve(undefined))),
  };
}

test("a call the dropped socket was carrying fails as Dropped; resume() puts the next one through", async () => {
  const at = await server();
  const session = connect(at.url);
  try {
    assert.deepEqual(await session.call("apps.accounts", {}), { accounts: [] });

    // one in flight when the socket goes: it is not answered, and says so as a drop (not as "disconnected")
    at.quiet(true);
    const lost = session.call("chats.create", {});
    at.drop();
    await assert.rejects(lost, (e: unknown) => e instanceof Dropped);

    // the page comes back: resume() takes it up now, and the next call goes over the socket that is up
    at.quiet(false);
    session.resume();
    assert.deepEqual(await session.call("apps.accounts", {}), { accounts: [] });
  } finally {
    session.close();
    await at.close();
  }
});

test("resume() leaves a connection that is up alone", async () => {
  const at = await server();
  const session = connect(at.url);
  try {
    await session.call("apps.accounts", {});
    const opened = at.connections();
    session.resume();
    await session.call("apps.accounts", {});
    assert.equal(at.connections(), opened, "no second socket was opened");
  } finally {
    session.close();
    await at.close();
  }
});

test("a repeatable call lost to a drop waits for the reconnect and is sent once more, and the page never sees the drop", async () => {
  const at = await server();
  const session = connect(at.url);
  try {
    await session.call("apps.accounts", {});
    at.asks.length = 0;

    at.quiet(true);
    const lost = session.call("apps.accounts", {});
    await new Promise((resolve) => setTimeout(resolve, 50)); // it reached the server, which did not answer
    at.quiet(false);
    at.drop();
    assert.deepEqual(await lost, { accounts: [] });
    // (chats.list: the reconnect catching up)
    assert.deepEqual(at.asks.filter((m) => m !== "chats.list"), ["apps.accounts", "apps.accounts"], "sent again once, after the reconnect");
  } finally {
    session.close();
    await at.close();
  }
});

test("a call that must not go twice says the server cannot be reached, in the user's words, and is not sent again", async () => {
  const at = await server();
  const session = connect(at.url, { unreachable: () => "无法连接服务器。" });
  try {
    await session.call("apps.accounts", {});
    at.asks.length = 0;

    at.quiet(true);
    const lost = session.call("chats.create", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    at.drop();
    await assert.rejects(lost, (e: unknown) => e instanceof Dropped && e.message === "无法连接服务器。");

    at.quiet(false);
    session.resume();
    await session.call("apps.accounts", {});
    assert.deepEqual(at.asks.filter((m) => m !== "chats.list"), ["chats.create", "apps.accounts"], "chats.create went once");
  } finally {
    session.close();
    await at.close();
  }
});

test("a repeatable call gives up in the user's words when no reconnect comes in time", async () => {
  const at = await server();
  const session = connect(at.url, { unreachable: () => "无法连接服务器。", patience: 100 });
  try {
    await session.call("apps.accounts", {});
    at.quiet(true);
    const lost = session.call("apps.accounts", {});
    const closing = at.close(); // the server is gone for good: no one can connect again
    at.drop();
    await closing;
    await assert.rejects(lost, (e: unknown) => e instanceof Dropped && e.message === "无法连接服务器。");
  } finally {
    session.close();
  }
});
