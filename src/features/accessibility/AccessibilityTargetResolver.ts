/**
 * Resolve a resourceId / text / contentDesc selector on the current screen to the unique Android
 * resource-id an accessibility-service node action can target. Shared by accessibilityFocus and
 * accessibilityAction (#14077).
 */

import { ActionableError, BootedDevice, ViewHierarchyResult } from "../../models";
import { ElementResolver, type ElementResolution } from "../utility/ElementResolver";
import { normalizeQuotes } from "../utility/TextMatcher";
import { SearchableHierarchy, matchesCtrlProxyResourceId } from "../utility/SearchableNode";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { BaseVisualChange } from "../action/BaseVisualChange";

/** One of these selects the target element. */
export interface AccessibilityTargetSelector {
  resourceId?: string;
  text?: string;
  contentDesc?: string;
}

export interface AccessibilityTargetResolverDependencies {
  resolver?: Pick<ElementResolver, "resolve">;
  observeScreen?: ObserveScreen;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function matchedTextNativeId(
  resolution: ElementResolution,
  text: string,
  contentDescription = false,
): string | undefined {
  const matched = resolution.matches.find(({ node }) => node === resolution.chosen);
  const query = normalizeQuotes(text).trim().toLowerCase();
  return matched?.sourceNodes?.find(
    (node) =>
      node.nativeId &&
      (contentDescription
        ? [node.textSources["content-desc"], node.accessibleLabel]
        : Object.values(node.textSources)
      ).some((value) => {
        const source = value && normalizeQuotes(value).trim().toLowerCase();
        return resolution.matchMode === "contains" ? source?.includes(query) : source === query;
      }),
  )?.nativeId;
}

function selectedNativeId(
  resolution: ElementResolution,
  options: AccessibilityTargetSelector,
): string | undefined {
  if (options.resourceId) {
    return resolution.chosen?.nativeId;
  }
  if (options.text) {
    return matchedTextNativeId(resolution, options.text);
  }
  return options.contentDesc
    ? matchedTextNativeId(resolution, options.contentDesc, true)
    : undefined;
}

export class AccessibilityTargetResolver {
  private readonly resolver: Pick<ElementResolver, "resolve">;
  private readonly searchable = new SearchableHierarchy();
  private readonly observeScreen: ObserveScreen;

  /** [purpose] names the feature in errors, e.g. "accessibility focus". */
  constructor(
    device: BootedDevice,
    private readonly purpose: string,
    deps: AccessibilityTargetResolverDependencies = {},
  ) {
    this.resolver = deps.resolver ?? new ElementResolver();
    this.observeScreen =
      deps.observeScreen ?? new RealObserveScreen(device, defaultAdbClientFactory);
  }

  /** Resolve observed identity locally; only a unique real native ID crosses the service boundary. */
  async resolveResourceId(options: AccessibilityTargetSelector): Promise<string> {
    const hierarchy = await this.getViewHierarchy();
    const nodes = this.searchable.project(hierarchy);
    const selector = options.resourceId
      ? { elementId: options.resourceId }
      : options.text
        ? { text: options.text, match: "exact" as const }
        : { contentDescription: options.contentDesc, match: "exact" as const };
    const resolution = this.resolver.resolve(
      { id: String(hierarchy.updatedAt ?? "accessibility-target"), nodes },
      selector,
      !options.resourceId && (options.text || options.contentDesc)
        ? { action: "inspect", requireBounds: true }
        : { action: "accessibility-focus", requireResourceId: true },
    );
    if (resolution.error) {
      throw new ActionableError(resolution.error);
    }
    const resourceId = selectedNativeId(resolution, options);
    if (!resourceId) {
      if (
        resolution.matches.some(({ node, sourceNodes }) =>
          (sourceNodes ?? [node]).some((source) => !source.nativeId),
        )
      ) {
        throw new ActionableError(
          `Matched element has no resource-id; ${this.purpose} requires one.`,
        );
      }
      throw new ActionableError(
        `Element not found for ${this.purpose} selector: ${JSON.stringify(selector)}`,
      );
    }
    const sharing = new Set(
      nodes
        .filter((node) => matchesCtrlProxyResourceId(node.nativeId, resourceId))
        .map((node) => node.source),
    ).size;
    if (sharing > 1) {
      throw new ActionableError(
        `Selected resource-id "${resourceId}" is shared by ${sharing} elements. ${capitalize(this.purpose)} requires a unique native target.`,
      );
    }
    return resourceId;
  }

  private async getViewHierarchy(): Promise<ViewHierarchyResult> {
    let observeResult = await this.observeScreen.getMostRecentCachedObserveResult();
    const hasUsableCache = Boolean(
      observeResult.viewHierarchy && !observeResult.viewHierarchy.hierarchy.error,
    );
    const staleCachedRefetch =
      hasUsableCache && BaseVisualChange.shouldRefetchCachedObservation(observeResult);
    if (staleCachedRefetch) {
      try {
        observeResult = await this.observeScreen.execute({ freshness: "fresh" });
      } catch (error) {
        throw new ActionableError(`Unable to observe screen to resolve ${this.purpose} target.`, {
          cause: error,
        });
      }
    } else if (!hasUsableCache) {
      observeResult = await this.observeScreen.execute();
    }
    if (
      !observeResult.viewHierarchy ||
      (staleCachedRefetch && observeResult.viewHierarchy.hierarchy?.error)
    ) {
      throw new ActionableError(`Unable to observe screen to resolve ${this.purpose} target.`);
    }
    return observeResult.viewHierarchy;
  }
}
