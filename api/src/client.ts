/**
 * A protocol Session over a WebSocket, for browsers (and Node 22+, which has
 * a global WebSocket). Results and events are parsed with the protocol
 * schemas on arrival, so a misbehaving server fails loudly at the boundary.
 * Reconnects with backoff and replays each chat's missed events from its last seq; `resume()` takes it up at once
 * (a page that comes back says so, rather than waiting out the backoff that was frozen with it), and asks a socket
 * that still looks up whether it answers, since one left in the background may be dead on the far side. The link's
 * rules are `step`, a table of its own.
 */
import {
  type Chat,
  type Envelope,
  type Method,
  Notification,
  type Params,
  Response,
  type Results,
  type Session,
  type State,
  type Update,
  parseResult,
} from "@amuse/protocol";

type Pending = { settle: (raw: unknown) => void; fail: (error: Error) => void };

/**
 * A call the server answered with an error: its words, and its JSON-RPC code (the protocol's `errors`: the PIN's, say).
 */
export class CallFailed extends Error {
  readonly code: number;
  /** a rejected command's rejection (`{ kind, … }`), for a client to say in its own words */
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * A call whose socket dropped before it was answered (a phone's browser freezes the page in the background, and the
 * socket with it). Its own kind, so a page says it in the user's language instead of showing "disconnected".
 */
export class Dropped extends Error {
  constructor(message = "the connection dropped") {
    super(message);
  }
}

/**
 * Calls that must not go twice: a drop may have come after the server acted on them, and doing them again would
 * send the message twice, answer the card again, or start another task. Every other call is a read or a write that
 * leaves the same state when repeated (a permission, a model), and is sent again once after the reconnect.
 */
const once = new Set<Method>([
  "chat.send",
  "chat.retry",
  "chats.create",
  "approval.resolve",
  "connection.begin",
  "browser.open",
  "schedule.control",
  "apps.connect",
  "apps.connectKey",
  "goals.add",
  "secret.answer",
  "secrets.add",
  "keys.login",
  "keys.answer",
  "sandbox.reset",
]);

/**
 * How the link to the server stands, as the page shows it:
 *   connecting  a socket on its way up (the first one, or one taken up again)
 *   live        up, and answering
 *   checking    up as far as the socket says, and asked whether it still answers: a socket that sat in the background
 *               or saw the network change may be open on this side and long gone on the other (half-open), and
 *               nothing tells the page but a call that is never answered
 *   down        none, a retry waiting
 */
export type Link = "connecting" | "live" | "checking" | "down";

/** What happens to the link: the socket opened or was lost, the page came back, the backoff ran out, the probe was answered or not in time. */
export type Signal = "opened" | "lost" | "returned" | "retry" | "answered" | "silent";

/**
 * What to do about it: open a socket now (`reopen`: let go of the one there is first, unanswered), wait out the
 * backoff, ask the socket that is up whether it still answers, catch up on what was missed, or nothing.
 */
export type Effect = "open" | "reopen" | "wait" | "probe" | "catchUp" | "none";

/** The link's rules: where a signal takes it, and what to do. Pure, so every case is a test of a table. */
export function step(link: Link, signal: Signal): { link: Link; then: Effect } {
  switch (signal) {
    case "opened":
      return { link: "live", then: "catchUp" };
    case "lost":
      // a socket let go of on purpose (`reopen`) is not lost: its close is ignored before it gets here
      return link === "down" ? { link, then: "none" } : { link: "down", then: "wait" };
    case "retry":
      return link === "down" ? { link: "connecting", then: "open" } : { link, then: "none" };
    case "returned":
      if (link === "live") return { link: "checking", then: "probe" };
      if (link === "down") return { link: "connecting", then: "open" };
      return { link, then: "none" }; // checking or connecting: already finding out
    case "answered":
      return link === "checking" ? { link: "live", then: "catchUp" } : { link, then: "none" };
    case "silent":
      return link === "checking" ? { link: "connecting", then: "reopen" } : { link, then: "none" };
  }
}

export interface ConnectOptions {
  /** the words for a call lost to a drop, in the user's language (what a page shows as it is) */
  unreachable?: () => string;
  /** how long a repeatable call waits for the reconnect, in ms, before it says the server cannot be reached */
  patience?: number;
  /** how long a socket that is up has to answer, in ms, when the page comes back, before it is taken for dead */
  probe?: number;
}

/** A Session over a socket, and the link under it: how it stands, and how to let go of it or take it up again. */
export interface Connected extends Session {
  close(): void;
  /** The page is back (on screen, the network changed): check the link, and take it up again at once if it is gone. */
  resume(): void;
  link(): Link;
  /** Every change of the link; returns unsubscribe. */
  watch(listener: (link: Link) => void): () => void;
}

export function connect(url: string, options: ConnectOptions = {}): Connected {
  const { unreachable = () => "the connection dropped", patience = 15_000, probe = 3_000 } = options;
  const listeners = new Set<(update: Update) => void>();
  const watchers = new Set<(link: Link) => void>();
  const pending = new Map<number, Pending>();
  const outbox: string[] = [];
  let socket: WebSocket | null = null;
  let nextId = 0;
  /** each chat's last seq seen: what a reconnect catches up from */
  const lastSeq = new Map<string, number>();
  let retry = 0;
  let closed = false;
  let link: Link = "connecting";
  /** whether a socket has been up before: the first one has nothing to catch up on */
  let wasUp = false;
  /** the retry that is waiting, so coming back can take it up now instead */
  let waiting: ReturnType<typeof setTimeout> | null = null;
  /** calls waiting for a socket that is up, to be sent again */
  const rejoin = new Set<() => void>();

  const deliver = (chat: string, envelope: Envelope) => {
    if (envelope.seq <= (lastSeq.get(chat) ?? 0)) return;
    lastSeq.set(chat, envelope.seq);
    for (const listener of listeners) listener({ kind: "event", chat, envelope });
  };
  /** The server could not replay what we missed: start over from its state. */
  const reset = (chat: string, state: State) => {
    lastSeq.set(chat, state.seq);
    for (const listener of listeners) listener({ kind: "reset", chat, state });
  };
  const chats = (list: Chat[]) => {
    for (const listener of listeners) listener({ kind: "chats", chats: list });
  };

  /** Everything since the last event seen: the chats as they are, and each chat's events (or its state, if too far behind). */
  const catchUp = () => {
    void call("chats.list", {}).then((r) => chats(r.chats), () => {});
    for (const [chat, since] of lastSeq)
      void call("session.sync", { chat, since }).then(
        (r) => (r.kind === "events" ? r.events.forEach((e) => deliver(chat, e)) : reset(chat, r.state)),
        () => {}, // lost to another drop: the next socket catches up again
      );
  };

  /** Take a signal through the rules, and do what they say. */
  const signal = (what: Signal) => {
    if (closed) return;
    const next = step(link, what);
    if (next.link !== link) {
      link = next.link;
      for (const watcher of watchers) watcher(link);
    }
    switch (next.then) {
      case "open":
        return open();
      case "reopen": {
        const stale = socket; // half-open: let go of, its close ignored, and what it carried lost with it
        socket = null;
        lose();
        stale?.close();
        return open();
      }
      case "wait":
        return void (waiting ??= setTimeout(() => {
          waiting = null;
          signal("retry");
        }, Math.min(10_000, 500 * 2 ** retry++)));
      case "probe":
        return check();
      case "catchUp":
        if (wasUp) catchUp();
        wasUp = true;
        return;
      case "none":
        return;
    }
  };

  /** The calls a socket was carrying fail with it, and what waited to go out. */
  const lose = () => {
    for (const entry of pending.values()) entry.fail(new Dropped(unreachable()));
    pending.clear();
    // what waited to go out has failed with them: sent later, a message the user takes back would arrive anyway
    outbox.length = 0;
  };

  /** Ask the socket that is up whether it answers; one that does not within `probe` is taken for dead. */
  const check = () => {
    const asked = socket;
    const timer = setTimeout(() => {
      if (socket === asked) signal("silent");
    }, probe);
    send("chats.list", {}).then(
      () => {
        clearTimeout(timer);
        if (socket === asked) signal("answered");
      },
      () => clearTimeout(timer), // the socket closed meanwhile: its close has said so
    );
  };

  const open = () => {
    if (waiting !== null) {
      clearTimeout(waiting);
      waiting = null;
    }
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return; // a newer socket is the one that counts
      retry = 0;
      outbox.splice(0).forEach((frame) => ws.send(frame));
      rejoin.forEach((go) => go());
      signal("opened");
    };
    ws.onmessage = ({ data }) => {
      if (socket !== ws) return; // a newer socket is the one that counts
      if (typeof data !== "string") return;
      const raw: unknown = JSON.parse(data);
      const note = Notification.safeParse(raw);
      if (note.success) {
        const push = note.data.params;
        return push.kind === "event" ? deliver(push.chat, push.envelope) : chats(push.chats);
      }
      const response = Response.parse(raw);
      const entry = typeof response.id === "number" ? pending.get(response.id) : undefined;
      if (!entry || typeof response.id !== "number") return;
      pending.delete(response.id);
      if ("error" in response) entry.fail(new CallFailed(response.error.message, response.error.code, response.error.data));
      else entry.settle(response.result);
    };
    ws.onclose = () => {
      if (socket !== ws) return; // we let this one go ourselves: its close is not the connection dropping
      socket = null;
      lose();
      signal("lost");
    };
  };

