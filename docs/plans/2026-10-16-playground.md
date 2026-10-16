# Playground plan: the Effective core in the browser

Status: validated, 2026-10-16. Design source: `docs/transpiler-design.md`,
sections 3.1 and 3.3 (the playground is step 3). Fable validated the first
draft and reported 16 findings. Opus accepted all 16 and resolved them in this
revision. Section 11 maps each finding to its resolution.

## 1. Decisions for this phase

The user settled four decisions on 2026-10-16. Each took the recommended option.

| Decision | Choice |
| --- | --- |
| P1 Location | The page and its build live in `playground/` in this repository. Publication to the `effective` site is a later step that the user approves. |
| P2 Editor | CodeMirror 6, bundled from npm with `deno bundle`. |
| P3 Run | The page shows diagnostics, hover, and generated TypeScript. It does not run the generated code. |
| P4 Project | The five examples and the host interface file are editable tabs. The page cannot add or remove files. |

## 2. Evidence from probes

Probes ran in `/tmp/pg-probe` on 2026-10-16. Each number is one run, not a
distribution.

- `src/core/` has no Deno API, no `node:` import, and no `jsr:` or `npm:` import.
- The core and `hoverAt` bundled into 201,528 bytes, 57,600 bytes after gzip.
- The core with `codemirror`, `@codemirror/view`, `state`, `lint`, and
  `lang-javascript` bundled into 708,662 bytes, 226,927 bytes after gzip (53
  modules).
- `deno info` resolved one version of each package: `codemirror` 6.0.2,
  `@codemirror/view` 6.43.14, `state` 6.7.6, `lint` 6.9.7, `lang-javascript`
  6.2.5, `language` 6.13.1, `commands` 6.11.1, `search` 6.7.2, `autocomplete`
  6.20.3. `@std/http` resolved to 1.1.3.
- In Deno, the first update of the examples took 20.0 ms. Later one-file
  updates took 1.0 to 1.8 ms. One `hoverAt` on `rename` took 0.016 ms after the
  module emitted.
- `deno check` accepted a file with `/// <reference lib="dom" />` that imports
  `npm:@codemirror/view`, together with the repository files.
- `deno bundle` inlines an import with `with { type: "json" }`.

## 3. Goal and acceptance

The phase delivers a static page that edits the examples and shows the result
of the core on each change. The phase is complete when these checks pass:

1. `deno task check` passes: format check, lint, type check, fast and slow tests.
2. `deno task playground:build` writes `playground/dist/` with `index.html`,
   `app.js`, `app.css`, `examples.json`, the font, and `OFL.txt`. It prints the
   size of `app.js` and its gzip size.
3. Fast tests cover the compile facade, the highlighter, and the page model
   (sections 5.1, 5.3, and 5.5) with no browser.
4. Opus opens the built page with the Playwright browser at 375 by 812 and at
   1280 by 800 CSS pixels. Opus confirms each item of section 7 and saves the
   screenshots in `demos/` (gitignored).
5. The user looks at the page with `deno task playground:serve` and accepts it.

Out of scope: running the generated code and adding or removing files. Saving
edits across visits, sharing a link to edited source, and a Web Worker are also
out of scope. So is the publication to the `effective` site.

## 4. Layout

```
playground/
  src/
    compile.ts     the compile facade over a program port (pure, no DOM)
    highlight.ts   token ranges from the core lexer (pure, no DOM)
    model.ts       page logic without DOM: hash, problems, counts, output state
    editor.ts      CodeMirror extensions and theme (DOM)
    app.ts         the page: tabs, regions, wiring (DOM)
  index.html
  app.css
  fonts/           Bricolage Grotesque and OFL.txt, copied from the site
  build.ts         writes the output directory
  serve.ts         builds, then serves dist/ on 127.0.0.1:8790
  dist/            build output, ignored by git
tests/playground_compile_test.ts
tests/playground_highlight_test.ts
tests/playground_model_test.ts
tests/playground_build_slow_test.ts
```

## 5. Behavior

### 5.1 Compile facade (`compile.ts`)

`createPlayground(files, ports)` returns a session. `files` maps root-relative
paths to text and includes `effective.json`. `ports` has two members:

