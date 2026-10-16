// The Serialization area (spec, "Equations and validation"): sets are sorted
// and unique, literals are finite, and source spans refer to supplied text.
// The walk reads the whole module as plain data, so it finds every set, number,
// and span, whichever node holds it.
//
// A span in an import payload belongs to the imported module. Its source is
// not one of `ir.sources`. The walk checks such a span against the text only
// when the caller supplies that text.

import type { ModuleIR, Span } from "../ir.ts";
import { AREA, type Report } from "./report.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSortedUnique(items: readonly unknown[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "string") return false;
    const previous = items[i - 1];
    if (i > 0 && typeof previous === "string" && previous >= item) return false;
  }
  return true;
}

function asSpan(value: unknown): Span | undefined {
  if (
    isRecord(value) && typeof value.source === "string" &&
    typeof value.start === "number" && typeof value.end === "number"
  ) {
    return { source: value.source, start: value.start, end: value.end };
  }
  return undefined;
}

export function checkSerialization(
  ir: ModuleIR,
  sources: ReadonlyMap<string, string>,
  report: Report,
): void {
  const fallback: Span = {
    source: ir.sources[0] ?? ir.module,
    start: 0,
    end: 0,
  };
  const own = new Set<string>(ir.sources);
  if (ir.format !== "light-functional-ir" || ir.version !== 1) {
    report.add(
      AREA.serialization,
      "format",
      `expected the format light-functional-ir version 1, recorded ${
        String(ir.format)
      } version ${String(ir.version)}`,
      fallback,
    );
  }
  ir.sources.forEach((source, i) => {
    if (!sources.has(source)) {
      report.add(
        AREA.serialization,
        `sources[${i}]`,
        `the source ${source} is not among the supplied source texts`,
        fallback,
      );
    }
  });

  const checkSpan = (
    span: Span,
    path: string,
    payload: boolean,
  ): void => {
    const fail = (what: string): void =>
      report.add(AREA.serialization, path, what, span);
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
      fail("a span has integer offsets");
      return;
    }
    if (span.start < 0 || span.end < span.start) {
      fail(
        `a span needs 0 <= start <= end, recorded ${span.start}..${span.end}`,
      );
      return;
    }
    const text = sources.get(span.source);
    if (!payload) {
      if (!own.has(span.source)) {
        fail(
          `the source ${span.source} is not listed in the sources of the module`,
        );
        return;
      }
      if (text === undefined) {
        fail(
          `the source ${span.source} is not among the supplied source texts`,
        );
        return;
      }
    }
    if (text !== undefined && span.end > text.length) {
      fail(
        `the span ${span.start}..${span.end} ends after the end of ${span.source}, which has ${text.length} code units`,
      );
    }
  };

  const walk = (
    value: unknown,
    path: string,
    payload: boolean,
    current: Span,
  ): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        report.add(
          AREA.serialization,
          path,
          `a number must be finite, recorded ${value}`,
          current,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, payload, current));
      return;
    }
    if (!isRecord(value)) return;
    const nodeSpan = asSpan(value.span);
    const here = nodeSpan ?? current;
    for (const key of Object.keys(value)) {
      const child = value[key];
      const at = path === "" ? key : `${path}.${key}`;
      if (
        (key === "failures" || key === "requirements") &&
        Array.isArray(child) &&
        !isSortedUnique(child)
      ) {
        report.add(
          AREA.serialization,
          at,
          `an effect set is sorted and unique, recorded [${child.join(", ")}]`,
          here,
        );
      }
      if (key === "span") {
        const span = asSpan(child);
        if (span === undefined) {
          report.add(
            AREA.serialization,
            at,
            "a span has a source and two offsets",
            here,
          );
        } else {
          checkSpan(span, at, payload);
        }
        continue;
      }
      walk(child, at, payload || (path === "" && key === "imports"), here);
    }
  };
  walk(ir, "", false, fallback);
}
