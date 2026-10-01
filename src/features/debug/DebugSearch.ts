import {
  type AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import type { BootedDevice, DebugSearchResult, DebugSearchMatch } from "../../models";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import { normalizeQuotes } from "../utility/TextMatcher";
import { ElementResolver, isMissingContainerError } from "../utility/ElementResolver";
import { ActionableError } from "../../models/ActionableError";
import { serverConfig } from "../../utils/ServerConfig";
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
    private readonly device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly timer: Timer = defaultTimer,
    private readonly resolver: Pick<ElementResolver, "resolve"> = new ElementResolver(),
    private readonly capture: HierarchyCapture = createDeviceHierarchyCapture(device, {
      timer,
      adbFactory,
    }),
  ) {}
  async execute(options: DebugSearchOptions): Promise<DebugSearchResult> {
    const timestamp = this.timer.now();
    const snapshot = await this.capture.capture({
      freshness: "fresh",
      searchRaw: this.device.platform === "android" && serverConfig.isRawElementSearchEnabled(),
    });
    const nodes = snapshot.nodes;
    const requestedMatch =
      options.match ??
      (options.resourceId
        ? "exact"
        : options.partialMatch === undefined
          ? undefined
          : options.partialMatch
            ? "contains"
            : "exact");
    const container = options.container?.text
      ? { ...options.container, match: "contains" as const }
      : options.container;
    const resolution = this.resolver.resolve(
      { id: String(timestamp), nodes },
      {
        elementId: options.resourceId,
        text: options.text,
        container,
        match: requestedMatch,
        caseSensitive: options.caseSensitive,
      },
      { action: "tap" },
    );
    if (resolution.error && !isMissingContainerError(resolution.error)) {
      throw new ActionableError(resolution.error);
    }
    const resultMatch = isMissingContainerError(resolution.error)
      ? (requestedMatch ?? "exact")
      : resolution.matchMode;
    const normalize = (value: string) =>
      options.caseSensitive
        ? normalizeQuotes(value).trim()
        : normalizeQuotes(value).trim().toLowerCase();
    const matches: DebugSearchMatch[] = resolution.matches.map(({ node, kind, sourceNodes }) => {
      const matchedNodes = sourceNodes ?? [node];
      const source = options.text
        ? (matchedNodes.find((candidate) =>
            Object.values(candidate.textSources).some((value) =>
              resolution.matchMode === "contains"
                ? normalize(value).includes(normalize(options.text!))
                : normalize(value) === normalize(options.text!),
            ),
          ) ?? matchedNodes[0])
        : node;
      const sources = options.resourceId
        ? [
            [
              kind === "node-key-exact" || !node.nativeId ? "view-id" : "resource-id",
              kind === "node-key-exact" || !node.nativeId ? node.nodeKey! : node.nativeId,
            ],
          ]
        : matchedNodes
            .flatMap((matchedNode) => Object.entries(matchedNode.textSources))
            .filter(([, value]) =>
              resolution.matchMode === "contains"
                ? normalize(value).includes(normalize(options.text ?? ""))
                : normalize(value) === normalize(options.text ?? ""),
            );
      return {
        element: source.element ?? source.properties,
        matchedProperty: [...new Set(sources.map(([key]) => key))].join(", ") || "label",
        matchedProperties: [...new Set(sources.map(([key]) => key))],
        matchedValue: sources[0]?.[1] ?? matchedNodes[0]?.label ?? "",
        matchKind: kind,
        isExactMatch: kind.endsWith("-exact") || kind === "id-namespace",
        className: source.className,
        resourceId: source.nativeId,
        clickable: source.affordances.includes("tap"),
        enabled: source.properties.enabled !== false && source.properties.enabled !== "false",
        visible:
          !!source.bounds &&
          source.bounds.right > source.bounds.left &&
          source.bounds.bottom > source.bounds.top,
      };
    });
    const scopedNodes = options.container
      ? this.resolver.resolve(
          { id: String(timestamp), nodes },
          { container },
          { action: "inspect" },
        ).candidates
      : nodes;
    const nearMisses: NonNullable<DebugSearchResult["nearMisses"]> = [];
    for (const node of options.includeNearMisses === false ? [] : scopedNodes) {
      if (
        !node.element ||
        resolution.candidates.includes(node) ||
        resolution.matches.some((match) => match.node === node || match.sourceNodes?.includes(node))
      ) {
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
        partialMatch: resultMatch === "contains",
        caseSensitive: options.caseSensitive === true,
        match: resultMatch,
      },
      matches,
      selectedMatch: resolution.chosen
        ? {
            ...matches[
              resolution.matches.findIndex(
                ({ node }) => node === resolution.candidates[resolution.indexInMatches ?? -1],
              )
            ],
            element: resolution.chosen.element ?? resolution.chosen.properties,
            resourceId: resolution.chosen.nativeId,
            className: resolution.chosen.className,
            clickable: resolution.chosen.affordances.includes("tap"),
            enabled:
              resolution.chosen.properties.enabled !== false &&
              resolution.chosen.properties.enabled !== "false",
            visible: !!resolution.chosen.bounds,
          }
        : undefined,
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
