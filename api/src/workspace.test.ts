import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createHost, type Timers } from "@amuse/core";
import { demoPorts } from "@amuse/demo";
import { Attachment } from "@amuse/protocol";
import { WorkspaceError } from "@amuse/core";
import { worded } from "./descend.ts";
import { MAX_FILE, workspace } from "./workspace.ts";
import { memorySent } from "./sent.ts";
import { letIn, noPin } from "./testing.ts";
import { listen } from "./server.ts";

const never: Timers<number> = { set: () => 0, clear: () => {} };
/** In with the cookie "amuse=s", and only with it. */
const access = letIn("s", (session) => session === "s");

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "amuse-files-"));
  const files = workspace(join(dir, "workspace"), memorySent(), dir);
  const server = await listen({
    session: createHost({ ...demoPorts(never), files }, { timers: never }),
    files,
    access,
    ...noPin,
    port: 0,
    host: "127.0.0.1",
  });
  const http = `http://127.0.0.1:${server.port}`;
  const upload = (name: string, type: string, body: BodyInit, auth = true) =>
    fetch(`${http}/files`, {
      method: "POST",
      headers: {
        "content-type": type,
        "x-file-name": encodeURIComponent(name),
        ...(auth ? { cookie: "amuse=s" } : {}),
      },
      body,
    });
  const get = (id: string, headers: Record<string, string> = {}) =>
    fetch(`${http}/files/${id}`, {
      headers: { cookie: "amuse=s", ...headers },
    });
  return { dir, files, server, upload, get };
}

test("a file is uploaded, kept with what it is (mode 600), and served back: images in the page, anything else only downloaded", async () => {
  const { dir, files, server, upload, get } = await serve();
  try {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const sent = await upload("猫.png", "image/png", png);
    assert.equal(sent.status, 201);
    const cat = Attachment.parse(await sent.json());
    assert.deepEqual(
      { name: cat.name, type: cat.type, size: cat.size, path: cat.path },
      {
        name: "猫.png",
        type: "image/png",
        size: 6,
        path: "user/media_library/猫.png",
      },
    );
    assert.equal((statSync(join(dir, "workspace", cat.path)).mode & 0o777).toString(8), "600");
    // the same name again is kept apart
    const again = Attachment.parse(await (await upload("猫.png", "image/png", png)).json());
    assert.equal(again.path, "user/media_library/猫 (2).png");
    // a name is only a name
    const sneaky = Attachment.parse(await (await upload("../../sent.json", "text/plain", "x")).json());
    assert.equal(sneaky.path, "user/sent.json");
    assert.ok(await files.holds(cat));
    assert.ok(!(await files.holds({ ...cat, size: 7 })), "as uploaded, or not at all");

    const shown = await get(cat.id);
    assert.equal(shown.headers.get("content-type"), "image/png");
    assert.match(shown.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
    assert.match(shown.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), png);

    // a page could run scripts on this origin: it is only ever downloaded
    const page = Attachment.parse(await (await upload("x.html", "text/html", "<script>alert(1)</script>")).json());
    const html = await get(page.id);
    assert.equal(html.headers.get("content-type"), "application/octet-stream");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment/);

    // a video seeks by ranges
    const part = await get(cat.id, { range: "bytes=2-3" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-3/6");
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), png.subarray(2, 4));
  } finally {
    await server.close();
  }
});

