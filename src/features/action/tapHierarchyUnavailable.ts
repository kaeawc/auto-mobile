import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { logger } from "../../utils/logger";

/**
 * Why a tapOn search could not read the screen: the typed unavailable reason from the capture
 * (e.g. `service_recovering` while CtrlProxy rebinds), or `unknown` when no read carried one.
 */
export type TapHierarchyUnavailableReason = string;

/**
 * The unavailable reason of one hierarchy read, or undefined when the read carries a usable tree.
 * A read that carries any node or window is usable even if it also reports an error.
 */
export function tapHierarchyUnavailableReason(
  result: ViewHierarchyResult,
): TapHierarchyUnavailableReason | undefined {
  const hierarchy = result.hierarchy;
  if (!hierarchy || typeof hierarchy !== "object") {
    return "unknown";
  }
  if (hierarchy.node || (result.windows?.length ?? 0) > 0) {
    return undefined;
  }
  if (hierarchy.unavailableReason) {
    return hierarchy.unavailableReason;
  }
  if (hierarchy.transportFailure === true) {
    return "connection_lost";
  }
  return hierarchy.error ? "unknown" : undefined;
}

/** Whether any read in a tapOn search returned a usable tree (#18983). */
export interface TapHierarchyAvailability {
  record(result: ViewHierarchyResult): void;
  /** The reason to report when no read in the search was usable; undefined otherwise. */
  unavailableReason(): TapHierarchyUnavailableReason | undefined;
}

/**
 * Track availability across a search, starting from its initial tree. Null reads (failed
 * captures) are never recorded, so they count as unavailable and keep the last typed reason.
 */
export function tapHierarchyAvailability(initial: ViewHierarchyResult): TapHierarchyAvailability {
  let sawUsable = false;
  let lastReason: TapHierarchyUnavailableReason | undefined;
  const record = (result: ViewHierarchyResult): void => {
    const reason = tapHierarchyUnavailableReason(result);
    if (reason === undefined) {
      sawUsable = true;
    } else {
      lastReason = reason;
    }
  };
  record(initial);
  return {
    record,
    unavailableReason: () => (sawUsable ? undefined : (lastReason ?? "unknown")),
  };
}

/**
 * The tapOn search never read a usable hierarchy, so it cannot say the element is absent.
 * Retryable: the screen was not read, which says nothing about the selector.
 */
export class TapHierarchyUnavailableError extends ActionableError {
  readonly retryable = true;

  constructor(
    readonly unavailableReason: TapHierarchyUnavailableReason,
    lookup: string,
    requestCount: number,
  ) {
    super(
      `View hierarchy unavailable (${unavailableReason}): no hierarchy read during the search for ` +
        `${lookup} returned a usable tree (${requestCount + 1} read(s)), so the element could not be ` +
        "looked up. Retry the operation after the accessibility service is connected.",
    );
    this.name = "TapHierarchyUnavailableError";
  }
}

/** The selector a tapOn searched for, as the hierarchy-unavailable error names it. */
export function tapLookupLabel(
  options: Pick<
    TapOnElementOptions,
    "text" | "textAny" | "testTag" | "accessibilityLink" | "elementId"
  >,
): string {
  if (options.text) {
    return `text '${options.text}'`;
  }
  if (options.textAny) {
    return `any text '${options.textAny.join("', '")}'`;
  }
  if (options.testTag) {
    return `testTag '${options.testTag}'`;
  }
  if (options.accessibilityLink) {
    return `accessibilityLink '${options.accessibilityLink}'`;
  }
  return `elementId '${options.elementId}'`;
}

/** The result fields a hierarchy-unavailable tapOn failure carries; empty for any other error. */
export function tapHierarchyUnavailableFields(error: unknown): {
  retryable?: true;
  hierarchyUnavailableReason?: TapHierarchyUnavailableReason;
} {
  return error instanceof TapHierarchyUnavailableError
    ? { retryable: true, hierarchyUnavailableReason: error.unavailableReason }
    : {};
}

/**
 * The tapOn search result field for a miss in which no read was usable (#18983); empty when the
 * element was found or any read returned a usable tree, so the not-found path stays in charge.
 */
export function tapSearchUnavailableField(
  lookup: string,
  element: unknown,
  availability: TapHierarchyAvailability,
  requestCount: number,
): { hierarchyUnavailableError?: TapHierarchyUnavailableError } {
  const reason = element ? undefined : availability.unavailableReason();
  if (reason === undefined) {
    return {};
  }
  logger.warn(
    `[TapOnElement] No usable view hierarchy during the element search (${reason}); ` +
      "reporting hierarchy unavailable instead of not found.",
  );
  return {
    hierarchyUnavailableError: new TapHierarchyUnavailableError(reason, lookup, requestCount),
  };
}
