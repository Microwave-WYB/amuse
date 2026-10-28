/**
 * Main chat feed, 1:1 with Muse: fit-content agent bubbles on --fill-secondary
 * with rich markdown, user bubbles right-aligned on --chat-user-bubble, a
 * small action row under each bubble (emoji/share/copy; user gets ⋯), group
 * timestamps ('8:27 AM') centered between message groups, and the three-dot
 * hatch-dot-pulse thinking indicator in a small gray bubble.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  Check,
  CircleAlert,
  Copy,
  File as FileIcon,
  Reply as ReplyArrow,
  Share,
  TextCursor,
} from "lucide-react";
import type { Attachment, Entity, Prompt, Quote, Reply, State } from "@amuse/protocol";
import { quoteOf, size } from "@amuse/core";
import { useFiles } from "../files.ts";
import type { Actions } from "../ui.ts";
import { useT } from "../i18n/react.ts";
import { useLongPress } from "../longPress.ts";
import { quoteLine } from "../reply.ts";
import { thinking, time } from "../view.ts";
import {
  ApprovalCard,
  BrowserCard,
  ConnectionCard,
  SecretCard,
  FailureCard,
  ScheduleCard,
  TaskCard,
} from "./cards";
import { RichText, linked } from "./markdown";
import { Picture } from "./Picture";
import { BUBBLE, BUBBLE_PAD, type Place, type Side, bottomRound, concentric, corners } from "./shape.ts";

type Message = Prompt | Reply;
type Thumb = ((id: string) => string) | null;

/** Messages this close together, from the same side, read as one group (Muse). */
const GROUP_GAP_MS = 5 * 60_000;
/** Who an entity comes from: the user's messages, or Muse (its replies and every card). */
const side = (e: Entity): Side => (e.kind === "prompt" ? "user" : "muse");
const joins = (a: Entity | undefined, b: Entity | undefined): boolean =>
  !!a &&
  !!b &&
  side(a) === side(b) &&
  Date.parse(b.at) - Date.parse(a.at) < GROUP_GAP_MS;

/** A time line goes in only after a pause this long (and before the first item). */
const STAMP_GAP_MS = 10 * 60_000;
const stamped = (previous: Entity | undefined, entity: Entity) =>
  !previous || Date.parse(entity.at) - Date.parse(previous.at) > STAMP_GAP_MS;

/**
 * What the chat shows. Not Muse's exchanges with its background runs: those
 * are between the agents (Muse tells the user what matters in its own words).
 * Not a reply that ended with nothing to read (a model's stray line breaks
 * before a tool call).
 */
function shown(entity: Entity): boolean {
  switch (entity.kind) {
    case "instruction":
    case "question":
      return false;
    case "reply":
      return (
        entity.streaming ||
        entity.text.trim() !== "" ||
        entity.attachments.length > 0
      );
    // one every instance starts with was not asked for here: it is in Settings › Schedules; the others stay as
    // their card, which says when one is paused, done or cancelled
    case "schedule":
      return !entity.preset;
    // one refused by the user's own rule was never a card: it is in the Approvals list, and Amuse says so in a line
    case "approval":
      return !entity.byRule;
    case "prompt":
    case "task":
    case "connection":
    case "secret":
    case "browser":
    case "failure":
      return true;
  }
}