test("a picture comes with its size and placeholder, and is served scaled down for the page at the widths there are", async () => {
  const { files, server, upload } = await serve();
  const http = `http://127.0.0.1:${server.port}`;
  const get = (id: string, query: string) => fetch(`${http}/files/${id}${query}`, { headers: { cookie: "amuse=s" } });
  try {
    const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#4a8" } }).jpeg().toBuffer();
    const sent = Attachment.parse(await (await upload("beach.jpg", "image/jpeg", photo)).json());
    assert.deepEqual({ width: sent.image?.width, height: sent.image?.height }, { width: 2400, height: 1600 });
    assert.ok(sent.image && sent.image.placeholder.length > 0);
    assert.deepEqual(files.find(sent.id)?.attachment.image, sent.image, "kept with it");

    const copy = await get(sent.id, "?w=960");
    assert.equal(copy.status, 200);
    assert.equal(copy.headers.get("content-type"), "image/webp");
    assert.match(copy.headers.get("content-disposition") ?? "", /^inline; filename\*=UTF-8''beach\.webp$/);
    assert.equal(copy.headers.get("x-content-type-options"), "nosniff");
    assert.match(copy.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(copy.headers.get("cache-control") ?? "", /immutable/);
    const bytes = Buffer.from(await copy.arrayBuffer());
    assert.ok(bytes.length < photo.length);
    assert.deepEqual(await sharp(bytes).metadata().then((m) => [m.format, m.width, m.height]), ["webp", 960, 640]);
    // asked again: the same copy
    assert.deepEqual(Buffer.from(await (await get(sent.id, "?w=960")).arrayBuffer()), bytes);

    // a width not offered, a GIF, a file that is not a picture: as they are
    const odd = await get(sent.id, "?w=123");
    assert.equal(odd.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await odd.arrayBuffer()), photo);
    const gif = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#000" } }).gif().toBuffer();
    const moving = Attachment.parse(await (await upload("wave.gif", "image/gif", gif)).json());
    assert.equal(moving.image?.width, 30);
    assert.equal((await get(moving.id, "?w=480")).headers.get("content-type"), "image/gif");
    const notes = Attachment.parse(await (await upload("notes.txt", "text/plain", "hi")).json());
    assert.equal(notes.image, undefined);
    assert.equal((await get(notes.id, "?w=480")).headers.get("content-type"), "application/octet-stream");
    // a "picture" that cannot be read has no size, and comes as it is
    const broken = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const bad = Attachment.parse(await (await upload("bad.png", "image/png", broken)).json());
    assert.equal(bad.image, undefined);
    const served = await get(bad.id, "?w=480");
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), broken);

    // one Muse sends from the workspace is described too
    await files.write("screenshots/page.png", await sharp({ create: { width: 640, height: 400, channels: 4, background: "#fff" } }).png().toBuffer(), false);
    const shared = await files.share("screenshots/page.png");
    assert.deepEqual([shared.image?.width, shared.image?.height], [640, 400]);
  } finally {
    await server.close();
  }
});

test("no upload without a session, none over the limit, and no file by a made-up name", async () => {
  const { upload, get, server } = await serve();
  try {
    assert.equal((await upload("a.txt", "text/plain", "hi", false)).status, 401);
    assert.equal((await upload("big.bin", "application/octet-stream", new Uint8Array(MAX_FILE + 1))).status, 413);
    assert.equal((await get("..%2Fsent.json")).status, 404);
    assert.equal((await get("f-00000000-0000-0000-0000-000000000000")).status, 404);
  } finally {
    await server.close();
  }
});

test("the workspace stays inside itself, and the chat's files follow them when they move, and are gone when deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amuse-ws-"));
  const files = workspace(join(dir, "workspace"), memorySent(), dir);
  await files.write("notes/today.md", new TextEncoder().encode("# hi"), false);
  await assert.rejects(files.write("notes/today.md", new Uint8Array(), false), /already exists/);
  await assert.rejects(files.open("../sent.json"), /outside the workspace/);
  // a path from the top is the workspace's top, not the machine's
  await files.write("/etc/passwd", new TextEncoder().encode("mine"), false);
  assert.ok(await files.exists("etc/passwd"));
  await files.remove("etc");
  symlinkSync("/etc", join(dir, "workspace", "outside"));
  await assert.rejects(files.open("outside/hostname"), /not in the workspace/);
  await assert.rejects(files.write("outside/x", new Uint8Array(), false), /not in the workspace/);
  assert.deepEqual(
    (await files.list("")).map((e) => `${e.kind} ${e.path}`),
    ["folder memory", "folder notes", "folder skills", "folder user"],
    "a link is not listed",
  );

  const shared = await files.share("notes/today.md");
  assert.deepEqual({ name: shared.name, type: shared.type, size: shared.size }, { name: "today.md", type: "text/markdown", size: 4 });
  await files.move("notes", "archive/notes");
  assert.equal(files.find(shared.id)?.attachment.path, "archive/notes/today.md");
  assert.equal(new TextDecoder().decode((await files.read(shared.id))?.data), "# hi");
  const theirs = await files.save("bill.png", "image/png", [new Uint8Array([1, 2])]);
  assert.ok(theirs);
  await files.move("user/media_library/bill.png", "archive/bill.png");
  assert.equal(files.locate(theirs.id), "archive/bill.png", "what the user sent is found where it is moved");
  await files.remove("archive");
  assert.equal(files.find(shared.id), null);
  assert.equal(await files.read(shared.id), null);
});

