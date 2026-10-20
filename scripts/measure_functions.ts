// Lists every named or long function in each file given as an argument, with
// the counts of its own body. Nested functions are not counted in the outer one.
// It prints tab-separated rows: file, name, line, loc, branches, cyclomatic, depth.
//
// Run `deno task measure:functions <files...>` from the repository root.

import ts from "typescript";
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
