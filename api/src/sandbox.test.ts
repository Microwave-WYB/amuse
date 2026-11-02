import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createHost, type Timers } from "@amuse/core";
import { demoPorts, seed } from "@amuse/demo";
import { letIn, noPin } from "./testing.ts";
import { refusing } from "./sandbox.ts";
import { AGENT_MARK, listen } from "./server.ts";

test("the sandbox's whole subnet is refused, whichever way its addresses are written, and no other", () => {
  const refuses = refusing("10.231.250.0/24");
  for (const address of ["10.231.250.2", "10.231.250.1", "10.231.250.254", "::ffff:10.231.250.2", "::FFFF:10.231.250.77"])
    assert.equal(refuses(address), true, address);
  for (const address of ["10.231.251.2", "10.231.249.255", "172.19.0.1", "127.0.0.1", "::1", "fe80::1", "::ffff:10.231.251.1", "not an address", undefined])
    assert.equal(refuses(address), false, String(address));
  assert.equal(refusing("10.231.250.7/24")("10.231.250.200"), true, "a host address in the range is the range");
  assert.equal(refusing("fd00:abcd::/48")("fd00:abcd:0:5::9"), true);
  assert.equal(refusing("fd00:abcd::/48")("fd00:abce::9"), false);
});

test("a subnet that cannot be read stops the server rather than letting the sandbox in", () => {
  for (const bad of ["", "sandbox", "10.231.250.0", "10.231.250.0/33", "10.231.250.0/x", "10.231.250.0/24/1", "300.1.1.1/24", "fd00::/129"])
    assert.throws(() => refusing(bad), /not an address range/, bad);
});

/** Lets every request in: whatever is refused is refused for where it comes from. */
const anyone = letIn();
const never: Timers<number> = { set: () => 0, clear: () => {} };

/** One request from a given local address (127.0.0.x are all this machine), the status it got. */
function ask(port: number, from: string, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, localAddress: from, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    // an accepted upgrade is no response
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.end(method === "POST" ? JSON.stringify({ password: "x" }) : undefined);
  });
}

test("the server refuses every route to the sandbox's network, and to Amuse's own browsers wherever they come from, signed in or not, and serves the rest", async () => {
  const server = await listen({
    session: createHost(demoPorts({ set: (_, fn) => (queueMicrotask(fn), 0), clear: () => {} }), { seed: seed(), timers: never }),
    access: anyone,
    ...noPin,
    refuse: (address) => address === "127.0.0.2",
    port: 0,
    host: "127.0.0.1",
  });
  try {
    const { port } = server;
    const json = { "content-type": "application/json" };
    const routes: [string, string, Record<string, string>][] = [
      ["GET", "/", {}],
      ["GET", "/unlock", {}],
      ["POST", "/unlock", json],
      ["POST", "/setup", json],
      ["POST", "/password", json],
      ["POST", "/lock", json],
      ["GET", "/account", {}],
      ["POST", "/account/pin/unlock", json],
      ["POST", "/account/devices/revoke", json],
      ["GET", "/files/f-1", {}],
      ["POST", "/files", { "content-type": "image/png", "x-file-name": "a.png" }],
      ["POST", "/transcribe", { "content-type": "audio/webm" }],
      ["GET", "/thumb?id=b1", {}],
      ["GET", "/connected?key=k", {}],
      // the sockets: a would-be /rpc or /live upgrade
      ["GET", "/rpc", { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }],
      ["GET", "/live?id=b1", { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }],
    ];
    for (const [method, path, headers] of routes) {
      assert.equal(await ask(port, "127.0.0.2", method, path, headers), 403, `${method} ${path} from the sandbox`);
      // the mark the browsers put on every request: the way in included, so Amuse never even asks to sign in
      assert.equal(await ask(port, "127.0.0.1", method, path, { ...headers, [AGENT_MARK]: "1" }), 403, `${method} ${path} from Amuse's browser`);
      assert.notEqual(await ask(port, "127.0.0.1", method, path, headers), 403, `${method} ${path} from anyone else`);
    }
    assert.equal(await ask(port, "127.0.0.1", "GET", "/unlock"), 204);
  } finally {
    await server.close();
  }
});
