/**
 * Top chrome: round ☰ menu button top-left (opens the drawer: pages + chats) and the centered
 * Muse avatar with its name badge. While Muse works, the badge grows a status
 * line ("is responding", "Re-observing page", ...).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { List, LoaderCircle, Menu, PanelLeftClose, ShieldAlert, Wrench, X } from "lucide-react";
import type { State } from "@amuse/protocol";
import type { Actions } from "../ui.ts";
import type { Swipe } from "../useSwipe.ts";
import { type AgentLine, agentLine } from "../view.ts";
import { HOLD_MS, holds, sameLine } from "../badge.ts";
import { museAvatar } from "../transition.ts";
import { useT } from "../i18n/react.ts";
import { barButton, barButtonLook, barIcon } from "./bar";

const LINE_ICONS = { list: List, tool: Wrench, approval: ShieldAlert, connecting: LoaderCircle } as const;

/**
 * The top bar; while the Muse panel is open, the avatar is over there (it travels, see transition.ts). `connecting`:
 * the link to the server is not live, which the badge says over what Muse was doing (that may be out of date).
 */
export function TopBar({ conversation, connecting, museOpen, actions }: { conversation: State; connecting: boolean; museOpen: boolean; actions: Actions }) {
  const t = useT();
  return (
    <header
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 py-2"
    >
      {/* spacer: the menu button lives outside the header (MenuButton) so it can sit above the drawer */}
      <span className="size-11" />

      {/* The avatar and its badge take the clicks that land on them (the bar around them lets them through).
          Amuse avatar bubble, drawn over the top of its name badge (Amuse: 52px avatar, badge tucked 4px under).
          Its shadow is a layer of its own under the badge, so it falls on the chat, not on the badge. */}
      {!museOpen && (
        <div data-muse-avatar-group="" className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center">
          <span
            aria-hidden
            className="absolute top-0 size-[52px] rounded-full"
            style={{ boxShadow: "var(--shadow-float)" }}
          />
          <button
            aria-label="Amuse"
            className="pointer-events-auto relative z-[2] flex size-[52px] items-center justify-center rounded-full text-[20px] font-semibold"
            data-muse-avatar=""
            style={{ ...museAvatar, background: "var(--avatar-fill)", color: "var(--avatar-text)" }}
            onClick={() => actions.setMuse(true)}
          >
            A
          </button>
          <AvatarBadge line={connecting ? { icon: "connecting", text: t.status.connecting } : agentLine(conversation, t)} />
        </div>
      )}

    </header>
  );
}

/** The line the badge shows (held a moment between two tools), and the lines that are fading out as it changes. */
function useBadgeLine(line: AgentLine | null) {
  const [shown, setShown] = useState(line);
  const [last, setLast] = useState(shown);
  const [leaving, setLeaving] = useState<{ id: number; line: AgentLine }[]>([]);

  useEffect(() => {
    if (sameLine(shown, line)) return;
    if (!holds(shown, line)) {
      setShown(line);
      return;
    }
    const timer = setTimeout(() => setShown(line), HOLD_MS);
    return () => clearTimeout(timer);
  }, [line?.icon, line?.text, shown]);

  // the line that was shown fades out where it was, while the new one fades in
  if (last !== shown) {
    setLast(shown);
    if (last) setLeaving((all) => [...all, { id: (all.at(-1)?.id ?? 0) + 1, line: last }]);
  }
  return { shown, leaving, gone: (id: number) => setLeaving((all) => all.filter((l) => l.id !== id)) };
}

/**
 * The name badge. Its size is set from what it holds (measured on an inner wrapper) so it can glide to the next one:
 * a box of auto size cannot be transitioned. What was there fades out over the box as it resizes, and the new line
 * fades in; the box never stands empty.
 */
