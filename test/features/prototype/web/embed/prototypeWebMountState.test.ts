import { describe, expect, test } from "bun:test";
import {
  mergePrototypeMountOptions,
  prototypeWebControls,
  prototypeWebNextOrientation,
  prototypeWebViewEvents,
  prototypeWebZoomOption,
  prototypeWebZoomStep,
  type PrototypeViewState,
} from "../../../../../src/features/prototype/web/embed/prototypeWebMountState";

const view: PrototypeViewState = {
  frame: "pixel-9",
  orientation: "portrait",
  zoom: "fit",
  scale: 1,
  mode: "light",
  screen: "home",
  screens: ["home", "detail"],
  unsupportedNodes: [],
};

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    events: {
      onRender: () => calls.push("render"),
      onScreenChange: ({ screen }: { screen: string }) => calls.push(`screen:${screen}`),
      onOrientationChange: ({ orientation }: { orientation: string }) =>
        calls.push(`orientation:${orientation}`),
      onZoomChange: ({ scale }: { scale: number }) => calls.push(`zoom:${scale}`),
      onError: ({ code }: { code: string }) => calls.push(`error:${code}`),
    },
  };
}

describe("mount state rules (#16453)", () => {
  test("controls default to all three; false draws none; unknown names drop", () => {
    expect([...prototypeWebControls(undefined)]).toEqual(["rotate", "zoom", "screen"]);
    expect([...prototypeWebControls(false)]).toEqual([]);
    expect([...prototypeWebControls(["zoom"])]).toEqual(["zoom"]);
  });

  test("a numeric zoom clamps to 0.5–4 and anything else fits", () => {
    expect(prototypeWebZoomOption(10)).toBe(4);
    expect(prototypeWebZoomOption(0.1)).toBe(0.5);
    expect(prototypeWebZoomOption(2)).toBe(2);
    expect(prototypeWebZoomOption(Number.NaN)).toBe("fit");
    expect(prototypeWebZoomOption(undefined)).toBe("fit");
  });

  test("zoom steps by 1.25 within the page's bounds", () => {
    expect(prototypeWebZoomStep(1, 1)).toBe(1.25);
    expect(prototypeWebZoomStep(1, -1)).toBe(0.8);
    expect(prototypeWebZoomStep(4, 1)).toBe(4);
    expect(prototypeWebZoomStep(0.3, -1)).toBe(0.3);
  });

  test("rotate turns through the frame's orientations, none with one", () => {
    expect(prototypeWebNextOrientation("portrait", ["portrait", "landscape"])).toBe("landscape");
    expect(prototypeWebNextOrientation("landscape", ["portrait", "landscape"])).toBe("portrait");
    expect(prototypeWebNextOrientation("landscape", ["landscape"])).toBeUndefined();
  });

  test("update keeps unset options, the view and the callbacks", () => {
    const onRender = () => undefined;
    const merged = mergePrototypeMountOptions(
      { spec: 1, zoom: 2, screen: "detail", onRender },
      { spec: 2, screen: undefined },
    );
    expect(merged).toEqual({ spec: 2, zoom: 2, screen: "detail", onRender });
  });

  test("a redraw fires render, then what changed", () => {
    const { calls, events } = recorder();
    prototypeWebViewEvents(undefined, view, events);
    prototypeWebViewEvents(
      view,
      { ...view, orientation: "landscape", screen: "detail", scale: 2 },
      events,
    );
    expect(calls).toEqual(["render", "render", "orientation:landscape", "screen:detail", "zoom:2"]);
  });

  test("an error view fires only error", () => {
    const { calls, events } = recorder();
    const error = {
      code: "unknownVersion" as const,
      message: "",
      missing: [],
      libraryVersion: "1",
    };
    prototypeWebViewEvents(view, { ...view, orientation: "landscape", error }, events);
    expect(calls).toEqual(["error:unknownVersion"]);
  });
});
