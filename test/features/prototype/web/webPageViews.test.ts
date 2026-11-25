import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  prototypeWebPickerScreens,
  renderPrototypeWebPointViews,
  renderPrototypeWebView,
} from "../../../../src/features/prototype/web/webPageViews";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import { bundleForBrowser, type BrowserBundle } from "./browserBundle";

const settings = { frame: "pixel-9", nowMs: 0, imageSlots: new Map<string, number>() };
const portrait = { orientation: "portrait", posture: undefined } as const;
const stacked = {
  id: "stacked",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "stack",
    start: "home",
    screens: {
      settings: { type: "text", text: "Settings" },
      home: { type: "text", text: "Home" },
      about: { type: "text", text: "About" },
    },
  },
};

describe("prototype web page views (#16528)", () => {
  test("the picker offers the start screen, then the others in key order", () => {
    expect(
      prototypeWebPickerScreens({
        start: "home",
        screens: ["about", "home", "settings"],
        screen: "about",
      }),
    ).toEqual(["home", "about", "settings"]);
    expect(prototypeWebPickerScreens({ start: "home", screens: ["home"], screen: "home" })).toEqual(
      [],
    );
    expect(prototypeWebPickerScreens({ start: "gone", screens: ["a", "b"], screen: "a" })).toEqual(
      [],
    );
    expect(prototypeWebPickerScreens(undefined)).toEqual([]);
  });

  test("a view is a hidden [data-view] naming its variant, revision, point and screen", () => {
    const view = renderPrototypeWebView(
      { ...settings, frame: "pixel-fold" },
      { variant: "a", revision: 3, spec: stacked, screen: "about" },
      { orientation: "landscape", posture: "half_opened" },
    );
    expect(view.element.attrs).toEqual({
      "data-view": "",
      "data-variant": "a",
      "data-revision": "3",
      "data-orientation": "landscape",
      "data-posture": "half_opened",
      "data-screen": "about",
      hidden: "",
    });
  });

  test("a stack draws one view per screen, start first, then in authored order", () => {
    const views = renderPrototypeWebPointViews(
      settings,
      { variant: "a", revision: 1, spec: stacked },
      portrait,
    );
    expect(views.map((view) => view.screen)).toEqual(["home", "settings", "about"]);
    expect(toHtml(views[2]!.element)).toContain("About");
    const plain = { ...stacked, root: { type: "text", text: "Hi" } };
    const single = renderPrototypeWebPointViews(
      settings,
      { variant: "a", revision: 1, spec: plain },
      portrait,
    );
    expect(single.map((view) => view.screen)).toEqual([undefined]);
  });
});

describe("prototype web page views bundle for the browser (#16528)", () => {
  let bundle: BrowserBundle;
  beforeAll(async () => {
    bundle = await bundleForBrowser(
      fileURLToPath(
        new URL("../../../../src/features/prototype/web/webPageViews.ts", import.meta.url),
      ),
    );
  });

  test("reaching no Node builtin, dependency or server module", () => {
    expect(bundle.builtins).toEqual([]);
    expect(bundle.inputs.filter((input) => !input.startsWith("src/features/"))).toEqual([]);
  });
});
