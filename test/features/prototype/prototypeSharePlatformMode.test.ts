import { describe, expect, test } from "bun:test";
import {
  prototypePlatformModeSchema,
  prototypeSharePlatformModeRefusal,
} from "../../../src/features/prototype/prototypeSharePlatformMode";

const shareSpec = {
  id: "share",
  window: { placement: { type: "fullscreen" } },
  requires: { platform: ["share"] },
  root: {
    type: "button",
    label: "Share",
    onTap: [{ type: "platform", call: "share.open", args: { text: { value: "Hi" } } }],
  },
};
const plainSpec = {
  id: "plain",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};

describe("show platformMode share (#19308)", () => {
  test("schema takes real or fake for share only", () => {
    for (const share of ["real", "fake"]) {
      expect(prototypePlatformModeSchema.safeParse({ share }).success).toBe(true);
    }
    expect(prototypePlatformModeSchema.safeParse({}).success).toBe(true);
    expect(prototypePlatformModeSchema.safeParse({ share: "native" }).success).toBe(false);
    expect(prototypePlatformModeSchema.safeParse({ media: "fake" }).success).toBe(false);
  });

  test("a share spec shows only in fake mode", () => {
    expect(prototypeSharePlatformModeRefusal(shareSpec, { share: "fake" })).toBeUndefined();
    for (const mode of [undefined, {}, { share: "real" as const }]) {
      const refusal = prototypeSharePlatformModeRefusal(shareSpec, mode);
      expect(refusal).toContain('platformMode: {share: "fake"}');
      expect(refusal).toContain("root.onTap[0]");
      expect(refusal).toContain("Nothing was shown");
    }
  });

  test("declaring share without a call still needs fake mode", () => {
    const declared = { ...plainSpec, requires: { platform: ["share"] } };
    expect(prototypeSharePlatformModeRefusal(declared, undefined)).toContain("requires.platform");
    expect(prototypeSharePlatformModeRefusal(declared, { share: "fake" })).toBeUndefined();
  });

  test("platformMode.share needs share declared, and a spec without share needs no mode", () => {
    expect(prototypeSharePlatformModeRefusal(plainSpec, undefined)).toBeUndefined();
    expect(prototypeSharePlatformModeRefusal(plainSpec, {})).toBeUndefined();
    for (const share of ["real", "fake"] as const) {
      expect(prototypeSharePlatformModeRefusal(plainSpec, { share })).toContain(
        "declares share in requires.platform",
      );
    }
  });
});
