/// <reference lib="dom" />
// The playground page (plan 5.4, 6.2 to 6.5). It fetches `examples.json`,
// starts the compile facade, and wires the file tabs, the three regions, the
// source editor, the Problems list, the TypeScript pane, and the URL hash.
// The DOM-free logic lives in `model.ts`. The CodeMirror parts live in
// `editor.ts`.

import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  createPlayground,
  type PlaygroundError,
  type PlaygroundResult,
} from "./compile.ts";
import {
  outputExtensions,
  showDiagnostics,
  sourceExtensions,
} from "./editor.ts";
import {
  DEFAULT_TAB,
  hoverLines,
  outputState,
  type ProblemItem,
  problemItems,
  tabCounts,
  tabFromHash,
} from "./model.ts";

/** The file that holds the project configuration. It is not a tab. */
const CONFIG_FILE = "effective.json";

/** The pause before the cursor line changes, in milliseconds. */
const CURSOR_PAUSE_MS = 300;

/** The width at which the wide layout starts. `app.css` uses the same value. */
const WIDE_QUERY = "(min-width: 720px)";

type ViewName = "source" | "problems" | "output";

const VIEW_NAMES: readonly ViewName[] = ["source", "problems", "output"];

const REGION_IDS: Readonly<Record<ViewName, string>> = {
  source: "source-region",
  problems: "problems-region",
  output: "output-region",
};

type CompileResult =
  | { readonly ok: true; readonly value: PlaygroundResult }
  | { readonly ok: false; readonly error: PlaygroundError };

type LoadResult =
  | { readonly ok: true; readonly files: Record<string, string> }
  | { readonly ok: false; readonly message: string };

function isTextRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

/** A missing element is a programming error, so it throws. */
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

