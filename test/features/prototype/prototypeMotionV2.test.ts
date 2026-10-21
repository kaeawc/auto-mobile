import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeMotionV2Fields,
  prototypeMotionV2UnsupportedMessage,
} from "../../../src/features/prototype/prototypeMotionV2";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (root: unknown) => ({
  id: "motion",
  window: { placement: { type: "fullscreen" } },
  state: { on: false },
  root,
});
const text = (extra: Record<string, unknown> = {}) => ({ type: "text", text: "Hi", ...extra });

describe("motion v2 gate (#14208)", () => {
  test("reports animate, the new transitions, scale and rotation, and zoomable", () => {
    const root = {
      type: "column",
      children: [
        text({ animate: {} }),
        text({ transition: "slideStart" }),
        text({ style: { rotation: 15 } }),
        text({ styleWhen: [{ when: { key: "on", equals: true }, style: { scale: 2 } }] }),
        { type: "image", asset: "photo", zoomable: { maxScale: 3 } },
      ],
    };
    expect(prototypeMotionV2Fields(spec(root))).toEqual([
      "root.children[0].animate",
      "root.children[1].transition",
      "root.children[2].style.rotation",
      "root.children[3].styleWhen[0].style.scale",
      "root.children[4].zoomable",
    ]);
    expect(validatePrototypeSpec(spec(root)).success).toBe(true);
    expect(requiredPrototypeCapabilities(spec(root))).toContain("prototype_motion_v2");
  });

  test("the existing transitions and style fields need no gate", () => {
    const root = text({ transition: "slide", style: { alpha: 0.5, pressScale: 0.9 } });
    expect(prototypeMotionV2Fields(spec(root))).toEqual([]);
  });

  test("onDoubleTap is fine on an image that is not zoomable", () => {
    const root = { type: "image", asset: "photo", onDoubleTap: [{ type: "emit", name: "like" }] };
    expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  });

  test("the refusal names the capability and the field", () => {
    const message = prototypeMotionV2UnsupportedMessage(["root.animate"], "ios");
    expect(message).toContain("prototype_motion_v2");
    expect(message).toContain("motion at root.animate.");
  });
});
