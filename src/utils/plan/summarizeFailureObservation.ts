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

  const elements = raw.elements;
  if (elements && typeof elements === "object") {
    const elObj = elements as Record<string, unknown>;
    let done = false;
    for (const key of ELEMENT_BUCKETS) {
      if (done) {
        break;
      }
      const arr = elObj[key];
      if (!Array.isArray(arr)) {
        continue;
      }
      for (const item of arr.slice(0, 80)) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const e = item as Record<string, unknown>;
        if (typeof e.text === "string") {
          const t = e.text.trim();
          if (t.length > 0) {
            texts.add(t.length > MAX_TEXT_LEN ? `${t.slice(0, MAX_TEXT_LEN)}…` : t);
          }
        }
        if (typeof e.resourceId === "string" && e.resourceId.length > 0) {
          const id =
            e.resourceId.length > MAX_ID_LEN
              ? `${e.resourceId.slice(0, MAX_ID_LEN)}…`
              : e.resourceId;
          resourceIds.add(id);
        }
        if (texts.size >= MAX_SAMPLES && resourceIds.size >= MAX_SAMPLES) {
          done = true;
          break;
        }
      }
    }
  }

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
