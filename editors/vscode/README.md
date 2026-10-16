# Effective for VS Code

This extension connects VS Code to the Effective language server. The server lives in `src/lsp/` of this repository. The extension has no build step.

## What the client does

The client starts the language server over standard input and output. It shows diagnostics, hover text, definitions, and document symbols for `.eff` and `.effi` files. It also adds syntax highlighting and one command that shows the generated TypeScript of a module.

The client watches `**/*.eff`, `**/*.effi`, and `**/effective.json` files. The server uses these events to reload files that change on disk.

## Versions

The client pins `vscode-languageclient` at version 10.1.2. This is the newest version at the time of writing. Its `engines.vscode` value is `^1.91.0`.

The extension declares `engines.vscode` as `^1.91.0`. This value equals the requirement of the library. The VS Code version used for tests is 1.142.0, which is later than 1.91.0.

## Install

Install Node 20 or later and Deno 2.9.7 or later. Run these commands once.

```sh
cd editors/vscode
npm ci
```

## Run from the repository

Start VS Code with the extension and the example files. Replace `<repo>` with the path of this repository.

```sh
code --extensionDevelopmentPath=<repo>/editors/vscode <repo>/fixtures/examples
```

Open a `.eff` file in the new window. The server starts when the file opens. The `Effective` output channel shows the server log.

## Settings

Each server setting needs a window reload after a change. The extension shows a message when one of them changes.

- `effective.server.deno` (default `deno`): the Deno executable that starts the server.
- `effective.server.repository` (default empty): the path of this repository. An empty value means two directories above the extension.
- `effective.writeOnSave` (default `true`): when true, the server writes the `.ts` and `.ts.map` files of a module on save.
- `effective.debounceMs` (default `0`): the delay in milliseconds before the server compiles after an edit.

## Command

The command `Effective: Show Generated TypeScript` opens the generated TypeScript of the active `.eff` file. It opens a read-only document beside the editor. The command works only in an Effective editor.

The document updates when the module compiles again. A module with errors shows the last good output. Its first line says that the output is stale.
