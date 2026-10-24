# Playground automated acceptance — 2026-10-21

The browser acceptance run passed at **375, 720 and 1280 CSS pixels**, each with a 900-pixel viewport height and device scale factor 1. No playground source changes were needed.

This record covers automated browser behavior and screenshot inspection. It is separate from the user's manual release acceptance. It does not claim a full WCAG audit or screen-reader, touch-device, Safari or Firefox acceptance.

## Environment and workflow

- Deno 2.9.7; Node 24.21.0; macOS arm64.
- Google Chrome 156.0.8078.47, launched headlessly from `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` through Playwright 1.64.1.
- Existing task: `deno task playground:serve`. The task built the current working tree, then served `http://127.0.0.1:8790/`. Build output: 818,373 JavaScript bytes, 252,436 bytes after gzip.
- Browser harness: `node /tmp/effektive-playground-review.mjs`. It used an existing temporary Playwright installation; no repository dependency changed. Each width used a fresh browser page and the bundled example project. Source edits occurred only in the browser.
- [Machine-readable evidence](release-assets/playground-review.json) records browser/build identity, generated asset SHA-256 values, viewport/panel geometry, keyboard focus traversal, diagnostics, assertions and screenshot names. The final rerun used the frozen release source after the boundary follow-up. The Git HEAD identifies the base; the build included the uncommitted integration and measurement work.

For each viewport, the harness loaded `main.eff`, checked page and panel geometry, drove file tabs with End/Home/ArrowRight, and used Tab to reach the labelled source editor. At 375 pixels it also moved between Source, Problems and TypeScript with the view-tab arrow keys and Home. It captured the final file tab with a visible keyboard focus outline and verified that horizontal tab scrolling brought the focused tab into view.

The harness changed `displayName("u1")` to `displayName(1)` using keyboard input. All widths reported `main.eff:6:40 type-mismatch/003 argument 1 has type int, but UserId is expected`. It verified that the TypeScript pane retained the prior `displayName("u1")` output with a stale banner. Keyboard activation of the diagnostic returned focus to its source location. Restoring the original source cleared the diagnostic and stale state.

It then replaced the source with `export const main = (`. All widths reported `main.eff:1:22 syntax/008 expected an expression, found end of file`, retained the last good output, and recovered after restoring the original program. The generated editor was read-only. No browser page errors or error-level console messages occurred.

## Results

| Width | Layout | Overflow | Keyboard and diagnostics | Evidence |
| --- | --- | --- | --- | --- |
| 375 | One panel with Source/Problems/TypeScript view tabs | Document and body widths both 375; file tabs scroll inside their own container | File and view keys, source Tab access, diagnostic activation, type/syntax error recovery passed | [Ready](release-assets/playground-375-ready.png), [keyboard focus](release-assets/playground-375-keyboard-files.png), [TypeScript](release-assets/playground-375-output.png), [type error](release-assets/playground-375-error.png), [stale output](release-assets/playground-375-stale-output.png), [syntax error](release-assets/playground-375-syntax-error.png), [recovered](release-assets/playground-375-recovered.png) |
| 720 | Source left; Problems above TypeScript right | Document and body widths both 720; narrow column text wraps and pane content scrolls | File keys, source Tab access, diagnostic activation, type/syntax error recovery passed | [Ready](release-assets/playground-720-ready.png), [keyboard focus](release-assets/playground-720-keyboard-files.png), [type error](release-assets/playground-720-error.png), [syntax error](release-assets/playground-720-syntax-error.png), [recovered](release-assets/playground-720-recovered.png) |
| 1280 | Source left; Problems above TypeScript right | Document and body widths both 1280 | File keys, source Tab access, diagnostic activation, type/syntax error recovery passed | [Ready](release-assets/playground-1280-ready.png), [keyboard focus](release-assets/playground-1280-keyboard-files.png), [type error](release-assets/playground-1280-error.png), [syntax error](release-assets/playground-1280-syntax-error.png), [recovered](release-assets/playground-1280-recovered.png) |

Screenshot inspection confirmed readable error rows, wrapping stale-output banners, visible tab/editor focus outlines, and retained generated code. At the exact 720-pixel breakpoint, all three regions remain available; the TypeScript pane uses its own scroll area for output beyond the viewport. No blocking layout or recovery defect was found in these scenarios.

The user's manual acceptance remains pending. These automated results supply evidence for that decision without recording it as completed.
