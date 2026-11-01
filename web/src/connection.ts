/**
 * Where the conversation lives:
 *   demo    no server configured: the real core runs in the browser with scripted ports
 *   server  VITE_AMUSE_URL (a full ws URL), or the same origin the app was served from
 *           (VITE_AMUSE_MODE=same-origin: the Docker build, and dev through Vite's proxy)
 *   locked  same-origin, but this browser has no session yet; `ready`: the master password is set
 * The master password opens a session the server keeps as an HttpOnly cookie, so scripts, URLs
 * and logs never see it.
 */
import { activeT } from "./i18n/language.ts";

export type Connection =
  | { kind: "demo" }
  | { kind: "locked"; ready: boolean }
  | {
      kind: "server";
      rpc: string;
      live: (id: string) => string;
      thumb: (id: string) => string;
      /** the sandbox's terminals, a websocket, at a size */
      terminal: (cols: number, rows: number) => string;
    };

/** A route next to /rpc on the same server, for a run id (ws for /live, http for /thumb). */
function route(rpc: string, path: string, id: string, http: boolean) {
  const url = new URL(rpc);
  url.pathname = path;
  url.searchParams.set("id", id);
  if (http) url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

function server(rpc: string): Connection {
  return {
    kind: "server",
    rpc,
    live: (id) => route(rpc, "/live", id, false),
    thumb: (id) => route(rpc, "/thumb", id, true),
    terminal: (cols, rows) => {
      const url = new URL(rpc);
      url.pathname = "/terminal";
      url.search = new URLSearchParams({ cols: String(cols), rows: String(rows) }).toString();
      return url.toString();
    },
  };
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Why the server said no, in its words (or a plain one). */
async function reason(response: Response): Promise<string> {
  const said: unknown = await response.json().catch(() => null);
  if (typeof said === "object" && said !== null && "reason" in said && typeof said.reason === "string") return said.reason;
  return response.status === 401 ? activeT().unlock.wrongPassword : activeT().common.somethingWrong;
}

/** How far starting has got, for the page that says why it could not start (index.html). */
export const startedTo = (stage: string) => void (document.documentElement.dataset["amuse"] = stage);

export async function connection(): Promise<Connection> {
  const explicit = import.meta.env["VITE_AMUSE_URL"];
  if (typeof explicit === "string" && explicit) return server(explicit);
  if (import.meta.env["VITE_AMUSE_MODE"] !== "same-origin") return { kind: "demo" };

  startedTo("asking the server (/unlock)");
  const unlocked = await fetch("/unlock").catch(() => null);
  startedTo(unlocked ? `the server answered /unlock (${unlocked.status})` : "/unlock could not be reached");
  if (unlocked?.status !== 204) {
    const said: unknown = await unlocked?.json().catch(() => null);
    const ready = typeof said === "object" && said !== null && "ready" in said ? said.ready !== false : true;
    return { kind: "locked", ready };
  }
  const rpc = new URL("/rpc", location.href);
  rpc.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return server(rpc.toString());
}

/** Open this browser with the password (`pin`: set both, the first time); reloads when in, else says why not. */
export async function enter(password: string, pin: string | null): Promise<string | null> {
  const response = await post(pin !== null ? "/setup" : "/unlock", pin !== null ? { password, pin } : { password }).catch(() => null);
  if (!response) return activeT().common.serverUnreachable;
  if (!response.ok) return reason(response);
  location.replace(location.pathname + location.search);
  return null;
}

/** Lock this browser: it needs the password again. */
export async function lock(): Promise<void> {
  await post("/lock", {}).catch(() => null);
  location.replace(location.pathname + location.search);
}
