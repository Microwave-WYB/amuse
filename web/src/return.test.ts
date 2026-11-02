/**
 * The page coming back: a phone's browser freezes a backgrounded page (switching apps to copy a Cloudflare token,
 * say) and the socket drops with it. Coming back must reconnect at once, say the failure in the app's own words
 * rather than the transport's "disconnected", and let go of it once a call has gone through.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { z } from "zod";
import { Dropped, connect } from "@amuse/api/client";
import { activeT } from "./i18n/language.ts";
import { FOREGROUND, resumeOnReturn } from "./return.ts";
import { standsAfterReturn, wordsFor } from "./shown.ts";

const Asked = z.object({ id: z.number().optional() });

/** A server that answers every call, unless told to keep quiet (so one is left in flight), and can drop anyone. */
async function server() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const sockets = new Set<ServerSocket>();
  let quiet = false;
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      const asked = Asked.parse(JSON.parse(data.toString()));
      if (quiet || asked.id === undefined) return;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: { accounts: [] } }));
    });
  });
  const address = wss.address();
  return {
    url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/rpc`,
    connections: () => connections,
    quiet: (on: boolean) => void (quiet = on),
    drop: () => sockets.forEach((ws) => ws.terminate()),
    close: () => new Promise((resolve) => wss.close(() => resolve(undefined))),
  };
}

test("a page that comes back reconnects, says the drop in the app's words, and goes on", async () => {
  const at = await server();
  const session = connect(at.url);
  // the browser's own events, and whether the page is on screen (a test's, instead of the real ones)
  const events = new EventTarget();
  let onScreen = true;
  const stopListening = resumeOnReturn(() => session.resume(), { events, visible: () => onScreen });
  const back = () => events.dispatchEvent(new Event("visibilitychange"));
  const t = activeT();
  try {
    assert.deepEqual(await session.call("apps.accounts", {}), { accounts: [] });

    // the user switches to another app and the browser freezes the page: the socket goes, with a call in flight
    at.quiet(true);
    const lost = session.call("chats.create", {});
    at.drop();
    let failure: unknown = null;
    await lost.catch((e: unknown) => void (failure = e));
    assert.ok(failure instanceof Dropped);
    const said = wordsFor(failure, t);
    assert.equal(said, t.common.serverUnreachable, "the app's words, not the transport's");
    assert.equal(said?.includes("disconnected"), false);

    // still hidden: nothing to take up yet
    onScreen = false;
    const opened = at.connections();
    back();
    assert.equal(at.connections(), opened, "a hidden page does not reconnect");

    // the user is back with the token: the socket comes up at once and the call goes over it
    onScreen = true;
    at.quiet(false);
    back();
    assert.deepEqual(await session.call("apps.accounts", {}), { accounts: [] });
    assert.equal(standsAfterReturn(failure), null, "the connection is up: that failure does not stand");

    // a call the server refused is not let go of: it still stands, in its own words
    const refused = new Error("Cloudflare did not accept that API Token");
    assert.equal(standsAfterReturn(refused), refused);
    assert.equal(wordsFor(refused, t), "Cloudflare did not accept that API Token");
  } finally {
    stopListening();
    session.close();
    await at.close();
  }
});

test("the Android app in front again, and a change of network, check the connection too", () => {
  const events = new EventTarget();
  const network = new EventTarget();
  let onScreen = false;
  let resumed = 0;
  const stop = resumeOnReturn(() => resumed++, { events, network, visible: () => onScreen });
  try {
    // MainActivity.onResume says so before the WebView may have told the page it is visible
    events.dispatchEvent(new Event(FOREGROUND));
    assert.equal(resumed, 1, "the app's word is enough");
    // Wi-Fi to mobile data: no `online` (it was never offline), only the network's change
    network.dispatchEvent(new Event("change"));
    assert.equal(resumed, 1, "not while hidden");
    onScreen = true;
    network.dispatchEvent(new Event("change"));
    events.dispatchEvent(new Event("online"));
    assert.equal(resumed, 3);
  } finally {
    stop();
  }
  events.dispatchEvent(new Event(FOREGROUND));
  network.dispatchEvent(new Event("change"));
  assert.equal(resumed, 3, "and nothing once it stops listening");
});

test("the Android app's foreground event is the one the page listens for", async () => {
  const kotlin = await readFile(new URL("../../android/app/src/main/java/live/amuse/app/PageSignals.kt", import.meta.url), "utf8");
  assert.match(kotlin, new RegExp(`const val FOREGROUND = "${FOREGROUND}"`));
});
