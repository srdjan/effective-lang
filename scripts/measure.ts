// Counts branches and cyclomatic complexity for each file given as an argument.
// It prints a JSON array with one entry for each file: lines of code, branches,
// the maximum cyclomatic number, imports, and the eight most complex functions.
//
// Run `deno task measure <files...>` from the repository root.

import ts from "typescript";
import { countIn, fnName, isBranch, isDecision } from "./measure_kernel.ts";

type FnStat = {
  name: string;
  line: number;
  loc: number;
  branches: number;
  cyclomatic: number;
};
type FileStat = {
  file: string;
  loc: number;
  branches: number;
  maxCyclo: number;
  fnCount: number;
  importsOut: number;
  exportedFns: number;
  anyDefault: number;
  topFns: FnStat[];
};

const measure = (file: string, text: string): FileStat => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fns: FnStat[] = [];
  let importsOut = 0, exportedFns = 0, anyDefault = 0;
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) importsOut++;
    if (ts.isDefaultClause(n)) anyDefault++;
    if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) {
      const name = fnName(n);
      const isTop = n.parent === sf ||
        (n.parent && ts.isVariableDeclaration(n.parent) &&
          n.parent.parent?.parent?.parent === sf);
      if (isTop) {
        const start = sf.getLineAndCharacterOfPosition(n.getStart()).line;
        const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
        const exported = ts.isFunctionDeclaration(n)
          ? (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0
          : (n.parent?.parent?.parent &&
            ts.isVariableStatement(n.parent.parent.parent) &&
            (ts.getCombinedModifierFlags(
                n.parent.parent.parent as unknown as ts.Declaration,
              ) & ts.ModifierFlags.Export) !== 0);
        if (exported) exportedFns++;
        // top-level function includes nested closures in its count
        fns.push({
          name,
          line: start + 1,
          loc: end - start + 1,
          branches: countIn(n, isBranch, false),
          cyclomatic: countIn(n, isDecision, false) + 1,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const loc =
    text.split("\n").filter((l) =>
      l.trim() !== "" && !l.trim().startsWith("//")
    ).length;
  return {
    file,
    loc,
    branches: countIn(sf, isBranch, false),
    maxCyclo: Math.max(0, ...fns.map((f) => f.cyclomatic)),
    fnCount: fns.length,
    importsOut,
    exportedFns,
    anyDefault,
    topFns: [...fns].sort((a, b) => b.cyclomatic - a.cyclomatic).slice(0, 8),
  };
};

const files = Deno.args;
const out = files.map((f) => measure(f, Deno.readTextFileSync(f)));
console.log(JSON.stringify(out, null, 1));