- `now: () => number`, the clock.
- `program: ProgramPort`, with default `new Program("")`.
  `interface ProgramPort { update(changes: ProgramChanges): Result<Revision, ConfigError> }`.

The session keeps the program across edits, so the module cutoff of Phase A
also applies in the browser. The first call sends every file. Later calls send
one file.

`session.update(path, text)` returns
`Result<PlaygroundResult, PlaygroundError>`, where
`PlaygroundError = { tag: "config"; message } | { tag: "internal"; message }`.
The `config` message is the text of `describeConfigError`. The `internal`
message comes from an exception inside the core. `update` catches it once, and
this is the only `try` in the facade.

`PlaygroundResult` holds:

- `diagnostics`: per source path, a list of `{ from, to, severity, code,
  message }` with UTF-16 offsets into that file. Related spans are dropped.
- `outputs`: per `.eff` source path, `{ text, stale }` or `null`, with the rule
  of the LSP plan (`2026-10-16-lsp.md`, section 5.8). Key each output by the
  source path from `revision.project.modules.get(name).path`, as `effModuleOf`
  in `src/lsp/features.ts` does. Do not key it by `EmittedModule.path`, which is
  the `.ts` path. The session keeps the last good text of each module.
- `elapsedMs`: the time of the update and the emits, from `now`.

`session.hover(path, offset)` returns `{ from, to, contract, backend }` or
undefined. It calls `hoverAt` on the last good revision. `backend` is the
backend text, the text `backend type: not available while the module has
errors`, or undefined, as in the LSP. After an error result, `hover` returns
undefined until the next good update.

### 5.2 Examples

`build.ts` reads `fixtures/examples/effective.json`, the five `.eff` files, and
`host/providers.effi`. It writes them to `examples.json` in the output
directory, as one object from path to text. The page fetches that file at
start. `users-live.ts` is not included, because the page does not run code.

### 5.3 Syntax highlighting (`highlight.ts`)

Highlighting uses the core lexer, so the page and the compiler agree on every
token. `highlightTokens(text)` calls `lex("", text)` from `src/core/lex.ts`. It
returns `{ from, to, kind }` ranges sorted by `from`. The function merges the
token table and the trivia table.

| Source | Kind |
| --- | --- |
| A keyword token (the 10 entries of `KEYWORDS`) | `keyword` |
| `type`, `error`, `service`, `provider` as the first token of a line or after `export` | `keyword` |
| `fails`, `uses`, `provides`, `from` anywhere | `keyword` |
| A name in `PRELUDE_NAMES` | `builtin` |
| A name in `BUILTIN_TYPE_NAMES`, or a capitalized name | `type` |
| `String` | `string` |
| `Number` | `number` |
| Line and block comment trivia | `comment` |
| An operator token, including `|>` and `=>` | `operator` |

Other names, punctuation, `Newline`, `Eof`, whitespace trivia, and `Unknown`
give no range. The diagnostic underline marks an `Unknown` token. The word
`error` in `UserMissing(error) =>` is a name, not a keyword.

### 5.4 Editor wiring (`editor.ts`, `app.ts`)

- One `EditorView` for the source, with one `EditorState` for each file. Create
  every state with the same extension array, because the extensions live in the
  state. A tab change calls `view.setState`, so each file keeps its own undo
  history and cursor.
- Extensions: `minimalSetup`, `lineNumbers()`, `history()`, `bracketMatching()`,
  `highlightActiveLine()`, the highlight decorations, the hover tooltip, and
  the theme. Do not use `basicSetup`. It adds the search panel, the fold gutter,
  autocompletion, and other parts that each need a theme. Do not bind
  `indentWithTab`, so that Tab leaves the editor.
- Highlight decorations: a `ViewPlugin` that calls `highlightTokens` on each
  document change and builds mark decorations with one class for each kind.
- Diagnostics use the push model. An update listener calls `session.update` on
  each document change. In the same listener, it dispatches `setDiagnostics`
  from `@codemirror/lint` with the diagnostics of the active file. After each
  `view.setState`, the page dispatches `setDiagnostics` again from the latest
  result, because a cross-file edit can change another file. Do not use
  `linter`.
- On an error result, dispatch `setDiagnostics` with an empty list, show the
  error region, and keep the generated text. Reason: old spans can point past
  the end of the changed document, and CodeMirror throws a `RangeError` for
  them.
