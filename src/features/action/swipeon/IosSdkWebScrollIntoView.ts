import type { BootedDevice, ObserveResult } from "../../../models";
import { serverConfig } from "../../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "../../observe/ios/IOSCtrlProxyClient";
import { deviceIosSdkWebReader, type IosSdkWebReader } from "../../observe/ios/IosSdkWebReader";
import { findWebViewNodes } from "../../observe/ios/iosSdkWebMerge";
import type { IosSdkWebElement } from "../../observe/ios/sdkWebViewBridge";
import { normalizeQuotes } from "../../utility/TextMatcher";
import type { IosSdkTapOutcome } from "../IosSdkBridgeTapRouter";
import { performIosSdkWebAction, type IosSdkWebActionClient } from "../IosSdkWebActionRouter";

/**
 * `swipeOn` with `lookFor` on a DOM element of an opted-in WKWebView (#5162): the page scrolls the
 * element into view itself (`scrollIntoView`) instead of being swiped toward it.
 *
 * The merged observation holds only the DOM elements inside the web view, so the element is found
 * in the web view's raw snapshot, which lists the page's off-screen elements too. Only a single
 * on-screen web view qualifies, as for the merge, and only a text selector, matched exactly (case
 * and quote style aside) against an element's label or value: a looser match could scroll to the
 * wrong element, while a miss just leaves the search to swipe as usual.
 */
export interface IosSdkWebScrollIntoView {
  /**
   * Scrolls the page element the selector names into view. Returns null when there is none to
   * scroll to (or routing is off), so the search swipes as usual and reports nothing extra.
   */
  scroll(
    lookFor: { text?: string; elementId?: string },
    observation: Pick<ObserveResult, "viewHierarchy">,
    signal?: AbortSignal,
  ): Promise<IosSdkTapOutcome | null>;
}

/** The value the SDK bridge reports in place of a DOM value when its policy redacts text. */
const REDACTED_WEB_VALUE = "[REDACTED]";

function normalized(text: string): string {
  return normalizeQuotes(text).trim().toLowerCase();
}

/** The one routable element whose label or value is `text`, or null when none or several are. */
function elementNamed(
  elements: readonly IosSdkWebElement[],
  text: string,
): IosSdkWebElement | null {
  const wanted = normalized(text);
  const counts = new Map<string, number>();
  for (const { id } of elements) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const matches = elements.filter(
    (element) =>
      element.id !== "" &&
      counts.get(element.id) === 1 &&
      // The page scrolls only an enabled, visible element; another is left to the swipe search.
      element.enabled &&
      element.visible &&
      [element.label, element.value === REDACTED_WEB_VALUE ? undefined : element.value].some(
        (name) => name !== undefined && normalized(name) === wanted,
      ),
  );
  return matches.length === 1 ? matches[0] : null;
}

export interface IosSdkWebScrollIntoViewOptions {
  reader: IosSdkWebReader;
  client: () => IosSdkWebActionClient | null;
  enabled?: () => boolean;
}

export function createIosSdkWebScrollIntoView(
  options: IosSdkWebScrollIntoViewOptions,
): IosSdkWebScrollIntoView {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  return {
    async scroll(lookFor, observation, signal) {
      if (!enabled() || lookFor.text === undefined) {
        return null;
      }
      if (findWebViewNodes(observation.viewHierarchy).length !== 1) {
        return null;
      }
      const entries = await options.reader.snapshots(signal);
      const entry = entries.length === 1 ? entries[0] : undefined;
      const snapshot = entry?.snapshot;
      const element = snapshot ? elementNamed(snapshot.elements, lookFor.text) : null;
      if (!entry || !snapshot || !element) {
        return null;
      }
      const target = { snapshotId: snapshot.snapshotId, elementId: element.id };
      return performIosSdkWebAction(
        options.client(),
        { webViewId: entry.webViewId, ...target },
        { scrollIntoView: target },
        "scroll into view",
        signal,
      );
    },
  };
}

/** The production scroller: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkWebScrollIntoView(
  device: Pick<BootedDevice, "deviceId">,
): IosSdkWebScrollIntoView {
  return createIosSdkWebScrollIntoView({
    reader: deviceIosSdkWebReader(device),
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}

/** The web-view `scrollIntoView` step of an iOS `lookFor` search; none on other platforms. */
export function iosWebScrollIntoView(
  device: Pick<BootedDevice, "deviceId" | "platform">,
  injected: IosSdkWebScrollIntoView | undefined,
): IosSdkWebScrollIntoView | undefined {
  return device.platform === "ios"
    ? (injected ?? deviceIosSdkWebScrollIntoView(device))
    : undefined;
}
