/**
 * amuse web app. The conversation is the fold of the session's events;
 * Ui is local panel state; Actions turn clicks into protocol calls or panel
 * changes. Components get exactly the slices they render.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { connect } from "@amuse/api/client";
import { createHost, realTimers } from "@amuse/core";
import { demoPorts, seed } from "@amuse/demo";
import { MAIN, type Method, type Params, type Session } from "@amuse/protocol";
import { type Connection, connection } from "./connection.ts";
import { useChats, useConversation } from "./session.ts";
import { applyTheme, storedTheme } from "./theme.ts";
import { activeT } from "./i18n/language.ts";
import { useT } from "./i18n/react.ts";
import { resumeOnReturn } from "./return.ts";
import { Files, serverFiles } from "./files.ts";
import { Unlock } from "./components/Unlock";
import { type Actions, type Ui, initialUi } from "./ui.ts";
import { pillBrowser, viewerTabs } from "./view.ts";
import { type Outgoing, outgoingIn } from "./outgoing.ts";
import { flyAvatar, transition, travels } from "./transition.ts";
import { close, useBack } from "./back.ts";
import { useSwipe } from "./useSwipe.ts";
import { type Ask, pinGuarded } from "./pin.ts";
import { PinContext, usePinSheet } from "./components/PinSheet";
import { AccountWatch } from "./components/AccountWatch";

/** the width the user dragged the viewer to (only that is kept; the default follows the window) */
const VIEWER_WIDTH = "amuse.viewerDragged";
/** The viewer is at least 420px; the chat keeps at least 360px of `room` (the window; the sidebar gives way first). */
const clampViewer = (width: number, room = innerWidth) =>
  Math.round(Math.max(420, Math.min(width, room - 360)));
/** whether the sidebar is docked where there is room (the user's choice) */
const SIDEBAR = "amuse.sidebar";
/** the chat's least width beside a docked sidebar: with less, the sidebar collapses */
const CHAT_ROOM = 480;
import { MusePanel } from "./components/MusePanel";
import { ChatFeed } from "./components/ChatFeed";
import {
  DockedSidebar,
  DrawerSidebar,
  SIDEBAR_INSET,
  SIDEBAR_ROOM,
  SIDEBAR_WIDTH,
} from "./components/ChatsPanel";
import { Composer } from "./components/Composer";
import { ExplainerModal } from "./components/ExplainerModal";
import { SettingsModal } from "./components/SettingsModal";
import { SessionContext } from "./sessionContext.ts";
import { AskContext, NotifyContext, detailOf, failureDetail } from "./ask.tsx";
import { wordsOf } from "./shown.ts";
import { asking } from "./reply.ts";
import { ErrorToast } from "./components/Errors.tsx";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { BrowserButton } from "./components/BrowserButton";
import { MenuButton, TopBar } from "./components/TopBar";
import { Viewer } from "./components/Viewer";
import { pictures } from "./photos.ts";

/** The image viewer, fetched the first time a picture is opened. */
const PhotoViewer = lazy(() => import("./components/PhotoViewer"));

/**
 * A session and how to let go of it (a socket must be closed, or it reconnects forever), and how to take the
 * connection up again at once when the page comes back (a phone's browser freezes it in the background).
 * On a server, a sensitive call the server holds for the PIN asks for it (`ask`), then goes again.
 */
const openSession = (
  where: Connection,
  ask: Ask,
): { session: Session; close: () => void; resume: () => void } => {
  if (where.kind === "server") {
    const remote = connect(where.rpc, { unreachable: () => activeT().common.serverUnreachable });
    return { session: pinGuarded(remote, ask), close: () => remote.close(), resume: () => remote.resume() };
  }
  return {
    session: createHost(demoPorts(realTimers), { seed: seed() }),
    close: () => {},
    resume: () => {},
  };
};

export default function App() {
  const [where, setWhere] = useState<Connection | null>(null);
  useEffect(() => void connection().then(setWhere), []);
  if (!where) return null;
  return where.kind === "locked" ? (
    <Unlock ready={where.ready} waiting={where.waiting} />
  ) : (
    <Chat where={where} />
  );
}

