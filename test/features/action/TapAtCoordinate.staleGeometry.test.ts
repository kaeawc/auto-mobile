import { describe, expect, test } from "bun:test";
import { createTapAt, observation } from "../../helpers/tapAtCoordinate";

const device = { deviceId: "duo", name: "iPhone Duo", platform: "ios" } as const;
const landscapeLayout = {
  node: [
    { bounds: { left: 0, top: 0, right: 951, bottom: 64 } },
    { bounds: { left: 855, top: 380, right: 951, bottom: 428 } },
  ],
};
const portraitLayout = {
  node: [
    { bounds: { left: 0, top: 0, right: 669, bottom: 96 } },
    { bounds: { left: 0, top: 870, right: 669, bottom: 951 } },
  ],
};

describe("tapAt stale posture geometry (#18245)", () => {
  test("refuses a portrait-reported observation laid out landscape and dispatches nothing", async () => {
    const fake = createTapAt(device, 669, 951);
    fake.observeScreen.setObserveResult(observation(669, 951, "frame-1", 0, landscapeLayout));
    const result = await fake.tapAt.execute({ x: 903, y: 404 });
    expect(result).toMatchObject({ success: false, x: 903, y: 404 });
    expect(result.error).toBe(
      "Screen geometry is stale after a posture change: observe reports rotation 0 and 669x951, " +
        "but elements are laid out for 951x669. Nothing was tapped. Observe again, then retry.",
    );
    expect(fake.iosDispatches).toEqual([]);
  });

  test("taps a landscape-native app whose elements fit the reported size", async () => {
    const fake = createTapAt(device, 951, 669);
    fake.observeScreen.setObserveResult(observation(951, 669, "frame-1", 0, landscapeLayout));
    expect((await fake.tapAt.execute({ x: 903, y: 404 })).success).toBe(true);
    expect(fake.iosDispatches).toMatchObject([{ x: 903, y: 404 }]);
  });

  test("taps a portrait app", async () => {
    const fake = createTapAt(device, 669, 951);
    fake.observeScreen.setObserveResult(observation(669, 951, "frame-1", 0, portraitLayout));
    expect((await fake.tapAt.execute({ x: 300, y: 900 })).success).toBe(true);
    expect(fake.iosDispatches).toMatchObject([{ x: 300, y: 900 }]);
  });
});
