import { describe, expect, test } from "bun:test";
import { deriveIosSdkScreenIdentity } from "../../../../src/features/observe/ios/IosSdkScreenIdentity";

const PLAYGROUND_BUNDLE = "dev.jasonpearson.automobile.Playground";

describe("deriveIosSdkScreenIdentity", () => {
  test("includes the SDK route, selected tab, and presentation metadata", () => {
    expect(
      deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, {
        destination: "ScrollPerformanceDemo",
        arguments: { tab: "Demos" },
        metadata: { presentation: "sheet" },
      }),
    ).toEqual({
      platform: "ios",
      source: "sdk",
      confidence: "high",
      key: JSON.stringify([
        ["bundle", PLAYGROUND_BUNDLE],
        ["route", "ScrollPerformanceDemo"],
        ["tab", "Demos"],
        ["presentation", "sheet"],
      ]),
      components: {
        bundleId: PLAYGROUND_BUNDLE,
        navigationRoute: "ScrollPerformanceDemo",
        selectedTab: "Demos",
        presentation: "sheet",
      },
    });
  });

  test("gives Playground tab and destination routes distinct, stable identities", () => {
    const routes = [
      { destination: "discover", metadata: { type: "tab_switch" } },
      { destination: "demos", metadata: { type: "tab_switch" } },
      { destination: "ScrollPerformanceDemo", arguments: { tab: "demos" } },
      { destination: "settings", metadata: { type: "tab_switch" } },
    ];
    const keys = routes.map(
      (route) => deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, route)!.key,
    );

    expect(new Set(keys).size).toBe(4);
    expect(deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, routes[2])!.key).toBe(
      keys[2],
    );
  });

  test("distinguishes destination instances by canonical navigation arguments", () => {
    const first = deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, {
      destination: "VideoDetail",
      arguments: { title: "First video", videoId: "video-1" },
    })!;
    const second = deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, {
      destination: "VideoDetail",
      arguments: { videoId: "video-2", title: "Second video" },
    })!;
    const reordered = deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, {
      destination: "VideoDetail",
      arguments: { videoId: "video-1", title: "First video" },
    })!;

    expect(first.key).not.toBe(second.key);
    expect(first.key).toBe(reordered.key);
    expect(first.key).toContain(JSON.stringify(["argument", "videoId", "video-1"]));
  });

  test("omits identity without a bundle or destination", () => {
    expect(
      deriveIosSdkScreenIdentity("navigation", undefined, { destination: "Settings" }),
    ).toBeUndefined();
    expect(
      deriveIosSdkScreenIdentity("navigation", PLAYGROUND_BUNDLE, { destination: "  " }),
    ).toBeUndefined();
  });

  test("ignores a destination-shaped payload from a non-navigation SDK event", () => {
    expect(
      deriveIosSdkScreenIdentity("custom", PLAYGROUND_BUNDLE, {
        destination: "Settings",
      }),
    ).toBeUndefined();
  });
});
