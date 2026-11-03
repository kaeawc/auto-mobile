import { describe, expect, test } from "bun:test";
import { stillPlatformState } from "../../../../src/features/prototype/web/webPlatformState";

const android = (widthDp: number, fold?: Parameters<typeof stillPlatformState>[0]["fold"]) =>
  stillPlatformState({ platform: "android", widthDp, heightDp: 900, ...(fold ? { fold } : {}) });
const ios = (widthDp: number, heightDp: number) =>
  stillPlatformState({ platform: "ios", widthDp, heightDp });

describe("stillPlatformState", () => {
  test("Android widthClass breaks at 600 and 840 dp", () => {
    expect(android(599)["/device/widthClass"]).toBe("compact");
    expect(android(600)["/device/widthClass"]).toBe("medium");
    expect(android(839)["/device/widthClass"]).toBe("medium");
    expect(android(840)["/device/widthClass"]).toBe("expanded");
  });

  test("iOS widthClass is regular on a tablet and on the widest phones in landscape", () => {
    expect(ios(393, 852)["/device/widthClass"]).toBe("compact");
    expect(ios(852, 393)["/device/widthClass"]).toBe("compact");
    expect(ios(956, 440)["/device/widthClass"]).toBe("regular");
    expect(ios(820, 1180)["/device/widthClass"]).toBe("regular");
  });

  test("Android posture follows the fold and the hinge", () => {
    expect(android(411)["/device/posture"]).toBeUndefined();
    expect(android(841, { posture: "opened", hinge: "vertical" })["/device/posture"]).toBe("flat");
    expect(android(841, { posture: "half_opened", hinge: "horizontal" })["/device/posture"]).toBe(
      "tabletop",
    );
    expect(android(841, { posture: "half_opened", hinge: "vertical" })["/device/posture"]).toBe(
      "book",
    );
    expect(
      android(360, { posture: "closed", hinge: "vertical" })["/device/posture"],
    ).toBeUndefined();
  });

  test("iOS never sets posture, but the still still decides it as missing", () => {
    const state = stillPlatformState({
      platform: "ios",
      widthDp: 820,
      heightDp: 1180,
      fold: { posture: "half_opened", hinge: "vertical" },
    });
    expect(Object.hasOwn(state, "/device/posture")).toBe(true);
    expect(state["/device/posture"]).toBeUndefined();
    expect(state["/device/os"]).toBe("ios");
  });
});
