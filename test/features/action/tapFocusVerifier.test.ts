import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import cartAItem44Focused from "../../fixtures/ios/nested-selection/cart-a-item-44-quantity-focused.json";
import { describe, expect, test } from "bun:test";
import { FocusVerifier } from "../../../src/features/action/tapFocusVerifier";
import type { BootedDevice } from "../../../src/models";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";

const device = { platform: "android", deviceId: "emu", name: "emu" } as BootedDevice;

function verifier(onFind: () => void = () => {}) {
  return new FocusVerifier({
    device,
    findElementInHierarchy: () => {
      onFind();
      throw new Error("scope unresolved");
    },
    withObservationScreenSize: (options) => options,
  });
}

describe("FocusVerifier", () => {
  const target = { text: "Search", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
  const options = { text: "Search", action: "focus" } as const;

  test("an observation without a hierarchy is unconfirmed", () => {
    expect(verifier().verify(options, target, undefined)).toBe(false);
    expect(verifier().verify(options, target, {} as ObserveResult)).toBe(false);
  });

  test("an unresolvable selector scope means not confirmed rather than an error", () => {
    let finds = 0;
    const observation: Partial<ObserveResult> = {
      viewHierarchy: { hierarchy: { node: createFlatNodeForTest({ node: [] }) } },
    };
    expect(
      verifier(() => (finds += 1)).verify(options, target, observation as ObserveResult, {
        labelText: "Search",
        selectedIndex: 0,
      }),
    ).toBe(false);
  });
});

describe("FocusVerifier on iOS (#13539)", () => {
  // Captured iOS Playground screen with one focused UITextField; the field is made id-less and
  // given the text a value-holding field exposes once focused, as in the Safari tab search field.
  const iosDevice = { platform: "ios", deviceId: "sim", name: "sim" } as BootedDevice;
  const iosVerifier = () =>
    new FocusVerifier({
      device: iosDevice,
      findElementInHierarchy: () => {
        throw new Error("scope unresolved");
      },
      withObservationScreenSize: (options) => options,
    });

  function focusedObservation(focusedText: string): ObserveResult {
    const { viewHierarchy }: { viewHierarchy: unknown } = structuredClone(cartAItem44Focused);
    const strip = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(strip);
      } else if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (node.focused === "true" && node.className === "UITextField") {
          delete node["resource-id"];
          delete node["hint-text"];
          delete node.node;
          node.text = focusedText;
        }
        Object.values(node).forEach(strip);
      }
    };
    strip(viewHierarchy);
    const observation: Partial<ObserveResult> = {
      viewHierarchy: viewHierarchy as ViewHierarchyResult,
    };
    return observation as ObserveResult;
  }

  const target = {
    className: "UITextField",
    role: "textfield",
    text: "Search Tabs",
    bounds: { left: 12, top: 420, right: 296, bottom: 454 },
  };
  const options = { text: "Search Tabs", action: "focus" } as const;

  test("a focused field holding text is the target even though its text changed", () => {
    expect(
      iosVerifier().verify(options, target, focusedObservation("tabsearch"), {
        labelText: "Search Tabs",
      }),
    ).toBe(true);
  });

  test("a focused field elsewhere on screen is not the target", () => {
    const elsewhere = { ...target, bounds: { left: 12, top: 100, right: 296, bottom: 134 } };
    expect(
      iosVerifier().verify(options, elsewhere, focusedObservation("tabsearch"), {
        labelText: "Search Tabs",
      }),
    ).toBe(false);
  });
});
