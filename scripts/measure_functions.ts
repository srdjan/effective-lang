// Lists every named or long function in each file given as an argument, with
// the counts of its own body. Nested functions are not counted in the outer one.
// It prints tab-separated rows: file, name, line, loc, branches, cyclomatic, depth.
//
// Run `deno task measure:functions <files...>` from the repository root.

import ts from "typescript";
import { countIn, fnName, isBranch, isDecision } from "./measure_kernel.ts";
const rows: string[] = [];
for (const file of Deno.args) {
  const sf = ts.createSourceFile(
    file,
    Deno.readTextFileSync(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (n: ts.Node, depth: number) => {
    if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) {
      const s = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const e = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
      const name = fnName(n);
      if (name !== "<anon>" || e - s > 20) {
        rows.push(
          [
            file,
            name,
            s,
            e - s + 1,
            countIn(n, isBranch, true),
            countIn(n, isDecision, true) + 1,
            depth,
          ].join("\t"),
        );
      }
      ts.forEachChild(n, (c) => visit(c, depth + 1));
      return;
    }
    ts.forEachChild(n, (c) => visit(c, depth));
  };
  visit(sf, 0);
}
console.log(rows.join("\n"));
