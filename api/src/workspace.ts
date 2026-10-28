/**
 * Muse's workspace on disk (core's Workspace): a folder of real files. What
 * the user sends is saved under user/ (pictures and videos under
 * user/media_library/) by its own name, made unique; the rest is laid out by
 * Muse. Paths are workspace-relative and checked before any use: no "..",
 * no absolute paths. The sandbox shares the folder and may swap a folder or a
 * file for a symbolic link at any moment, so a path is never looked up twice:
 * it is walked from the top, each folder opened from the one before without
 * following a link, and everything is done through what was opened
 * (descend.ts). A link on the way is refused.
 * The chat's attachments are kept in an index beside the workspace (not in
 * it, out of the agent's reach): id → where the file is now, kept up to date
 * when files move and dropped when they are deleted.
 */
import { constants, createWriteStream, lstatSync, mkdirSync, rmSync } from "node:fs";
import { type FileHandle, lstat, readdir, rename } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Entry, type Workspace, WorkspaceError, newId } from "@amuse/core";
import { Attachment } from "@amuse/protocol";
import { z } from "zod";
import { type Folder, Missing, copy, kindOf, openFile, presentSync, remove as removeTree, walk, worded } from "./descend.ts";
import { describe } from "./images.ts";

/** The largest file the server takes. */
export const MAX_FILE = 50 * 1024 ** 2;

const kinds: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** A file's kind by its name. */
export const typeOf = (name: string) => kinds[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Kinds shown in the page itself (an <img> or a <video>); every other file is only downloaded. */
export const shownInline = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type) || /^video\/(mp4|webm|quicktime|ogg)$/.test(type);

/** A name the user's device gave, as a file name of its own: no folders, no control characters. */
function cleanName(name: string): string {
  const base = basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base === "" || base === "." || base === ".." ? "file" : base.slice(0, 200);
}

/** A workspace path, made plain ("a/./b/" → "a/b"); refused if it would leave the workspace. */
export function plain(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.includes("\u0000"))) throw new WorkspaceError(`"${path}" is outside the workspace`);
  return parts.join("/");
}

