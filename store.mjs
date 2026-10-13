/** The folder a download is kept in until it is zipped, and the zip. */

import { mkdir, writeFile, rename, access, readdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import yazl from "yazl";

export function folderStore(root) {
  return {
    root,
    async has(path) {
      try {
        await access(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
    async write(path, value) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      // Written aside and moved into place, so a file in the folder is always whole.
      const part = `${target}.part`;
      await writeFile(part, JSON.stringify(value ?? null));
      await rename(part, target);
    },
  };
}

async function* filesIn(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesIn(path);
    else if (!entry.name.endsWith(".part")) yield path;
  }
}

/** Zips everything in `root` into `target`, under one top folder `name`. */
export async function zipFolder(root, target, name) {
  const zip = new yazl.ZipFile();
  const part = `${target}.part`;
  const written = new Promise((resolve, reject) => {
    const out = createWriteStream(part);
    out.on("close", resolve);
    out.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(out);
  });
  for await (const file of filesIn(root)) zip.addFile(file, `${name}/${relative(root, file).split(sep).join("/")}`);
  zip.end();
  await written;
  await rename(part, target);
}

export const removeFolder = (root) => rm(root, { recursive: true, force: true });