- Hover: a `hoverTooltip` that calls `session.hover`. The tooltip shows the
  contract and the backend type as two labelled code blocks.
- The generated TypeScript pane is a second `EditorView` with
  `EditorState.readOnly.of(true)`, `EditorView.editable.of(false)`,
  `javascript({ typescript: true })`, `lineNumbers()`, and the same theme.

### 5.5 Page model (`model.ts`)

`model.ts` holds the page logic that needs no DOM, so fast tests cover it.

- `tabFromHash(hash, paths)`: the path in
  `decodeURIComponent(hash.slice(1))`, or `main.eff` when the hash is unknown.
  A nested path such as `host/providers.effi` is valid.
- `problemItems(result, texts)`: every diagnostic of every file, sorted by path
  and position. Each item has the path, the offsets, the one-based line and
  column from `lineStarts` and `positionOf` in `src/core/source.ts`, the code,
  and the message.
- `tabCounts(result)`: the error count of each path.
- `outputState(result, path)`: one of `{ tag: "text" }`, `{ tag: "stale" }`,
  `{ tag: "none" }`, or `{ tag: "interface" }` for an `.effi` path, with the
  text when it exists.
- `hoverLines(hit)`: the texts of the tooltip and of the cursor line.

## 6. Interface

### 6.1 Visual direction and contrast

The page uses the tokens of the `effective` site (`public/site.css` in the
sibling repository). The page is white with navy ink `#1f2b4d`. The accent is
orange `#f7941d`, and the code panes are `#141d34`. Display type is Bricolage
Grotesque. Code uses `ui-monospace`.

Copy the font file and its `OFL.txt` from the sibling repository into
`playground/fonts/`. The license names no reserved font name, so the copy is
allowed. Define the colors once as custom
properties in `app.css` and bind every rule to them.

Orange on white has a contrast of about 2.3:1, so orange is never text or an
outline on white. Use orange only as a fill under navy text, or as an outline
on the navy panes. The focus outline on white uses the navy ink. The error badge
of a tab is navy text on an orange fill. The error underline in the editor must
reach 3:1 against `#141d34`.

`editor.ts` exports one theme, `EditorView.theme({...}, { dark: true })`, bound
to the custom properties. `.cm-editor` has height 100%. `.cm-scroller` has the
overflow, so the editor scrolls and the page does not. The theme also covers
`.cm-content`,
`.cm-gutters`, `.cm-activeLine`, `.cm-activeLineGutter`,
`.cm-selectionBackground`, `.cm-cursor`, `.cm-tooltip`, `.cm-tooltip-lint`,
`.cm-lintRange-error`, `.cm-matchingBracket`, and `.cm-panels`.

### 6.2 Structure

- `header`: the name "Effective playground", a link to the book, and the status
  line with the compile time. The status line has no `aria-live`.
- `nav` with the file tabs: a `tablist` of `button` elements with `role="tab"`,
  arrow-key movement, and `aria-selected`. Each tab shows the error count of its
  file when it is above zero. The tablist scrolls inside itself with
  `overflow-x: auto`, and a focused tab scrolls into view.
- `main` with three `section` regions, each with an `h2`: Source, Problems,
  and TypeScript. Source holds the editor and the cursor line.
- Cursor line: it shows the hover text at the cursor and has
  `aria-live="polite"`. It updates only for transactions without a document
  change, only when its text changes, and only after a 300 ms pause. It is
  empty on the `.effi` tab, because `hoverAt` gives nothing there.
- Problems: the `h2` holds the count. An ordered list holds every diagnostic,
  from `problemItems`. Each item is a `button` with the text
  `path:line:column code message`. A click opens the file and places the cursor
  on the span. The list has no `aria-live`.
- TypeScript: the read-only pane for the `.eff` file of the active tab, with
  the states of section 6.5.

### 6.3 Responsive shape

The app shell is the viewport. So the page uses the viewport media query
`(min-width: 960px)` in CSS, and the script uses the same query through
`matchMedia`. Write the narrow layout as the base and add the wide layout with
`min-width` rules.

Narrow mode (below 960 pixels): a view switch `tablist` selects Source,
Problems, or TypeScript. The script sets `hidden` on the two inactive regions,
and it gives each region `role="tabpanel"` and `aria-labelledby`. The Problems
tab label shows the total count. A click on a Problems item also switches the
view to Source.

