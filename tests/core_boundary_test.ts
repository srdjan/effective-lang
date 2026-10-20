// Guard test for the rule "src/core does no I/O". The core library may not use
// Deno or global host APIs, and it may import only relative files. Without this
// test, a regression of the boundary shows up only when a consumer breaks.
//
// The test walks src/core with Deno.readDir, not with git, because
// `deno task behavior:capture` runs the tests in an exported tree that has no
// .git directory. It skips the capture hook files (HOOK_PATHS) that the capture
// writes into that temporary tree: the hooks read the environment on purpose.

import { assertEquals } from "@std/assert";
import { HOOK_PATHS } from "../scripts/behavior_capture.ts";

/** The forbidden names. Each pattern runs on code with comments and literals blanked. */
const FORBIDDEN: readonly (readonly [name: string, pattern: RegExp])[] = [
  ["Deno.", /\bDeno\./],
  ["console.", /\bconsole\./],
  ["Date.now", /\bDate\.now\b/],
  ["Math.random", /\bMath\.random\b/],
  ["performance.now", /\bperformance\.now\b/],
  ["setTimeout", /\bsetTimeout\b/],
  ["setInterval", /\bsetInterval\b/],
  ["fetch(", /(?<![.\w])fetch\s*\(/],
  ["globalThis", /\bglobalThis\b/],
];

/** A module specifier follows `from`, `import`, or `import(` and is a string literal. */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*$/;

/** The characters after which a `/` starts a regular expression and not a division. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

interface Scan {
  /** The source with every comment and literal body replaced by spaces. Line breaks stay. */
  readonly code: string;
  /** Each string literal that follows `from`, `import`, or `import(`. */
  readonly specifiers: readonly string[];
}

/**
 * Splits TypeScript text into code and non-code. The scan is a small state
 * machine, not a parser. It blanks line comments, block comments, string
 * literals, template literal text, and regular expression literals, so a name
 * inside emitted code (the `.await` text of emit/explicit_scope.ts, for
 * example) is not a violation. Code inside `${...}` of a template stays code.
 * It records the string literals in import position, to check their specifiers.
 */
function scanCode(text: string): Scan {
  const out: string[] = [];
  const specifiers: string[] = [];
  // Each entry is the brace depth at which a template literal resumes.
  const templates: number[] = [];
  let braces = 0;
  let i = 0;
  const blank = (c: string) => (c === "\n" || c === "\r" ? c : " ");
  const lastCode = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k] !== " " && out[k] !== "\n" && out[k] !== "\r") return out[k];
    }
    return "";
  };
  const readTemplate = () => {
    // The caller consumed the opening backtick or the closing brace of `${}`.
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        out.push(" ", blank(text[i + 1] ?? ""));
        i += 2;
      } else if (c === "`") {
        out.push("`");
        i++;
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        out.push("$", "{");
        i += 2;
        templates.push(braces);
        braces++;
        return;
      } else {
        out.push(blank(c));
        i++;
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") out.push(" "), i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) out.push(blank(text[i])), i++;
    } else if (c === '"' || c === "'") {
      const start = i;
      // Only the tail matters, and a full join per literal would be quadratic.
      const before = out.slice(-40).join("");
      out.push(c);
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") out.push(" "), i++;
        out.push(blank(text[i] ?? ""));
        i++;
      }
      if (text[i] === c) out.push(c), i++;
      if (SPECIFIER.test(before)) {
        specifiers.push(text.slice(start + 1, i - 1));
      }
    } else if (c === "`") {
      out.push("`");
      i++;
      readTemplate();
    } else if (
      c === "/" && (lastCode() === "" || REGEX_PRECEDERS.includes(lastCode()))
    ) {
      // A regular expression literal: read to the closing slash outside a class.
      out.push("/");
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== "\n") {
        const r = text[i];
        if (r === "\\") out.push(" "), i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        out.push(blank(text[i] ?? ""));
        i++;
      }
      if (text[i] === "/") out.push("/"), i++;
    } else {
      if (c === "{") braces++;
      if (c === "}") {
        braces--;
        if (
          templates.length > 0 && templates[templates.length - 1] === braces
        ) {
          templates.pop();
          out.push("}");
          i++;
          readTemplate();
          continue;
        }
      }
      out.push(c);
      i++;
    }
  }
  return { code: out.join(""), specifiers };
}

