// Counts branches and cyclomatic complexity for each file given as an argument.
// It prints a JSON array with one entry for each file: lines of code, branches,
// the maximum cyclomatic number, imports, and the eight most complex functions.
//
// Run `deno task measure <files...>` from the repository root.

import ts from "typescript";

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

const isBranch = (n: ts.Node): boolean => {
  switch (n.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CatchClause:
      return true;
    case ts.SyntaxKind.BinaryExpression: {
      const k = (n as ts.BinaryExpression).operatorToken.kind;
      return k === ts.SyntaxKind.AmpersandAmpersandToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken;
    }
    case ts.SyntaxKind.PropertyAccessExpression:
    case ts.SyntaxKind.ElementAccessExpression:
    case ts.SyntaxKind.CallExpression:
      return (n as ts.PropertyAccessExpression).questionDotToken !== undefined;
    case ts.SyntaxKind.ReturnStatement: {
      // early return inside a branch: parent chain hits if/case before the function body
      let p = n.parent;
      while (p && !ts.isFunctionLike(p)) {
        if (ts.isIfStatement(p) || ts.isCaseClause(p)) return true;
        p = p.parent;
      }
      return false;
    }
    default:
      return false;
  }
};
// cyclomatic: decision points without early returns, +1
const isDecision = (n: ts.Node) =>
  isBranch(n) && n.kind !== ts.SyntaxKind.ReturnStatement;

const countIn = (
  root: ts.Node,
  pred: (n: ts.Node) => boolean,
  stopAtFns: boolean,
): number => {
  let c = 0;
  const walk = (n: ts.Node) => {
    if (n !== root && stopAtFns && ts.isFunctionLike(n)) return;
    if (pred(n)) c++;
    ts.forEachChild(n, walk);
  };
  walk(root);
  return c;
};

const fnName = (n: ts.Node): string => {
  const named = n as ts.FunctionDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const p = n.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  return "<anon>";
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
