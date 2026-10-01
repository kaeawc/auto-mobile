import type { BootedDevice } from "../../models";
import type { ElementSearchDebugInfo } from "../../utils/DebugContextBuilder";
import { isDebugModeEnabled } from "../../utils/debug";
import { serverConfig } from "../../utils/ServerConfig";
import { logger } from "../../utils/logger";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { ElementResolver } from "./ElementResolver";
import { DefaultTextMatcher } from "./TextMatcher";

/**
 * Build debug context for element search failures
 * Only collects information if debug mode is enabled
 */
export async function buildElementSearchDebugContext(
  device: BootedDevice | null,
  searchCriteria: {
    text?: string;
    resourceId?: string;
    container?: {
      elementId?: string;
      text?: string;
    };
  },
  capture?: HierarchyCapture,
): Promise<ElementSearchDebugInfo | undefined> {
  // Only build debug context if debug mode is enabled
  if (!isDebugModeEnabled()) {
    return undefined;
  }

  // Can't build debug context without a device
  if (!device) {
    return {
      searchCriteria,
      nearMisses: [],
      totalElementsChecked: 0,
    };
  }

  try {
    const snapshot = await (capture ?? createDeviceHierarchyCapture(device)).capture({
      freshness: "fresh",
      searchRaw: device.platform === "android" && serverConfig.isRawElementSearchEnabled(),
    });
    const resolver = new ElementResolver();
    const container = searchCriteria.container?.text
      ? { ...searchCriteria.container, match: "contains" as const }
      : searchCriteria.container;
    const resolution = resolver.resolve(
      { id: String(snapshot.receivedAt), nodes: snapshot.nodes },
      {
        elementId: searchCriteria.resourceId,
        text: searchCriteria.text,
        container,
        match: "contains",
      },
      { action: "tap" },
    );
    const scopedNodes = container
      ? resolver.resolve(
          { id: String(snapshot.receivedAt), nodes: snapshot.nodes },
          { container },
          { action: "inspect" },
        ).candidates
      : snapshot.nodes;
    const matchedNodes = new Set([
      ...resolution.candidates,
      ...resolution.matches.flatMap(({ node, sourceNodes }) => [node, ...(sourceNodes ?? [])]),
    ]);
    const query = searchCriteria.resourceId ?? searchCriteria.text ?? "";
    const matcher = new DefaultTextMatcher();
    const nearMisses = scopedNodes
      .filter((node) => node.element && !matchedNodes.has(node))
      .flatMap((node) =>
        Object.entries(
          searchCriteria.resourceId ? { "resource-id": node.nativeId } : node.textSources,
        )
          .filter(([, value]) => value && matcher.partialTextMatch(value, query))
          .map(([property, value]) => ({
            element: node.element!,
            property,
            value: value!,
            reason: "Similar but did not match the selected mode",
          })),
      )
      .slice(0, 10);

    return {
      searchCriteria,
      nearMisses: nearMisses.length ? nearMisses : undefined,
      totalElementsChecked: scopedNodes.length,
    };
  } catch (error) {
    logger.warn("Could not build element search debug context", error);
    return {
      searchCriteria,
      nearMisses: [],
      totalElementsChecked: 0,
    };
  }
}