async function loadExamples(): Promise<LoadResult> {
  try {
    const response = await fetch("examples.json");
    if (!response.ok) {
      return {
        ok: false,
        message: `examples.json: ${response.status} ${response.statusText}`,
      };
    }
    const data: unknown = await response.json();
    if (!isTextRecord(data)) {
      return { ok: false, message: "examples.json: unexpected content" };
    }
    if (!(DEFAULT_TAB in data)) {
      return { ok: false, message: `examples.json: missing ${DEFAULT_TAB}` };
    }
    return { ok: true, files: data };
  } catch (error) {
    return {
      ok: false,
      message: `examples.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function errorText(error: PlaygroundError): string {
  switch (error.tag) {
    case "config":
      return `Configuration error: ${error.message}`;
    case "internal":
      return `Internal error: ${error.message}`;
  }
}

/** The tabs of `list`, in document order. */
function tabsOf(list: HTMLElement): HTMLButtonElement[] {
  return Array.from(list.querySelectorAll<HTMLButtonElement>("[role=tab]"));
}

/** Marks `selected` as the one tab with `aria-selected` and `tabindex` 0. */
function markSelected(list: HTMLElement, selected: HTMLElement): void {
  for (const tab of tabsOf(list)) {
    const isSelected = tab === selected;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }
}

/**
 * Wires click, the arrow keys, Home, End, and scroll-into-view for a tablist.
 * `activate` runs for a click and for each key that moves the focus.
 */
function wireTablist(
  list: HTMLElement,
  activate: (tab: HTMLButtonElement) => void,
): void {
  const tabFrom = (
    target: EventTarget | null,
  ): HTMLButtonElement | undefined => {
    if (!(target instanceof Element)) return undefined;
    const found = target.closest<HTMLButtonElement>("[role=tab]");
    return found !== null && list.contains(found) ? found : undefined;
  };
  list.addEventListener("click", (event) => {
    const tab = tabFrom(event.target);
    if (tab !== undefined) activate(tab);
  });
  list.addEventListener("focusin", (event) => {
    tabFrom(event.target)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  });
  list.addEventListener("keydown", (event) => {
    const tabs = tabsOf(list);
    const current = tabFrom(event.target);
    if (current === undefined) return;
    const index = tabs.indexOf(current);
    const last = tabs.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[next];
    target.focus();
    activate(target);
  });
}

function makeTab(id: string, label: string): HTMLButtonElement {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.id = id;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
  tab.tabIndex = -1;
  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = label;
  tab.append(name);
  return tab;
}

async function main(): Promise<void> {
  const status = element("status");
  const loading = element("loading");
  const errorRegion = element("error-region");
  const errorMessage = element("error-message");
  const reload = element("reload");
  const filesNav = element("files");
  const fileTabs = element("file-tabs");
  const viewsNav = element("views");
  const app = element("app");
  const sourcePane = element("source-pane");
  const cursorLine = element("cursor-line");
  const problemsTitle = element("problems-title");
  const problemsList = element("problems");
  const noProblems = element("no-problems");
  const staleBanner = element("stale-banner");
  const outputMessage = element("output-message");
  const outputPane = element("output-pane");
  const regions: Readonly<Record<ViewName, HTMLElement>> = {
    source: element(REGION_IDS.source),
    problems: element(REGION_IDS.problems),
    output: element(REGION_IDS.output),
  };

  function showFailure(message: string): void {
    loading.hidden = true;
    errorMessage.textContent = message;
    reload.hidden = false;
    errorRegion.hidden = false;
    status.textContent = "";
  }

  const examples = await loadExamples();
  if (!examples.ok) {
    showFailure(`The playground could not start. ${examples.message}`);
    return;
  }
  const files = examples.files;
  const paths = Object.keys(files).filter((path) => path !== CONFIG_FILE);
  const session = createPlayground(files, { now: () => performance.now() });
  const first = session.start();
  if (!first.ok) {
    showFailure(
      `The playground could not start. ${errorText(first.error)}`,
    );
    return;
  }

  let latest: PlaygroundResult = first.value;
  let active = tabFromHash(location.hash, paths);
  let currentView: ViewName = "source";
  let narrow = false;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  let outputPath: string | undefined;
  const texts: Record<string, string> = { ...files };
  const states = new Map<string, EditorState>();
  const fileButtons = new Map<string, HTMLButtonElement>();
  const badges = new Map<string, HTMLElement>();
  const viewTabs = new Map<ViewName, HTMLButtonElement>();
  let problemCount = 0;

  function showError(message: string): void {
    errorMessage.textContent = message;
    reload.hidden = true;
    errorRegion.hidden = false;
  }

  function clearError(): void {
    errorRegion.hidden = true;
    errorMessage.textContent = "";
  }

  // The source editor and its states. A state exists for each file so that
  // the undo history and the cursor stay with the file.

  const extensions = sourceExtensions({
    hover: (offset) => session.hover(active, offset),
    onUpdate: (update: ViewUpdate) => {
      if (update.docChanged) {
        clearTimeout(cursorTimer);
        const text = update.state.doc.toString();
        texts[active] = text;
        applyResult(session.update(active, text));
      } else if (update.selectionSet) {
        scheduleCursorLine();
      }
    },
  });
  for (const path of paths) {
    states.set(path, EditorState.create({ doc: files[path], extensions }));
  }
  const sourceState = states.get(active);
  if (sourceState === undefined) throw new Error(`no state for ${active}`);
  const sourceView = new EditorView({ state: sourceState, parent: sourcePane });
  const outputView = new EditorView({
    state: EditorState.create({ doc: "", extensions: outputExtensions() }),
    parent: outputPane,
  });

  // The cursor line shows the contract at the cursor, after a pause.

  function refreshCursorLine(): void {
    const text = active.endsWith(".effi") ? "" : hoverLines(
      session.hover(active, sourceView.state.selection.main.head),
    ).cursor;
    if (text !== cursorLine.textContent) cursorLine.textContent = text;
  }

  function scheduleCursorLine(): void {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(refreshCursorLine, CURSOR_PAUSE_MS);
  }

  // The file tabs.

  for (const path of paths) {
    const tab = makeTab(`file-tab-${fileButtons.size}`, path);
    tab.dataset.path = path;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.hidden = true;
    tab.append(badge);
    fileTabs.append(tab);
    fileButtons.set(path, tab);
    badges.set(path, badge);
  }
  wireTablist(fileTabs, (tab) => {
    const path = tab.dataset.path;
    if (path !== undefined) goTo(path);
  });

  function renderFileTabs(): void {
    const counts = tabCounts(latest);
    for (const [path, badge] of badges) {
      const count = counts[path] ?? 0;
      badge.hidden = count === 0;
      if (count === 0) {
        badge.replaceChildren();
        continue;
      }
      badge.replaceChildren(
        String(count),
        Object.assign(document.createElement("span"), {
          className: "sr-only",
          textContent: ` ${count === 1 ? "error" : "errors"}`,
        }),
      );
    }
    const button = fileButtons.get(active);
    if (button !== undefined) markSelected(fileTabs, button);
  }

  /** Scrolls the tab of the active file into view inside its tablist. */
  function revealActiveTab(): void {
    fileButtons.get(active)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }

  // The Problems region.

  function renderProblems(): void {
    const items = problemItems(latest, texts);
    problemsTitle.textContent = `Problems (${items.length})`;
    noProblems.hidden = items.length > 0;
    problemsList.hidden = items.length === 0;
    problemsList.replaceChildren(...items.map(problemElement));
    problemCount = items.length;
    updateProblemsLabel();
  }

  function problemElement(item: ProblemItem): HTMLElement {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "problem";
    button.dataset.severity = item.severity;
    const where = document.createElement("span");
    where.className = "problem-where";
    where.textContent = `${item.path}:${item.line}:${item.column}`;
    const code = document.createElement("span");
    code.className = "problem-code";
    code.textContent = item.code;
    button.append(where, " ", code, " ", item.message);
    button.addEventListener("click", () => openProblem(item));
    li.append(button);
    return li;
  }

  function openProblem(item: ProblemItem): void {
    goTo(item.path);
    if (narrow) setView("source");
    const length = sourceView.state.doc.length;
    sourceView.dispatch({
      selection: { anchor: Math.min(item.from, length) },
      effects: EditorView.scrollIntoView(Math.min(item.from, length), {
        y: "center",
      }),
    });
    sourceView.focus();
  }

  // The TypeScript region.

  function renderOutput(): void {
    const state = outputState(latest, active);
    staleBanner.hidden = state.tag !== "stale";
    switch (state.tag) {
      case "text":
      case "stale":
        outputMessage.hidden = true;
        outputPane.hidden = false;
        setOutputText(state.text);
        break;
      case "none":
        showOutputMessage("This module has no output yet.");
        break;
      case "interface":
        showOutputMessage("A host interface file has no generated code.");
        break;
    }
  }

  function showOutputMessage(message: string): void {
    outputPane.hidden = true;
    outputMessage.hidden = false;
    outputMessage.textContent = message;
    outputPath = undefined;
  }

  function setOutputText(text: string): void {
    const doc = outputView.state.doc;
    if (doc.toString() !== text) {
      outputView.dispatch({
        changes: { from: 0, to: doc.length, insert: text },
      });
    }
    if (outputPath !== active) {
      outputPath = active;
      outputView.dispatch({ effects: EditorView.scrollIntoView(0) });
    }
    outputView.requestMeasure();
  }

  // Results of the facade.

  function applyResult(result: CompileResult): void {
    if (!result.ok) {
      showError(errorText(result.error));
      showDiagnostics(sourceView, []);
      return;
    }
    clearError();
    latest = result.value;
    status.textContent = `compiled in ${latest.elapsedMs.toFixed(1)} ms`;
    renderFileTabs();
    renderProblems();
    renderOutput();
    showDiagnostics(sourceView, latest.diagnostics[active] ?? []);
  }

  // The active file and the URL hash.

  function selectFile(path: string): void {
    if (path === active) return;
    clearTimeout(cursorTimer);
    states.set(active, sourceView.state);
    active = path;
    const state = states.get(path);
    if (state === undefined) throw new Error(`no state for ${path}`);
    sourceView.setState(state);
    renderFileTabs();
    revealActiveTab();
    renderOutput();
    showDiagnostics(sourceView, latest.diagnostics[path] ?? []);
    scheduleCursorLine();
  }

  /** Opens `path` through the hash, so the Back button moves between tabs. */
  function goTo(path: string): void {
    if (location.hash !== `#${path}`) location.hash = path;
    selectFile(path);
  }

  globalThis.addEventListener("hashchange", () => {
    selectFile(tabFromHash(location.hash, paths));
  });

  // The narrow layout: a switch between the three regions.

  function viewLabel(name: ViewName): string {
    switch (name) {
      case "source":
        return "Source";
      case "problems":
        return `Problems (${problemCount})`;
      case "output":
        return "TypeScript";
    }
  }

  function updateProblemsLabel(): void {
    const label = viewTabs.get("problems")?.querySelector(".tab-name");
    if (label !== null && label !== undefined) {
      label.textContent = viewLabel("problems");
    }
  }

  function setView(name: ViewName): void {
    currentView = name;
    for (const view of VIEW_NAMES) {
      const region = regions[view];
      region.hidden = view !== name;
      region.setAttribute("role", "tabpanel");
      region.setAttribute("aria-labelledby", `view-tab-${view}`);
    }
    const tab = viewTabs.get(name);
    if (tab !== undefined) markSelected(viewsNav, tab);
    sourceView.requestMeasure();
    outputView.requestMeasure();
  }

  function enterNarrow(): void {
    narrow = true;
    const list = document.createElement("div");
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-label", "Views");
    list.id = "view-tabs";
    viewTabs.clear();
    for (const name of VIEW_NAMES) {
      const tab = makeTab(`view-tab-${name}`, viewLabel(name));
      viewTabs.set(name, tab);
      list.append(tab);
    }
    wireTablist(list, (tab) => {
      const name = VIEW_NAMES.find((view) => `view-tab-${view}` === tab.id);
      if (name !== undefined) setView(name);
    });
    viewsNav.replaceChildren(list);
    viewsNav.hidden = false;
    setView(currentView);
  }

  function enterWide(): void {
    narrow = false;
    viewTabs.clear();
    viewsNav.replaceChildren();
    viewsNav.hidden = true;
    for (const view of VIEW_NAMES) {
      const region = regions[view];
      region.hidden = false;
      region.removeAttribute("role");
      region.removeAttribute("aria-labelledby");
    }
    sourceView.requestMeasure();
    outputView.requestMeasure();
  }

  const wideQuery = globalThis.matchMedia(WIDE_QUERY);
  function applyMode(): void {
    if (wideQuery.matches) enterWide();
    else enterNarrow();
  }
  wideQuery.addEventListener("change", applyMode);

  // Start.

  status.textContent = `compiled in ${latest.elapsedMs.toFixed(1)} ms`;
  applyMode();
  renderFileTabs();
  filesNav.hidden = false;
  revealActiveTab();
  renderProblems();
  renderOutput();
  showDiagnostics(sourceView, latest.diagnostics[active] ?? []);
  loading.hidden = true;
  app.hidden = false;
  sourceView.requestMeasure();
  outputView.requestMeasure();
  scheduleCursorLine();
}

await main();