/** A workspace with, beside it, a folder of the server's own that must never be reached: keys and a folder of them. */
function withSecrets() {
  const dir = mkdtempSync(join(tmpdir(), "amuse-links-"));
  const secrets = join(dir, "secrets");
  mkdirSync(join(secrets, "folder"), { recursive: true });
  writeFileSync(join(secrets, "keys.json"), "keys");
  writeFileSync(join(secrets, "folder/more.json"), "more");
  const files = workspace(join(dir, "workspace"), memorySent(), dir);
  const untouched = () => {
    assert.equal(readFileSync(join(secrets, "keys.json"), "utf8"), "keys");
    assert.equal(readFileSync(join(secrets, "folder/more.json"), "utf8"), "more");
    assert.deepEqual(readdirSync(secrets).sort(), ["folder", "keys.json"], "nothing was added or taken");
  };
  return { dir, secrets, files, untouched };
}
const text = (s: string) => new TextEncoder().encode(s);

test("a link to a folder, on the way or at the end, is refused for read, write, move, delete and listing, and nothing it leads to is touched", async () => {
  const { dir, secrets, files, untouched } = withSecrets();
  await files.write("mine/note.md", text("# hi"), false);
  symlinkSync(secrets, join(dir, "workspace/out"));
  symlinkSync(secrets, join(dir, "workspace/mine/out2"));
  for (const link of ["out", "mine/out2"]) {
    await assert.rejects(files.open(`${link}/keys.json`), /not in the workspace/);
    await assert.rejects(files.list(link), /not in the workspace/);
    await assert.rejects(files.exists(`${link}/keys.json`), /not in the workspace/);
    await assert.rejects(files.write(`${link}/new.txt`, text("x"), false), /not in the workspace/);
    await assert.rejects(files.write(`${link}/keys.json`, text("x"), true), /not in the workspace/);
    await assert.rejects(files.write(`${link}/deeper/new.txt`, text("x"), false), /not in the workspace/);
    await assert.rejects(files.move(`${link}/keys.json`, "stolen.json"), /not in the workspace/);
    await assert.rejects(files.move("mine/note.md", `${link}/note.md`), /not in the workspace/);
    await assert.rejects(files.move(link, "moved-link"), /not in the workspace/);
    await assert.rejects(files.remove(`${link}/keys.json`), /not in the workspace/);
    await assert.rejects(files.remove(`${link}/folder`), /not in the workspace/);
    await assert.rejects(files.remove(link), /not in the workspace/);
    await assert.rejects(files.share(`${link}/keys.json`), /not in the workspace/);
  }
  untouched();
  assert.ok(existsSync(join(dir, "workspace/mine/note.md")));
});

test("a link to a file, at the end of a path, is refused for read, write, move, delete and serving", async () => {
  const { dir, secrets, files, untouched } = withSecrets();
  symlinkSync(join(secrets, "keys.json"), join(dir, "workspace/leaf.json"));
  await assert.rejects(files.open("leaf.json"), /not in the workspace/);
  await assert.rejects(files.write("leaf.json", text("overwritten"), true), /not in the workspace/);
  await assert.rejects(files.write("leaf.json", text("new"), false), /not in the workspace/);
  await assert.rejects(files.move("leaf.json", "elsewhere.json"), /not in the workspace/);
  await files.write("plain.txt", text("p"), false);
  await assert.rejects(files.move("plain.txt", "leaf.json"), /already exists/);
  await assert.rejects(files.remove("leaf.json"), /not in the workspace/);
  await assert.rejects(files.exists("leaf.json"), /not in the workspace/);
  assert.deepEqual((await files.list("")).map((e) => e.path), ["memory", "skills", "user", "plain.txt"], "a link is not listed");
  untouched();
  assert.ok(statSync(join(dir, "workspace/leaf.json"), { throwIfNoEntry: false }) !== undefined, "the link itself is still there");
});

test("a sent file whose folder or file is swapped for a link is no longer served, read or held", async () => {
  const { dir, secrets, files, untouched } = withSecrets();
  const server = await listen({ session: createHost({ ...demoPorts(never), files }, { timers: never }), files, access, ...noPin, port: 0, host: "127.0.0.1" });
  const get = (id: string) => fetch(`http://127.0.0.1:${server.port}/files/${id}`, { headers: { cookie: "amuse=s" } });
  try {
    const sent = await files.save("report.txt", "text/plain", [text("the report")]);
    assert.ok(sent);
    assert.equal(await (await get(sent.id)).text(), "the report");
    assert.ok(await files.holds(sent));

    // the file swapped for a link to a secret
    const where = join(dir, "workspace", sent.path);
    renameSync(where, `${where}.real`);
    symlinkSync(join(secrets, "keys.json"), where);
    assert.equal((await get(sent.id)).status, 404);
    assert.equal(await files.read(sent.id), null);
    assert.ok(!(await files.holds(sent)));
    rmSync(where);
    renameSync(`${where}.real`, where);

    // its folder swapped for a link to a folder holding a file of the same name
    writeFileSync(join(secrets, "report.txt"), "not the report");
    renameSync(join(dir, "workspace/user"), join(dir, "workspace/user-real"));
    symlinkSync(secrets, join(dir, "workspace/user"));
    assert.equal((await get(sent.id)).status, 404);
    assert.equal(await files.read(sent.id), null);
    assert.equal(readFileSync(join(secrets, "keys.json"), "utf8"), "keys");
    rmSync(join(secrets, "report.txt"));
    untouched();
  } finally {
    await server.close();
  }
});

