import assert from "node:assert/strict";
import { test } from "node:test";
import { type Entry, type Workspace, noWorkspace } from "@amuse/core";
import { allSkills, builtInSkills, catalog, parseSkill, skillsPort } from "./skills.ts";

/** A workspace holding just these files. */
function holding(files: Record<string, string>): Workspace {
  const paths = Object.keys(files);
  return {
    ...noWorkspace,
    exists: async (path) => path in files || paths.some((p) => p.startsWith(`${path}/`)),
    open: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no ${path}`);
      const data = new TextEncoder().encode(content);
      return { path, type: "text/markdown", size: data.length, data };
    },
    list: async (folder) => {
      const names = new Set(paths.filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1).split("/")[0] ?? ""));
      return [...names].map((name): Entry => ({ path: `${folder}/${name}`, kind: `${folder}/${name}` in files ? "file" : "folder", size: 0, modified: "" }));
    },
  };
}

test("a SKILL.md is its front matter's name and description, and the rest", () => {
  const skill = parseSkill('---\nname: trips\ndescription: "Planning a trip"\n---\n\n# Trips\nBook early.', "skills/trips", "fallback");
  assert.deepEqual(skill, { name: "trips", description: "Planning a trip", body: "# Trips\nBook early.", from: "skills/trips" });
  assert.equal(parseSkill("# No front matter", "x", "x"), null, "a skill says what it covers");
  assert.equal(parseSkill("---\ndescription: Only this\n---\nBody", "skills/named-by-folder", "named-by-folder")?.name, "named-by-folder");
});

test("the built-in skills ship with Amuse, each saying what it covers", () => {
  const names = builtInSkills().map((s) => s.name);
  assert.deepEqual([...names].sort(), ["amuse", "browser", "connections", "delegation", "files", "goals", "herdr", "memory", "sandbox", "schedules"]);
  for (const skill of builtInSkills()) assert.ok(skill.description.length > 20 && skill.body.length > 200, skill.name);
});

test("the user's skills join the built-in ones, and one of theirs replaces a built-in one of the same name", async () => {
  const files = holding({
    "skills/trips/SKILL.md": "---\nname: trips\ndescription: Planning a trip the way I like\n---\nWindow seats.",
    "skills/browser/SKILL.md": "---\nname: browser\ndescription: My own way with browsers\n---\nAlways ask first.",
    "skills/notes.md": "not a skill folder",
  });
  const skills = await allSkills(builtInSkills(), files);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.equal(byName.get("trips")?.from, "skills/trips");
  assert.equal(byName.get("browser")?.description, "My own way with browsers");
  assert.equal(byName.get("memory")?.from, "built in");
  const list = catalog(skills);
  assert.match(list, /^- trips: Planning a trip the way I like$/m);
  assert.match(list, /use_skill/);
});

test("the sidebar's skills: the user's first, a built-in one theirs replaces said so, and only theirs can go", async () => {
  const removed: string[] = [];
  const files = {
    ...holding({
      "skills/trips/SKILL.md": "---\nname: trips\ndescription: Planning a trip the way I like\n---\nWindow seats.",
      "skills/trips/scripts/fares.py": "print(1)",
      "skills/browser/SKILL.md": "---\nname: browser\ndescription: My own way with browsers\n---\nAsk first.",
    }),
    remove: async (path: string) => void removed.push(path),
  };
  const port = skillsPort(builtInSkills(), files);
  const listed = await port.list();
  assert.deepEqual(
    listed.slice(0, 2).map((s) => [s.name, s.origin]),
    [
      ["browser", "yours"],
      ["trips", "yours"],
    ],
  );
  assert.equal(listed.find((s) => s.origin === "built-in" && s.name === "browser")?.replaced, true);
  assert.equal(listed.find((s) => s.origin === "built-in" && s.name === "memory")?.replaced, false);

  const trips = await port.get("trips", "yours");
  assert.equal(trips?.body, "Window seats.");
  assert.deepEqual(trips?.files, ["SKILL.md", "scripts/fares.py"]);
  assert.ok((await port.get("memory", "built-in"))?.body.length);
  assert.equal(await port.get("nothing", "yours"), null);

  await port.remove("trips");
  assert.deepEqual(removed, ["skills/trips"]);
  await assert.rejects(port.remove("memory"), /not there/, "a built-in one cannot go");
});

test("every built-in skill has its tools mapped, and the map has no skill that does not ship", async () => {
  const { BUILT_IN_SKILLS, SKILL_TOOLS } = await import("./skills.ts");
  const shipped = builtInSkills().map((s) => s.name).sort();
  assert.deepEqual([...BUILT_IN_SKILLS].sort(), shipped);
  assert.deepEqual(Object.keys(SKILL_TOOLS).sort(), shipped);
  for (const name of shipped) assert.ok((SKILL_TOOLS as Record<string, readonly string[]>)[name]?.length, `${name} unlocks something`);
});

test("every tool a built-in skill names is declared from the start or unlocked by reading it (or a skill it names)", async () => {
  const { unreachableIn } = await import("./skills.ts");
  for (const skill of builtInSkills()) assert.deepEqual(unreachableIn(`${skill.description}\n${skill.body}`, skill.name), [], skill.name);
});

test("what a skill unlocks: its own tools by name; the user's own skill the file tools; nothing more", async () => {
  const { unlockedBy, SKILL_TOOLS } = await import("./skills.ts");
  assert.deepEqual(unlockedBy("schedules"), ["schedule", "list_schedules", "cancel_schedule"]);
  assert.ok(unlockedBy("files").includes("send_file"));
  assert.deepEqual(new Set(unlockedBy("connections")), new Set(["request_connection", "app_tools", "app_call", "list_secrets", "request_secret", "use_secret"]), "the Composio key is asked for with request_secret, even without a sandbox");
  assert.deepEqual(unlockedBy("trips"), SKILL_TOOLS.files);
  assert.deepEqual(unlockedBy("constructor"), SKILL_TOOLS.files, "no prototype key passes for a skill");
});

test("a text that sends the model to a gated tool must name a skill that unlocks it", async () => {
  const { unreachableIn } = await import("./skills.ts");
  assert.deepEqual(unreachableIn("Run it with `run_command`."), ["run_command"]);
  assert.deepEqual(unreachableIn("Open the sandbox skill and run it with `run_command`."), []);
  assert.deepEqual(unreachableIn("Open the connections or sandbox skill (`list_secrets`, `request_secret`)."), []);
  assert.deepEqual(unreachableIn("The delegation, browser and schedules skills say how (`schedule`)."), []);
  assert.deepEqual(unreachableIn("Use `memory_search`, `say` and `message_run`."), [], "tools declared from the start are always there");
  assert.deepEqual(unreachableIn("Read the rest with `memory_get`."), ["memory_get"]);
});
