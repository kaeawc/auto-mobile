import { observationOfPayload } from "../utils/toolUtils";
import type { ObserveResult, DisplayObservation } from "../models/ObserveResult";
import {
  sanitizeObserveResult,
  projectSanitizedObserveSkeleton,
  type SanitizeObserveConfig,
  type ObserveResultCloner,
} from "../features/observe/output/ObserveResultOutput";
import {
  applyObserveScopeExperiments,
  applyObserveScopeToSkeleton,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import { capLayoutWarnings } from "../features/observe/audits/SafeAreaAuditor";

interface ObservationDisplayRenderingOptions {
  cfg: SanitizeObserveConfig;
  scopeActive: boolean;
  scopeConfig: ReturnType<typeof buildObserveScopeConfig>;
  cloneObservation?: ObserveResultCloner;
  resolveProjection: () => "full" | "skeleton";
}

/** Output-only projection and scoping for the headline observe result and its display panels. */
export class ObservationDisplayRenderer {
  static displayMetadata(state: DisplayMetadataState) {
    const { ctx, payload } = state;
    const renderedObservation = observationOfPayload(ctx.name, payload);
    const renderedDisplayKey = isObserveResult(renderedObservation)
      ? renderedObservation.display?.key
      : undefined;
    const renderedDisplayGeneration = isObserveResult(renderedObservation)
      ? renderedObservation.display?.generation
      : undefined;
    const renderedDisplayRevision = this.displayRevisionFor(renderedObservation, state);
    return {
      revision: renderedDisplayRevision,
      key: renderedDisplayKey,
      generation: renderedDisplayGeneration,
    };
  }

  private static displayRevisionFor(
    renderedObservation: unknown,
    state: DisplayMetadataState,
  ): number | undefined {
    const { ctx, isObserveTool, noObserveEnabled } = state;
    const renderedDisplayRevision =
      !ctx.internal &&
      !(isObserveTool && ctx.args?.display === "all") &&
      (isObserveTool || !noObserveEnabled) &&
      isObserveResult(renderedObservation) &&
      typeof renderedObservation.displayRevision === "number"
        ? renderedObservation.displayRevision
        : undefined;
    return renderedDisplayRevision;
  }

  constructor(private readonly options: ObservationDisplayRenderingOptions) {}
  render(
    observeResult: ObserveResult,
    uncapped: ObserveResult,
    sanitized: ObserveResult,
  ): ObserveResult {
    const { scopeActive, scopeConfig } = this.options;
    let served: ObserveResult = sanitized;
    if (this.options.resolveProjection() === "skeleton") {
      served = projectSanitizedObserveSkeleton(sanitized, observeResult);
      // Skeleton replaces the hierarchy, so FOCUS/REGION run on the full uncapped
      // tree and the skeleton keeps only the rows that survive them.
      if (scopeActive) {
        served = applyObserveScopeToSkeleton(served, uncapped, scopeConfig);
      }
    } else if (scopeActive) {
      // Scope-then-cap (#5074): use the already-sanitized UNCAPPED copy so the scope
      // transforms see every warning, then cap the scoped result — an in-scope
      // warning is never lost to a cap taken against the full tree. The baseline
      // above stays the capped `sanitized` full tree.
      served = applyObserveScopeExperiments(uncapped, scopeConfig);
      // A no-op scope returns its input. Keep subsequent output-only metadata
      // off the cached baseline when capped and uncapped are the same object.
      if (served === uncapped) {
        served = { ...served };
      }
      if (served.layoutWarnings) {
        served.layoutWarnings = capLayoutWarnings(served.layoutWarnings);
      }
    }
    served = this.renderDisplayPanels(served, observeResult);
    return served;
  }

  private renderDisplayPanels(served: ObserveResult, observeResult: ObserveResult): ObserveResult {
    if (observeResult.displays) {
      served = {
        ...served,
        displays: observeResult.displays.map((entry) => {
          return this.renderDisplayPanel(entry, observeResult);
        }),
      };
    }
    return served;
  }

  private renderDisplayPanel(
    entry: DisplayObservation,
    observeResult: ObserveResult,
  ): DisplayObservation {
    const { cfg, scopeActive, scopeConfig, cloneObservation } = this.options;
    const source: ObserveResult = {
      observationId: observeResult.observationId,
      updatedAt: observeResult.updatedAt,
      ...entry,
      systemInsets: entry.systemInsets ?? observeResult.systemInsets,
    };
    let panel = sanitizeObserveResult(source, cfg, cloneObservation);
    if (this.options.resolveProjection() === "skeleton") {
      const projected = projectSanitizedObserveSkeleton(panel, source);
      panel = scopeActive ? applyObserveScopeToSkeleton(projected, panel, scopeConfig) : projected;
    } else if (scopeActive) {
      panel = applyObserveScopeExperiments(panel, scopeConfig);
    }
    return {
      display: panel.display,
      screenSize: panel.screenSize,
      freshness: entry.freshness,
      ...copyDefinedFields(panel, [
        "importedPrototypeContent",
        "viewHierarchy",
        "skeleton",
        "context",
        "keyboard",
        "truncationReasons",
        "windowTruncations",
        "screenshotPath",
        "screenshotExpiresAt",
        "observeScope",
      ]),
    } satisfies DisplayObservation;
  }
}

/**
 * Copy only defined fields so absent metadata remains absent from the emitted
 * diff and serializes exactly as it does in full mode.
 */
export function copyDefinedFields<T extends object, K extends keyof T>(
  source: T,
  fields: readonly K[],
): Partial<Pick<T, K>> {
  const metadata: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) {
      Object.assign(metadata, { [field]: value });
    }
  }
  return metadata;
}

interface DisplayMetadataState {
  ctx: { name: string; internal?: boolean; args?: Record<string, unknown> };
  payload: Record<string, unknown>;
  isObserveTool: boolean;
  noObserveEnabled: boolean;
}

/**
 * A value is treated as an `ObserveResult` for sanitization purposes when it is
 * an object carrying observe-specific fields. Hierarchy collection can fail
 * while the rest of observe still completes, so `viewHierarchy` is only one
 * marker; debug-perf fields on hierarchy-less observations must still be
 * stripped at the wire boundary.
 */
const OBSERVE_RESULT_MARKERS: ReadonlyArray<string> = [
  "updatedAt",
  "screenSize",
  "systemInsets",
  "viewHierarchy",
  "rawViewHierarchy",
  "elements",
  "perfTiming",
  "perfTimingTruncated",
  "gfxMetrics",
  "performanceAudit",
  "accessibilityAudit",
  "freshness",
];

export function isObserveResult(value: unknown): value is ObserveResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return OBSERVE_RESULT_MARKERS.some((key) => key in record);
}