function Chat({ where }: { where: Exclude<Connection, { kind: "locked" }> }) {
  const t = useT();
  const pin = usePinSheet();
  const [link, setLink] = useState(() => openSession(where, pin.ask));
  const { session, resume } = link;
  // a page that comes back after the browser froze it (a phone in the background) takes its socket up at once
  useEffect(() => resumeOnReturn(resume), [resume]);
  const chats = useChats(session);
  // the look this device was left in
  const [ui, setUi] = useState<Ui>(() => ({
    ...initialUi,
    theme: storedTheme(),
    sidebar: localStorage.getItem(SIDEBAR) !== "false",
  }));
  const {
    state: conversation,
    older,
    release,
  } = useConversation(session, ui.chat);
  /** messages on their way, shown at once (outgoing.ts) */
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const shownOutgoing = useMemo(
    () => outgoingIn(conversation.entities, outgoing, ui.chat),
    [conversation.entities, outgoing, ui.chat],
  );
  /** the chat's pictures, those on their way too: what the image viewer moves between */
  const chatPictures = useMemo(
    () => pictures([...conversation.entities, ...shownOutgoing.sending]),
    [conversation.entities, shownOutgoing.sending],
  );
  /** the image viewer, once one has been opened: it stays, to fade out as it closes */
  const [photosOpened, setPhotosOpened] = useState(false);
  if (ui.photo !== null && !photosOpened) setPhotosOpened(true);
  /** where files go and come from: the server's (the demo keeps none) */
  const files = useMemo(
    () => (where.kind === "server" ? serverFiles(where.rpc) : null),
    [where],
  );
  // on a server, what is not set up yet (asked again as settings close): with no chat model, the chat
  // says where to choose one; with no apps' key, a Connect card opens the settings where it goes
  const [needsModel, setNeedsModel] = useState(false);
  const [needsAppsKey, setNeedsAppsKey] = useState(false);
  useEffect(() => {
    if (where.kind !== "server" || ui.settings.open) return;
    session.call("keys.list", {}).then(
      (keys) => {
        setNeedsModel(keys.chat === null);
        setNeedsAppsKey(
          keys.providers.some((p) => p.use === "apps" && !p.connected),
        );
      },
      () => {},
    );
  }, [session, where.kind, ui.settings.open]);
  // back from connecting an app (another tab, or Settings): a Connect card still waiting asks how it went
  useEffect(() => {
    if (where.kind !== "server") return;
    const waiting = () =>
      conversationRef.current.entities.some(
        (e) => e.kind === "connection" && e.status === "pending",
      );
    const look = () => {
      if (document.visibilityState === "visible" && waiting())
        session.call("apps.accounts", {}).catch(() => {});
    };
    if (!ui.settings.open) look();
    document.addEventListener("visibilitychange", look);
    return () => document.removeEventListener("visibilitychange", look);
  }, [session, where.kind, ui.settings.open]);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const needsAppsKeyRef = useRef(needsAppsKey);
  needsAppsKeyRef.current = needsAppsKey;
  /** the chat on screen, for actions made once (sending goes where the user is now) */
  const chatRef = useRef(ui.chat);
  chatRef.current = ui.chat;
  /** what the next message replies to: the quote bar's item, if it is this chat's */
  const replying = ui.replying?.chat === ui.chat ? ui.replying.quote : null;
  const replyingRef = useRef(replying);
  replyingRef.current = replying;
  // the chat on screen was deleted (here or on another device): back to the main chat
  useEffect(() => {
    if (chats.length > 0 && !chats.some((c) => c.id === ui.chat))
      setUi((u) => ({ ...u, chat: MAIN, viewer: null }));
  }, [chats, ui.chat]);
  const museOpen = useRef(ui.museOpen);
  museOpen.current = ui.museOpen;

  useEffect(() => applyTheme(ui.theme), [ui.theme]);

  // desktop: how wide the browser viewer is (its left edge is dragged), kept on this device
  const [viewerWidth, setViewerWidth] = useState(() =>
    // first time: at most two thirds of the window, the chat keeping the rest
    clampViewer(
      Number(localStorage.getItem(VIEWER_WIDTH)) ||
        Math.min(innerWidth - 482, (innerWidth * 2) / 3),
    ),
  );
  /** the window's width: what decides whether the sidebar has room to dock */
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const resized = () => setWidth(innerWidth);
    addEventListener("resize", resized);
    return () => removeEventListener("resize", resized);
  }, []);
  // the width the viewer is shown at: the one chosen, as far as this window leaves the chat its least
  // (a window made narrower after a drag does not squeeze the chat out; widened again, it comes back)
  const shownViewer = clampViewer(viewerWidth, width);
  // the right side's share: the browser (docked from lg), or a docked Muse panel
  const right =
    ui.viewer && width >= 1024
      ? shownViewer + 8
      : ui.museOpen && !ui.viewer && width >= 768
        ? 368
        : 0;
  /** room to dock the sidebar and leave the chat enough (md up) */
  const fits = width >= 768 && width - right - SIDEBAR_ROOM >= CHAT_ROOM;
  const docked = ui.sidebar && fits;
  /** the sidebar is out, docked or over the chat */
  const sidebarOut = docked || ui.chatsOpen;
  // ☰ sits in the sidebar's top right while it is out (4px in from its edge), else at the chat's top left
  // (on a phone the sidebar is a page of its own: the screen's top right, where it turns into the close X)
  const drawerWidth = width >= 768 ? SIDEBAR_WIDTH : width;
  const menuOpenLeft = (width >= 768 ? SIDEBAR_INSET : 0) + drawerWidth - 4 - 44;
  const menuLeft = sidebarOut ? menuOpenLeft : 12;
  // once there is room to dock it, the sidebar is no longer a drawer over the chat
  useEffect(() => {
    if (docked) setUi((u) => (u.chatsOpen ? { ...u, chatsOpen: false } : u));
  }, [docked]);
  useEffect(() => {
    // what the right side takes of the window: the browser button keeps to the chat's corner beside it
    document.documentElement.style.setProperty(
      "--right-room",
      `${width >= 768 ? right : 0}px`,
    );
  }, [width, right]);
  useEffect(() => {
    // the browser's share of the window, when it is docked there: what floats over the chat dims all but it
    document.documentElement.style.setProperty(
      "--viewer-room",
      `${ui.viewer && width >= 1024 ? shownViewer + 8 : 0}px`,
    );
  }, [ui.viewer, width, shownViewer]);
  useEffect(() => {
    // read by what floats over the chat (the Muse panel), to keep beside the sidebar
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${docked ? SIDEBAR_ROOM : 0}px`,
    );
  }, [docked]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--viewer-width",
      `${shownViewer}px`,
    ); // read by the viewer and the chat beside it
  }, [shownViewer]);

  const actions = useMemo<Actions>(() => {
    const patch = (fn: (u: Ui) => Ui) => setUi(fn);
    /** Every call's failure is shown, briefly; nothing is dropped silently. */
    const call = <M extends Method>(method: M, params: Params[M]) =>
      void session.call(method, params).catch((error: unknown) =>
        patch((u) => ({
          ...u,
          notice: wordsOf(error),
          noticeAbout: { detail: failureDetail("a call", error), retry: () => call(method, params) },
        })),
      );
    return {
      // the device's time zone is the user's: times the agent sets and says are on their clock
      // shown at once as sending; one that does not get through comes off the chat (the composer takes it back)
      send: (text, attachments, suggested) => {
        const chat = chatRef.current;
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const key = `sending-${crypto.randomUUID()}`;
        // the reply goes with this message and leaves the bar; a message that does not get through takes it back
        const quote = replyingRef.current;
        patch((u) => ({ ...u, replying: null }));
        setOutgoing((list) => [
          ...list,
          {
            key,
            chat,
            text,
            attachments,
            quote,
            at: new Date().toISOString(),
            timezone,
            sent: null,
            after: conversationRef.current.entities.at(-1)?.id ?? null,
          },
        ]);
        return session
          .call("chat.send", {
            chat,
            text,
            timezone,
            attachments,
            ...(suggested ? { suggested } : {}),
            ...(quote?.kind === "error"
              ? { about: { message: quote.text, detail: quote.detail ?? "" } }
              : quote
                ? { replyTo: quote.id }
                : {}),
          })
          .then(
            ({ id }) =>
              setOutgoing((list) =>
                list.map((o) => (o.key === key ? { ...o, sent: id } : o)),
              ),
            (error: unknown) => {
              setOutgoing((list) => list.filter((o) => o.key !== key));
              if (quote) patch((u) => (u.replying ? u : { ...u, replying: { chat, quote } }));
              const reason = wordsOf(error);
              patch((u) => ({
                ...u,
                notice:
                  reason === "disconnected"
                    ? activeT().chat.notSentUnreachable
                    : activeT().chat.notSent(reason),
              }));
              throw error;
            },
          );
      },
      reply: (quote) =>
        patch((u) => ({ ...u, replying: quote ? { chat: chatRef.current, quote } : null })),
      stop: () => call("chat.stop", { chat: chatRef.current }),
      retry: (id) => call("chat.retry", { id }),
      answerSecret: async (id, answer) =>
        void (await session.call("secret.answer", { id, answer })),
      resolveApproval: (id, resolution) =>
        call("approval.resolve", { id, resolution }),
      // before apps are set up, a Connect card goes straight to where their key goes
      openExplainer: (explainer) =>
        patch((u) =>
          explainer !== null && needsAppsKeyRef.current
            ? {
                ...u,
                settings: {
                  open: true,
                  section: "connectors",
                  app: null,
                  provider: null,
                  entry: null,
                },
              }
            : { ...u, explainer },
        ),
      connect: (id) => {
        // apps are not set up yet: the card leads to where their key goes
        if (needsAppsKeyRef.current)
          return patch((u) => ({
            ...u,
            explainer: null,
            settings: {
              open: true,
              section: "connectors",
              app: null,
              provider: null,
              entry: null,
            },
          }));
        patch((u) => ({ ...u, explainer: null }));
        // open the tab now, inside the click, so mobile browsers do not block it; point it at the link once known
        const tab = window.open("about:blank", "_blank");
        session.call("connection.begin", { id }).then(
          ({ url }) =>
            tab ? tab.location.replace(url) : window.location.assign(url),
          (error: unknown) => {
            tab?.close();
            patch((u) => ({
              ...u,
              notice: wordsOf(error),
              noticeAbout: { detail: failureDetail("an action", error) },
            }));
          },
        );
      },
      appAccess: async (app) => (await session.call("apps.access", { app })).access,
      connectKey: async (app, values) => void (await session.call("apps.connectKey", { app, values })),
      // the browser takes the right: a docked Muse panel gives it up, and its avatar goes back to the top
      openViewer: (browserId) => {
        const open = () =>
          patch((u) => ({
            ...u,
            museOpen: false,
            viewer: { browserId, shown: "browser" },
          }));
        // only a docked Muse panel's avatar has somewhere to travel; otherwise the viewer just slides in
        // (a transition would lift the avatar over the viewer, then drop it at the end)
        if (museOpen.current) transition(open);
        else open();
      },
      closeViewer: () => patch((u) => ({ ...u, viewer: null })),
      notify: (message, about) =>
        patch((u) => ({ ...u, notice: message, noticeAbout: about ?? { detail: detailOf("app", "", "notice") } })),
      // settings (a modal over the chat on a phone) gives way to the chat; the line is filled in by the composer
      askAmuse: (about) => patch((u) => asking(u, chatRef.current, about, `error-${crypto.randomUUID()}`)),
      selectTab: (browserId) =>
        patch((u) =>
          u.viewer ? { ...u, viewer: { ...u.viewer, browserId } } : u,
        ),
      showInViewer: (shown) =>
        patch((u) => (u.viewer ? { ...u, viewer: { ...u.viewer, shown } } : u)),
      // closing a tab closes its browser; the viewer moves to another open one, or goes
      closeTab: (browserId) => {
        call("browser.control", { id: browserId, action: "stop" });
        patch((u) => {
          if (!u.viewer) return u;
          const last = viewerTabs(conversation)
            .filter((b) => b.id !== browserId)
            .at(-1);
          // the last one closed: the viewer stays, saying none is open
          if (!last) return { ...u, viewer: { ...u.viewer, browserId: null } };
          return {
            ...u,
            viewer: {
              ...u.viewer,
              browserId:
                u.viewer.browserId === browserId ? last.id : u.viewer.browserId,
            },
          };
        });
      },
      newBrowser: () =>
        void session
          .call("browser.open", {
            chat: chatRef.current,
            url: "https://www.google.com/",
          })
          .then(
            ({ id }) =>
              patch((u) => ({
                ...u,
                museOpen: false,
                viewer: { browserId: id, shown: "browser" },
              })),
            (error: unknown) =>
              patch((u) => ({
                ...u,
                notice: wordsOf(error),
              noticeAbout: { detail: failureDetail("an action", error) },
              })),
          ),
      control: (id, action) => call("browser.control", { id, action }),
      // best effort and quiet: a desktop that keeps its shape still works
      fit: (id, view) =>
        void session.call("browser.fit", { id, view }).catch(() => {}),
      stopTask: (id) => call("task.stop", { id }),
      openTaskDetail: (taskDetail) => patch((u) => ({ ...u, taskDetail })),
      openPhoto: (photo) => patch((u) => ({ ...u, photo })),
      setChats: (chatsOpen) => patch((u) => ({ ...u, chatsOpen })),
      setSidebar: (sidebar) => {
        localStorage.setItem(SIDEBAR, String(sidebar));
        patch((u) => ({ ...u, sidebar, chatsOpen: false }));
      },
      openLeft: (left) =>
        patch((u) => ({ ...u, left, goal: null, skill: null })),
      openGoal: (goal) => patch((u) => ({ ...u, goal })),
      openSkill: (skill) => patch((u) => ({ ...u, skill })),
      // a chat's browsers are its own: the viewer starts over
      openChat: (chat) =>
        patch((u) => ({ ...u, chat, chatsOpen: false, viewer: null, photo: null })),
      newChat: () =>
        void session.call("chats.create", {}).then(
          ({ id }) =>
            patch((u) => ({ ...u, chat: id, chatsOpen: false, viewer: null, photo: null })),
          (error: unknown) =>
            patch((u) => ({
              ...u,
              notice: wordsOf(error),
              noticeAbout: { detail: failureDetail("an action", error) },
            })),
        ),
      renameChat: (id, title) => call("chats.rename", { id, title }),
      deleteChat: (id) => {
        call("chats.delete", { id });
        patch((u) => (u.chat === id ? { ...u, chat: MAIN, viewer: null, photo: null } : u));
      },
      // the avatar travels between the top and the panel
      // the avatar travels with the change: a view transition on a phone, a flight of its own on a wider screen
      setMuse: (museOpen) =>
        (travels() ? transition : flyAvatar)(() =>
          patch((u) => ({ ...u, museOpen })),
        ),
      openSettings: (section) =>
        patch((u) => ({
          ...u,
          chatsOpen: false,
          settings: { open: true, section, app: null, provider: null, entry: null },
        })),
      openApp: (app) =>
        patch((u) => ({ ...u, settings: { ...u.settings, app } })),
      openProvider: (provider) =>
        patch((u) => ({ ...u, settings: { ...u.settings, provider } })),
      openEntry: (entry) =>
        patch((u) => ({ ...u, settings: { ...u.settings, entry } })),
      closeSettings: () =>
        patch((u) => ({ ...u, settings: { ...u.settings, open: false } })),
      setTheme: (theme) => patch((u) => ({ ...u, theme })),
      reset: () => {
        link.close();
        setLink(openSession(where, pin.ask));
        setUi((u) => ({ ...initialUi, theme: u.theme }));
      },
    };
  }, [session, link, conversation, pin.ask]);

  // Back closes the top layer; Muse's panel closes as its button does, its avatar travelling home
  useBack(ui, (layer) =>
    layer === "muse" ? actions.setMuse(false) : setUi((u) => close(u, layer)),
  );

  // on a phone, swipes open and close the sidebar and the viewer (the browser button's: the run that needs you); the Amuse
  // panel's page, sheets and the like keep to themselves
  const swipe = useSwipe({
    open: ui.viewer ? "viewer" : ui.chatsOpen ? "sidebar" : null,
    blocked: ui.museOpen || ui.settings.open || ui.explainer !== null || ui.taskDetail !== null || ui.photo !== null,
    commit: (panel, open) =>
      panel === "sidebar" ? actions.setChats(open) : open ? actions.openViewer(pillBrowser(conversation)?.id ?? null) : actions.closeViewer(),
  });
  const swiping = (panel: "sidebar" | "viewer") => (swipe?.panel === panel ? swipe : null);

  // a notice shows for a few seconds, a longer one a little longer (a tap closes it sooner)
  useEffect(() => {
    if (!ui.notice) return;
    const timer = setTimeout(
      () => setUi((u) => ({ ...u, notice: null, noticeAbout: null })),
      // a notice with something to do stays a little longer
      Math.min(9000, 4000 + ui.notice.length * 40) + (ui.noticeAbout ? 4000 : 0),
    );
    return () => clearTimeout(timer);
  }, [ui.notice]);

  return (
    <PinContext.Provider value={pin}>
      <Files.Provider value={files}>
        <SessionContext.Provider value={session}>
        <AskContext.Provider value={actions.askAmuse}>
        <NotifyContext.Provider value={actions.notify}>
        <div
          className="flex h-full"
          style={{ background: "var(--chat-background)" }}
        >
          {/* on a desktop, closing (by ☰, or giving way) as it opens: by its width */}
          <DockedSidebar
            open={docked}
            chats={chats}
            current={ui.chat}
            left={ui.left}
            goal={ui.goal}
            skill={ui.skill}
            session={session}
            actions={actions}
          />
          {/* with the viewer open on desktop, the chat keeps what the viewer leaves */}
          <div
            className="relative flex min-w-0 flex-1 flex-col"
            // the right side's panel (the Amuse panel, or the browser) pushes the chat aside on the same curve as the
            // sidebar on the left
            style={{
              marginRight: width >= 768 ? right : 0,
              transition: "margin-right 0.24s cubic-bezier(0.2, 0, 0, 1)",
            }}
          >
            <ChatFeed
              conversation={conversation}
              outgoing={shownOutgoing}
              older={older}
              release={release}
              thumb={where.kind === "server" ? where.thumb : null}
              actions={actions}
            />
            <TopBar
              conversation={conversation}
              museOpen={ui.museOpen}
              actions={actions}
            />
            <MenuButton
              open={sidebarOut}
              left={menuLeft}
              swipe={swiping("sidebar")}
              openLeft={menuOpenLeft}
              onClick={() =>
                docked
                  ? actions.setSidebar(false)
                  : ui.chatsOpen
                    ? actions.setChats(false)
                    : fits
                      ? actions.setSidebar(true)
                      : actions.setChats(true)
              }
            />
            <BrowserButton
              conversation={conversation}
              open={ui.viewer !== null}
              swipe={swiping("viewer")}
              actions={actions}
            />
            {ui.notice && (
              <ErrorToast
                message={ui.notice}
                detail={ui.noticeAbout?.detail ?? detailOf("app", "", "notice")}
                {...(ui.noticeAbout?.retry ? { retry: ui.noticeAbout.retry } : {})}
                onClose={() => setUi((u) => ({ ...u, notice: null, noticeAbout: null }))}
              />
            )}
            {needsModel && !ui.notice && (
              <button
                className="anim-fade-in absolute inset-x-0 bottom-[86px] z-30 mx-auto w-fit max-w-[90%] rounded-full px-4 py-2 text-[13px] font-medium"
                style={{
                  background: "var(--fill-primary)",
                  color: "var(--fill-blue)",
                  boxShadow: "var(--shadow-float)",
                }}
                onClick={() => actions.openSettings("models")}
              >
                {t.chat.chooseModel}
              </button>
            )}
            <Composer
              conversation={conversation}
              replying={replying}
              place={
                ui.chat === MAIN
                  ? null
                  : chats.find((c) => c.id === ui.chat)?.title || t.chat.newChat
              }
              actions={actions}
            />
          </div>

          <MusePanel
            open={ui.museOpen}
            conversation={conversation}
            session={session}
            mode={ui.viewer ? "floating" : "docked"}
            actions={actions}
          />
          <DrawerSidebar
            open={ui.chatsOpen && !docked}
            swipe={swiping("sidebar")}
            chats={chats}
            current={ui.chat}
            left={ui.left}
            goal={ui.goal}
            skill={ui.skill}
            session={session}
            actions={actions}
          />
          <SettingsModal
            ui={ui.settings}
            theme={ui.theme}
            session={session}
            demo={where.kind === "demo"}
            actions={actions}
          />
          <ExplainerModal
            conversation={conversation}
            open={ui.explainer}
            actions={actions}
          />
          <TaskDetailSheet
            conversation={conversation}
            open={ui.taskDetail}
            actions={actions}
          />
          <Viewer
            conversation={conversation}
            viewer={ui.viewer}
            swipe={swiping("viewer")}
            live={where.kind === "server" ? where.live : null}
            thumb={where.kind === "server" ? where.thumb : null}
            terminal={where.kind === "server" ? where.terminal : null}
            onResize={(edge) => {
              const width = clampViewer(innerWidth - 8 - edge);
              localStorage.setItem(VIEWER_WIDTH, String(width));
              setViewerWidth(width);
            }}
            actions={actions}
          />
          {photosOpened && files && (
            <Suspense fallback={null}>
              <PhotoViewer pictures={chatPictures} open={ui.photo} onShow={actions.openPhoto} />
            </Suspense>
          )}
          {pin.sheet}
          {where.kind === "server" && <AccountWatch notify={actions.notify} />}
        </div>
        </NotifyContext.Provider>
        </AskContext.Provider>
        </SessionContext.Provider>
      </Files.Provider>
    </PinContext.Provider>
  );
}
