// The counting rules that measure.ts and measure_functions.ts share.

import ts from "typescript";

export const isBranch = (n: ts.Node): boolean => {
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
export const isDecision = (n: ts.Node) =>
  isBranch(n) && n.kind !== ts.SyntaxKind.ReturnStatement;

export const countIn = (
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

export const fnName = (n: ts.Node): string => {
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