/** Messages render as bubbles; every other entity is a card. */
function EntityView({
  entity,
  place,
  thumb,
  actions,
  onMenu,
  reveal,
  selecting,
  sending,
  closed,
}: {
  entity: Entity;
  place: Place;
  thumb: Thumb;
  actions: Actions;
  onMenu: (menu: Menu) => void;
  /** scroll to an item and mark it (a quote was tapped) */
  reveal: (id: string) => void;
  /** its words are selectable in the bubble (Select text) */
  selecting: boolean;
  /** a message of the user's still on its way */
  sending: boolean;
  /** the user has written since: a reply's suggestions can no longer be tapped */
  closed: boolean;
}) {
  switch (entity.kind) {
    case "prompt":
    case "reply":
      return (
        <Bubble
          item={entity}
          place={place}
          onMenu={onMenu}
          actions={actions}
          reveal={reveal}
          selecting={selecting}
          sending={sending}
          closed={closed}
        />
      );
    case "task":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <TaskCard task={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "approval":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <ApprovalCard approval={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "connection":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <ConnectionCard connection={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "secret":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <SecretCard secret={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "browser":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <BrowserCard
            browser={entity}
            thumb={thumb}
            place={place}
            actions={actions}
          />
        </Replyable>
      );
    case "schedule":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <ScheduleCard schedule={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "failure":
      return (
        <Replyable entity={entity} onMenu={onMenu} actions={actions}>
          <FailureCard failure={entity} place={place} actions={actions} />
        </Replyable>
      );
    case "instruction":
    case "question":
      return null; // between the agents (see `shown`)
  }
}

/**
 * A card of Amuse's, which can be replied to: a long press on a phone opens the menu (Reply, Copy), and with a
 * pointer a reply icon sits beside it while it is hovered (the same strip a message's actions use).
 */
function Replyable({
  entity,
  onMenu,
  actions,
  children,
}: {
  entity: Entity;
  onMenu: (menu: Menu) => void;
  actions: Actions;
  children: React.ReactNode;
}) {
  const quote = quoteOf(entity);
  const { handlers } = useLongPress((point, item) => {
    if (quote) onMenu({ text: quote.text, quote, mine: false, select: null, opened: Date.now(), point, item });
  });
  return (
    // the cards inside are `w-full` up to --amuse-width themselves: the cap is here once, not on both (a percentage of a percentage)
    <div
      className="msg relative w-full max-w-(--amuse-width) [&>*]:max-w-none"
      {...handlers}
    >
      {children}
      {quote && <ActionRow mine={false} text="" onReply={() => actions.reply(quote)} />}
    </div>
  );
}

/** What can be done with a message's text: copy it, or share it where the system can. */
const copyText = (text: string) =>
  void navigator.clipboard?.writeText(text).catch(() => {});
const canShare = () => typeof navigator.share === "function";
const shareText = (text: string) =>
  void navigator.share?.({ text }).catch(() => {});

/** Desktop: a message's actions, beside its bubble while the pointer is on it or its side (index.css: .msg-actions). */
function ActionRow({
  mine,
  text,
  onReply,
}: {
  mine: boolean;
  text: string;
  /** Amuse's items only: start a reply to it */
  onReply?: () => void;
}) {
  const t = useT();
  return (
    <div
      className={`msg-actions ${mine ? "msg-actions-mine" : ""} flex items-center gap-0.5`}
    >
      {onReply && (
        <button
          aria-label={t.chat.reply}
          title={t.chat.reply}
          className="hover-fade rounded-full p-1.5"
          style={{ color: "var(--icon-secondary)" }}
          onClick={onReply}
        >
          <ReplyArrow size={16} />
        </button>
      )}
      {text !== "" && canShare() && (
        <button
          aria-label={t.chat.share}
          className="hover-fade rounded-full p-1.5"
          style={{ color: "var(--icon-secondary)" }}
          onClick={() => shareText(text)}
        >
          <Share size={16} />
        </button>
      )}
      {text !== "" && (
        <button
          aria-label={t.chat.copy}
          className="hover-fade rounded-full p-1.5"
          style={{ color: "var(--icon-secondary)" }}
          onClick={() => copyText(text)}
        >
          <Copy size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * What a menu is for: the words to copy, the quote that starts a reply (Amuse's items only), where the finger was,
 * and the item (where it sits on screen).
 */
type Menu = {
  text: string;
  quote: Quote | null;
  /** the user's own bubble (on the right) */
  mine: boolean;
  /** the message whose words can be selected in its bubble (the phone's own selection, which the press took over); null for a card */
  select: string | null;
  /** when it opened (ms): the tap that ends the long press is not a tap outside it (the browser may send one) */
  opened: number;
  point: { x: number; y: number };
  item: HTMLElement;
};

const MENU_WIDTH = 176;
const MARGIN = 12;

/**
 * Touch: a long press on a message or a card opens this (a tap does nothing; with a pointer there are the hover actions): a card over the
 * item (above it, else below), from its sender's side, kept on screen; what can be done with it. A tap elsewhere
 * closes it. Words the phone has already selected stay the phone's, with its handles and its copy button.
 */
function MessageMenu({
  menu,
  onClose,
  onReply,
  onSelect,
}: {
  menu: Menu | null;
  onClose: () => void;
  onReply: (quote: Quote) => void;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => setHeight(card.current?.offsetHeight ?? 0), [menu]);
  if (!menu) return null;
  const { text, quote, mine, select, point, item } = menu;
  // over the item, not on its selected words: above it, else below it, from the side of whoever said it;
  // an item too tall for either has it where the finger was
  const rect = item.getBoundingClientRect();
  const fits = (y: number) => y >= MARGIN && y + height <= innerHeight - MARGIN;
  const above = rect.top - 8 - height;
  const under = rect.bottom + 8;
  const top = fits(above)
    ? above
    : fits(under)
      ? under
      : Math.max(MARGIN, Math.min(point.y + 8, innerHeight - MARGIN - height));
  const left = Math.min(
    Math.max(MARGIN, mine ? rect.right - MENU_WIDTH : rect.left),
    innerWidth - MENU_WIDTH - MARGIN,
  );
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const row =
    "hover-fade flex h-11 w-full items-center gap-3 rounded-[12px] px-3 text-[15px]";
  return (
    // a press held on the menu is no selection of its words
    <div
      className="fixed inset-0 z-[80] select-none [-webkit-touch-callout:none]"
      onClick={() => {
        if (Date.now() - menu.opened > 500) onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={card}
        role="menu"
        className="anim-popover-in absolute rounded-[18px] p-1.5"
        style={{
          left,
          top,
          width: MENU_WIDTH,
          transformOrigin: `${point.x - left}px ${point.y - top}px`,
          background: "var(--fill-primary)",
          boxShadow: "var(--shadow-sheet)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {quote && (
          <button
            role="menuitem"
            className={row}
            style={{ color: "var(--text-primary)" }}
            onClick={act(() => onReply(quote))}
          >
            <ReplyArrow size={18} /> {t.chat.reply}
          </button>
        )}
        {text !== "" && (
          <button
            role="menuitem"
            className={row}
            style={{ color: "var(--text-primary)" }}
            onClick={act(() => copyText(text))}
          >
            <Copy size={18} /> {t.chat.copy}
          </button>
        )}
        {select && (
          <button
            role="menuitem"
            className={row}
            style={{ color: "var(--text-primary)" }}
            onClick={act(() => onSelect(select))}
          >
            <TextCursor size={18} /> {t.chat.selectText}
          </button>
        )}
        {text !== "" && canShare() && (
          <button
            role="menuitem"
            className={row}
            style={{ color: "var(--text-primary)" }}
            onClick={act(() => shareText(text))}
          >
            <Share size={18} /> {t.chat.share}
          </button>
        )}
      </div>
    </div>
  );
}

/** Files sent with a message, above its words: images and videos shown, anything else as a file to open or download. */
function Sent({
  attachments,
  mine,
  onOpen,
}: {
  attachments: Attachment[];
  mine: boolean;
  /** open a picture in the image viewer */
  onOpen: (id: string) => void;
}) {
  const shown = (a: Attachment) =>
    /^image\/(png|jpeg|gif|webp|avif)$/.test(a.type) || /^video\//.test(a.type);
  const media = attachments.filter(shown);
  const others = attachments.filter((a) => !shown(a));
  const single = media.length === 1;
  return (
    <div
      className={`flex max-w-[88%] sm:max-w-[78%] flex-col gap-1.5 ${mine ? "items-end" : "items-start"}`}
    >
      {media.length > 0 && (
        <div className={single ? "max-w-full" : "grid grid-cols-2 gap-1.5"}>
          {media.map((a) => (
            <Media key={a.id} file={a} single={single} onOpen={() => onOpen(a.id)} />
          ))}
        </div>
      )}
      {others.map((a) => (
        <FileCard key={a.id} file={a} gone={false} />
      ))}
    </div>
  );
}

/** A picture or video; once its file is gone from the workspace, a card saying so. */
function Media({ file, single, onOpen }: { file: Attachment; single: boolean; onOpen: () => void }) {
  const files = useFiles();
  const [gone, setGone] = useState(false);
  if (gone) return <FileCard file={file} gone />;
  const fit = single ? "max-h-[360px] max-w-full" : "size-36 object-cover";
  if (file.type.startsWith("video/"))
    return (
      <video
        src={files?.url(file.id)}
        controls
        playsInline
        preload="metadata"
        aria-label={file.name}
        onError={() => setGone(true)}
        className={`rounded-[18px] ${fit}`}
        style={{ background: "var(--fill-secondary)" }}
      />
    );
  return <Picture file={file} single={single} onOpen={onOpen} onGone={() => setGone(true)} />;
}

/** A file as a card: its name and size, to open or download; or that it was deleted. */
function FileCard({ file, gone }: { file: Attachment; gone: boolean }) {
  const t = useT();
  const files = useFiles();
  const body = (
    <>
      <FileIcon size={20} style={{ color: "var(--icon-secondary)" }} />
      <span className="min-w-0">
        <span
          className={`block truncate text-[14px] font-medium ${gone ? "line-through" : ""}`}
          style={{
            color: gone ? "var(--text-secondary)" : "var(--text-primary)",
          }}
        >
          {file.name}
        </span>
        <span
          className="block text-[12px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {gone ? t.chat.deleted : size(file.size)}
        </span>
      </span>
    </>
  );
  const look =
    "flex max-w-full items-center gap-2.5 rounded-[18px] px-3.5 py-2.5";
  if (gone || !files)
    return (
      <div className={look} style={{ background: "var(--fill-secondary)" }}>
        {body}
      </div>
    );
  return (
    <a
      href={files.url(file.id)}
      download={file.name}
      className={`hover-fade ${look}`}
      style={{ background: "var(--fill-secondary)" }}
    >
      {body}
    </a>
  );
}

/** The item a message replies to, small and muted above it; tapping it goes to the item. */
function QuoteChip({
  quote,
  reveal,
}: {
  quote: Quote;
  reveal: (id: string) => void;
}) {
  const t = useT();
  return (
    <button
      aria-label={t.chat.jumpToQuoted}
      className="hover-fade flex max-w-[88%] sm:max-w-[78%] items-start gap-1.5 rounded-[16px] px-3 py-2 text-left text-[13px] leading-[18px]"
      style={{
        background: "var(--fill-secondary)",
        color: "var(--text-secondary)",
      }}
      // an error has no place in the feed to go to
      onClick={() => quote.kind !== "error" && reveal(quote.id)}
    >
      {quote.kind === "error" ? (
        <CircleAlert size={14} className="mt-0.5 shrink-0" />
      ) : (
        <ReplyArrow size={14} className="mt-0.5 shrink-0" />
      )}
      <span className="line-clamp-2 [overflow-wrap:anywhere]">
        {quoteLine(quote, t)}
      </span>
    </button>
  );
}

function Bubble({
  item,
  place,
  onMenu,
  actions,
  reveal,
  selecting,
  sending,
  closed,
}: {
  item: Message;
  place: Place;
  onMenu: (menu: Menu) => void;
  actions: Actions;
  reveal: (id: string) => void;
  selecting: boolean;
  sending: boolean;
  closed: boolean;
}) {
  const t = useT();
  const isUser = item.kind === "prompt";
  const bubble = useRef<HTMLDivElement>(null);
  /** what a reply to this starts from; none for a message the server does not have yet */
  const quote = sending ? null : quoteOf(item);
  // entering selection mode selects the whole text at once, so the phone shows its handles and its copy menu
  useEffect(() => {
    const words = selecting ? bubble.current?.querySelector("[data-words]") : null;
    if (!words) return;
    const range = document.createRange();
    range.selectNodeContents(words);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }, [selecting]);
  const select = item.text.trim() === "" ? null : item.id;
  // a long press on a message opens the menu: Reply and Copy (words already selected by the phone are the phone's)
  const press = useLongPress((point, el) => {
    onMenu({ text: item.text, quote, mine: isUser, select, opened: Date.now(), point, item: el });
  });
  const { attachments } = item;
  return (
    <div
      className={`anim-fade-in flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"} transition-opacity ${sending ? "opacity-60" : ""}`}
    >
      {item.kind === "prompt" && item.quote && (
        <QuoteChip quote={item.quote} reveal={reveal} />
      )}
      {attachments.length > 0 && (
        <Sent attachments={attachments} mine={isUser} onOpen={actions.openPhoto} />
      )}
      {(item.text !== "" || attachments.length === 0) && (
        <div
          ref={bubble}
          // in selection mode the press is the phone's own, and the bubble says so
          {...(selecting ? { "data-selecting": "" } : press.handlers)}
          // 15px text on 23px lines, 11px of padding above and below and 17px at the sides, measured from Muse: a line is
          // 45px high, a full pill with BUBBLE's 23px corners; with suggestions the bottom pads 17px too, so the boxes
          // sit 17px from the sides and the bottom and have the corner 23 - 17 = 6px, concentric
          // a long run with no space (a web address) breaks where it must, inside the bubble
          // both fit their words: the user's to a share of the column, Amuse's to the width its cards share (--amuse-width)
          className={`msg relative ${selecting ? "bubble-selectable" : ""} px-[17px] py-[11px] text-[15px] leading-[23px] [overflow-wrap:anywhere] ${item.kind === "reply" && item.suggestions.length > 0 ? "pb-[17px]" : ""} ${isUser ? "w-fit max-w-[88%] sm:max-w-[78%]" : `max-w-(--amuse-width) ${item.suggestions.length > 0 ? "w-full" : "w-fit"}`}`}
          style={{
            ...corners(isUser ? "user" : "muse", place, BUBBLE),
            background: isUser
              ? "var(--chat-user-bubble)"
              : "var(--fill-secondary)",
            color: isUser ? "var(--chat-user-text)" : "var(--chat-agent-text)",
          }}
        >
          {item.kind === "prompt" ? (
            <span data-words>{linked(item.text, item.id, true)}</span>
          ) : (
            <div
              data-words
              className={item.streaming ? "shimmer-text" : undefined}
            >
              <RichText text={item.text} />
            </div>
          )}
          {item.kind === "reply" && item.suggestions.length > 0 && (
            <Suggestions reply={item} closed={closed || sending} place={place} actions={actions} />
          )}
          <ActionRow
            mine={isUser}
            text={item.text}
            {...(quote ? { onReply: () => actions.reply(quote) } : {})}
          />
        </div>
      )}
      {sending && (
        <span
          className="activity-indicator-fade px-1 text-[12px]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {t.chat.sending}
        </span>
      )}
    </div>
  );
}

/**
 * The answers Amuse offers, in boxes the width of the bubble: dashed while they can be tapped. A tap sends the words as
 * the user's message; that box turns solid with a check and the rest dim. Once the user has written anything newer
 * (or one was chosen) none can be tapped.
 */
function Suggestions({ reply, closed, place, actions }: { reply: Reply; closed: boolean; place: Place; actions: Actions }) {
  const t = useT();
  const done = reply.chosen !== null;
  // the bubble's 17px side and bottom padding is the boxes' inset: their radius is the corner's minus it
  const round = concentric(bottomRound(place, BUBBLE), BUBBLE_PAD);
  return (
    <div role="group" aria-label={t.chat.suggestedReplies} className="mt-3 flex flex-col gap-2">
      {reply.suggestions.map((text, index) => {
        const mine = reply.chosen === index;
        const still = !mine && (done || closed);
        return (
          <button
            key={text}
            type="button"
            aria-pressed={mine}
            disabled={done || closed}
            onClick={() => void actions.send(text, [], { reply: reply.id, index }).catch(() => {})}
            // 48px high; the check is 20px, so its distance to the top, bottom and right edge is (48 - 20) / 2 = 14px,
            // 12.5px of padding inside the 1.5px border
            className={`flex min-h-12 w-full items-center gap-2 border-[1.5px] py-2.5 pl-4 pr-[12.5px] text-left text-[15px] leading-[22px] outline-offset-2 outline-[color:var(--fill-blue)] focus-visible:outline-2 ${mine ? "border-solid font-medium" : still ? "border-solid" : "hover-fade border-dashed"}`}
            style={{
              borderRadius: round,
              borderColor: mine ? "var(--text-secondary)" : "var(--text-tertiary)",
              background: "var(--fill-card-button)",
              color: mine ? "var(--text-primary)" : "var(--chat-agent-text)",
              // the ones not chosen recede
              opacity: still ? 0.4 : 1,
            }}
          >
            <span className="min-w-0 flex-1">{text}</span>
            {mine && (
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full"
                style={{ background: "var(--text-secondary)", color: "var(--fill-card-button)" }}
              >
                <Check size={12} strokeWidth={3} aria-hidden />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TimeDivider({ time }: { time: string }) {
  return (
    <div className="anim-fade-in flex justify-center py-1">
      <span
        className="text-[12px] font-medium"
        style={{ color: "var(--text-tertiary)" }}
      >
        {time}
      </span>
    </div>
  );
}

/** px from the bottom past which the jump-to-bottom button shows */
/** how long after the user's own touch a scroll counts as theirs (momentum runs on a while) */
const USER_SCROLL_MS = 1500;
const JUMP_BUTTON_DISTANCE = 240;
/** px from the top within which older messages are fetched */
const OLDER_DISTANCE = 600;
/** Most pages fetched back to find the item a quote points at. */
const REVEAL_PAGES = 20;
/** How long (ms) an item stays marked after a quote was tapped (index.css `.quote-flash`). */
const FLASH_MS = 1600;

interface Props {
  conversation: State;
  /** messages on their way (outgoing.ts): those not on the server yet, and the keys theirs keep once there */
  outgoing: { sending: Prompt[]; keys: Map<string, string> };
  /** fetch the page before the oldest message held */
  older: () => Promise<void>;
  /** let go of pages fetched back */
  release: () => void;
  thumb: Thumb;
  actions: Actions;
}

export function ChatFeed({
  conversation,
  outgoing,
  older,
  release,
  thumb,
  actions,
}: Props) {
  const t = useT();
  // what is on its way goes at the end, as it will be once the server has it
  const feed = useMemo(
    () => [...conversation.entities.filter(shown), ...outgoing.sending],
    [conversation.entities, outgoing.sending],
  );
  /** where the user last wrote: suggestions above it are closed */
  const lastWritten = feed.findLastIndex((e) => e.kind === "prompt");
  const sending = useMemo(
    () => new Set(outgoing.sending.map((p) => p.id)),
    [outgoing.sending],
  );
  /** messages in the whole feed: what "new" is counted against, so pages fetched back are not new */
  const total = conversation.earlier + conversation.entities.length;
  /** the item whose menu is open (touch: a long press on a message or card) */
  const [menu, setMenu] = useState<Menu | null>(null);
  /** the message whose words are selectable in its bubble (Select text), until a tap elsewhere or a scroll takes it away */
  const [selecting, setSelecting] = useState<string | null>(null);
  const leaveSelecting = () => {
    setSelecting(null);
    if (getSelection()?.anchorNode && scrollRef.current?.contains(getSelection()?.anchorNode ?? null)) getSelection()?.removeAllRanges();
  };
  const openMenu = (next: Menu) => {
    setSelecting(null);
    setMenu(next);
  };
  useEffect(() => {
    if (selecting === null) return;
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest("[data-selecting]"))) leaveSelecting();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [selecting]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** far enough from the bottom to offer the jump button, new messages or not */
  const [far, setFar] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const seenRef = useRef(0);
  /**
   * The view sticks to the end while the user leaves it there: only their own scrolling
   * changes this, so content that grows (a streaming reply, a thumbnail loading) is followed.
   */
  const stick = useRef(true);
  /** a smooth scroll to the end is under way: the positions it passes through are not the user's */
  const gliding = useRef(false);

  const toEnd = (smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    seenRef.current = total;
    setPendingCount(0);
    if (!smooth) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    gliding.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // the glide aims where the end was; once it settles, land on where the end is now (content may have grown)
    const land = () => {
      el.removeEventListener("scrollend", land);
      clearTimeout(fallback);
      gliding.current = false;
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scrollend", land);
    const fallback = setTimeout(land, 800); // where scrollend is not fired
  };
  const scrollToBottom = () => toEnd(true);

  // stuck to the end, it stays there whatever grows or shrinks: content, or the view (the keyboard)
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // the fades spare the scrollbar (index.css, and the composer's): how wide it is now (none where it floats, or before
    // there is anything to scroll); on the root, where the composer reads it too
    const bar = () =>
      document.documentElement.style.setProperty(
        "--chat-scrollbar",
        `${el.offsetWidth - el.clientWidth}px`,
      );
    bar();
    const follow = new ResizeObserver(() => {
      bar();
      if (!stick.current) return;
      if (gliding.current)
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); // keep the glide aimed at the end
      else el.scrollTop = el.scrollHeight;
    });
    follow.observe(content);
    follow.observe(el);
    return () => follow.disconnect();
  }, []);
  /** the user's own hand on the scroll ends a glide: from then on, where they scroll counts */
  const handOn = () => {
    gliding.current = false;
    handled.current = Date.now();
  };
  /** when the user last touched the scroll (wheel, touch, keys, the scrollbar): a scroll long after is not theirs */
  const handled = useRef(0);

  /** Where the first message held sat before older ones went in above it, to put it back there. */
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const fetching = useRef(false);
  const offset = (id: string) => {
    const el = scrollRef.current;
    const item = el?.querySelector(`[data-entity="${CSS.escape(id)}"]`);
    return el && item
      ? item.getBoundingClientRect().top - el.getBoundingClientRect().top
      : null;
  };
  const fetchOlder = () => {
    const el = scrollRef.current;
    const first = feed[0];
    if (
      !el ||
      !first ||
      conversation.earlier === 0 ||
      fetching.current ||
      el.scrollTop > OLDER_DISTANCE
    )
      return;
    const top = offset(first.id);
    if (top === null) return;
    fetching.current = true;
    anchor.current = { id: first.id, top };
    older().finally(() => (fetching.current = false));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const held = anchor.current;
    if (!el || !held) return;
    anchor.current = null;
    const top = offset(held.id);
    if (top !== null) el.scrollTop += top - held.top;
  }, [conversation.earlier]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    fetchOlder();
    // the bubble being selected has scrolled out of view
    if (selecting !== null) {
      const own = el.querySelector(`[data-entity="${CSS.escape(selecting)}"]`)?.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      if (!own || own.bottom < view.top || own.top > view.bottom) leaveSelecting();
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance < 80;
    setFar(distance > JUMP_BUTTON_DISTANCE);
    if (gliding.current) return; // positions a glide passes through are not the user's
    // a scroll the user did not make (the page laid out anew as cards arrived) does not unstick the view
    if (
      !near &&
      stick.current &&
      Date.now() - handled.current > USER_SCROLL_MS
    ) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    stick.current = near;
    setAtBottom(near);
    if (near) {
      seenRef.current = total;
      setPendingCount(0);
      release();
    }
  };

  /**
   * Go to an item a quote points at and mark it for a moment, fetching older pages while it is not held yet (the
   * view holds only the recent end). Gone from the chat, there is nowhere to go.
   */
  const latest = useRef(conversation);
  latest.current = conversation;
  const reveal = async (id: string) => {
    const el = () =>
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-entity="${CSS.escape(id)}"]`,
      ) ?? null;
    for (let pages = 0; !el() && latest.current.earlier > 0 && pages < REVEAL_PAGES; pages++) {
      await older();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const found = el();
    if (!found) return;
    // the view leaves the end for good: it is not to snap back, nor follow what grows
    stick.current = false;
    handled.current = Date.now();
    found.scrollIntoView({ block: "center", behavior: "smooth" });
    found.classList.remove("quote-flash");
    void found.offsetWidth; // the mark starts again when a quote is tapped twice
    found.classList.add("quote-flash");
    setTimeout(() => found.classList.remove("quote-flash"), FLASH_MS);
  };

  const arrived = useRef(false);
  /** the newest message the user sent: sending one takes the view back to the end */
  const lastPrompt = useRef<string | null>(null);
  useEffect(() => {
    const newestPrompt = feed.findLast((e) => e.kind === "prompt")?.id ?? null;
    // The first content (the initial sync) lands at the bottom at once, like opening a chat.
    if (!arrived.current && feed.length > 0) {
      arrived.current = true;
      lastPrompt.current = newestPrompt;
      toEnd(false);
      return;
    }
    if (
      newestPrompt !== lastPrompt.current &&
      feed.at(-1)?.id === newestPrompt
    ) {
      lastPrompt.current = newestPrompt;
      toEnd(true); // the user just sent it
    } else if (stick.current) {
      // at the end: the view follows (the resize observer); pages fetched back can go
      seenRef.current = total;
      release();
    } else {
      // reading back: leave the view alone and count what is new for the jump-to-latest pill
      setPendingCount(Math.max(0, total - seenRef.current));
    }
    fetchOlder(); // the feed may not fill the screen yet
  }, [feed, conversation.activity]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={handOn}
        onTouchStart={handOn}
        onTouchMove={handOn}
        onKeyDown={handOn}
        onPointerDown={handOn}
        className="h-full overflow-x-hidden overflow-y-auto px-4 pt-16 pb-28 chat-scroll-fade"
        // no scroll anchoring: it moves the view when cards arrive above the end, and the view would think the user scrolled
        style={{ background: "var(--chat-background)", overflowAnchor: "none" }}
      >
        <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3">
          {feed.map((entity, i) => (
            // joining the one above: 4px under it, bubble or card alike (the feed's gap is 12px)
            <div
              key={outgoing.keys.get(entity.id) ?? entity.id}
              data-entity={entity.id}
              className={`flex flex-col gap-3 ${joins(feed[i - 1], entity) ? "-mt-2" : ""}`}
            >
              {stamped(feed[i - 1], entity) && (
                <TimeDivider time={time(entity.at)} />
              )}
              <EntityView
                entity={entity}
                place={{
                  joinsPrevious: joins(feed[i - 1], entity),
                  joinsNext: joins(entity, feed[i + 1]),
                }}
                thumb={thumb}
                actions={actions}
                onMenu={openMenu}
                selecting={selecting === entity.id}
                reveal={reveal}
                sending={sending.has(entity.id)}
                closed={i < lastWritten}
              />
            </div>
          ))}
          {thinking(conversation) && (
            <div className="anim-fade-in flex justify-start">
              <div
                className="flex w-fit items-center gap-1.5 rounded-[22px] px-4 py-3.5"
                style={{ background: "var(--fill-secondary)" }}
                aria-label={t.chat.thinking}
              >
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="hatch-dot"
                    style={{ animationDelay: `${i * 200}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        {/* Jump-to-bottom: a plain down-arrow button while far from the bottom;
          "N messages" pill (Amuse ref 09-waiting) when new ones arrived. */}
        {(far || pendingCount > 0) &&
          !atBottom &&
          (pendingCount > 0 ? (
            <button
              className="absolute bottom-[86px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full py-1.5 pl-3 pr-2 text-[12px] font-semibold"
              style={{
                background: "var(--chat-user-bubble)",
                color: "var(--chat-user-text)",
                boxShadow: "var(--shadow-float)",
              }}
              onClick={scrollToBottom}
            >
              {t.chat.newMessages(pendingCount)}
              <ChevronDown size={14} />
            </button>
          ) : (
            <button
              aria-label={t.chat.scrollToBottom}
              className="absolute bottom-[86px] left-1/2 z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full"
              style={{
                background: "var(--fill-card-button)",
                color: "var(--icon-primary)",
                boxShadow: "var(--shadow-float)",
              }}
              onClick={scrollToBottom}
            >
              <ArrowDown size={18} />
            </button>
          ))}
        {/* Muse-style scroll fade: a mask dissolves the content itself under the
          floating top bar and composer — no solid overlay sits on top. */}
      </div>
      <MessageMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onReply={actions.reply}
        onSelect={setSelecting}
      />
    </div>
  );
}
