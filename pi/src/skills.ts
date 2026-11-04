/**
 * Skills: how to do a kind of work well, written down, read when the work
 * comes up rather than told every turn. Each is a folder with a SKILL.md
 * (the usual format: front matter with `name` and `description`, then the
 * instructions), so skills from elsewhere drop in as they are. Built-in ones
 * ship with Amuse (pi/skills/); the user's own live in the workspace
 * (skills/), where they and Amuse add to them, and one of the user's
 * replaces a built-in one of the same name. Every turn gets the list, a line
 * a skill; `use_skill` reads one in full.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type Skills, type Workspace, WorkspaceError } from "@amuse/core";
import type { SkillInfo, SkillOrigin } from "@amuse/protocol";
import { Type } from "typebox";
import { status } from "./status.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** where it comes from: built in, or its folder in the workspace */
  from: string;
}

/** Where the user's skills live in the workspace. */
export const SKILLS = "skills";
/** The built-in skills' folder. */
const builtInDir = fileURLToPath(new URL("../skills", import.meta.url));

/** A SKILL.md as a skill: its front matter's name and description, and the rest; null when it has neither. */
export function parseSkill(source: string, from: string, fallbackName: string): Skill | null {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const front = match?.[1] ?? "";
  const field = (key: string) =>
    front
      .match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  const description = field("description");
  if (!description) return null;
  return { name: field("name") || fallbackName, description, body: (match?.[2] ?? source).trim(), from };
}

/** The skills that ship with Amuse, read once. */
export function builtInSkills(dir = builtInDir): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) return [];
    const skill = parseSkill(readFileSync(file, "utf8"), "built in", entry.name);
    return skill ? [skill] : [];
  });
}

/** The user's skills, as they are now: skills/<name>/SKILL.md in the workspace. */
export async function userSkills(files: Workspace): Promise<Skill[]> {
  if (!(await files.exists(SKILLS))) return [];
  const found = await Promise.all(
    (await files.list(SKILLS))
      .filter((e) => e.kind === "folder")
      .map(async (folder) => {
        const path = `${folder.path}/SKILL.md`;
        if (!(await files.exists(path))) return null;
        const source = new TextDecoder().decode((await files.open(path)).data);
        return parseSkill(source, folder.path, folder.path.slice(SKILLS.length + 1));
      }),
  );
  return found.filter((s) => s !== null);
}