  /**
   * The page is back (a phone's browser freezes it, and its timers, in the background; the network changed), and a
   * call that finds no socket asks for this too: a socket that is gone is taken up now, without waiting out the
   * retry, and one that is up is asked whether it still answers.
   */
  const resume = () => {
    // a socket gone without a close yet (the browser has not noticed): the rules take it for down
    if (link !== "down" && link !== "connecting" && socket?.readyState !== WebSocket.OPEN) {
      const gone = socket;
      socket = null;
      gone?.close();
      lose();
      signal("lost");
    }
    retry = 0;
    signal("returned");
  };

  /** Resolves once a socket is up, rejects as Dropped when none comes within `patience`. */
  const reconnected = () =>
    new Promise<void>((resolve, reject) => {
      if (socket?.readyState === WebSocket.OPEN) return resolve();
      const go = () => {
        clearTimeout(timer);
        rejoin.delete(go);
        resolve();
      };
      const timer = setTimeout(() => {
        rejoin.delete(go);
        reject(new Dropped(unreachable()));
      }, patience);
      rejoin.add(go);
      resume();
    });

  /** A call; one lost to a drop that is safe to repeat waits for the reconnect and goes once more. */
  function call<M extends Method>(method: M, params: Params[M]): Promise<Results[M]> {
    return send(method, params).catch((error: unknown) => {
      if (!(error instanceof Dropped) || once.has(method) || closed) throw error;
      return reconnected().then(() => send(method, params));
    });
  }

  function send<M extends Method>(method: M, params: Params[M]): Promise<Results[M]> {
    const id = ++nextId;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<Results[M]>((resolve, reject) => {
      pending.set(id, {
        settle: (raw) => {
          // a result that does not parse fails its call, rather than the socket's message handler
          const parsed = (() => {
            try {
              return { ok: true, result: parseResult[method](raw) } as const;
            } catch (error) {
              return { ok: false, error } as const;
            }
          })();
          if (!parsed.ok) return reject(parsed.error);
          // a snapshot the caller fetched is where we now stand, so a later reconnect catches up from there;
          // returned events move us forward only as they are delivered
          if (method === "session.sync" && "chat" in params && typeof params.chat === "string") {
            const synced = parseResult["session.sync"](raw);
            if (synced.kind === "snapshot") lastSeq.set(params.chat, synced.state.seq);
          }
          resolve(parsed.result);
        },
        fail: reject,
      });
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
      else {
        // no socket (it dropped, or the page is only now coming back): it goes as soon as there is one
        outbox.push(frame);
        resume();
      }
    });
  }

  open();
  return {
    call,
    resume,
    link: () => link,
    watch(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
      socket?.close();
    },
  };
}
