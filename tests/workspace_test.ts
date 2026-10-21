import { assertEquals } from "@std/assert";
import type { ReadError, Result } from "../src/core/source.ts";
import type { CliFs, DirectoryEntry, FileFailure } from "../src/host/io.ts";
import { readWorkspace } from "../src/host/workspace.ts";

/**
 * A file system with directory links. `files` maps real file paths to texts.
 * `links` maps the path of a link to its target. A link resolves in any
 * position of a path, so `absolute` gives the real path of a directory.
 */
function linkedFs(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>>,
): CliFs {
  const resolve = (path: string): string => {
    let current = path;
    for (let hop = 0; hop < 64; hop++) {
      const parts = current.split("/");
      let changed = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        const target = links[prefix];
        if (target !== undefined) {
          current = [target, ...parts.slice(i)].join("/");
          changed = true;
          break;
        }
      }
      if (!changed) return current;
    }
    throw new Error(`too many links: ${path}`);
  };
  return {
    readText(path: string): Result<string, ReadError> {
      const text = files[resolve(path)];
      return text === undefined
        ? { ok: false, error: { tag: "not-found", path } }
        : { ok: true, value: text };
    },
    writeText: () => ({ ok: false, error: { message: "read only" } }),
    kind: (path) => {
      const real = resolve(path);
      if (files[real] !== undefined) return "file";
      return Object.keys(files).some((key) => key.startsWith(`${real}/`))
        ? "directory"
        : "missing";
    },
    list(path: string): Result<readonly DirectoryEntry[], FileFailure> {
      const real = resolve(path);
      const found = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(`${real}/`)) continue;
        const rest = key.slice(real.length + 1);
        const slash = rest.indexOf("/");
        if (slash < 0) found.set(rest, false);
        else found.set(rest.slice(0, slash), true);
      }
      for (const link of Object.keys(links)) {
        const slash = link.lastIndexOf("/");
        if (resolve(link.slice(0, slash)) === real) {
          found.set(link.slice(slash + 1), true);
        }
      }
      return {
        ok: true,
        value: [...found].map(([name, isDirectory]) => ({ name, isDirectory })),
      };
    },
    absolute: resolve,
  };
}

const FILES = {
  "/p/effective.json": "{}",
  "/p/a.eff": "a",
  "/p/sub/b.eff": "b",
  "/other/c.eff": "c",
};

/** The texts that the walk reads, sorted. Each real file must appear once. */
function textsOf(links: Readonly<Record<string, string>>): string[] {
  const read = readWorkspace(linkedFs(FILES, links), "/p");
  if (!read.ok) throw new Error(read.error);
  return [...read.value.values()].sort();
}

const ONCE = ["a", "b", "{}"];

Deno.test("readWorkspace reads each file once when a link points to its own parent", () => {
  assertEquals(textsOf({ "/p/sub/up": "/p" }), ONCE);
});

Deno.test("readWorkspace ends on a cycle between two links", () => {
  assertEquals(textsOf({ "/p/sub/x": "/p/y", "/p/y": "/p/sub" }), ONCE);
});

Deno.test("readWorkspace skips a link to the parent of the root", () => {
  assertEquals(textsOf({ "/p/out": "/" }), ONCE);
});

Deno.test("readWorkspace skips a link to a directory outside the root", () => {
  assertEquals(textsOf({ "/p/elsewhere": "/other" }), ONCE);
});

Deno.test("readWorkspace reads a directory once when a link points to a directory inside the root", () => {
  assertEquals(textsOf({ "/p/alias": "/p/sub" }), ONCE);
});

Deno.test("readWorkspace skips a directory that cannot be resolved", () => {
  const fs = linkedFs(FILES, {});
  const read = readWorkspace(
    {
      ...fs,
      absolute: (path) => {
        if (path === "/p/sub") throw new Error("gone");
        return fs.absolute(path);
      },
    },
    "/p",
  );
  if (!read.ok) throw new Error(read.error);
  assertEquals([...read.value.values()].sort(), ["a", "{}"]);
});