/** Every skill there is, the user's replacing built-in ones of the same name, by name. */
export async function allSkills(builtIn: Skill[], files: Workspace | undefined): Promise<Skill[]> {
  const mine = files ? await userSkills(files).catch(() => []) : [];
  const byName = new Map(builtIn.map((s) => [s.name, s]));
  for (const s of mine) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills that ship with Amuse (pi/skills/), by name: each has its tools in `SKILL_TOOLS` (a test holds the folders to this list). */
export const BUILT_IN_SKILLS = ["amuse", "browser", "connections", "delegation", "files", "goals", "herdr", "memory", "sandbox", "schedules"] as const;
export type BuiltInSkill = (typeof BUILT_IN_SKILLS)[number];

/** The chat's tools that are declared only once a skill that needs them is read (`use_skill`). */
export type GatedTool =
  | "request_connection"
  | "app_tools"
  | "app_call"
  | "amuse_status"
  | "list_chats"
  | "read_chat"
  | "save_screenshot"
  | "list_files"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "move_file"
  | "delete_file"
  | "send_file"
  | "memory_get"
  | "memory_explain"
  | "forget"
  | "schedule"
  | "list_schedules"
  | "cancel_schedule"
  | "run_command"
  | "list_secrets"
  | "request_secret"
  | "use_secret";

const fileTools = ["list_files", "read_file", "write_file", "edit_file", "move_file", "delete_file", "send_file"] as const satisfies readonly GatedTool[];
const secretTools = ["list_secrets", "request_secret", "use_secret"] as const satisfies readonly GatedTool[];
const scheduleTools = ["schedule", "list_schedules", "cancel_schedule"] as const satisfies readonly GatedTool[];

/**
 * What reading each built-in skill unlocks for the rest of the chat turn: every gated tool its SKILL.md names (a test
 * checks the docs and the system rules against it). Every built-in skill is here, or the build fails. The rest of the
 * chat's tools are declared on every turn: the core ones, and the controls of work already running (message_run,
 * answer_question, stop_run, read_browser, job_output, stop_job), so the list a turn starts with depends only on the
 * setup and the kind of chat, and a provider can cache it.
 */
export const SKILL_TOOLS: { readonly [K in BuiltInSkill]: readonly GatedTool[] } = {
  amuse: ["amuse_status", "list_chats", "read_chat", ...secretTools],
  browser: ["save_screenshot", "send_file", ...secretTools],
  connections: ["request_connection", "app_tools", "app_call", ...secretTools],
  delegation: ["list_chats", "read_chat"],
  files: fileTools,
  goals: [...fileTools, "memory_get", ...scheduleTools],
  herdr: ["run_command", ...secretTools, "list_files", "read_file", "write_file", "edit_file"],
  memory: ["memory_get", "memory_explain", "forget", "list_chats", "read_chat"],
  sandbox: ["run_command", ...secretTools, ...fileTools],
  schedules: scheduleTools,
};

/** A skill of the user's own (not one of the built-in names) unlocks the file tools: it says to read the rest of its folder. */
export const USER_SKILL_TOOLS: readonly GatedTool[] = fileTools;

/** Every tool kept behind a skill until `use_skill` opens one. */
export const GATED_TOOLS: ReadonlySet<string> = new Set<string>(Object.values(SKILL_TOOLS).flat());

/** The tools reading `skill` unlocks: its own list when it has a built-in name (the user's replacing it too), the file tools for one of the user's. */
export function unlockedBy(skill: string): readonly GatedTool[] {
  return Object.hasOwn(SKILL_TOOLS, skill) ? SKILL_TOOLS[skill as BuiltInSkill] : USER_SKILL_TOOLS;
}

/**
 * The gated tools `text` names (in backticks) that a turn reading it could not see: not unlocked by `skill` (the skill the
 * text is, if it is one) nor by a skill it names ("the sandbox skill", "the connections or sandbox skill"). Empty when
 * every tool it sends the model to is there to call.
 */
export function unreachableIn(text: string, skill?: string): string[] {
  const skills = new Set(skill ? [skill] : []);
  for (const [, names] of text.matchAll(/\b[Tt]he ((?:[a-z]+(?:, | and | or ))*[a-z]+) skills?\b/g)) for (const name of names?.split(/, | and | or /) ?? []) skills.add(name);
  const reachable = new Set([...skills].flatMap((name) => (Object.hasOwn(SKILL_TOOLS, name) ? SKILL_TOOLS[name as BuiltInSkill] : [])));
  const named = [...text.matchAll(/`([a-z_]+)(?:\([^`]*\))?`/g)].map((m) => m[1] ?? "");
  return [...new Set(named.filter((name) => GATED_TOOLS.has(name) && !reachable.has(name as GatedTool)))];
}

/** The list every turn gets. */
export function catalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills (only when a turn needs one of these workflows or its tools — call `use_skill` to read the instructions and unlock that skill's tools; skip for plain conversation):",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

type Text = { content: { type: "text"; text: string }[]; details: null };
const say = (text: string): Text => ({ content: [{ type: "text", text }], details: null });

/**
 * Reading a skill, and, when `gate` is on (the chat turn), unlocking the tools that belong to it (`unlockedBy`) from the
 * next step of the turn on: Pi asks `prepareLoadout` again between steps, and the tools it stops hiding are added after
 * those the turn began with. `unlocked`: tools declared from the start all the same (list_chats and read_chat in a side chat).
 * A hidden tool still runs if called by name, and codemode and the helpers have them all.
 */
export function skillTools(
  builtIn: Skill[],
  files: Workspace | undefined,
  { gate = false, unlocked }: { gate?: boolean | undefined; unlocked?: Iterable<string> | (() => Iterable<string>) | undefined } = {},
): ToolDefinition[] {
  const opened = new Set<string>();
  return [
    defineTool({
      name: "use_skill",
      label: "Read up",
      description: "Read a skill's instructions and unlock its tools for this turn (connections, files, sandbox, schedules, etc.). Only call when the turn needs what that skill covers.",
      parameters: Type.Object({ status, name: Type.String() }),
      ...(gate
        ? {
            prepareLoadout(loadout) {
              const initial = typeof unlocked === "function" ? unlocked() : (unlocked ?? []);
              const active = new Set<string>(initial);
              for (const name of opened) for (const tool of unlockedBy(name)) active.add(tool);
              const hiddenDeclarations = loadout.declared.map((t) => t.name).filter((name) => GATED_TOOLS.has(name) && !active.has(name));
              return hiddenDeclarations.length > 0 ? { hiddenDeclarations } : {};
            },
          }
        : {}),
      async execute(_, { name }) {
        const skills = await allSkills(builtIn, files);
        const skill = skills.find((s) => s.name === name.trim());
        if (!skill) return say(`There is no skill "${name}". There are: ${skills.map((s) => s.name).join(", ") || "none"}.`);
        opened.add(skill.name);
        const more = skill.from === "built in" ? "" : `\n\n(Its folder is ${skill.from}; other files in it can be read with read_file. To run what is in it, read the sandbox skill.)`;
        return say(`# ${skill.name}\n\n${skill.body}${more}`);
      },
    }),
  ];
}

/** Every path under `folder` (relative to it), files only, up to `limit`. */
async function filesIn(files: Workspace, folder: string, limit = 200): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await files.list(at)) {
      if (found.length >= limit) return;
      if (entry.kind === "folder") await walk(entry.path);
      else found.push(entry.path.slice(folder.length + 1));
    }
  };
  await walk(folder);
  return found.sort();
}

/** The skills for the user to see in the sidebar, and to remove their own: built in and in skills/. */
export function skillsPort(builtIn: Skill[], files: Workspace): Skills {
  const mine = () => userSkills(files).catch((): Skill[] => []);
  const info = (skill: Skill, origin: SkillOrigin, replaced: boolean): SkillInfo => ({ name: skill.name, description: skill.description, origin, replaced });
  return {
    async list() {
      const own = await mine();
      const names = new Set(own.map((s) => s.name));
      const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);
      return [...[...own].sort(byName).map((s) => info(s, "yours", false)), ...[...builtIn].sort(byName).map((s) => info(s, "built-in", names.has(s.name)))];
    },
    async get(name, origin) {
      const own = await mine();
      if (origin === "built-in") {
        const skill = builtIn.find((s) => s.name === name);
        return skill ? { skill: info(skill, "built-in", own.some((s) => s.name === name)), body: skill.body, files: [] } : null;
      }
      const skill = own.find((s) => s.name === name);
      return skill ? { skill: info(skill, "yours", false), body: skill.body, files: await filesIn(files, skill.from).catch(() => []) } : null;
    },
    async remove(name) {
      const skill = (await mine()).find((s) => s.name === name);
      // only a folder of its own under skills/, never skills/ itself
      if (!skill || !skill.from.startsWith(`${SKILLS}/`) || skill.from.slice(SKILLS.length + 1).includes("/")) throw new WorkspaceError("that skill is not there any more");
      await files.remove(skill.from);
    },
  };
}
