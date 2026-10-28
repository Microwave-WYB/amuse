/**
 * UI-only state: which panels are open and what they show. Server state is
 * the conversation (session.ts); this never duplicates it, only ids into it.
 */
import { type App, type AppAccess, type Attachment, type GivenField, type KeyProvider, MAIN, type Quote, type SecretAnswer, type SkillOrigin } from "@amuse/protocol";

export type SettingsSection = "general" | "security" | "models" | "connectors" | "permissions" | "logins" | "secrets" | "schedules" | "sandbox";

/** What the Vault shows besides its list: the form to add an entry, or an entry's page (its name, to title the page). */
export type SecretPage = { kind: "add" } | { kind: "entry"; id: string; name: string };

/** A section of the sidebar besides the chats (nav.ts). */
export type LeftSection = "goals" | "skills";

import type { Theme } from "./theme.ts";
import type { ErrorAbout } from "./ask.tsx";

export type { Theme };

/** What the viewer on the right shows. */
export type Shown = "browser" | "terminal";

export interface Ui {
  theme: Theme;
  /** the chat on screen: MAIN or a side chat's id */
  chat: string;
  /** the sidebar docked beside the chat, where there is room: the user's choice (☰), kept on this device */
  sidebar: boolean;
  /** the sidebar as a drawer over the chat (a phone; a desktop without room to dock it) */
  chatsOpen: boolean;
  /** what the sidebar shows besides the chats; null: the chats */
  left: LeftSection | null;
  /** the goal whose page is open in the sidebar */
  goal: string | null;
  /** the skill whose page is open in the sidebar */
  skill: { name: string; origin: SkillOrigin } | null;
  /** the Muse panel (profile and activity): docked on the right, or floating over the chat while the browser has the right */
  museOpen: boolean;
  /** section null: on a phone, the list of sections (on a desktop, the first one) */
  /** `app`, `provider`, `entry`: a connector's, a key provider's or a secret's page (or the form to add one), open over its section */
  settings: {
    open: boolean;
    section: SettingsSection | null;
    app: App | null;
    provider: KeyProvider | null;
    entry: SecretPage | null;
  };
  /** the viewer on the right: the browser (its active tab) or the sandbox's terminals */
  viewer: { browserId: string | null; shown: Shown } | null;
  /** connection whose pre-connect explainer is open */
  explainer: string | null;
  /** task whose detail sheet is open */
  taskDetail: string | null;
  /** the picture open in the image viewer (an attachment's id), over everything */
  photo: string | null;
  /** the item of Amuse's the next message in `chat` replies to (the quote bar over the composer) */
  replying: { chat: string; quote: Quote } | null;
  /** a short message about something that did not work */
  notice: string | null;
  /** the notice's technical detail (for the agent) and a way to try again, when it has them: these give it actions */
  noticeAbout: { detail: string; retry?: () => void } | null;
}

export const initialUi: Ui = {
  theme: "system",
  chat: MAIN,
  sidebar: true,
  chatsOpen: false,
  left: null,
  goal: null,
  skill: null,
  museOpen: false,
  settings: { open: false, section: null, app: null, provider: null, entry: null },
  viewer: null,
  explainer: null,
  taskDetail: null,
  photo: null,
  replying: null,
  notice: null,
  noticeAbout: null,
};

/** Everything a component can ask for: protocol calls and UI changes. */
export interface Actions {
  /** say something in the chat on screen, with any files already uploaded; fails when it did not get through */
  send(text: string, attachments: Attachment[], suggested?: { reply: string; index: number }): Promise<void>;
  /** start replying to an item of Amuse's in the chat on screen, or (null) stop; the next message goes with it */
  reply(quote: Quote | null): void;
  stop(): void;
  /** try again a turn Muse could not reply to */
  retry(failure: string): void;
  resolveApproval(id: string, resolution: "allow_once" | "allow_always" | "deny"): void;
  /** answer a request for a secret: the code or the fields it asked for (to the server's care, never the chat), or null to decline; fails, in words, when it could not be given */
  answerSecret(id: string, answer: SecretAnswer | null): Promise<void>;
  openExplainer(connectionId: string | null): void;
  connect(connectionId: string): void;
  /** how an app is connected: a hosted link, or credentials of the user's own (one field, or several) */
  appAccess(app: string): Promise<AppAccess>;
  /** connect an app with those credentials (typed by them, passed on to Composio, kept nowhere); fails, in words, when it did not go through */
  connectKey(app: string, values: GivenField[]): Promise<void>;
  /** null: whichever browser is newest (or none, said so) */
  openViewer(browserId: string | null): void;
  closeViewer(): void;
  /** a short message about something that did not work, shown for a moment */
  notify(message: string, about?: { detail: string; retry?: () => void }): void;
  /** ask Amuse about an error: its summary becomes the quote bar over the composer, with a line ready to send */
  askAmuse(about: ErrorAbout): void;
  selectTab(browserId: string): void;
  /** what the viewer shows: the browser or the terminals */
  showInViewer(shown: Shown): void;
  /** close a browser (its tab): its agent stops, its logins are kept, its place is given up */
  closeTab(browserId: string): void;
  /** open a browser of the user's own, held by them from the start, and show it */
  newBrowser(): void;
  control(browserId: string, action: "take" | "handBack" | "stop"): void;
  /** while a browser is viewed: shape its desktop like this view (CSS px); null: back to the standard size */
  fit(browserId: string, view: { width: number; height: number } | null): void;
  stopTask(taskId: string): void;
  openTaskDetail(taskId: string | null): void;
  /** open a picture sent in the chat in the image viewer, or (null) close it */
  openPhoto(attachmentId: string | null): void;
  setChats(open: boolean): void;
  /** dock the sidebar or collapse it (where there is room for it) */
  setSidebar(docked: boolean): void;
  /** show a section in the sidebar (null: the chats) */
  openLeft(section: LeftSection | null): void;
  /** open a goal's page in the sidebar (null: back to the list) */
  openGoal(goal: string | null): void;
  /** open a skill's page in the sidebar (null: back to the list) */
  openSkill(skill: { name: string; origin: SkillOrigin } | null): void;
  /** show a chat (the drawer closes) */
  openChat(chat: string): void;
  /** open a new side chat and show it */
  newChat(): void;
  renameChat(chat: string, title: string): void;
  deleteChat(chat: string): void;
  setMuse(open: boolean): void;
  openSettings(section: SettingsSection | null): void;
  /** Settings › Connections: a service's page, or back to the list (null) */
  openApp(app: App | null): void;
  openProvider(provider: KeyProvider | null): void;
  /** Settings › Vault: an entry's page, the form to add one, or back to the list (null) */
  openEntry(entry: SecretPage | null): void;
  closeSettings(): void;
  setTheme(theme: Theme): void;
  reset(): void;
}

