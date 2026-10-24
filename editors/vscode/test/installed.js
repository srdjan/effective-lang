"use strict";

// Executed by a real VS Code extension host against an installed VSIX.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert(await vscode.workspace.applyEdit(edit));
}

async function run() {
  const root = process.env.EFFEKTIVE_TEST_PROJECT;
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(root, "main.eff")),
  );
  const uri = document.uri;
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension("local.effektive-vscode");
  assert(extension, "installed extension must be discovered");
  await extension.activate();
  assert(
    extension.extensionPath.startsWith(process.env.EFFEKTIVE_TEST_EXTENSIONS),
  );
  assert(
    fs.existsSync(
      path.join(extension.extensionPath, "server", "effektive-lsp.js"),
    ),
  );
  const text = document.getText();
  const at = (needle, within = 0) =>
    document.positionAt(document.getText().indexOf(needle) + within);
  await until(async () => {
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      uri,
      at("twice", 1),
    );
    return hovers && hovers.length;
  }, "bundled server hover");
  if (process.env.EFFEKTIVE_TEST_PHASE === "restart") {
    assert(
      fs.readFileSync(path.join(root, "main.ts"), "utf8").includes("twice"),
    );
    return;
  }
  if (process.env.EFFEKTIVE_TEST_FEATURES === "true") {
    const references = await vscode.commands.executeCommand(
      "vscode.executeReferenceProvider",
      uri,
      at("twice", 1),
    );
    assert(references.length >= 2, "declaration and call references");
    const rename = await vscode.commands.executeCommand(
      "vscode.executeDocumentRenameProvider",
      uri,
      at("twice", 1),
      "double",
    );
    assert(
      rename && rename.size > 0,
      "versioned rename is converted to a workspace edit",
    );
    assert(await vscode.workspace.applyEdit(rename));
    assert(document.getText().includes("double(21)"));
    await replace(document, text);
    const completions = await vscode.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      uri,
      at("twice(21)", 3),
    );
    assert(
      completions.items.some((item) =>
        (typeof item.label === "string" ? item.label : item.label.label) ===
          "twice"
      ),
    );
    const tokens = await vscode.commands.executeCommand(
      "vscode.provideDocumentSemanticTokens",
      uri,
    );
    assert(tokens && tokens.data.length > 0, "full semantic tokens");
    for (
      const body of [
        "error Failed = {}\nexport const broken = (): Count => fail(Failed({}))\n",
        "service Clock { now(): Count }\nexport const read = (): Count => Clock.now()\n",
      ]
    ) {
      await replace(document, text + body);
      await until(
        () => vscode.languages.getDiagnostics(uri).length > 0,
        "missing effect diagnostic",
      );
      const actions = await until(async () => {
        const result = await vscode.commands.executeCommand(
          "vscode.executeCodeActionProvider",
          uri,
          new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          ),
          vscode.CodeActionKind.QuickFix.value,
        );
        return result && result.find((action) => action.edit);
      }, "missing effect code action");
      assert(await vscode.workspace.applyEdit(actions.edit));
      await until(
        () => vscode.languages.getDiagnostics(uri).length === 0,
        "validated effect code action",
      );
    }
    await replace(document, text);
  }
  await replace(document, text + "\n// installed save acceptance\n");
  assert(await document.save());
  await until(
    () =>
      fs.existsSync(path.join(root, "main.ts")) &&
      fs.existsSync(path.join(root, "main.ts.map")),
    "generated files after save",
  );
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("effektive.showGeneratedTypeScript");
  const generated = await until(
    () =>
      vscode.workspace.textDocuments.find((doc) =>
        doc.uri.scheme === "effektive-generated" &&
        doc.getText().includes("twice")
      ),
    "generated virtual document",
  );
  const valid = document.getText();
  await replace(document, valid.replace("twice(21)", 'twice("wrong")'));
  await until(
    () => generated.getText().includes("// stale:"),
    "stale output after invalid edit",
  );
  await replace(document, valid);
  assert(await document.save());
  await until(
    () => !generated.getText().includes("// stale:"),
    "generated output recovers after correction",
  );
}

module.exports.run = async () => {
  try {
    await run();
    fs.writeFileSync(
      process.env.EFFEKTIVE_TEST_RESULT,
      JSON.stringify({
        ok: true,
        phase: process.env.EFFEKTIVE_TEST_PHASE,
        features: process.env.EFFEKTIVE_TEST_FEATURES,
      }),
    );
  } catch (error) {
    fs.writeFileSync(
      process.env.EFFEKTIVE_TEST_RESULT,
      JSON.stringify({ ok: false, error: error.stack || String(error) }),
    );
    throw error;
  }
};
