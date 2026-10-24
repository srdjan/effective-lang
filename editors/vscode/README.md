# Effektive for VS Code

The Effektive extension includes its language server and all client runtime dependencies. It needs VS Code 1.91 or later and **Deno 2.9.8**; no checkout or separate npm installation is needed after installing the VSIX.

Install the local VSIX with **Extensions: Install from VSIX...**, then open an `.eff` or `.effi` file. The extension checks Deno before starting and reports a missing executable or incompatible version. Set `effektive.server.deno` if VS Code cannot find Deno on `PATH`.

The language client supports diagnostics, hover, definitions, document symbols, and the editor capabilities advertised by the bundled server. **Effektive: Show Generated TypeScript** opens generated output beside the source and refreshes it after edits. Errors retain the last good output with a stale marker.

## Settings

- `effektive.server.deno` (default `deno`): the Deno 2.9.8 executable.
- `effektive.server.repository` (default empty): an explicit development override pointing to an effektive-lang checkout. Empty uses the bundled server.
- `effektive.writeOnSave` (default `true`): on save, write every generated `.ts` and `.ts.map` file that changed, from the saved files on disk.
- `effektive.debounceMs` (default `0`): compilation delay after an edit, in milliseconds.

Reload the window after changing a server setting.

## Build from source

Run `deno task package` at the repository root with Deno 2.9.8 and Node 20 or later. This installs the pinned `vscode-languageclient` 10.1.2 closure using `npm ci` and creates `dist/effektive-vscode-0.5.2.vsix`. No publishing occurs. See `docs/installation.md` for the standalone CLI and isolated offline smoke test.

For checkout development, run `npm ci` in this directory, set `effektive.server.repository` to the repository root, and launch VS Code with `--extensionDevelopmentPath=<repo>/editors/vscode`. The development override uses the checkout's Deno configuration and server source.
