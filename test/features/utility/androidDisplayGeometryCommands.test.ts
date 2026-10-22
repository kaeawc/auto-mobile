import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  availableOverlayValues,
  enabledOverlays,
  overlayCommands,
  overlayTargetFor,
  overlayValue,
  parseWmSize,
  wmSizeReadCommand,
  wmSizeWriteCommand,
} from "../../../src/features/utility/androidDisplayGeometryCommands";
import { parseOverlayList } from "../../../src/features/utility/DisplayProfile";
import { FakeDisplayGeometryAdb } from "../../fakes/FakeDisplayGeometryAdb";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-display-geometry/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const NAVBAR = "com.android.internal.systemui.navbar.";
const CUTOUT = "com.android.internal.display.cutout.emulation.";

describe("parseWmSize", () => {
  test("reads the physical size and an override", () => {
    expect(parseWmSize(fixture("wm-size-physical"))).toEqual({
      physical: { width: 1080, height: 2400 },
    });
    expect(parseWmSize(fixture("wm-size-override"))).toEqual({
      physical: { width: 1080, height: 2400 },
      override: { width: 720, height: 1600 },
    });
  });

  test.each([
    "",
    "Physical size: garbage\n",
    "Override size: 720x1600\n",
    "Physical size: 1x2\nPhysical size: 3x4\n",
  ])("rejects unreadable output %j", (raw) => {
    expect(parseWmSize(raw)).toBeUndefined();
  });
});

describe("wm size commands", () => {
  test("only a non-default display carries -d", () => {
    expect(wmSizeReadCommand(undefined)).toBe("shell wm size");
    expect(wmSizeReadCommand(0)).toBe("shell wm size");
    expect(wmSizeReadCommand(2)).toBe("shell wm size -d 2");
    expect(wmSizeWriteCommand({ width: 720, height: 1600 }, undefined)).toBe(
      "shell wm size 720x1600",
    );
    expect(wmSizeWriteCommand("default", 2)).toBe("shell wm size reset -d 2");
  });
});

function overlays(raw: string) {
  return parseOverlayList(raw).map(({ name, enabled }) => ({ packageName: name, enabled }));
}

describe("overlay listing", () => {
  test("the reconstructed gestural fixture has gesture navigation enabled and no cutout", () => {
    const entries = overlays(fixture("overlay-list-gestural"));
    expect(entries).toContainEqual({ packageName: `${NAVBAR}gestural`, enabled: true });
    expect(enabledOverlays(entries, "navigationMode")).toEqual([`${NAVBAR}gestural`]);
    expect(enabledOverlays(entries, "displayCutout")).toEqual([]);
  });

  test("the stateful fake renders the reconstructed fixture format", () => {
    expect(new FakeDisplayGeometryAdb().renderOverlayList()).toBe(fixture("overlay-list-gestural"));
  });
});

describe("overlay value mapping", () => {
  test("maps enabled overlays to displayConfig values", () => {
    expect(overlayValue("navigationMode", [])).toBe("default");
    expect(overlayValue("navigationMode", [`${NAVBAR}gestural_wide_back`])).toBe("gesture");
    expect(overlayValue("navigationMode", [`${NAVBAR}threebutton`])).toBe("threeButton");
    expect(overlayValue("navigationMode", [`${NAVBAR}twobutton`])).toBe("twoButton");
    expect(overlayValue("displayCutout", [])).toBe("none");
    expect(overlayValue("displayCutout", [`${CUTOUT}hole`])).toBe("hole");
    expect(overlayValue("displayCutout", [`${CUTOUT}emu01`])).toBeUndefined();
    expect(overlayValue("displayCutout", [`${CUTOUT}hole`, `${CUTOUT}tall`])).toBeUndefined();
  });

  test("maps values to the overlay they enable", () => {
    expect(overlayTargetFor("navigationMode", "threeButton")).toEqual([`${NAVBAR}threebutton`]);
    expect(overlayTargetFor("navigationMode", "default")).toEqual([]);
    expect(overlayTargetFor("displayCutout", "waterfall")).toEqual([`${CUTOUT}waterfall`]);
    expect(overlayTargetFor("displayCutout", "none")).toEqual([]);
  });

  test("lists only the values whose overlay the image ships and can enable", () => {
    // `---` overlays (twobutton here) cannot be enabled, so they are not offered.
    const entries = overlays(fixture("overlay-list-hole-cutout"));
    expect(availableOverlayValues(entries, "navigationMode")).toEqual(["default", "threeButton"]);
    expect(availableOverlayValues(entries, "displayCutout")).toEqual(["none", "hole"]);
  });
});

describe("overlayCommands", () => {
  test("switches exclusively, enables extras and disables leftovers", () => {
    const gestural = `${NAVBAR}gestural`;
    const three = `${NAVBAR}threebutton`;
    expect(overlayCommands([gestural], [gestural])).toEqual([]);
    expect(overlayCommands([], [])).toEqual([]);
    expect(overlayCommands([gestural], [three])).toEqual([
      `shell cmd overlay enable-exclusive --category ${three}`,
      `shell cmd overlay disable ${gestural}`,
    ]);
    expect(overlayCommands([gestural], [])).toEqual([`shell cmd overlay disable ${gestural}`]);
    expect(overlayCommands([], [gestural, three])).toEqual([
      `shell cmd overlay enable-exclusive --category ${gestural}`,
      `shell cmd overlay enable ${three}`,
    ]);
  });
});
