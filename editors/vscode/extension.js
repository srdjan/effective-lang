"use strict";

// VS Code client of the Effective language server. Plain CommonJS, no build step.

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

// These values must equal the exports of src/lsp/methods.ts.
const GENERATED_TYPESCRIPT_METHOD = "effective/generatedTypeScript";
const GENERATED_CHANGED_METHOD = "effective/generatedChanged";
const GENERATED_SCHEME = "effective-generated";

const LANGUAGE_ID = "effective";
const SHOW_COMMAND = "effective.showGeneratedTypeScript";
const SERVER_SETTINGS = [
  "effective.server.deno",
  "effective.server.repository",
  "effective.writeOnSave",
  "effective.debounceMs",
];

const NO_RESULT_TEXT =
  "// No generated TypeScript yet: the module has not compiled in this session.";
const STALE_LINE =
  "// stale: the module has errors. This is the last good output.";

/** @type {LanguageClient | undefined} */
let client;
/** @type {Promise<void> | undefined} */
let started;

/** The virtual URI of a source `foo/users.eff` is `effective-generated:foo/users.ts?<source URI>`. */
function virtualUriOf(sourceUri) {
  return vscode.Uri.from({
    scheme: GENERATED_SCHEME,
    path: sourceUri.path.replace(/\.eff$/, ".ts"),
    query: encodeURIComponent(sourceUri.toString()),
  });
}

/** Returns the source URI string stored in the query of a virtual URI. */
function sourceUriStringOf(virtualUri) {
  return decodeURIComponent(virtualUri.query);
}

class GeneratedContentProvider {
  constructor(getClient) {
    this.getClient = getClient;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  fire(virtualUri) {
    this.emitter.fire(virtualUri);
  }

  dispose() {
    this.emitter.dispose();
  }

  async provideTextDocumentContent(virtualUri) {
    const running = this.getClient();
    if (running === undefined || started === undefined) {
      return "// The Effective language server is not running.";
    }
    try {
      await started;
    } catch (_error) {
      return "// The Effective language server did not start. See the Effective output channel.";
    }
    try {
      const result = await running.sendRequest(GENERATED_TYPESCRIPT_METHOD, {
        textDocument: { uri: sourceUriStringOf(virtualUri) },
      });
      if (result === null || result === undefined) return NO_RESULT_TEXT;
      return result.stale ? `${STALE_LINE}\n${result.text}` : result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `// The request for generated TypeScript failed: ${message}`;
    }
  }
}

function serverOptions() {
  const config = vscode.workspace.getConfiguration("effective");
  const deno = config.get("server.deno", "deno") || "deno";
  const setting = config.get("server.repository", "");
  const repository = setting ? setting : path.resolve(__dirname, "..", "..");
  return {
    repository,
    options: {
      command: deno,
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--config",
        path.join(repository, "deno.json"),
        path.join(repository, "src", "lsp", "main.ts"),
      ],
    },
  };
}

async function showGeneratedTypeScript() {
  const editor = vscode.window.activeTextEditor;
  const document = editor && editor.document;
  if (
    !document || document.languageId !== LANGUAGE_ID ||
    !document.uri.path.endsWith(".eff")
  ) {
    await vscode.window.showInformationMessage(
      "Open an Effective .eff file to show its generated TypeScript.",
    );
    return;
  }
  const virtual = await vscode.workspace.openTextDocument(
    virtualUriOf(document.uri),
  );
  if (virtual.languageId !== "typescript") {
    await vscode.languages.setTextDocumentLanguage(virtual, "typescript");
  }
  await vscode.window.showTextDocument(virtual, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
}

function activate(context) {
  const config = vscode.workspace.getConfiguration("effective");
  const { repository, options } = serverOptions();
  const entry = path.join(repository, "src", "lsp", "main.ts");
  if (!fs.existsSync(entry)) {
    vscode.window.showErrorMessage(
      `Effective: the language server was not found at ${entry}. ` +
        "Set effective.server.repository to the effective-lang repository.",
    );
  }

  const outputChannel = vscode.window.createOutputChannel("Effective");
  client = new LanguageClient(
    "effective",
    "Effective",
    options,
    {
      documentSelector: [{ scheme: "file", language: LANGUAGE_ID }],
      synchronize: {
        fileEvents: [
          vscode.workspace.createFileSystemWatcher("**/*.eff"),
          vscode.workspace.createFileSystemWatcher("**/*.effi"),
          vscode.workspace.createFileSystemWatcher("**/effective.json"),
        ],
      },
      initializationOptions: {
        writeOnSave: config.get("writeOnSave", true),
        debounceMs: config.get("debounceMs", 0),
      },
      outputChannel,
    },
  );

  const provider = new GeneratedContentProvider(() => client);
  client.onNotification(GENERATED_CHANGED_METHOD, (params) => {
    if (params && typeof params.uri === "string") {
      provider.fire(virtualUriOf(vscode.Uri.parse(params.uri)));
    }
  });

  context.subscriptions.push(
    outputChannel,
    provider,
    vscode.workspace.registerTextDocumentContentProvider(
      GENERATED_SCHEME,
      provider,
    ),
    vscode.commands.registerCommand(SHOW_COMMAND, showGeneratedTypeScript),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (SERVER_SETTINGS.some((name) => event.affectsConfiguration(name))) {
        vscode.window
          .showInformationMessage(
            "Effective: a server setting changed. Reload the window to apply it.",
            "Reload Window",
          )
          .then((choice) => {
            if (choice === "Reload Window") {
              return vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
            }
          });
      }
    }),
  );

  started = client.start();
  started.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`The language server failed to start: ${message}`);
  });
}

function deactivate() {
  if (client === undefined) return undefined;
  const stopping = client.stop();
  client = undefined;
  return stopping.catch(() => undefined);
}

module.exports = { activate, deactivate };
