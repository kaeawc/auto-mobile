import { describe, expect, test } from "bun:test";
import { bootPrototypeWebPage } from "../../../../../src/features/prototype/web/embed/prototypeWebPageBoot";
import {
  prototypeWebPageJson,
  type PrototypeWebPageData,
} from "../../../../../src/features/prototype/web/webPageData";

const stacked = {
  id: "stacked",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "stack",
    start: "home",
    screens: { home: { type: "text", text: "Home" }, about: { type: "text", text: "About" } },
  },
};
const data: PrototypeWebPageData = {
  frame: "pixel-9",
  nowMs: 0,
  imageSlots: [],
  glyphs: {},
  revisions: [{ variant: "a", revision: 2, spec: stacked }],
};

/** A page whose views are the inserted markup's `[data-view]` attributes. */
function fakePage(dataText: string | null, held: Record<string, string>[] = []) {
  const inserted: string[] = [];
  const views = () => [
    ...held.map((dataset) => ({ dataset })),
    ...inserted.map((html) => ({
      dataset: Object.fromEntries(
        [...html.slice(0, html.indexOf(">")).matchAll(/data-(\w+)="([^"]*)"/g)].map((match) => [
          match[1]!,
          match[2]!,
        ]),
      ),
    })),
  ];
  return {
    inserted,
    dom: { dataText: () => dataText, views, insert: (html: string) => void inserted.push(html) },
  };
}

const portrait = { variant: "a", revision: "2", orientation: "portrait", posture: "" };

describe("bootPrototypeWebPage (#16528)", () => {
  test("a page without a data block gets no ensureViews", () => {
    expect(bootPrototypeWebPage(fakePage(null).dom)).toBeUndefined();
  });

  test("draws each of a key's screens once, start first, from the data", () => {
    const page = fakePage(prototypeWebPageJson(data));
    const ensureViews = bootPrototypeWebPage(page.dom)!;
    expect(ensureViews(portrait)).toBe(true);
    expect(page.inserted.map((html) => /data-screen="(\w+)"/.exec(html)?.[1])).toEqual([
      "home",
      "about",
    ]);
    expect(page.inserted.every((html) => html.includes('data-view="" hidden=""'))).toBe(true);
    expect(ensureViews(portrait)).toBe(false);
    expect(page.inserted).toHaveLength(2);
  });

  test("skips the screens the page already holds, such as the host's first view", () => {
    const held = [
      { view: "", variant: "a", revision: "2", orientation: "portrait", screen: "home" },
    ];
    const page = fakePage(prototypeWebPageJson(data), held);
    expect(bootPrototypeWebPage(page.dom)!(portrait)).toBe(true);
    expect(page.inserted.map((html) => /data-screen="(\w+)"/.exec(html)?.[1])).toEqual(["about"]);
  });

  test("draws nothing for a revision the page did not inline", () => {
    const page = fakePage(prototypeWebPageJson(data));
    expect(bootPrototypeWebPage(page.dom)!({ ...portrait, revision: "1" })).toBe(false);
    expect(page.inserted).toEqual([]);
  });

  test("reads back a spec whose text holds a closing script tag", () => {
    const spec = { ...stacked, root: { type: "text", text: "</script>" } };
    const json = prototypeWebPageJson({
      ...data,
      revisions: [{ variant: "a", revision: 2, spec }],
    });
    expect(json).not.toContain("</script>");
    const page = fakePage(json);
    bootPrototypeWebPage(page.dom)!(portrait);
    expect(page.inserted[0]).toContain("&lt;/script&gt;");
  });
});
