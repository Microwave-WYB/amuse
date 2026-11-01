/**
 * What the account asks of a signed-in device, kept an eye on while the app is open (on a server only):
 *   - the reminders, like Signal's: set a PIN when there is none (an instance from before the PIN, say), and enter
 *     it after a week without, so it is not forgotten. "Later" puts either off a day, on the server, for every device;
 *   - the PIN locked after wrong tries, wherever they were made: said in the chat's notice;
 *   - the unlock ends at once when the app goes to the background or the page closes.
 */
import { useEffect, useRef, useState } from "react";
import { untilWords, usePin } from "./PinSheet";
import { useT } from "../i18n/react.ts";
import { type AccountState, accountState, lockPin } from "../account.ts";

/** how often the account is asked while the app is in view: a reminder put off, or a lockout, from another device comes within this */
const POLL_MS = 5000;

export function AccountWatch({ notify }: { notify: (message: string) => void }) {
  const t = useT();
  const { open } = usePin();
  const [state, setState] = useState<AccountState | null>(null);
  /** a reminder's sheet is open */
  const reminding = useRef(false);
  const lockedSaid = useRef<string | null>(null);
  const look = () => void accountState().then(setState);

  useEffect(() => {
    const now = () => {
      if (document.visibilityState === "visible") look();
    };
    now();
    const timer = setInterval(now, POLL_MS);
    const shown = () => (document.visibilityState === "hidden" ? lockPin() : look());
    document.addEventListener("visibilitychange", shown);
    addEventListener("pagehide", lockPin);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
      removeEventListener("pagehide", lockPin);
    };
  }, []);

  const reminder = state?.pin.reminder ?? null;
  useEffect(() => {
    if (!reminder || reminding.current) return;
    reminding.current = true;
    void open(reminder === "set" ? "set" : "check", "reminder").then(() => {
      reminding.current = false;
      look();
    });
  }, [reminder, open]);

  const locked = state?.pin.locked ?? null;
  useEffect(() => {
    if (locked && locked !== lockedSaid.current) notify(t.pin.lockedNotice(untilWords(locked)));
    lockedSaid.current = locked;
  }, [locked, notify, t]);

  return null;
}
