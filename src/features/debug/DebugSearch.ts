import {
  type AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import type { BootedDevice, DebugSearchResult, DebugSearchMatch } from "../../models";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeQuotes } from "../utility/TextMatcher";
import { ElementResolver } from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import { ActionableError } from "../../models/ActionableError";
interface DebugSearchOptions {
  /**
   * Text to search for
   */
  text?: string;

  /**
   * Resource ID to search for
   */
  resourceId?: string;

  /**
   * Container element to restrict search within
   */
  container?: {
    elementId?: string;
    text?: string;
  };

  /**
   * Whether to use partial matching (substring containment, default: true)
   */
  partialMatch?: boolean;
  match?: "exact" | "contains";

  /**
   * Whether to use case-sensitive matching (default: false)
   */
  caseSensitive?: boolean;

  /**
   * Include near-misses in the result (elements that were close to matching)
   */
  includeNearMisses?: boolean;

  /**
   * Maximum number of near-misses to include
   */
  maxNearMisses?: number;
}

export class DebugSearch {
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly timer: Timer = defaultTimer,
    private readonly parser: ElementParser = new DefaultElementParser(),
    private readonly resolver: Pick<ElementResolver, "resolve"> = new ElementResolver(),
    private readonly viewHierarchy: Pick<ViewHierarchy, "getViewHierarchy"> = new ViewHierarchy(
      device,
      adbFactory,
    ),
  ) {}
  async execute(options: DebugSearchOptions): Promise<DebugSearchResult> {
    const timestamp = this.timer.now();
    const hierarchy = await this.viewHierarchy.getViewHierarchy({}, new NoOpPerformanceTracker());
    const capture = resolveViewHierarchyForSearch(hierarchy) ?? hierarchy;
    const nodes = capture ? new SearchableHierarchy(this.parser).project(capture) : [];
    const resolution = this.resolver.resolve(
      { id: String(timestamp), nodes },
      {
        elementId: options.resourceId,
        text: options.text,
        container: options.container,
        match:
          options.match ??
          (options.resourceId
            ? "exact"
            : options.partialMatch === undefined
              ? undefined
              : options.partialMatch
                ? "contains"
                : "exact"),
        caseSensitive: options.caseSensitive,
      },
      { action: "tap" },
    );
    if (resolution.error && resolution.error !== "Container not found") {
      throw new ActionableError(resolution.error);
    }
    const normalize = (value: string) =>
      options.caseSensitive
        ? normalizeQuotes(value).trim()
        : normalizeQuotes(value).trim().toLowerCase();
    const matches: DebugSearchMatch[] = resolution.matches.map(({ node, kind }) => {
      const sources = options.resourceId
        ? [
            [
              kind === "node-key-exact" ? "view-id" : "resource-id",
              kind === "node-key-exact" ? node.nodeKey! : node.nativeId!,
            ],
          ]
        : Object.entries(node.textSources).filter(([, value]) =>
            resolution.matchMode === "contains"
              ? normalize(value).includes(normalize(options.text ?? ""))
              : normalize(value) === normalize(options.text ?? ""),
          );
      return {
        element: node.element ?? node.properties,
        matchedProperty: sources.map(([key]) => key).join(", ") || "label",
        matchedProperties: sources.map(([key]) => key),
        matchedValue: sources[0]?.[1] ?? node.label ?? "",
        matchKind: kind,
        isExactMatch: kind.endsWith("-exact"),
        className: node.className,
        resourceId: node.nativeId,
        clickable: node.affordances.includes("tap"),
        enabled: node.properties.enabled !== false && node.properties.enabled !== "false",
        visible:
          !!node.bounds &&
          node.bounds.right > node.bounds.left &&
          node.bounds.bottom > node.bounds.top,
      };
    });
    const scopedNodes = options.container
      ? this.resolver.resolve(
          { id: String(timestamp), nodes },
          { container: options.container },
          { action: "inspect" },
        ).candidates
      : nodes;
    const nearMisses: NonNullable<DebugSearchResult["nearMisses"]> = [];
    for (const node of options.includeNearMisses === false ? [] : scopedNodes) {
      if (!node.element || resolution.candidates.includes(node)) {
        continue;
      }
      for (const [property, value] of Object.entries(
        options.resourceId ? { "resource-id": node.nativeId } : node.textSources,
      )) {
        if (value && this.isSimilar(value, options.resourceId ?? options.text ?? "")) {
          nearMisses.push({
            element: node.element,
            property,
            value,
            reason: "Similar but did not match the selected mode",
          });
        }
      }
    }

    return {
      query: {
        text: options.text,
        resourceId: options.resourceId,
        container: options.container,
        partialMatch: resolution.matchMode === "contains",
        caseSensitive: options.caseSensitive === true,
        match: resolution.matchMode,
      },
      matches,
      selectedMatch: matches[resolution.indexInMatches ?? -1],
      totalElements: scopedNodes.length,
      timestamp,
      ...(nearMisses.length
        ? { nearMisses: nearMisses.slice(0, options.maxNearMisses ?? 10) }
        : {}),
    };
  }
  /**
   * Check if two strings are similar (for near-miss detection)
   */
  private isSimilar(a: string, b: string): boolean {
    if (!a || !b) {
      return false;
    }
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    // Check if one contains a significant portion of the other
    if (aLower.length > 3 && bLower.length > 3) {
      // Check for common substring
      const shorter = aLower.length < bLower.length ? aLower : bLower;
      const longer = aLower.length < bLower.length ? bLower : aLower;

      // If the shorter string is at least 50% of the longer and they share a common prefix/suffix
      if (shorter.length >= longer.length * 0.5) {
        if (
          longer.startsWith(shorter.substring(0, 3)) ||
          longer.endsWith(shorter.substring(shorter.length - 3))
        ) {
          return true;
        }
      }
    }

    return false;
  }
}