/** The violations of the boundary in one file, as readable lines. */
function violationsOf(path: string, text: string): string[] {
  const { code, specifiers } = scanCode(text);
  const found: string[] = [];
  const lines = code.split("\n");
  lines.forEach((line, index) => {
    for (const [name, pattern] of FORBIDDEN) {
      if (pattern.test(line)) found.push(`${path}:${index + 1} uses ${name}`);
    }
  });
  for (const specifier of specifiers) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      found.push(`${path} imports non-relative "${specifier}"`);
    }
  }
  return found;
}

async function sourceFiles(directory: string, found: string[]): Promise<void> {
  for await (const entry of Deno.readDir(new URL(directory, ROOT))) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory) await sourceFiles(`${path}/`, found);
    else if (entry.isFile && path.endsWith(".ts")) found.push(path);
  }
}

const ROOT = new URL("../", import.meta.url);

Deno.test("src/core uses no host API, no global API, and no non-relative import", async () => {
  const files: string[] = [];
  await sourceFiles("src/core/", files);
  files.sort();
  const checked = files.filter((path) => !HOOK_PATHS.includes(path));
  // Guard against a walk that finds nothing and so proves nothing.
  assertEquals(checked.length > 20, true, `only ${checked.length} files`);
  const violations: string[] = [];
  for (const path of checked) {
    const text = await Deno.readTextFile(new URL(path, ROOT));
    violations.push(...violationsOf(path, text));
  }
  assertEquals(violations, []);
});

Deno.test("the boundary scan reports each forbidden name and each non-relative import", () => {
  const names = [
    "Deno.readTextFile(p)",
    "console.log(1)",
    "Date.now()",
    "Math.random()",
    "performance.now()",
    "setTimeout(f, 1)",
    "setInterval(f, 1)",
    "fetch(url)",
    "globalThis.x",
  ];
  for (const name of names) {
    assertEquals(
      violationsOf("a.ts", `const x = ${name};`).length,
      1,
      name,
    );
  }
  for (
    const line of [
      'import { a } from "@std/assert";',
      'import "npm:left-pad";',
      'export { b } from "node:fs";',
      'const m = await import("jsr:@std/path");',
    ]
  ) {
    assertEquals(violationsOf("a.ts", line).length, 1, line);
  }
  assertEquals(
    violationsOf(
      "a.ts",
      'import { a } from "./a.ts";\nexport * from "../b.ts";',
    ),
    [],
  );
});

Deno.test("the boundary scan skips comments, string literals, templates, and regular expressions", () => {
  const text = [
    "// Deno.readTextFile is only named here",
    "/* console.log\n globalThis */",
    'const a = "Deno.x and fetch(y)";',
    "const b = 'it\\'s Date.now()';",
    "const c = `emits .await then Math.random() ${1 + 1} done`;",
    'const d = /"|setTimeout/g;',
    "const e = x.fetch(1) / 2 / 3;",
    "const f = 10 / 2; const g = 'ok';",
  ].join("\n");
  assertEquals(violationsOf("a.ts", text), []);
  // Code inside `${...}` still counts, even when it has braces of its own.
  const nested = "const h = `a ${ {k: 1}.k + Date.now() } b`;";
  assertEquals(violationsOf("a.ts", nested).length, 1);
  // A violation after a literal on the same line still counts.
  assertEquals(
    violationsOf("a.ts", 'const i = "x"; console.log(i);').length,
    1,
  );
});
