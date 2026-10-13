import { describe, expect, test } from "bun:test";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeWindowChromeUnsupportedMessage,
  resolvePrototypeWindowChrome,
} from "../../../src/features/prototype/prototypeWindowChrome";

const spec = (window: Record<string, unknown> = {}) => ({
  id: "panel",
  window: { placement: { type: "fullscreen" }, ...window },
  root: { type: "text", text: "Hello" },
});

describe("prototype window chrome", () => {
  test.each(["android", "ios"] as const)(
    "unsupported none returns the final %s refusal",
    (platform) => {
      const result = resolvePrototypeWindowChrome(
        prototypeSpecSchema.parse(spec({ chrome: "none" })),
        {
          supported: false,
          platform,
        },
      );
      expect(result.refusal).toBe(prototypeWindowChromeUnsupportedMessage(platform));
      expect(result.refusal).toContain(
        platform === "ios" ? "launchApp prototype: true" : "Update the connected CtrlProxy",
      );
      expect(result.effective).toBeUndefined();
    },
  );
  test.each(["none", "bar", "hidden"])("both schemas validate %s", (chrome) => {
    expect(prototypeSpecSchema.safeParse(spec({ chrome })).success).toBe(chrome !== "hidden");
    expect(validatePrototypeSpec(spec({ chrome })).success).toBe(chrome !== "hidden");
  });
  test("omission stays omitted", () => {
    expect(prototypeSpecSchema.parse(spec()).window.chrome).toBeUndefined();
    const validated = validatePrototypeSpec(spec());
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.window.chrome).toBeUndefined();
    }
  });
  for (const supported of [false, true]) {
    for (const persistence of ["session", "device"]) {
      test.each([undefined, "none", "bar"])(
        `fullscreen %p supported=${supported} persistence=${persistence}`,
        (chrome) => {
          const result = resolvePrototypeWindowChrome(
            prototypeSpecSchema.parse(spec({ persistence, ...(chrome ? { chrome } : {}) })),
            { supported, platform: "android" },
          );
          expect(result.requested).toBe(chrome);
          if (!supported && chrome === "none") {
            expect(result.refusal).toContain("prototype_window_chrome_v1");
            expect(result.effective).toBeUndefined();
          } else {
            expect(result.refusal).toBeUndefined();
            expect(result.effective).toBe(
              supported ? (chrome ?? (persistence === "device" ? "bar" : "none")) : "bar",
            );
          }
        },
      );
    }
  }
  for (const placement of [
    { type: "sheet", edge: "bottom", height: 200 },
    { type: "floating", gravity: "center", offset: { x: 0, y: 0 } },
  ]) {
    test.each([undefined, "none", "bar"])(`${placement.type} %p`, (chrome) => {
      for (const supported of [true, false]) {
        const result = resolvePrototypeWindowChrome(
          prototypeSpecSchema.parse(spec({ placement, ...(chrome ? { chrome } : {}) })),
          { supported, platform: "android" },
        );
        expect(result.effective).toBeUndefined();
        expect(result.requested).toBe(chrome);
        if (chrome) {
          expect(result.refusal).toBe(
            "window.chrome applies to a fullscreen placement only; omit it for a sheet or floating window. Nothing was shown.",
          );
        } else {
          expect(result.refusal).toBeUndefined();
        }
      }
    });
  }
});
