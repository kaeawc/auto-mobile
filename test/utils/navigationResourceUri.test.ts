import { describe, expect, test } from "bun:test";
import { buildNavigationNodeScreenshotUri } from "../../src/utils/navigationResourceUri";

/**
 * Single source of truth for the node-screenshot resource URI shape (#5600).
 * Both the resolver (navigationResources) and the exporter
 * (NavigationGraphManager.exportGraphSummaryForApp / telemetry) build the URI
 * through this helper so the `?appId=` scoping introduced by #5534 cannot drift
 * back to an unscoped literal in any one emitter.
 */
describe("buildNavigationNodeScreenshotUri (#5600)", () => {
  test("scopes the URI with an encoded appId when appId is present", () => {
    expect(buildNavigationNodeScreenshotUri(7, "com.example.b")).toBe(
      "automobile:navigation/nodes/7/screenshot?appId=com.example.b",
    );
  });

  test("percent-encodes appId characters that are unsafe in a query value", () => {
    expect(buildNavigationNodeScreenshotUri(3, "com.foo bar&baz")).toBe(
      "automobile:navigation/nodes/3/screenshot?appId=com.foo%20bar%26baz",
    );
  });

  test("emits the unscoped URI when appId is null or undefined", () => {
    expect(buildNavigationNodeScreenshotUri(9, null)).toBe(
      "automobile:navigation/nodes/9/screenshot",
    );
    expect(buildNavigationNodeScreenshotUri(9)).toBe("automobile:navigation/nodes/9/screenshot");
  });
});
