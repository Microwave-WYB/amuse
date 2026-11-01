/**
 * Doubles of the way in, for the tests that are not about it: an Access that lets in the sessions `valid` names, and a
 * server's PIN options with nothing behind the PIN.
 */
import type { Access, Entry } from "./access.ts";
import type { Pin, Unlocks } from "./pin.ts";

/** In with `session` (or, by default, with anything at all). */
export function letIn(session = "session", valid: (given: string) => boolean = () => true): Access {
  const entry: Entry = { session, device: null };
  return {
    ready: () => true,
    setup: async () => entry,
    login: async () => entry,
    valid,
    logout: () => {},
    change: async () => session,
    matches: async () => true,
    deviceOf: () => null,
    devices: () => [],
    revoke: () => {},
  };
}

const pin: Pin = {
  isSet: () => true,
  set: async () => {},
  off: () => false,
  turnOff: () => {},
  check: async () => ({ kind: "right" }),
  locked: () => null,
  reminder: () => null,
  later: () => {},
  minutes: () => 5,
  setMinutes: () => {},
};
const unlocks: Unlocks = { open: () => {}, lock: () => {}, require: () => {}, until: () => null };

/** Nothing needs the PIN. */
export const noPin = { pin, unlocks, sensitive: async () => false };
