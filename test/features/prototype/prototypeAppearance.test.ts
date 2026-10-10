import { describe, expect, test } from "bun:test";
import { PROTOTYPE_APPEARANCE_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  parsePrototypeAppearance,
  PROTOTYPE_APPEARANCE_SOURCES,
  prototypeAppearanceAfterChange,
  prototypeAppearanceOverride,
  prototypeAppearanceUnsupportedMessage,
  shownAppearance,
  withParsedAppearance,
} from "../../../src/features/prototype/prototypeAppearance";

const dark = { mode: "dark", source: "override", deviceDark: false } as const;

describe("prototype appearance helpers", () => {
  test("the capability flag is the prototype-named one", () => {
    expect(PROTOTYPE_APPEARANCE_CAPABILITY).toBe("prototype_appearance_v1");
  });

  test("only light and dark go on the wire; device and absence send nothing", () => {
    expect(prototypeAppearanceOverride("light")).toBe("light");
    expect(prototypeAppearanceOverride("dark")).toBe("dark");
    expect(prototypeAppearanceOverride("device")).toBeUndefined();
    expect(prototypeAppearanceOverride(undefined)).toBeUndefined();
  });

  test("parses every source the device contract names and nothing else", () => {
    // The order android/protocol WebSocketResponseTest pins.
    expect([...PROTOTYPE_APPEARANCE_SOURCES].sort()).toEqual(
      ["explicit", "override", "roleLuminance", "authoredBackground", "system"].sort(),
    );
    for (const source of PROTOTYPE_APPEARANCE_SOURCES) {
      const value = { mode: "light", source, deviceDark: true };
      expect(parsePrototypeAppearance(value)).toEqual(value);
    }
    expect(parsePrototypeAppearance({ ...dark, extra: 1 })).toEqual(dark);
    for (const bad of [
      undefined,
      null,
      "dark",
      [],
      { mode: "dark", source: "override" },
      { ...dark, mode: "sepia" },
      { ...dark, source: "wallpaper" },
      { ...dark, deviceDark: "no" },
    ]) {
      expect(parsePrototypeAppearance(bad)).toBeUndefined();
    }
  });

  test("withParsedAppearance keeps a well-formed report and strips anything else", () => {
    expect(withParsedAppearance({ success: true })).toEqual({ success: true });
    expect(withParsedAppearance({ success: true, appearance: dark })).toEqual({
      success: true,
      appearance: dark,
    });
    const malformed = { success: true, appearance: { mode: "dark" } as never };
    expect(withParsedAppearance(malformed)).toEqual({ success: true });
  });

  test("only a show that landed records an appearance", () => {
    expect(shownAppearance("show", { success: true, appearance: dark })).toEqual({
      appearance: dark,
    });
    expect(shownAppearance("show", { success: true })).toEqual({});
    expect(shownAppearance("show", { success: false, appearance: dark })).toEqual({});
    expect(shownAppearance("dismiss", { success: true, appearance: dark })).toEqual({});
  });

  test("a change event keeps deviceDark unless the device's own setting decided the mode", () => {
    expect(prototypeAppearanceAfterChange(dark, { mode: "light", source: "system" })).toEqual({
      mode: "light",
      source: "system",
      deviceDark: false,
    });
    expect(
      prototypeAppearanceAfterChange(dark, { mode: "light", source: "authoredBackground" }),
    ).toEqual({ mode: "light", source: "authoredBackground", deviceDark: false });
    expect(
      prototypeAppearanceAfterChange(undefined, { mode: "dark", source: "roleLuminance" }),
    ).toBeUndefined();
    expect(prototypeAppearanceAfterChange(dark, { mode: "light" })).toBe(dark);
    expect(prototypeAppearanceAfterChange(dark, null)).toBe(dark);
  });

  test("the refusal names the flag, the value and the platform's update path", () => {
    const androidMessage = prototypeAppearanceUnsupportedMessage("dark", "android");
    expect(androidMessage).toContain(
      "The connected CtrlProxy does not advertise prototype_appearance_v1",
    );
    expect(androidMessage).toContain('appearance "dark"');
    expect(androidMessage).toContain("Nothing was shown. Update the connected CtrlProxy");
    const iosMessage = prototypeAppearanceUnsupportedMessage("light", "ios");
    expect(iosMessage).toContain(
      "The connected iOS prototype agent does not advertise prototype_appearance_v1",
    );
    expect(iosMessage).toContain("Relaunch the app with launchApp prototype: true");
    expect(`${androidMessage}${iosMessage}`.toLowerCase()).not.toContain("overlay");
  });
});
