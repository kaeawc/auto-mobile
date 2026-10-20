import { readFileSync } from "node:fs";
import path from "node:path";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { observeResultSchema, viewHierarchyResultSchema } from "../../src/server/toolOutputSchemas";

const FIXTURES_DIR = import.meta.dir;

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, relativePath), "utf8"));
}

/**
 * Older captures serialize absent optional fields as `null`; the wire contract omits them (see
 * `normalizeHierarchyOptionalFields`). Drop them so the capture is checked against the contract.
 */
function omitNullFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
}

function omitObservationNulls(value: unknown): unknown {
  const top = omitNullFields(value);
  if (typeof top !== "object" || top === null || !("viewHierarchy" in top)) {
    return top;
  }
  return { ...top, viewHierarchy: omitNullFields(top.viewHierarchy) };
}

function assertObserveResult(value: unknown): asserts value is ObserveResult {
  // Captures are committed device output: validate the wire shape instead of trusting it.
  observeResultSchema.parse(value);
}

function assertViewHierarchyResult(value: unknown): asserts value is ViewHierarchyResult {
  viewHierarchyResultSchema.required({ hierarchy: true }).parse(value);
}

/** A committed `ObserveResult` capture under `test/fixtures`, checked against the wire schema. */
export function readCapturedObservation(relativePath: string): ObserveResult {
  const captured = omitObservationNulls(readJson(relativePath));
  assertObserveResult(captured);
  return captured;
}

/** A committed `ViewHierarchyResult` capture under `test/fixtures`, checked against the wire schema. */
export function readCapturedHierarchy(relativePath: string): ViewHierarchyResult {
  const captured = omitNullFields(readJson(relativePath));
  assertViewHierarchyResult(captured);
  return captured;
}