Wide mode (960 pixels and more): the script removes the view switch, `hidden`,
`role`, and `aria-labelledby`. Source is on the left. Problems is above
TypeScript on the right.

Use `100dvh` for the app shell and a font size of at least 16 pixels in the
editors.

### 6.4 URL state

The URL hash holds the active file, for example `#users.eff` or
`#host/providers.effi`. Load and `hashchange` select the tab through
`tabFromHash`. A tab click sets `location.hash`, so the browser Back button
moves through the tabs. Nothing else goes in the URL in this phase.

### 6.5 States

- Loading: before `app.js` runs, `index.html` shows a short loading line. A
  `noscript` element says that the playground needs JavaScript.
- Start failure: the fetch of `examples.json` fails, or the first update gives
  a configuration error. The page shows an error region with the reason and a
  reload link.
- No problems: the Problems region says "No problems".
- Stale output: a banner above the TypeScript pane says "This module has errors.
  This is the last good output." The pane keeps the last good text.
- No output yet: the pane says that the module has no output yet. This state
  needs a module that never compiled, so it is a fallback.
- Host interface tab: the pane says that a host interface file has no generated
  code.
- Error result after start: an error region with the message (5.4).
- Reduced motion: no animation runs when `prefers-reduced-motion` is set.

## 7. Browser review checks

Opus starts `deno task playground:serve` in the background, because a fetch of
`examples.json` fails on a `file:` URL. Then Opus checks each item in the
Playwright browser at both sizes:

1. The page loads with no console error, and the status line shows a compile
   time.
2. Every tab and button can be reached with Tab and works with Enter or Space.
   Arrow keys move between tabs. A visible focus outline shows on each.
3. An edit that adds `+ "x"` to a number in `users.eff` shows an underline, a
   Problems item, and an error count on the tab. Undo clears all three.
4. A Problems item opens its file and places the cursor on the span. In narrow
   mode, it also shows the Source view.
5. A hover on `rename` shows the contract and the backend type. With the cursor
   on `rename`, the cursor line shows the same contract.
6. A break in `users.eff` shows the stale banner and keeps the last good
   TypeScript. A repair removes the banner.
7. An edit in `host/providers.effi` that changes a provided service shows the
   new diagnostic on `main.eff` when its tab opens.
8. The hash selects the tab on load and on change, including
   `#host/providers.effi`.
9. At 375 pixels, the view switch shows one region at a time. The document has
   no horizontal scroll. The file tablist may scroll inside itself.
10. Text and controls meet WCAG AA contrast. Hit areas are at least 44 by 44
    pixels.

## 8. Build, serve, and checks

- `deno task playground:build` runs `playground/build.ts` with
  `--allow-read --allow-write --allow-run=deno`. `build.ts` takes the output
  directory as an argument, with the default `playground/dist`. It removes that
  directory first. It runs `deno bundle --platform browser --format esm
  --minify` on `playground/src/app.ts` with the repository root as `cwd`, so
  the import map applies. It writes `app.js`, copies `index.html`, `app.css`,
  and `fonts/`, writes `examples.json`, and prints the sizes. `deno bundle`
  prints an "experimental" note on stderr, so stderr is not a failure.
- `deno task playground:serve` builds, then serves the output directory with
  `serveDir` from `@std/http` and
  `Deno.serve({ hostname: "127.0.0.1", port: 8790 })`. Its permissions are the
  build permissions plus `--allow-net=127.0.0.1:8790`.
- Add these imports to `deno.json` with exact versions: `codemirror` 6.0.2,
  `@codemirror/view` 6.43.14, `@codemirror/state` 6.7.6, `@codemirror/lint`
  6.9.7, `@codemirror/language` 6.13.1, `@codemirror/commands` 6.11.1,
  `@codemirror/lang-javascript` 6.2.5, and `@std/http` 1.1.3. Commit the changes
  to `deno.lock`. After the change, `deno info` must still show one version of
  each `@codemirror/*` package.
- The browser files start with `/// <reference lib="dom" />`. Add
  `'playground/**/*.ts'` to the type-check list of the `check` task.
