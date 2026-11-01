import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_IOS_MINIMUM_OS,
  prototypeIosMinimumOsNote,
} from "../../../src/features/prototype/prototypeIosMinimumOs";
import { PROTOTYPE_CHART_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { specCapabilityRefusal } from "../../../src/server/prototypeTools/preflight";

const chartSpec = { root: { type: "chart" } };
const iosTarget = (advertised: readonly string[]) => ({
  ios: { supportsCapability: (name: string) => advertised.includes(name) },
});

describe("prototype iOS minimum OS (#15242)", () => {
  test("the host refusal names the iOS version a gated capability needs", async () => {
    const refusal = await specCapabilityRefusal(iosTarget([]), chartSpec, undefined, {
      iosMinimumOs: {
        [PROTOTYPE_CHART_CAPABILITY]: 18,
      },
    });

    expect(refusal?.success).toBe(false);
    expect(refusal?.error).toContain("connected iOS prototype agent");
    expect(refusal?.error).toContain("It needs iOS 18 or later.");
  });

  test("a capability on the iOS floor gets the plain refusal", async () => {
    const refusal = await specCapabilityRefusal(iosTarget([]), chartSpec, undefined, {
      iosMinimumOs: {},
    });

    expect(refusal?.success).toBe(false);
    expect(refusal?.error).not.toContain("It needs iOS");
  });

  test("an agent that advertises the capability is not refused", async () => {
    await expect(
      specCapabilityRefusal(iosTarget([PROTOTYPE_CHART_CAPABILITY]), chartSpec, undefined, {
        iosMinimumOs: {
          [PROTOTYPE_CHART_CAPABILITY]: 18,
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("Android refusals never carry an iOS version note", async () => {
    const android = { supportsCommand: async () => false };
    const refusal = await specCapabilityRefusal({ android }, chartSpec, undefined, {
      iosMinimumOs: {
        [PROTOTYPE_CHART_CAPABILITY]: 18,
      },
    });

    expect(refusal?.error).not.toContain("It needs iOS");
  });

  test("the note is empty for a capability outside the table", () => {
    expect(prototypeIosMinimumOsNote("prototype_unknown_v1", { prototype_x_v1: 26 })).toBe("");
    expect(prototypeIosMinimumOsNote("prototype_x_v1", { prototype_x_v1: 26 })).toBe(
      " It needs iOS 26 or later.",
    );
  });

  test("the host table matches the Swift agent table entry for entry", () => {
    const swift = readFileSync(
      join(
        import.meta.dir,
        "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/AutoMobilePrototypeCapabilities.swift",
      ),
      "utf8",
    );
    const block = /static let table(?:: \[String: Int\])? = \[([^\]]*)\]/.exec(swift)?.[1] ?? "";
    const entries = [...block.matchAll(/"(prototype_[a-z0-9_]+)":\s*(\d+)/g)].map(
      ([, name, major]) => [name, Number(major)] as const,
    );

    expect(Object.fromEntries(entries)).toEqual({ ...PROTOTYPE_IOS_MINIMUM_OS });
  });
});
