import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost, memoryRules, type Timers } from "@amuse/core";
import { demoPorts } from "@amuse/demo";
import { migratedDatabase } from "@amuse/db";
import { errors } from "@amuse/protocol";
import { WebSocket } from "ws";
import { z } from "zod";
import { sqliteAccess } from "./access.ts";
import { sqlitePin, unlocks } from "./pin.ts";
import { sensitive } from "./sensitive.ts";
import { listen } from "./server.ts";

const never: Timers<number> = { set: () => 0, clear: () => {} };
const Reply = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ code: z.number() }).optional() });

/** A fresh instance, set up: its session's cookie, and ways to ask it things over HTTP and its socket. */
async function instance() {
  const db = await migratedDatabase();
  const access = sqliteAccess(db);
  const pin = sqlitePin(db);
  const rules = memoryRules();
  const server = await listen({
    session: createHost(demoPorts(never), { timers: never }),
    access,
    pin,
    unlocks: unlocks(pin, access.valid),
    sensitive: (call) => sensitive(call, rules),
    port: 0,
    host: "127.0.0.1",
  });
  const http = `http://127.0.0.1:${server.port}`;
  const send = (path: string, body: unknown, cookie: string) =>
    fetch(`${http}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const set = await send("/setup", { password: "correct horse", pin: "135790" }, "");
  const cookie = set.headers.getSetCookie().map((c) => c.split(";")[0] ?? "").join("; ");
  const post = (path: string, body: unknown = {}) => send(path, body, cookie);
  const state = async () =>
    z
      .object({ pin: z.object({ set: z.boolean(), reminder: z.string().nullable(), unlocked: z.string().nullable(), locked: z.string().nullable() }) })
      .parse(await (await fetch(`${http}/account`, { headers: { cookie } })).json()).pin;
  const socket = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, { headers: { cookie } });
    await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
    let id = 0;
    const call = (method: string, params: unknown) =>
      new Promise<z.infer<typeof Reply>>((resolve) => {
        const mine = ++id;
        const heard = (data: Buffer) => {
          const said = Reply.parse(JSON.parse(data.toString()));
          if (said.id !== mine) return;
          ws.off("message", heard);
          resolve(said);
        };
        ws.on("message", heard);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }));
      });
    const closed = new Promise((resolve) => ws.once("close", resolve));
    return { call, closed, close: () => ws.close() };
  };
  return { post, state, socket, access, close: () => server.close() };
}

test("a sensitive call needs this session unlocked with the PIN: setting it up unlocks, Lock now locks, the right PIN unlocks again", async () => {
  const { post, state, socket, close } = await instance();
  const rpc = await socket();
  try {
    const loosen = () => rpc.call("browser.permit", { action: "visit", permission: "allow" });
    assert.ok((await state()).unlocked, "the PIN set with the password unlocks");
    assert.equal((await loosen()).error, undefined);
    assert.equal((await post("/account/pin/lock")).status, 204);
    assert.equal((await state()).unlocked, null);
    assert.equal((await loosen()).error?.code, errors.pinLocked.code);
    assert.equal((await rpc.call("browser.permit", { action: "visit", permission: "deny" })).error, undefined, "tightening needs nothing");

    const wrong = await post("/account/pin/unlock", { pin: "000000" });
    assert.deepEqual([wrong.status, z.object({ left: z.number() }).parse(await wrong.json()).left], [401, 4]);
    // the weekly check unlocks nothing
    assert.equal((await post("/account/pin/check", { pin: "135790" })).status, 204);
    assert.equal((await loosen()).error?.code, errors.pinLocked.code);
    assert.equal((await post("/account/pin/unlock", { pin: "135790" })).status, 204);
    assert.equal((await loosen()).error, undefined);
  } finally {
    rpc.close();
    await close();
  }
});

test("five wrong PINs lock it, for every device; changing the PIN needs the password and the unlock", async () => {
  const { post, state, close } = await instance();
  try {
    assert.equal((await post("/account/pin/lock")).status, 204);
    const change = await post("/account/pin", { password: "correct horse", pin: "999999" });
    assert.deepEqual([change.status, z.object({ pin: z.string() }).parse(await change.json()).pin], [403, "locked"]);
    for (let i = 0; i < 4; i++) assert.equal((await post("/account/pin/unlock", { pin: "000000" })).status, 401);
    const locked = await post("/account/pin/unlock", { pin: "000000" });
    assert.equal(locked.status, 429);
    assert.ok((await state()).locked);
    assert.equal((await post("/account/pin/unlock", { pin: "135790" })).status, 429, "even the right one waits");
  } finally {
    await close();
  }
});

test("removing a device takes the PIN; a removed device's open socket is closed", async () => {
  const { post, socket, access, close } = await instance();
  try {
    const other = await access.login("correct horse", null, { agent: "phone", address: "100.64.0.9" });
    const phone = access.devices().find((d) => d.agent === "phone");
    assert.ok(other && phone);
    assert.equal((await post("/account/pin/lock")).status, 204);
    assert.equal((await post("/account/devices/revoke", { id: phone.id })).status, 403);
    assert.equal((await post("/account/pin/unlock", { pin: "135790" })).status, 204);
    assert.equal((await post("/account/devices/revoke", { id: phone.id })).status, 204);
    assert.equal(access.valid(other.session), false);

    // this device, removed: its socket goes at once
    const rpc = await socket();
    const mine = access.devices()[0];
    assert.equal((await post("/account/devices/revoke", { id: mine?.id ?? "" })).status, 204);
    await rpc.closed;
  } finally {
    await close();
  }
});

test("turning the PIN off takes the password and the PIN there is; with it off the gate asks nothing and no reminder comes back", async () => {
  const { post, state, socket, close } = await instance();
  const rpc = await socket();
  try {
    const loosen = () => rpc.call("browser.permit", { action: "visit", permission: "allow" });
    // the password, always: without one, and with a wrong one, nothing changes
    assert.equal((await post("/account/pin/off", {})).status, 400);
    const wrongPassword = await post("/account/pin/off", { password: "not the password", pin: "135790" });
    assert.deepEqual([wrongPassword.status, z.object({ reason: z.string() }).parse(await wrongPassword.json()).reason], [401, "That is not the password."]);
    assert.equal((await state()).set, true, "still set");
    // the PIN there is: asked for, and a wrong one counts as a try
    assert.equal((await post("/account/pin/off", { password: "correct horse" })).status, 400);
    const wrongPin = await post("/account/pin/off", { password: "correct horse", pin: "000000" });
    assert.deepEqual([wrongPin.status, z.object({ left: z.number() }).parse(await wrongPin.json()).left], [401, 4]);
    assert.equal((await state()).set, true, "still set");

    assert.equal((await post("/account/pin/off", { password: "correct horse", pin: "135790" })).status, 204);
    const off = await state();
    assert.deepEqual([off.set, off.reminder, off.locked, off.unlocked], [false, null, null, null], "off: nothing is asked");
    // the gate: sensitive actions go through, locked or not, and nothing counts as an unlock
    assert.equal((await post("/account/pin/lock")).status, 204);
    assert.equal((await loosen()).error, undefined, "no PIN sheet, the server treats it as unlocked");
    assert.equal((await post("/account/pin/lock")).status, 204);
    assert.equal((await loosen()).error, undefined);
    assert.equal((await state()).unlocked, null);
    // no reminder: there is nothing to check, and nothing to set
    assert.equal((await post("/account/pin/check", { pin: "135790" })).status, 403);

    // turning it on again is the normal set-PIN flow: the password, then the gate holds from scratch
    assert.equal((await post("/account/pin", { password: "not the password", pin: "246802" })).status, 401);
    assert.equal((await post("/account/pin", { password: "correct horse", pin: "246802" })).status, 204);
    assert.equal((await state()).set, true);
    assert.equal((await post("/account/pin/lock")).status, 204);
    assert.equal((await loosen()).error?.code, errors.pinLocked.code, "the PIN is asked for again");
    assert.equal((await post("/account/pin/unlock", { pin: "246802" })).status, 204);
    assert.equal((await loosen()).error, undefined);
  } finally {
    rpc.close();
    await close();
  }
});