/** Each sent file, and who sent it: what the user sent stays theirs wherever it is moved. */
export const Sent = z.object({ attachment: Attachment, by: z.enum(["user", "muse"]) });
export type Sent = z.infer<typeof Sent>;
const at = (sent: Sent, path: string) => ({ ...sent, attachment: { ...sent.attachment, path } });
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export interface FileStore extends Workspace {
  /** Keep an upload in user/ by its name (made unique): its bytes as they come, under the size limit; null when too large. */
  save(name: string, type: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Attachment | null>;
  /** A sent file, by its id: what it is; null when it is not (or no longer) one. */
  find(id: string): { attachment: Attachment } | null;
  /**
   * A sent file ready to serve, by its id: opened (never through a link) and its size now. The caller closes the handle (a
   * stream made from it does, when it ends); null when the file is gone, or is not a plain file.
   */
  serve(id: string): Promise<{ attachment: Attachment; size: number; handle: FileHandle } | null>;
}

/**
 * The folders the sandbox mounts read-only (compose.yaml): what Amuse reads as its own context and instructions, and what the user
 * sent. They are mount points there, so they must always exist, and are never removed or renamed, nor filled by renaming: a folder
 * or file the sandbox holds open (its working folder, a descriptor, a second link) stays writable from there wherever it is moved.
 */
export const PROTECTED = ["memory", "skills", "user"];
const isProtected = (rel: string) => PROTECTED.includes(rel.split("/")[0] ?? "");

/** Where the index of sent files is kept (outside the workspace): read once, written whole on each change. */
export interface SentIndex {
  load(): Record<string, Sent>;
  save(all: Record<string, Sent>): void;
}

/** The workspace at `root`; the index of sent files kept in `index`; uploads arrive in `scratch` (on the same disk) before they are moved in. */
export function workspace(root: string, index: SentIndex, scratch: string): FileStore {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of PROTECTED) {
    if (!lstatSync(join(root, name), { throwIfNoEntry: false })) mkdirSync(join(root, name), { mode: 0o700 });
    if (!lstatSync(join(root, name)).isDirectory()) throw new Error(`${name} in the workspace is not a folder: it must be one (the sandbox mounts it).`);
  }
  let sent = index.load();
  const saveIndex = () => index.save(sent);

  const parts = (rel: string) => (rel === "" ? [] : rel.split("/"));
  /** The folder at a path (made if `make`), to use and let go. */
  const inFolder = async <T>(rel: string, make: boolean, use: (folder: Folder) => Promise<T>): Promise<T> => {
    const folder = await walk(root, parts(rel), make);
    try {
      return await use(folder);
    } finally {
      await folder.close().catch(() => {});
    }
  };
  /** The folder a path is in (made if `make`), and its name there, to use and let go. */
  const inParent = <T>(rel: string, make: boolean, use: (folder: Folder, leaf: string) => Promise<T>): Promise<T> => {
    const names = parts(rel);
    return inFolder(names.slice(0, -1).join("/"), make, (folder) => use(folder, names.at(-1) ?? ""));
  };
  const missing = (path: string) => new Missing(`there is no ${plain(path) || "workspace"}`);
  const refused = (path: string) => new WorkspaceError(`"${path}" is not in the workspace`);
  const kept = (folder: string) => new WorkspaceError(`${folder}/ itself cannot be removed or renamed: what is in it can be deleted or moved one by one`);

  /** `name` in `folder`, or "name (2).ext" and so on if that is taken. */
  const unique = async (folder: Folder, name: string) => {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if ((await kindOf(folder, candidate)) === "missing") return candidate;
    }
  };

  const shownOf = (path: string) => {
    try {
      return plain(path) || "the workspace";
    } catch {
      return path;
    }
  };
  /** `work` about `path`, whose failures come out as words about the path (see worded). */
  const careful = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw worded(shownOf(path), error);
    }
  };

  const raw: FileStore = {
    find: (id) => (sent[id] ? { attachment: sent[id].attachment } : null),
    async serve(id) {
      const attachment = sent[id]?.attachment;
      if (!attachment) return null;
      try {
        return await inParent(plain(attachment.path), false, async (folder, leaf) => {
          const handle = await openFile(folder, leaf, attachment.path);
          return { attachment, size: (await handle.stat()).size, handle };
        });
      } catch {
        // gone, replaced by a link, or not readable: not there to serve
        return null;
      }
    },
    async save(name, type, body) {
      const clean = cleanName(name);
      const kind = type && type !== "application/octet-stream" ? type.slice(0, 255) : typeOf(clean);
      const folder = /^(image|video)\//.test(kind) ? "user/media_library" : "user";
      return inFolder(folder, true, async (into) => {
        const partial = join(scratch, `upload-${newId("p")}.part`);
        let size = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _, done) {
            size += chunk.length;
            done(size > MAX_FILE ? new Error("too large") : null, chunk);
          },
        });
        try {
          await pipeline(Readable.from(body), limit, createWriteStream(partial, { mode: 0o600 }));
        } catch (error) {
          rmSync(partial, { force: true });
          if (size > MAX_FILE) return null;
          throw error;
        }
        // read while it is still only the server's, before the sandbox can see it
        const image = await describe(partial, kind);
        const leaf = await unique(into, clean);
        await rename(partial, into.at(leaf));
        const attachment: Attachment = { id: newId("f"), name: clean, type: kind, size, path: `${folder}/${leaf}`, ...(image ? { image } : {}) };
        sent = { ...sent, [attachment.id]: { attachment, by: "user" } };
        saveIndex();
        return attachment;
      });
    },
    async holds(attachment) {
      const found = await store.serve(attachment.id);
      await found?.handle.close();
      return (
        found !== null && found.attachment.name === attachment.name && found.attachment.type === attachment.type && found.attachment.size === attachment.size
      );
    },
    async read(id) {
      const found = await store.serve(id);
      if (!found) return null;
      try {
        return { attachment: found.attachment, data: new Uint8Array(await found.handle.readFile()) };
      } finally {
        await found.handle.close();
      }
    },
    async list(folder) {
      const rel = plain(folder);
      return inFolder(rel, false, async (dir) => {
        const entries = await Promise.all(
          (await readdir(dir.self)).map(async (name): Promise<Entry | null> => {
            const stat = await lstat(dir.at(name));
            if (stat.isSymbolicLink()) return null;
            return {
              path: [rel, name].filter(Boolean).join("/"),
              kind: stat.isDirectory() ? "folder" : "file",
              size: stat.isDirectory() ? 0 : stat.size,
              modified: stat.mtime.toISOString(),
            };
          }),
        );
        return entries.filter((e) => e !== null).sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "folder" ? -1 : 1));
      });
    },
    async open(path) {
      const rel = plain(path);
      if (rel === "") throw missing(rel);
      return inParent(rel, false, async (folder, leaf) => {
        const handle = await openFile(folder, leaf, rel);
        try {
          const data = new Uint8Array(await handle.readFile());
          return { path: rel, type: typeOf(leaf), size: data.length, data };
        } finally {
          await handle.close();
        }
      });
    },
    async exists(path) {
      const rel = plain(path);
      if (rel === "") return true;
      try {
        return await inParent(rel, false, async (folder, leaf) => {
          const kind = await kindOf(folder, leaf);
          if (kind === "link") throw refused(rel);
          return kind !== "missing";
        });
      } catch (error) {
        if (error instanceof Missing) return false;
        throw error;
      }
    },
    async write(path, data, overwrite) {
      const rel = plain(path);
      if (rel === "") throw new WorkspaceError("a file needs a name");
      await inParent(rel, true, async (folder, leaf) => {
        const kind = await kindOf(folder, leaf);
        if (kind === "link") throw refused(rel);
        if (kind !== "missing" && (!overwrite || kind !== "file")) throw new WorkspaceError(`${rel} already exists`);
        // made new, or opened as a plain file and emptied only once it is known to be one
        const handle = await openFile(folder, leaf, rel, kind === "missing" ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_WRONLY);
        try {
          await handle.truncate(0);
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
      });
    },
    async move(from, to) {
      const [a, b] = [plain(from), plain(to)];
      if (a === "" || b === "") throw new WorkspaceError("the workspace itself cannot be moved");
      if (b === a || b.startsWith(`${a}/`)) throw new WorkspaceError(`${a} cannot go inside itself`);
      if (PROTECTED.includes(a)) throw kept(a);
      await inParent(a, false, (source, was) =>
        inParent(b, true, async (target, now) => {
          const [there, taken] = [await kindOf(source, was), await kindOf(target, now)];
          if (there === "missing") throw missing(a);
          if (there === "link") throw refused(a);
          if (there === "other") throw new WorkspaceError(`${a} is not a file or a folder`);
          if (taken !== "missing") throw new WorkspaceError(`${b} already exists`);
          if (!isProtected(b)) return await rename(source.at(was), target.at(now));
          // into a folder the sandbox sees read-only: a copy, not the same inodes it may still hold (and then the original goes)
          try {
            await copy(source, was, a, target, now);
          } catch (error) {
            await removeTree(target, now).catch(() => {});
            throw error;
          }
          await removeTree(source, was);
        }),
      );
      // the chat's files follow them
      sent = Object.fromEntries(
        Object.entries(sent).map(([id, file]) => [id, within(file.attachment.path, a) ? at(file, b + file.attachment.path.slice(a.length)) : file]),
      );
      saveIndex();
    },
    async remove(path) {
      const rel = plain(path);
      if (rel === "") throw new WorkspaceError("the workspace itself cannot be deleted");
      if (PROTECTED.includes(rel)) throw kept(rel);
      await inParent(rel, false, async (folder, leaf) => {
        const kind = await kindOf(folder, leaf);
        if (kind === "missing") throw missing(rel);
        if (kind === "link") throw refused(rel);
        await removeTree(folder, leaf);
      });
      // a sent file that is gone points at nothing
      sent = Object.fromEntries(Object.entries(sent).filter(([, file]) => !within(file.attachment.path, rel)));
      saveIndex();
    },
    async share(path) {
      const { path: rel, type, size, data } = await store.open(path);
      const image = await describe(data, type);
      const attachment: Attachment = { id: newId("f"), name: basename(rel), type, size, path: rel, ...(image ? { image } : {}) };
      sent = { ...sent, [attachment.id]: { attachment, by: "muse" } };
      saveIndex();
      return attachment;
    },
    locate(id) {
      const attachment = sent[id]?.attachment;
      try {
        return attachment && presentSync(root, parts(plain(attachment.path))) ? attachment.path : null;
      } catch {
        return null;
      }
    },
  };
  const store: FileStore = {
    ...raw,
    list: (folder) => careful(folder, () => raw.list(folder)),
    open: (path) => careful(path, () => raw.open(path)),
    exists: (path) => careful(path, () => raw.exists(path)),
    write: (path, data, overwrite) => careful(path, () => raw.write(path, data, overwrite)),
    move: (from, to) => careful(from, () => raw.move(from, to)),
    remove: (path) => careful(path, () => raw.remove(path)),
    share: (path) => careful(path, () => raw.share(path)),
    save: (name, type, body) => careful(name, () => raw.save(name, type, body)),
  };
  return store;
}
