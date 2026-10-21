# Local installation

Effective requires **Deno 2.9.7**. The extension checks the executable before starting its server and reports missing or incompatible installations. Packaged CLI and server entry points also reject other versions. Generated TypeScript targets Effect 4.0.5.

## Build the local artifacts

From a checkout, with Deno 2.9.7 and Node 20 or later (including npm):

```sh
deno task package
```

This runs `npm ci --ignore-scripts` against the extension lockfile, bundles the full CLI and language-server dependency closures (including `@std/path`), and writes:

- `dist/effective.js`: standalone CLI JavaScript.
- `dist/effective-lsp.js`: standalone stdio language server.
- `dist/effective-vscode-0.5.2.vsix`: extension, bundled server, syntax assets, and the complete locked client runtime dependencies and licenses.

The build needs registry access or populated build caches. Installation and startup of these artifacts need no checkout, npm installation, registry, or populated Deno cache. The VSIX uses sorted entries and fixed ZIP timestamps; identical inputs produce identical bytes. Building does not publish artifacts.

## Install the CLI

Copy `effective.js` to a permanent local directory, then install that copy:

```sh
mkdir -p "$HOME/.local/share/effective"
cp dist/effective.js "$HOME/.local/share/effective/effective.js"
deno install --global --name effective --no-config --no-lock --cached-only \
  --allow-read --allow-write --allow-run=deno \
  "$HOME/.local/share/effective/effective.js"
```

Add the bin directory printed by Deno to `PATH`. The launcher refers to the copied bundle, so retain that file. Run `effective --help`, `effective check /path/to/project`, or `effective build /path/to/project`. The subprocess grant remains restricted to the PATH executable `deno`; ensure Deno 2.9.7 is on `PATH` for `build --tsc` and `watch --tsc`.

Checking and emitting source work offline. Target checking with `--tsc` still needs the application's host dependencies, Effect 4.0.5, and `@effect/platform-node` 4.0.5 in its Deno cache or registry access. The bundle does not package application runtime dependencies.

## Install VS Code support

Use VS Code's **Extensions: Install from VSIX...** command to select the VSIX, or run:

```sh
code --install-extension dist/effective-vscode-0.5.2.vsix --force
```

Open an `.eff` or `.effi` file. The extension uses its own bundled server. If Deno is outside VS Code's `PATH`, set `effective.server.deno` to its executable. `effective.server.repository` is an explicit development override for a checkout; leave it empty for normal installation.

The **Effective: Show Generated TypeScript** command opens a read-only output document. `effective.writeOnSave` controls generated `.ts` and `.ts.map` writes on save, and defaults to true. The first save of a session writes every module whose generated files are missing or stale. `effective.debounceMs` defaults to zero. Reload the window after changing a server setting.

## Verification

```sh
deno task test:installation
```

The smoke test rebuilds the artifacts, checks reproducible VSIX bytes, unpacks the extension outside the checkout, and starts its server with an empty `DENO_DIR`, remote imports disabled, and network access denied. It verifies initialization and generated output, installs the CLI with `deno install`, then checks and builds a temporary project through the installed launcher. These automated checks do not replace manual editor acceptance.

For installed VS Code acceptance, run `deno task test:vscode`. The default executable is `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`; set `EFFECTIVE_VSCODE_EXECUTABLE` for another installation. This separate graphical check installs the VSIX into temporary extension and user-data directories, tests references, rename, completion, semantic tokens and missing-effect actions, checks generated preview, save and error recovery, then starts another editor process to verify restart. `--baseline` limits the run to startup, hover, generated output, save, recovery and restart. Set `EFFECTIVE_KEEP_SMOKE=1` to retain its temporary evidence and editor logs for debugging.

Automated acceptance on 2026-10-21 used Deno 2.9.7, Node 24.21.0 and VS Code 1.143.0 on macOS arm64. The portable offline installation test passed, including reproducible archive bytes. The full installed editor run passed references, applied rename, completion, semantic tokens, both missing-effect quick fixes, generated output, save, error recovery and a new-process restart. These are automated results; the user's manual release acceptance remains separate.

The final rerun and local artifact SHA-256 hashes are recorded in [machine-readable installed-editor evidence](release-assets/installed-vscode-review.json). The installed VSIX matches the final artifact byte for byte.