- Ignore `playground/dist/` in git, `deno fmt`, and `deno lint`. `deno fmt`
  checks `index.html` and `app.css`. Update the README section "Format and lint
  scope".
- `tests/playground_build_slow_test.ts` runs the build into a temporary
  directory and checks the six outputs. It sets no size limit, because no
  budget exists.

## 9. Parts and dispatch order

Each part is one Sonnet dispatch and one commit. Opus reviews each diff line by
line and runs the acceptance commands before the next dispatch.

| Part | Content | Depends on | Acceptance |
| --- | --- | --- | --- |
| G1 | `compile.ts`, `highlight.ts`, `model.ts`, and their fast tests | none | Facade: clean examples; an error and its offsets; stale output and its repair; a cross-file edit from `host/providers.effi`; hover with backend; a config error; an internal error through a throwing `ProgramPort` double; a fake clock. Highlighter: every row of the table in 5.3, including `error` as a name. Model: every function of 5.5 |
| G2a | `build.ts`, `serve.ts`, tasks, imports, ignores, fonts, `examples.json`, the slow build test, and a walking skeleton: `index.html` and an `app.ts` that mounts one editor over the facade | G1 | `deno task check`; the build prints sizes; the page loads in the Playwright browser with no console error |
| G2b | `editor.ts` (theme, highlight, diagnostics, hover), the full `app.ts`, `app.css`, and `index.html` | G2a | `deno task check`; the page shows three regions and a compile time in the Playwright browser |
| G3 | Browser review by Opus with section 7. Fixes go back to Sonnet with the findings | G2b | Every item of section 7 passes at both sizes; screenshots in `demos/` |
| G4 | README section "Playground", design doc status line | G3 | STE checker passes; `deno task check` passes |

## 10. Risks

| Risk | Signal | Response |
| --- | --- | --- |
| The main thread stalls on a large edit | The status line shows a high compile time | Keep it; the examples are small. A Worker is a later decision with a measurement |
| `deno bundle` cannot bundle a package | Build error | Report the package and the error; do not change bundlers without the user |
| Two versions of `@codemirror/state` | CodeMirror throws "Unrecognized extension value" | Pin exact versions; check `deno info` |
| Old spans after an error | `RangeError` in the console | Clear the diagnostics on an error result (5.4) |
| The tokens of the site change later | The page and the site look different after publication | Publication is a separate step; it compares the tokens then |

## 11. Validation record

Fable validated the first draft on 2026-10-16 with probes in `/tmp/pg-probe`.

| Finding | Severity | Resolution |
| --- | --- | --- |
| 1 Old spans after an internal error break CodeMirror | Major | 5.1 and 5.4: clear diagnostics, no hover until a good update |
| 2 `linter` is pull-based and keeps old results per state | Major | 5.4: `setDiagnostics` push, again after `setState` |
| 3 No dark theme; base theme fails contrast | Major | 6.1: one dark theme; 5.4: `minimalSetup` and named extensions |
| 4 Container query cannot drive `hidden`; ARIA mismatch; tabs overflow | Major | 6.3: viewport query and `matchMedia`; 6.2: scrolling tablist |
| 5 Three result shapes; no throwing input for the test | Major | 5.1: `Result` with `PlaygroundError`; `ProgramPort` double |
| 6 Contextual words are names in the lexer | Minor | 5.3: table of kinds with position rules |
| 7 `readOnly` value | Minor | 5.4: `readOnly.of(true)`, `editable.of(false)` |
| 8 `aria-live` on every cursor move | Minor | 6.2: change-only, 300 ms pause, no live status |
| 9 Orange fails contrast on white | Minor | 6.1: orange as fill or on navy only |
| 10 Build directory, `cwd`, stderr, permissions, fmt of HTML and CSS | Minor | 8 |
| 11 Exact versions; bundle size with `lang-javascript` | Minor | 2 and 8 |
| 12 Nested hash path; history; empty hover on `.effi` | Minor | 6.4 and 6.2 |
| 13 Unreachable states | Minor | 6.5: fallbacks; start failure covers a config error |
| 14 G2 is not testable without a browser; output key | Major in effect | 5.5 `model.ts` in G1; 5.1 output key |
| 15 G2 is too large | Major | 9: G2a and G2b |
| 16 Two long sentences | Minor | Rewritten |
