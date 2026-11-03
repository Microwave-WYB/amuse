/**
 * Settings › Models: the model Muse chats with, the one that works in the
 * browser (it must see pictures; the chat's unless chosen), among those of the providers set up with
 * the user's own API keys or account sign-ins; the providers set up (only the end of a key
 * shows), each with a page of its own to test, replace or remove its key (or sign in again, or out); and
 * every other one to add.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound, Search } from "lucide-react";
import type {
  KeyProvider,
  KeysState,
  ModelRole,
  Session,
  ThinkingLevel,
} from "@amuse/protocol";
import { Button } from "./Button";
import { KeyLine, KeyLogin, type TestState, useKeyTests } from "./KeyLogin";
import { Sheet } from "./Sheet";
import { useT } from "../i18n/react.ts";
import { wordsOf } from "../shown.ts";
import { detailOf, useFail } from "../ask.tsx";
import { ErrorBanner, ErrorState } from "./Errors";

const label = "mb-2 mt-6 px-1 text-[13px] font-medium";
const group = "divide-y divide-[var(--fill-divider)] rounded-[18px] px-4";

/** `viewing`: the provider whose page is open (the settings' own state, so a phone's back button can leave it). */
export function Models({
  session,
  viewing,
  onView,
}: {
  session: Session;
  viewing: KeyProvider | null;
  onView: (provider: KeyProvider | null) => void;
}) {
  const t = useT();
  const [state, setState] = useState<KeysState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setting, setSetting] = useState<KeyProvider | null>(null);
  const { tests, test, clear } = useKeyTests(session);
  const [query, setQuery] = useState("");
  const [ownVoice, setOwnVoice] = useState(false);

  const load = useCallback(
    () =>
      session.call("keys.list", {}).then(
        (s) => setState(s),
        (e: unknown) => setError(wordsOf(e)),
      ),
    [session],
  );
  /** The same list once the providers' own catalogs have been fetched over the network (a model added since this version shows up when it is in). */
  const refresh = useCallback(
    () =>
      session.call("keys.refresh", {}).then(
        (s) => setState(s),
        // a fetch that cannot be done leaves the list as it is: nothing for the user to do about it
        () => {},
      ),
    [session],
  );
  /** Opening the page: the list as it is at once, then the providers asked. */
  useEffect(() => {
    void load();
    void refresh();
  }, [load, refresh]);
  /** a change that did not go through is a toast (the page itself is fine); `error` is only for a page that could not load */
  const failed = useFail();
  const choose = (role: ModelRole, model: string | null) => {
    session.call("models.choose", { role, model }).then(load, (e: unknown) => failed(e, "Settings › Models › choose a model", () => choose(role, model)));
  };
  const think = (role: ModelRole, level: ThinkingLevel) => {
    session.call("models.think", { role, level }).then(load, (e: unknown) => failed(e, "Settings › Models › thinking level", () => think(role, level)));
  };
  const voice = (provider: string | null) => {
    session.call("models.voice", { provider }).then(load, (e: unknown) => failed(e, "Settings › Models › voice", () => voice(provider)));
  };
  const forget = (provider: KeyProvider) => {
    clear(provider.id);
    onView(null);
    session.call("keys.logout", { provider: provider.id }).then(load, (e: unknown) => failed(e, `Settings › Models › remove the key for ${provider.id}`, () => forget(provider)));
  };

  const providers = state?.providers.filter((p) => p.use === "models") ?? [];
  const mine = providers.filter((p) => p.connected);
  const words = query.trim().toLowerCase();
  const others = providers.filter(
    (p) =>
      !p.connected &&
      (!words || p.name.toLowerCase().includes(words) || p.id.includes(words)),
  );
  const models = state?.models ?? [];
  /** a provider's name by its id, for the pickers */
  const names = new Map(providers.map((p) => [p.id, p.name]));
  // the page shows the provider as it is now (its key may have been replaced)
  const open =
    viewing && (providers.find((p) => p.id === viewing.id) ?? viewing);

  const sheet = (
    <KeyLogin
      session={session}
      provider={setting}
      onClose={(done) => {
        // a key just set up is tried at once
        if (done && setting) test(setting.id);
        setSetting(null);
        if (done) void load();
      }}
    />
  );

  if (open)
    return (
      <ProviderPage
        provider={open}
        test={tests[open.id]}
        uses={(["chat", "browser"] satisfies ModelRole[]).filter((role) =>
          state?.[role]?.startsWith(`${open.id}/`),
        )}
        onBack={() => onView(null)}
        onTest={() => test(open.id)}
        onReplace={() => setSetting(open)}
        onRemove={() => forget(open)}
      >
        {sheet}
      </ProviderPage>
    );

  const retryLoad = () => {
    setError(null);
    void load();
  };
  // the list could not load: the page says so in place of its content
  if (error !== null && state === null)
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        <ErrorState title={t.ask.loadTitle} message={error} detail={detailOf("Settings › Models", "keys", "keys_list_failed")} retry={retryLoad} />
      </div>
    );
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
      <p
        className="text-[13px] leading-snug"
        style={{ color: "var(--text-secondary)" }}
      >
        {t.models.intro}
      </p>
      {error !== null && state !== null && (
        <ErrorBanner message={error} detail={detailOf("Settings › Models", "keys", "keys_list_failed")} retry={retryLoad} />
      )}
      {mine.length > 0 && state && (
        <>
          {/* each role a group of its own, a row for each thing chosen and what it is: provider, model, thinking */}
          <p className={label} style={{ color: "var(--text-secondary)" }}>
            {t.models.chat}
          </p>
          <div
            className={group}
            style={{ background: "var(--fill-secondary)" }}
          >
            <ModelPicker
              title={t.models.chat}
              value={state.chat}
              options={models}
              names={names}
              onChange={(m) => choose("chat", m)}
            />
            <ThinkingPicker
              title={t.models.chat}
              levels={models.find((m) => m.id === state.chat)?.thinking}
              value={state.thinking.chat}
              onChange={(level) => think("chat", level)}
            />
          </div>
          <p className={label} style={{ color: "var(--text-secondary)" }}>
            {t.models.browser}
          </p>
          <div
            className={group}
            style={{ background: "var(--fill-secondary)" }}
          >
            <ModelPicker
              title={t.models.browser}
              value={state.browser}
              options={models.filter((m) => m.images)}
              names={names}
              unset={t.models.sameAsChat}
              onChange={(m) => choose("browser", m)}
            />
            <ThinkingPicker
              title={t.models.browser}
              levels={
                models.find((m) => m.id === (state.browser ?? state.chat))
                  ?.thinking
              }
              value={state.thinking.browser}
              onChange={(level) => think("browser", level)}
            />
          </div>
          {/* the browser on the chat's model, which cannot do its work */}
          {state.browser === null && state.chat !== null && models.find((m) => m.id === state.chat)?.images === false && (
            <p className="mt-2 px-1 text-[13px] leading-snug" style={{ color: "var(--text-secondary)" }}>
              {t.models.browserBlind}
            </p>
          )}
          {/* scheduled work: memory upkeep, reflection, the user's schedules */}
          <p className={label} style={{ color: "var(--text-secondary)" }}>
            {t.models.background}
          </p>
          <div
            className={group}
            style={{ background: "var(--fill-secondary)" }}
          >
            <ModelPicker
              title={t.models.background}
              value={state.background}
              options={models}
              names={names}
              unset={t.models.sameAsChat}
              onChange={(m) => choose("background", m)}
            />
            <ThinkingPicker
              title={t.models.background}
              levels={
                models.find((m) => m.id === (state.background ?? state.chat))
                  ?.thinking
              }
              value={state.thinking.background}
              onChange={(level) => think("background", level)}
            />
          </div>
          <p
            className="mt-2 px-1 text-[13px] leading-snug"
            style={{ color: "var(--text-secondary)" }}
          >
            {t.models.backgroundHelp}
          </p>
          <p className={label} style={{ color: "var(--text-secondary)" }}>
            {t.models.voice}
          </p>
          <div
            className={group}
            style={{ background: "var(--fill-secondary)" }}
          >
            <label className="flex items-center gap-3 py-2.5">
              <span
                className="text-[16px]"
                style={{ color: "var(--text-primary)" }}
              >
                {t.models.speechToText}
              </span>
              <select
                aria-label={t.models.speechToText}
                className="min-w-0 flex-1 truncate bg-transparent text-right text-[15px] outline-none"
                style={{ color: "var(--text-secondary)" }}
                value={state.voice.chosen ?? ""}
                onChange={(e) => voice(e.target.value || null)}
              >
                <option value="">
                  {state.voice.services.length > 0
                    ? t.models.automatic
                    : t.models.needsKey}
                </option>
                {state.voice.services.map((s) => (
                  <option key={s.provider} value={s.provider}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="flex w-full items-center gap-3 py-2.5 text-left"
              onClick={() => setOwnVoice(true)}
            >
              <span className="min-w-0 flex-1">
                <span
                  className="block text-[16px]"
                  style={{ color: "var(--text-primary)" }}
                >
                  {t.models.ownServer}
                </span>
                <span
                  className="block truncate text-[13px]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {state.voice.local
                    ? `${state.voice.local.model} · ${state.voice.local.url}`
                    : t.models.notSet}
                </span>
              </span>
              <ChevronRight
                size={16}
                style={{ color: "var(--icon-secondary)" }}
              />
            </button>
          </div>
          <LocalVoiceSheet
            open={ownVoice}
            current={state.voice.local}
            onClose={() => setOwnVoice(false)}
            onSave={(service) => {
              return session.call("models.localVoice", { service }).then(
                () => {
                  setOwnVoice(false);
                  void load();
                },
                (e: unknown) => {
                  throw e instanceof Error ? e : new Error(String(e));
                },
              );
            }}
          />
          <p
            className="mt-2 px-1 text-[13px] leading-snug"
            style={{ color: "var(--text-secondary)" }}
          >
            {t.models.voiceHelp}
          </p>
          <p className={label} style={{ color: "var(--text-secondary)" }}>
            {t.models.yourProviders}
          </p>
          <ul className={group} style={{ background: "var(--fill-secondary)" }}>
            {mine.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-3 py-2.5 text-left"
                  onClick={() => onView(p)}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[16px]"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {p.name}
                    </span>
                    <KeyLine
                      hint={p.hint}
                      way={p.way}
                      test={tests[p.id]}
                      brief
                    />
                  </span>
                  <ChevronRight
                    size={16}
                    style={{ color: "var(--icon-secondary)" }}
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className={label} style={{ color: "var(--text-secondary)" }}>
        {/* until the list is in, nothing is said about what is set up */}
        {state === null
          ? t.models.providers
          : mine.length > 0
            ? t.models.addProvider
            : t.models.chooseToStart}
      </p>
      <label
        className="mb-2 flex items-center gap-2 rounded-full px-4 py-2.5"
        style={{ background: "var(--field)" }}
      >
        <Search size={16} style={{ color: "var(--icon-secondary)" }} />
        <input
          aria-label={t.models.searchProviders}
          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          style={{ color: "var(--text-primary)" }}
          placeholder={t.models.searchProviders}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul className={group} style={{ background: "var(--fill-secondary)" }}>
        {state === null &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="py-3">
              <div className="skeleton h-5 w-2/5 rounded" />
            </li>
          ))}
        {state && others.length === 0 && (
          <li
            className="py-3.5 text-[15px]"
            style={{ color: "var(--text-secondary)" }}
          >
            {t.models.noProvider}
          </li>
        )}
        {others.map((p) => (
          <li key={p.id}>
            <button
              className="flex w-full items-center gap-3 py-3 text-left"
              onClick={() => setSetting(p)}
            >
              <span
                className="min-w-0 flex-1 truncate text-[16px]"
                style={{ color: "var(--text-primary)" }}
              >
                {p.name}
              </span>
              <ChevronRight
                size={16}
                style={{ color: "var(--icon-secondary)" }}
              />
            </button>
          </li>
        ))}
      </ul>
      {sheet}
    </div>
  );
}

/** A provider set up: its key (only the end), what it is used for, and what can be done with it. */
function ProviderPage({
  provider,
  test,
  uses,
  onBack,
  onTest,
  onReplace,
  onRemove,
  children,
}: {
  provider: KeyProvider;
  test: TestState;
  uses: ModelRole[];
  onBack: () => void;
  onTest: () => void;
  onReplace: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  // signed in with the user's account: there is no key, and removing it signs out
  const signedIn = provider.way === "account";
  const row =
    "hover-fade w-full py-3.5 text-left text-[15px] disabled:opacity-50";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3 sm:px-6">
      <button
        aria-label={t.common.back}
        // a desktop's way back to the providers (a phone's is in the settings' own bar)
        className="hover-fade hidden size-8 shrink-0 items-center justify-center rounded-full sm:flex"
        style={{
          background: "var(--fill-primary)",
          color: "var(--icon-primary)",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={onBack}
      >
        <ChevronLeft size={18} />
      </button>
      <div className="mt-2 flex flex-col items-center text-center">
        <span
          className="flex size-12 items-center justify-center rounded-[14px]"
          style={{ background: "#ffffff", color: "#111112" }}
        >
          <KeyRound size={22} />
        </span>
        <p
          className="mt-2 text-[18px] font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {provider.name}
        </p>
        <p
          className="mt-0.5 text-[13px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {uses.length === 0
            ? t.models.notUsed
            : t.models.usedFor(uses.map((u) => (u === "chat" ? t.models.useChat : t.models.useBrowser)))}
        </p>
      </div>
      <div
        className="mt-5 rounded-[18px] px-4 py-3"
        style={{ background: "var(--fill-secondary)" }}
      >
        <KeyLine hint={provider.hint} way={provider.way} test={test} />
      </div>
      <ul
        className={`${group} mt-3`}
        style={{ background: "var(--fill-secondary)" }}
      >
        <li>
          <button
            disabled={test === "testing"}
            className={row}
            style={{ color: "var(--fill-blue)" }}
            onClick={onTest}
          >
            {signedIn ? t.keys.testSignIn : t.keys.testKey}
          </button>
        </li>
        <li>
          <button
            className={row}
            style={{ color: "var(--fill-blue)" }}
            onClick={onReplace}
          >
            {signedIn ? t.keys.signInAgain : t.keys.replaceKey}
          </button>
        </li>
        <li>
          <button
            className={row}
            style={{ color: "var(--fill-red)" }}
            onClick={onRemove}
          >
            {signedIn ? t.keys.signOut : t.keys.removeKey}
          </button>
        </li>
      </ul>
      {children}
    </div>
  );
}

/**
 * How much a role's model thinks. The row is always there, so it is plain where it is; it can be changed only for a
 * model that thinks (it takes more than "off"), and says why not otherwise.
 */
function ThinkingPicker({
  title,
  levels,
  value,
  onChange,
}: {
  title: string;
  /** the levels the role's model takes; undefined: no model yet */
  levels: ThinkingLevel[] | undefined;
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  const t = useT();
  if (!levels || levels.length < 2)
    return (
      <Row name={t.models.thinking}>
        <span className="min-w-0 flex-1 truncate text-right text-[15px]" style={{ color: "var(--text-tertiary)" }}>
          {levels ? t.models.thinkingNone : t.models.thinkingNoModel}
        </span>
      </Row>
    );
  return (
    <Row name={t.models.thinking}>
      <select
        aria-label={t.models.thinkingFor(title)}
        className={pick}
        style={{ color: "var(--text-secondary)" }}
        value={value}
        onChange={(e) => {
          const level = levels.find((l) => l === e.target.value);
          if (level) onChange(level);
        }}
      >
        {levels.map((level) => (
          <option key={level} value={level}>
            {t.models.levels[level]}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * The user's own speech server: an OpenAI-style /audio/transcriptions (faster-whisper-server,
 * whisper.cpp's server, LocalAI…), by its address, the model it serves, and a key if it wants one.
 */
function LocalVoiceSheet({
  open,
  current,
  onClose,
  onSave,
}: {
  open: boolean;
  current: { url: string; model: string } | null;
  onClose: () => void;
  onSave: (
    service: { url: string; model: string; key: string | null } | null,
  ) => Promise<void>;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setUrl(current?.url ?? "http://host.docker.internal:8000/v1");
    setModel(current?.model ?? "");
    setKey("");
    setProblem(null);
  }, [open, current]);
  const save = (
    service: { url: string; model: string; key: string | null } | null,
  ) =>
    onSave(service).catch((e: unknown) =>
      setProblem(wordsOf(e)),
    );
  const field = "w-full bg-transparent px-4 py-3.5 text-[16px] outline-none";
  return (
    <Sheet open={open} onClose={onClose} bare>
      <div className="flex flex-col items-center px-6 pb-6 pt-5 text-center">
        <p
          className="text-[20px] font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {t.models.localTitle}
        </p>
        <p
          className="mt-1 text-[14px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {t.models.localHelp}
        </p>
        <div
          className="mt-5 w-full divide-y divide-[var(--fill-divider)] overflow-hidden rounded-[18px] text-left"
          style={{ background: "var(--field)" }}
        >
          <input
            aria-label={t.models.address}
            className={field}
            style={{ color: "var(--text-primary)" }}
            placeholder="http://host.docker.internal:8000/v1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            aria-label={t.models.modelName}
            className={field}
            style={{ color: "var(--text-primary)" }}
            placeholder={t.models.modelPlaceholder}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <input
            aria-label={t.models.keyLabel}
            type="password"
            autoComplete="off"
            className={field}
            style={{ color: "var(--text-primary)" }}
            placeholder={current ? t.models.keyKeepNone : t.models.keyIfNeeded}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        {problem && (
          <p
            role="alert"
            className="mt-2 text-[13px]"
            style={{ color: "var(--fill-red)" }}
          >
            {problem}
          </p>
        )}
        <Button
          variant="primary"
          size="lg"
          className="mt-6"
          disabled={!url.trim() || !model.trim()}
          onClick={() =>
            void save({
              url: url.trim(),
              model: model.trim(),
              key: key.trim() || null,
            })
          }
        >
          {t.models.save}
        </Button>
        {current && (
          <Button
            variant="plain"
            size="lg"
            tone="danger"
            className="mt-2"
            onClick={() => void save(null)}
          >
            {t.common.remove}
          </Button>
        )}
        <Button variant="plain" size="lg" className="mt-2" onClick={onClose}>
          {t.common.cancel}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * One role's model, as rows of its group: its provider (when more than one has models: the same model can be at two),
 * then one of that provider's models. None chosen yet: said so. A provider picked shows its models; the role's model
 * changes only once one of them is picked. A role that can follow the chat's model (`unset`) offers that first in both.
 */
function ModelPicker({
  title,
  value,
  options,
  names,
  unset,
  onChange,
}: {
  title: string;
  value: string | null;
  options: KeysState["models"];
  /** a provider's name by its id */
  names: ReadonlyMap<string, string>;
  /** what no choice means, where it means something ("Same as chat"); else one must be chosen */
  unset?: string;
  onChange: (model: string | null) => void;
}) {
  const t = useT();
  const providers = [...new Set(options.map((o) => o.provider))];
  const current = options.find((o) => o.id === value)?.provider ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  // a role on the chat's model has no provider of its own: the provider row says so too, until one is picked
  const following = unset !== undefined && value === null && picked === null && providers.length > 1;
  const provider = following ? null : (picked ?? current ?? providers[0] ?? null);
  const shown = options.filter((o) => o.provider === provider);
  // the role's model is this provider's: it is the one shown chosen; else, until one is picked, nothing is
  const chosen = value !== null && shown.some((o) => o.id === value) ? value : "";
  return (
    <>
      {providers.length > 1 && (
        <Row name={t.models.provider}>
          <select
            aria-label={t.models.providerFor(title)}
            className={pick}
            style={{ color: "var(--text-secondary)" }}
            value={provider ?? ""}
            onChange={(e) => {
              setPicked(e.target.value || null);
              if (!e.target.value && value !== null) onChange(null);
            }}
          >
            {unset && <option value="">{unset}</option>}
            {providers.map((id) => (
              <option key={id} value={id}>
                {names.get(id) ?? id}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row name={t.models.model}>
        <select
          aria-label={t.models.modelFor(title)}
          className={pick}
          style={{
            color: chosen || (unset && value === null) ? "var(--text-secondary)" : "var(--fill-blue)",
          }}
          value={chosen}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
            else if (unset) onChange(null);
          }}
        >
          {unset ? <option value="">{unset}</option> : !chosen && <option value="">{t.models.chooseModel}</option>}
          {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
          {shown.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

/** A picker as a role's row: what it is, then the choice at the end. */
const pick = "min-w-0 flex-1 truncate bg-transparent text-right text-[15px] outline-none [text-align-last:right]";

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 py-2.5">
      <span className="shrink-0 text-[16px]" style={{ color: "var(--text-primary)" }}>
        {name}
      </span>
      {children}
    </label>
  );
}