function AvatarBadge({ line }: { line: AgentLine | null }) {
  const { shown, leaving, gone } = useBadgeLine(line);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const content = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((was) => (was && was.width === width && was.height === height ? was : { width, height }));
    };
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);

  return (
    <span
      className="badge-pill pointer-events-auto relative z-[1] -mt-1 flex items-start justify-center overflow-hidden rounded-[20px]"
      style={{ background: "var(--fill-primary)", boxShadow: "var(--shadow-float)", ...size }}
    >
      <span ref={content} className="relative flex w-max min-w-[52px] shrink-0 flex-col items-center px-3.5 pb-1.5 pt-[5px]">
        <span className="text-[14px] font-semibold leading-[18px]" style={{ color: "var(--text-primary)" }}>
          Amuse
        </span>
        {shown && <BadgeLine key={`${shown.icon}:${shown.text}`} line={shown} className="anim-badge-in" />}
        {leaving.map((l) => (
          <BadgeLine
            key={l.id}
            line={l.line}
            className="anim-badge-out absolute left-1/2 top-[23px] -translate-x-1/2"
            onAnimationEnd={() => gone(l.id)}
          />
        ))}
      </span>
    </span>
  );
}

function BadgeLine({ line, className, onAnimationEnd }: { line: AgentLine; className: string; onAnimationEnd?: () => void }) {
  const Icon = LINE_ICONS[line.icon];
  return (
    <span
      aria-hidden={onAnimationEnd ? true : undefined}
      className={`${className} flex items-center gap-1.5 whitespace-nowrap text-[12.5px] leading-[17px]`}
      style={{ color: "var(--text-secondary)" }}
      onAnimationEnd={onAnimationEnd}
    >
      <Icon size={12} className={line.icon === "connecting" ? "animate-spin" : undefined} />
      {line.text}
    </span>
  );
}

/**
 * ☰, one round button for the sidebar, as the browser's is: away, it sits at the chat's top left; with the sidebar
 * out, it moves into the sidebar's top right (App.tsx places it), on the same curve the sidebar moves on, and becomes
 * the way to put it away: on a phone, where the sidebar fills the screen, the round close X the sheets and the
 * viewer have; from md, the collapse icon.
 */
export function MenuButton({ open, left, swipe, openLeft, onClick }: { open: boolean; left: number; swipe: Swipe | null; openLeft: number; onClick: () => void }) {
  const t = useT();
  const ease = "0.24s cubic-bezier(0.2, 0, 0, 1)";
  // while a swipe moves the sidebar, the button goes with it, by how open it is (`--swipe`, useSwipe.ts): from the
  // chat's corner into the sidebar's, the icon turning as it goes
  const following = swipe?.panel === "sidebar" && (swipe.phase === "drag" || swipe.phase === "settle");
  const settling = swipe?.phase === "settle";
  const icon = `absolute ${following ? (settling ? "swipe-settle" : "transition-none") : "transition-all duration-200 ease-out"}`;
  const closeIcon = following
    ? { opacity: "var(--swipe)", transform: "rotate(calc((1 - var(--swipe)) * -90deg)) scale(calc(0.6 + 0.4 * var(--swipe)))" }
    : { opacity: open ? 1 : 0, transform: open ? "none" : "rotate(-90deg) scale(0.6)" };
  return (
    <button
      aria-label={open ? t.chat.closeSidebar : t.chat.openMenu}
      aria-expanded={open}
      data-swipe="sidebar"
      className={`${barButton} fixed top-3 z-[45]`}
      style={{
        ...barButtonLook,
        left: following ? `calc(12px + ${openLeft - 12}px * var(--swipe))` : left,
        transition: following && !settling ? "none" : `left ${ease}`,
      }}
      onClick={onClick}
    >
      <Menu
        size={barIcon}
        className={icon}
        style={following ? { opacity: "calc(1 - var(--swipe))", transform: "rotate(calc(var(--swipe) * 90deg)) scale(calc(1 - 0.4 * var(--swipe)))" } : { opacity: open ? 0 : 1, transform: open ? "rotate(90deg) scale(0.6)" : "none" }}
      />
      {/* a phone's page is closed with the X, a wider screen's panel is collapsed */}
      <PanelLeftClose size={barIcon} className={`${icon} hidden md:block`} style={closeIcon} />
      <X size={barIcon} className={`${icon} md:hidden`} style={closeIcon} />
    </button>
  );
}