test("deleting a folder deletes the links in it, not what they lead to; a pipe in a file's place does not hang a read", async () => {
  const { dir, secrets, files, untouched } = withSecrets();
  await files.write("tree/inner/f.txt", text("x"), false);
  symlinkSync(secrets, join(dir, "workspace/tree/inner/out"));
  symlinkSync(join(secrets, "keys.json"), join(dir, "workspace/tree/file-link"));
  await files.remove("tree");
  assert.ok(!existsSync(join(dir, "workspace/tree")));
  untouched();

  execFileSync("mkfifo", [join(dir, "workspace/pipe")]);
  await assert.rejects(files.open("pipe"), /there is no file pipe/);
  await assert.rejects(files.write("pipe", text("x"), true), /already exists/);
});

/** A workspace of its own, in a folder of its own. */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "amuse-protected-"));
  const root = join(dir, "workspace");
  return { dir, root, files: workspace(root, memorySent(), dir) };
}

test("what is moved into memory/, skills/ or user/ is a copy, with inodes the sandbox has no hold on", async () => {
  const { root, files } = fresh();
  // a file the sandbox keeps a second link to, and one it holds open, in the writable part
  await files.write("drafts/SKILL.md", text("draft"), false);
  linkSync(join(root, "drafts/SKILL.md"), join(root, "kept-link.md"));
  await files.write("held.md", text("held"), false);
  const held = openSync(join(root, "held.md"), "r+");
  assert.equal(statSync(join(root, "drafts/SKILL.md")).nlink, 2);

  await files.move("drafts/SKILL.md", "skills/trips/SKILL.md");
  assert.equal(statSync(join(root, "skills/trips/SKILL.md")).nlink, 1, "no second link into the writable part");
  assert.notEqual(statSync(join(root, "skills/trips/SKILL.md")).ino, statSync(join(root, "kept-link.md")).ino);
  writeFileSync(join(root, "kept-link.md"), "planted");
  assert.equal(readFileSync(join(root, "skills/trips/SKILL.md"), "utf8"), "draft", "what the sandbox still has a hold on does not reach it");
  assert.ok(!existsSync(join(root, "drafts/SKILL.md")), "the original is gone");

  await files.move("held.md", "memory/held.md");
  writeSync(held, "planted2");
  assert.equal(readFileSync(join(root, "memory/held.md"), "utf8"), "held", "nor does a descriptor");

  // a folder: copied with what is in it, links left behind, never followed
  await files.write("pack/inner/a.md", text("a"), false);
  await files.write("pack/b.md", text("b"), false);
  symlinkSync("/etc", join(root, "pack/etc-link"));
  const before = statSync(join(root, "pack/b.md")).ino;
  await files.move("pack", "user/pack");
  assert.equal(readFileSync(join(root, "user/pack/inner/a.md"), "utf8"), "a");
  assert.equal(readFileSync(join(root, "user/pack/b.md"), "utf8"), "b");
  assert.notEqual(statSync(join(root, "user/pack/b.md")).ino, before);
  assert.deepEqual(readdirSync(join(root, "user/pack")).sort(), ["b.md", "inner"], "the link was not copied");
  assert.ok(!existsSync(join(root, "pack")), "the original folder is gone, its link with it");
  assert.ok(existsSync("/etc"), "and what it pointed to is there");
  // out of a protected folder, and between two, work too; the chat's files follow
  const sent = await files.save("bill.png", "image/png", [new Uint8Array([1, 2])]);
  assert.ok(sent);
  await files.move("user/media_library/bill.png", "user/bill.png");
  assert.equal(files.locate(sent.id), "user/bill.png");
  await files.move("user/pack", "outside-again");
  assert.ok(existsSync(join(root, "outside-again/b.md")));
  // a move that cannot be done leaves nothing half made
  await files.write("clash/x.md", text("x"), false);
  await assert.rejects(files.move("clash", "skills/trips"), /already exists/);
  assert.ok(existsSync(join(root, "clash/x.md")));
});

