import type { FailureObservationSummary } from "../../models/FailureObservation";

/**
 * Drop heavy hierarchy fields for `executePlan` debug when mode is `summary`.
 */
export function trimObservationForStepCapture(
  summary: FailureObservationSummary,
  mode: "summary" | "full",
): FailureObservationSummary {
  if (mode === "full") {
    return summary;
  }
  const out: FailureObservationSummary = { ...summary };
  delete out.viewHierarchy;
  delete out.rawViewHierarchy;
  return out;
}

const MAX_SAMPLES = 80;
const MAX_TEXT_LEN = 300;
const MAX_ID_LEN = 200;
const ELEMENT_BUCKETS = ["clickable", "text", "scrollable"] as const;

/**
 * Builds failure-observation payload from a full observe structured result.
 * Includes entire viewHierarchy / rawViewHierarchy plus compact element digests.
 */
export function summarizeObserveResultForFailure(
  raw: Record<string, unknown>,
): FailureObservationSummary {
  const capturedAtMs = Date.now();
  const texts = new Set<string>();
  const resourceIds = new Set<string>();

  // Legacy `elements` buckets first (still present on `project: "full"` / older
  // payloads), then the default skeleton projection's `skeleton` (actionable) and
  // `context` (static text) rows, which replaced them (#17308).
  collectElementSamples(raw.elements, texts, resourceIds);
  collectSkeletonSamples(raw.skeleton, texts, resourceIds);
  collectSkeletonSamples(raw.context, texts, resourceIds);

  return {
    capturedAtMs,
    activeWindow: raw.activeWindow,
    awaitTimeout: typeof raw.awaitTimeout === "boolean" ? raw.awaitTimeout : undefined,
    awaitedElement: raw.awaitedElement,
    accessibilityState: raw.accessibilityState,
    viewHierarchy: raw.viewHierarchy,
    rawViewHierarchy: raw.rawViewHierarchy,
    visibleTextsSample: [...texts].slice(0, MAX_SAMPLES),
    resourceIdsSample: [...resourceIds].slice(0, MAX_SAMPLES),
    observeError: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function collectElementSamples(
  elements: unknown,
  texts: Set<string>,
  resourceIds: Set<string>,
): void {
  if (!elements || typeof elements !== "object") {
    return;
  }
  const elObj = elements as Record<string, unknown>;
  for (const key of ELEMENT_BUCKETS) {
    const arr = elObj[key];
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const item of arr.slice(0, 80)) {
      if (!item || typeof item !== "object") {
        continue;
      }
      addElementSamples(item as Record<string, unknown>, texts, resourceIds);
      if (texts.size >= MAX_SAMPLES && resourceIds.size >= MAX_SAMPLES) {
        return;
      }
    }
  }
}

function collectSkeletonSamples(rows: unknown, texts: Set<string>, resourceIds: Set<string>): void {
  if (!Array.isArray(rows)) {
    return;
  }
  for (const row of rows) {
    if (texts.size >= MAX_SAMPLES && resourceIds.size >= MAX_SAMPLES) {
      return;
    }
    if (!row || typeof row !== "object") {
      continue;
    }
    const r = row as Record<string, unknown>;
    addText(r.label, texts);
    addText(r.sublabel, texts);
    addResourceId(r.elementId, resourceIds);
  }
}

function addElementSamples(
  e: Record<string, unknown>,
  texts: Set<string>,
  resourceIds: Set<string>,
): void {
  addText(e.text, texts);
  addResourceId(e.resourceId, resourceIds);
}

function addText(value: unknown, texts: Set<string>): void {
  if (typeof value !== "string" || texts.size >= MAX_SAMPLES) {
    return;
  }
  const t = value.trim();
  if (t.length > 0) {
    texts.add(t.length > MAX_TEXT_LEN ? `${t.slice(0, MAX_TEXT_LEN)}…` : t);
  }
}

function addResourceId(value: unknown, resourceIds: Set<string>): void {
  if (typeof value !== "string" || value.length === 0 || resourceIds.size >= MAX_SAMPLES) {
    return;
  }
  resourceIds.add(value.length > MAX_ID_LEN ? `${value.slice(0, MAX_ID_LEN)}…` : value);
}
