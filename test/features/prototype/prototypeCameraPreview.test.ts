import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeCameraCallError,
  prototypeCameraPreviewIds,
} from "../../../src/features/prototype/prototypeCameraPreview";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const preview = { type: "cameraPreview", id: "vf", lensKey: "lens", zoomKey: "zoom" };

function spec(children: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "camera",
    window: { placement: { type: "fullscreen" } },
    state: { lens: "back", zoom: 0 },
    requires: {
      platform: ["camera"],
      permissions: [{ name: "camera", purpose: "Show the viewfinder" }],
    },
    ...extra,
    root: { type: "column", children },
  };
}

const takePhoto = (value: string) => ({
  type: "button",
  label: "Shoot",
  onTap: [{ type: "platform", call: "camera.takePhoto", args: { preview: { value } } }],
});

describe("cameraPreview nodes", () => {
  test("a viewfinder with its photo call validates and needs the camera capability", () => {
    const valid = spec([preview, takePhoto("vf")]);
    expect(validatePrototypeSpec(valid).success).toBe(true);
    expect(requiredPrototypeCapabilities(valid)).toContain("prototype_platform_camera_v1");
  });

  test("collects preview ids from node positions", () => {
    expect([...prototypeCameraPreviewIds(spec([preview]))]).toEqual(["vf"]);
  });

  test("a call naming no viewfinder is refused at its value", () => {
    expect(validatePrototypeSpec(spec([preview, takePhoto("other")]))).toEqual({
      success: false,
      error: {
        path: "root.children[1].onTap[0].args.preview.value",
        message: "Unknown camera preview",
      },
    });
  });

  test("a state-bound preview is resolved at runtime, so only literals are checked", () => {
    const action = { call: "camera.takePhoto", args: { preview: { state: "lens" } } };
    expect(prototypeCameraCallError(action, "a", new Set())).toBeUndefined();
  });

  test("a second viewfinder is refused", () => {
    expect(validatePrototypeSpec(spec([preview, { type: "cameraPreview", id: "vf2" }]))).toEqual({
      success: false,
      error: { path: "root.children[1]", message: "At most one cameraPreview per prototype" },
    });
  });

  test("the viewfinder needs the camera permission", () => {
    const result = validatePrototypeSpec(spec([preview], { requires: { platform: ["camera"] } }));
    expect(result).toEqual({
      success: false,
      error: {
        path: "root.children[0]",
        message: "cameraPreview requires permission camera in requires.permissions",
      },
    });
  });

  test("lens and zoom keys name declared state of the right type", () => {
    const wrong = spec([preview], { state: { lens: 1, zoom: 0 } });
    expect(validatePrototypeSpec(wrong)).toEqual({
      success: false,
      error: {
        path: "root.children[0].lensKey",
        message: "lensKey must name a declared string state key",
      },
    });
  });
});