test("memory/, skills/ and user/ always exist, and cannot be removed or renamed, only emptied", async () => {
  const { dir, root, files } = fresh();
  for (const name of ["memory", "skills", "user"]) {
    assert.ok(statSync(join(root, name)).isDirectory(), `${name} is made at the start`);
    await assert.rejects(files.remove(name), /cannot be removed or renamed/);
    await assert.rejects(files.move(name, `${name}-old`), /cannot be removed or renamed/);
    await assert.rejects(files.move("elsewhere", name), /there is no elsewhere|already exists/);
  }
  await files.write("elsewhere/x.md", text("x"), false);
  await assert.rejects(files.move("elsewhere", "memory"), /already exists/);
  await files.write("memory/MEMORY.md", text("m"), false);
  await files.remove("memory/MEMORY.md");
  await files.write("skills/a/SKILL.md", text("s"), false);
  await files.remove("skills/a");
  assert.deepEqual(readdirSync(join(root, "skills")), []);
  assert.ok(existsSync(join(root, "skills")));
  // made again at the next start, if they went some other way
  rmSync(join(root, "memory"), { recursive: true });
  workspace(root, memorySent(), dir);
  assert.ok(statSync(join(root, "memory")).isDirectory());
  // but not over something that is not a folder
  rmSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills"), "a file");
  assert.throws(() => workspace(root, memorySent(), dir), /skills in the workspace is not a folder/);
  rmSync(join(root, "skills"));
  symlinkSync(dir, join(root, "skills"));
  assert.throws(() => workspace(root, memorySent(), dir), /skills in the workspace is not a folder/);
});

test("a sent file deleted or swapped outside the server is gone for locate, as it is for reading", async () => {
  const { dir, root, files } = fresh();
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "report.txt"), "not it");
  const sent = await files.save("report.txt", "text/plain", [text("the report")]);
  assert.ok(sent);
  assert.equal(files.locate(sent.id), "user/report.txt");
  const where = join(root, sent.path);
  rmSync(where);
  assert.equal(files.locate(sent.id), null, "deleted behind the server's back");
  symlinkSync(join(secrets, "report.txt"), where);
  assert.equal(files.locate(sent.id), null, "a link in its place");
  rmSync(where);
  writeFileSync(where, "back");
  assert.equal(files.locate(sent.id), "user/report.txt");
  renameSync(join(root, "user"), join(root, "user-real"));
  symlinkSync(secrets, join(root, "user"));
  assert.equal(files.locate(sent.id), null, "its folder swapped for a link");
  assert.equal(files.locate("f-nobody"), null);
});

test("what goes wrong in the walk is said in words about the path, never in paths of this machine", async () => {
  const { root, files } = fresh();
  const errno = (code: string) => Object.assign(new Error(`${code}: open '/proc/self/fd/23/secret-name'`), { code });
  for (const code of ["ENOENT", "ELOOP", "ENOTDIR", "EISDIR", "EEXIST", "EACCES", "EPERM", "ENOTEMPTY", "ENOSPC", "EXDEV", "EBUSY", "EMFILE", "EIO", "EWHATEVER"]) {
    const said = worded("notes/today.md", errno(code));
    assert.ok(said instanceof WorkspaceError, code);
    assert.doesNotMatch(said.message, /proc|fd\/|secret-name|EACCES|ENOENT/, code);
    assert.match(said.message, /notes\/today\.md|file|room|open/, code);
  }
  const mine = new WorkspaceError("already said");
  assert.equal(worded("x", mine), mine);

  // really: a folder this account cannot enter, a file where a folder should be
  await files.write("locked/x.md", text("x"), false);
  chmodSync(join(root, "locked"), 0o000);
  try {
    if (process.getuid?.() !== 0) {
      for (const work of [() => files.list("locked"), () => files.open("locked/x.md"), () => files.write("locked/y.md", text("y"), false), () => files.remove("locked"), () => files.exists("locked/x.md")]) {
        const error = await work().then(
          () => assert.fail("it should have been refused"),
          (e: unknown) => e,
        );
        assert.ok(error instanceof WorkspaceError, String(error));
        assert.doesNotMatch(error.message, /proc|fd\/|EACCES/);
        assert.match(error.message, /locked/);
      }
    }
  } finally {
    chmodSync(join(root, "locked"), 0o700);
  }
  await files.write("plain.md", text("p"), false);
  await assert.rejects(files.write("plain.md/inside.md", text("x"), false), /plain\.md is not a folder/);
});
