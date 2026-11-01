/**
 * The account, on the server's /account (api/src/server.ts): the PIN's state and the devices, and the changes to
 * them. Every request carries the session cookie; none carries the PIN or the password anywhere but its body.
 */
import { activeT } from "./i18n/language.ts";
import type { Said } from "./pin.ts";

export interface DeviceInfo {
  id: string;
  agent: string;
  address: string;
  at: string;
  seen: string;
}

export interface AccountState {
  pin: {
    set: boolean;
    /** what the app should ask now: a PIN set, the PIN confirmed, or nothing */
    reminder: "set" | "confirm" | null;
    /** locked after wrong tries until then */
    locked: string | null;
    /** how long an unlock lasts after the last sensitive action */
    minutes: number;
    /** until when this session is unlocked */
    unlocked: string | null;
  };
  /** this device's id */
  device: string | null;
  devices: DeviceInfo[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** The server's answer read as it is meant, field by field: what is missing is nothing, never a guess. */
function stateOf(raw: unknown): AccountState | null {
  if (!isRecord(raw) || !isRecord(raw["pin"]) || !Array.isArray(raw["devices"])) return null;
  const pin = raw["pin"];
  const reminder = pin["reminder"];
  return {
    pin: {
      set: pin["set"] === true,
      reminder: reminder === "set" || reminder === "confirm" ? reminder : null,
      locked: textOrNull(pin["locked"]),
      minutes: typeof pin["minutes"] === "number" ? pin["minutes"] : 5,
      unlocked: textOrNull(pin["unlocked"]),
    },
    device: textOrNull(raw["device"]),
    devices: raw["devices"].filter(isRecord).map((d) => ({
      id: text(d["id"]),
      agent: text(d["agent"]),
      address: text(d["address"]),
      at: text(d["at"]),
      seen: text(d["seen"]),
    })),
  };
}

/** The account now; null when it cannot be read (no server, or signed out). */
export async function accountState(): Promise<AccountState | null> {
  const response = await fetch("/account", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  return stateOf(await response.json().catch(() => null));
}

/** POST a change, and read what the server said to it. */
async function change(path: string, body: unknown = {}, keepalive = false): Promise<Said> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  }).catch(() => null);
  if (!response) return { ok: false, reason: activeT().common.serverUnreachable, pin: null, left: null, until: null };
  if (response.ok) return { ok: true };
  const said: unknown = await response.json().catch(() => null);
  const record = isRecord(said) ? said : {};
  const need = record["pin"];
  return {
    ok: false,
    reason: text(record["reason"]) || activeT().common.somethingWrong,
    pin: need === "unset" || need === "locked" ? need : null,
    left: typeof record["left"] === "number" ? record["left"] : null,
    until: textOrNull(record["until"]),
  };
}

/** Set the PIN (a new one too), with the password: it unlocks this session. */
export const setPin = (password: string, pin: string) => change("/account/pin", { password, pin });
/** Turn the PIN off: the password, and the PIN there is when there is one. Sensitive actions then go through without it. */
export const turnOffPin = (password: string, pin: string | null) => change("/account/pin/off", pin === null ? { password } : { password, pin });
/** Unlock this session with the PIN. */
export const unlockPin = (pin: string) => change("/account/pin/unlock", { pin });
/** The weekly reminder: is this the PIN? It unlocks nothing. */
export const checkPin = (pin: string) => change("/account/pin/check", { pin });
/** Lock this session now; it still goes as the page closes. */
export const lockPin = () => void change("/account/pin/lock", {}, true);
/** Put the reminder off for a day, for every device. */
export const remindLater = () => change("/account/pin/later");
export const setUnlockMinutes = (minutes: number) => change("/account/pin/minutes", { minutes });
/** Change the password (behind the PIN): every other device has to enter the new one. */
export const changePassword = (current: string, next: string) => change("/password", { current, next });
export const revokeDevice = (id: string) => change("/account/devices/revoke", { id });
