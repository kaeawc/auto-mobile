import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrototypeWebPage,
  largestPinnedView,
  MAX_PROTOTYPE_WEB_RUNTIME_BYTES,
  PROTOTYPE_WEB_RUNTIME,
  prototypeWebFrameRotates,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";
import {
  prototypeWebClockDelay,
  prototypeWebClockText,
  prototypeWebFitScale,
  prototypeWebRotation,
  prototypeWebScreenView,
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "../../../../src/features/prototype/web/webPageRuntime";

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const tiny = (text: string) => ({
  id: "tiny",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});
const input: PrototypeWebPageInput = {
  title: "Checkout <v2>",
  variants: [
    {
      id: "a",
      label: "Cart",
      revisions: [
        { revision: 1, operation: "show", spec: tiny("first") },
        { revision: 2, operation: "patch", spec: reference },
      ],
    },
    {
      id: "b",
      label: "One page",
      revisions: [{ revision: 1, operation: "show", spec: tiny("alt") }],
    },
  ],
};
const controls = (html: string) =>
  [...html.slice(0, html.indexOf("<script")).matchAll(/data-control="([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

describe("prototype web page (#16346)", () => {
  const page = buildPrototypeWebPage(input);

  test("the same input yields the same bytes and hash", () => {
    const again = buildPrototypeWebPage(input);
    expect(again.html).toBe(page.html);
    expect(page.sha256).toBe(createHash("sha256").update(page.html).digest("hex"));
  });

  test("pins its only script by hash and loads nothing from the network", () => {
    const hash = createHash("sha256").update(PROTOTYPE_WEB_RUNTIME).digest("base64");
    expect(page.html).toContain(
      `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:`,
    );
    expect(page.html.match(/<script/g)).toHaveLength(1);
    expect(page.html).not.toMatch(/\s(src|href)="(?!data:|#)/);
    expect(page.html).not.toMatch(/@import|url\((?!data:)/);
  });

  test("zooming out never enlarges a preview fitted below 50%", () => {
    expect(prototypeWebZoomScale(0.38, 0.38 / 1.25)).toBe(0.38);
    expect(prototypeWebZoomScale(1, 0.2)).toBe(0.5);
    expect(prototypeWebZoomScale(1, 9)).toBe(4);
    expect(prototypeWebZoomScale(0.38, 0.38 * 1.25)).toBeCloseTo(0.475);
  });

  test("fit keeps the whole frame visible in a tiny viewport and recovers from an empty one", () => {
    const frame = { width: 1000, height: 2000 };
    expect(prototypeWebFitScale({ width: 50, height: 50 }, frame)).toBeCloseTo(0.025 * 0.95);
    expect(prototypeWebFitScale({ width: 0, height: 0 }, frame)).toBe(1);
    expect(prototypeWebFitScale({ width: 9000, height: 9000 }, frame)).toBe(4);
  });

  test("only vertical wheel input zooms", () => {
    expect(prototypeWebWheelFactor(0)).toBeUndefined();
    expect(prototypeWebWheelFactor(-3)).toBe(1.1);
    expect(prototypeWebWheelFactor(3)).toBeCloseTo(1 / 1.1);
  });

  test("the inlined runtime carries every rule it is handed", () => {
    for (const rule of [
      "prototypeWebZoomScale",
      "prototypeWebFitScale",
      "prototypeWebWheelFactor",
      "prototypeWebScreenView",
    ]) {
      expect(PROTOTYPE_WEB_RUNTIME).toContain(`function ${rule}(`);
    }
  });

  test("the clock reads local time in the stills' fixed 9:41 form (#16585)", () => {
    expect(prototypeWebClockText(new Date(2026, 0, 1, 9, 41))).toBe("9:41");
    expect(prototypeWebClockText(new Date(2026, 0, 1, 0, 5))).toBe("12:05");
    expect(prototypeWebClockText(new Date(2026, 0, 1, 12, 0))).toBe("12:00");
    expect(prototypeWebClockText(new Date(2026, 0, 1, 21, 9))).toBe("9:09");
  });

  test("the clock re-arms at the next minute boundary (#16585)", () => {
    expect(prototypeWebClockDelay(0)).toBe(60_000);
    expect(prototypeWebClockDelay(59_999)).toBe(1);
    expect(prototypeWebClockDelay(125_000)).toBe(55_000);
  });

  test("the inlined runtime carries the clock rules and updates the status bar clock", () => {
    expect(PROTOTYPE_WEB_RUNTIME).toContain("function prototypeWebClockText(");
    expect(PROTOTYPE_WEB_RUNTIME).toContain("function prototypeWebClockDelay(");
    expect(PROTOTYPE_WEB_RUNTIME).toContain('[data-status="clock"]');
  });

  test("keeps the runtime within its budget", () => {
    expect(Buffer.byteLength(PROTOTYPE_WEB_RUNTIME)).toBeLessThanOrEqual(
      MAX_PROTOTYPE_WEB_RUNTIME_BYTES,
    );
  });

  test("offers only rotate, zoom and pan, a variant switcher and revision history", () => {
    expect(controls(page.html)).toEqual([
      "revisions",
      "rotate",
      "screen",
      "variant",
      "zoom-fit",
      "zoom-in",
      "zoom-level",
      "zoom-out",
    ]);
  });

  test("hides the variant switcher with a single variant", () => {
    const single = buildPrototypeWebPage({ ...input, variants: [input.variants[1]!] });
    expect(controls(single.html)).not.toContain("variant");
  });

  test("pre-renders both orientations of every inlined revision and shows the latest first", () => {
    expect(page.inlinedRevisions).toEqual({ a: [2, 1], b: [1] });
    // The reference checkout's stack has two screens, so its revision has two views per orientation.
    expect(page.html.match(/data-view=""/g)).toHaveLength(8);
    expect(page.html).toContain(
      '<body data-variant="a" data-revision="2" data-platform="android">',
    );
    expect(page.html.match(/data-view="" hidden=""/g)).toHaveLength(7);
  });

  test("lists revisions newest first with the operation that made them", () => {
    const history = page.html.slice(page.html.indexOf('data-control="revisions"'));
    expect(history.indexOf("r2 · patch")).toBeLessThan(history.indexOf("r1 · show"));
  });

  test("escapes the title", () => {
    expect(page.html).toContain("<title>Checkout &lt;v2&gt;</title>");
  });

  test("reports the unsupported nodes of the view shown first", () => {
    expect(page.unsupportedNodes.map((node) => node.type)).toEqual(["progress"]);
  });

  test("drops older revisions to stay within the budget, keeping each variant's latest", () => {
    const maxBytes = Buffer.byteLength(page.html) - 1000;
    const small = buildPrototypeWebPage({ ...input, maxBytes });
    expect(small.inlinedRevisions.a).toEqual([2]);
    expect(Buffer.byteLength(small.html)).toBeLessThanOrEqual(maxBytes);
  });

  test("a requested older revision is kept within the budget like each latest", () => {
    const [a, b] = input.variants;
    const three = {
      ...input,
      variants: [
        {
          ...a!,
          revisions: [
            ...a!.revisions,
            { revision: 3, operation: "patch" as const, spec: tiny("third") },
          ],
        },
        b!,
      ],
    };
    // More than revision 2's second screen, so revision 2 cannot stay even with its start alone.
    const maxBytes = Buffer.byteLength(buildPrototypeWebPage(three).html) - 8000;
    const pinned = buildPrototypeWebPage({ ...three, revision: 1, maxBytes });
    expect(pinned.inlinedRevisions.a).toEqual([3, 1]);
    expect(pinned.html).toContain(
      '<body data-variant="a" data-revision="1" data-platform="android">',
    );
    expect(Buffer.byteLength(pinned.html)).toBeLessThanOrEqual(maxBytes);
  });

  test("a page that exactly fits its budget keeps every revision", () => {
    const exact = buildPrototypeWebPage({ ...input, maxBytes: Buffer.byteLength(page.html) });
    expect(exact.inlinedRevisions).toEqual(page.inlinedRevisions);
    expect(exact.html).toBe(page.html);
  });

  test("a variant with no revisions is not offered in the switcher", () => {
    const withEmpty = buildPrototypeWebPage({
      ...input,
      variants: [...input.variants, { id: "empty", label: "Empty", revisions: [] }],
    });
    expect(withEmpty.html).not.toContain('value="empty"');
    expect(withEmpty.html).toContain('value="b"');
  });

  test("refuses when even the latest revisions do not fit, naming the largest view", () => {
    expect(() => buildPrototypeWebPage({ ...input, maxBytes: 10 * 1024 })).toThrow(
      /would exceed 10240 bytes even with only the latest revision of each variant and the revision shown first\. Largest view: variant a revision 2/,
    );
  });

  test("names the largest single view, even outside the group with the most bytes", () => {
    const view = (variant: string, bytes: number) => ({ variant, html: "x".repeat(bytes) });
    // Group a holds more bytes in all (180), but group b holds the largest view (120).
    const largest = largestPinnedView([
      [view("a", 90), view("a", 90)],
      [view("b", 40), view("b", 120)],
    ]);
    expect(largest.variant).toBe("b");
    expect(largest.html).toHaveLength(120);
  });

  test("an unknown variant lists the valid ones", () => {
    expect(() => buildPrototypeWebPage({ ...input, variant: "z" })).toThrow(
      'Unknown or empty prototype variant "z". Variants: a, b',
    );
  });
});

describe("prototype web page chrome (#16382)", () => {
  const page = buildPrototypeWebPage(input);
  const style = (html: string) => html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

  test("a page with only one revision shows no revision history", () => {
    const single = buildPrototypeWebPage({ ...input, variants: [input.variants[1]!] });
    expect(controls(single.html)).not.toContain("revisions");
    expect(controls(page.html)).toContain("revisions");
  });

  test("a page whose older revisions were dropped shows no revision history", () => {
    const both = buildPrototypeWebPage({ ...input, variants: [input.variants[0]!] });
    const full = Buffer.byteLength(both.html);
    const trimmed = buildPrototypeWebPage({
      ...input,
      variants: [input.variants[0]!],
      maxBytes: full - 1,
    });
    expect(trimmed.inlinedRevisions).toEqual({ a: [2] });
    expect(controls(trimmed.html)).not.toContain("revisions");
  });

  test("a narrow viewport stacks the history below the stage", () => {
    const css = style(page.html);
    const narrow = css.slice(css.indexOf("@media (max-width:"));
    expect(narrow).toContain("[data-main]{flex-direction:column}");
    expect(narrow).toContain("[data-control=revisions]{width:auto");
  });

  test("says the preview is static", () => {
    const note = page.html.slice(page.html.indexOf("data-note"), page.html.indexOf("<script"));
    expect(note).toContain("Static preview");
    expect(note).toContain("taps do nothing");
  });
});

describe("prototype web page screen picker (#16382)", () => {
  const screen = (id: string, text: string) => ({ type: "text", text: `${id}: ${text}` });
  /** A stack whose screens are authored in `ids` order and start at `start`. */
  const stackSpec = (start: string, ids: readonly string[], text = "") => ({
    id: "stacked",
    root: {
      type: "stack",
      start,
      screens: Object.fromEntries(ids.map((id) => [id, screen(id, text)])),
    },
  });
  const pageOf = (...specs: unknown[]) =>
    buildPrototypeWebPage({
      title: "Stack",
      variants: [
        {
          id: "a",
          label: "A",
          revisions: specs.map((spec, index) => ({
            revision: index + 1,
            operation: index === 0 ? ("show" as const) : ("patch" as const),
            spec,
          })),
        },
      ],
    });
  /** Each view's value of one attribute, in page order (attributes are written sorted). */
  const attrsOf = (html: string, name: string) =>
    [...html.matchAll(/<div (data-orientation="[^>]*data-view="")[^>]*>/g)].map(
      (match) => new RegExp(`${name}="([^"]*)"`).exec(match[1]!)?.[1],
    );
  const picker = (html: string) => {
    const at = html.indexOf('data-control="screen"');
    if (at < 0) {
      return undefined;
    }
    const select = html.slice(at, html.indexOf("</select>", at));
    return [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
  };
  const shownScreen = (html: string) =>
    /<div data-orientation="[^"]*" data-revision="[^"]*" data-screen="([^"]*)" data-variant="[^"]*" data-view="">/.exec(
      html,
    )?.[1];

  test("offers a screen picker only for a stack with more than one screen", () => {
    expect(controls(pageOf(stackSpec("b", ["a", "b"])).html)).toContain("screen");
    expect(controls(pageOf(stackSpec("a", ["a"])).html)).not.toContain("screen");
    expect(controls(pageOf(tiny("plain")).html)).not.toContain("screen");
  });

  test("a page without a multi-screen stack has no screen views", () => {
    expect(pageOf(stackSpec("a", ["a"])).html).not.toContain("data-screen");
    expect(pageOf(tiny("plain")).html).not.toContain("data-screen");
  });

  test("pre-renders both orientations of every screen, start first, and shows the start", () => {
    const { html } = pageOf(stackSpec("b", ["a", "b", "c"]));
    expect(attrsOf(html, "data-screen")).toEqual(["b", "b", "a", "a", "c", "c"]);
    expect(attrsOf(html, "data-orientation")).toEqual([
      "portrait",
      "landscape",
      "portrait",
      "landscape",
      "portrait",
      "landscape",
    ]);
    expect(html).toContain("b: </span>");
    expect(html).toContain("c: </span>");
    expect(shownScreen(html)).toBe("b");
    expect(html.match(/data-view="" hidden=""/g)).toHaveLength(5);
    expect(picker(html)).toEqual(["b", "a", "c"]);
    expect(html).toContain('<select aria-label="Screen" data-control="screen">');
  });

  test("the start screen's view is the page's view without a picker", () => {
    const { html } = pageOf(stackSpec("a", ["a", "b"]));
    const single = pageOf(stackSpec("a", ["a"])).html;
    const shown = (page: string) =>
      /data-view="">(.*?)<\/div><div data-orientation="landscape"/.exec(page)?.[1];
    expect(shown(html)).toBeDefined();
    expect(shown(html)).toBe(shown(single));
  });

  test("lists the shown revision's screens; every revision keeps its own views", () => {
    const { html } = pageOf(stackSpec("x", ["x", "y"]), stackSpec("a", ["a", "b", "c"]));
    expect(picker(html)).toEqual(["a", "b", "c"]);
    expect(attrsOf(html, "data-revision")).toEqual([
      "2",
      "2",
      "2",
      "2",
      "2",
      "2",
      "1",
      "1",
      "1",
      "1",
    ]);
    expect(attrsOf(html, "data-screen")).toEqual([
      "a",
      "a",
      "b",
      "b",
      "c",
      "c",
      "x",
      "x",
      "y",
      "y",
    ]);
  });

  test("keeps the start screen and as many others as fit when the latest's screens do not", () => {
    const spec = stackSpec("a", ["a", "b", "c"], "x".repeat(4000));
    const full = Buffer.byteLength(pageOf(spec).html);
    const page = buildPrototypeWebPage({
      title: "Stack",
      maxBytes: full - 1,
      variants: [{ id: "a", label: "A", revisions: [{ revision: 1, operation: "show", spec }] }],
    });
    expect(attrsOf(page.html, "data-screen")).toEqual(["a", "a", "b", "b"]);
    expect(picker(page.html)).toEqual(["a", "b"]);
    expect(Buffer.byteLength(page.html)).toBeLessThanOrEqual(full - 1);
  });

  test("keeps every screen of the latest revision before an older revision", () => {
    const older = stackSpec("x", ["x", "y"], "o".repeat(4000));
    const latest = stackSpec("a", ["a", "b"], "n".repeat(4000));
    const latestOnly = Buffer.byteLength(pageOf(latest).html);
    const both = pageOf(older, latest);
    const maxBytes = latestOnly + 1000;
    const page = buildPrototypeWebPage({
      title: "Stack",
      maxBytes,
      variants: [
        {
          id: "a",
          label: "A",
          revisions: [
            { revision: 1, operation: "show", spec: older },
            { revision: 2, operation: "patch", spec: latest },
          ],
        },
      ],
    });
    expect(both.inlinedRevisions).toEqual({ a: [2, 1] });
    expect(page.inlinedRevisions).toEqual({ a: [2] });
    expect(attrsOf(page.html, "data-screen")).toEqual(["a", "a", "b", "b"]);
    expect(Buffer.byteLength(page.html)).toBeLessThanOrEqual(maxBytes);
  });

  test("an older revision keeps its start screen and as many others as fit", () => {
    const older = stackSpec("x", ["x", "y"], "o".repeat(4000));
    const latest = stackSpec("a", ["a", "b"], "n".repeat(4000));
    const maxBytes = Buffer.byteLength(pageOf(older, latest).html) - 1;
    const page = buildPrototypeWebPage({
      title: "Stack",
      maxBytes,
      variants: [
        {
          id: "a",
          label: "A",
          revisions: [
            { revision: 1, operation: "show", spec: older },
            { revision: 2, operation: "patch", spec: latest },
          ],
        },
      ],
    });
    expect(page.inlinedRevisions).toEqual({ a: [2, 1] });
    expect(attrsOf(page.html, "data-screen")).toEqual(["a", "a", "b", "b", "x", "x"]);
    expect(Buffer.byteLength(page.html)).toBeLessThanOrEqual(maxBytes);
  });

  test("the runtime shows the chosen screen's view, else the revision's first (its start)", () => {
    const view = (screen?: string) => ({ dataset: screen === undefined ? {} : { screen } });
    const start = view("a");
    const other = view("b");
    expect(prototypeWebScreenView([start, other], "b")).toBe(other);
    expect(prototypeWebScreenView([start, other], "gone")).toBe(start);
    const plain = view();
    expect(prototypeWebScreenView([plain], "b")).toBe(plain);
    expect(prototypeWebScreenView([], "a")).toBeUndefined();
  });
});

describe("prototype web page rotation (#16545)", () => {
  const transforms = (frames: Keyframe[]) => frames.map((frame) => frame.transform);
  const opacities = (frames: Keyframe[]) => frames.map((frame) => frame.opacity);

  test("turns the frame a quarter counterclockwise into landscape, both views tracking one frame", () => {
    const turn = prototypeWebRotation("android", "landscape");
    expect(transforms(turn.outgoing)).toEqual([
      "translate(-50%, -50%) rotate(0deg)",
      "translate(-50%, -50%) rotate(-90deg)",
    ]);
    expect(transforms(turn.incoming)).toEqual([
      "translate(-50%, -50%) rotate(90deg)",
      "translate(-50%, -50%) rotate(0deg)",
    ]);
  });

  test("turns back clockwise into portrait", () => {
    const turn = prototypeWebRotation("android", "portrait");
    expect(turn.outgoing.at(-1)?.transform).toBe("translate(-50%, -50%) rotate(90deg)");
    expect(turn.incoming[0]?.transform).toBe("translate(-50%, -50%) rotate(-90deg)");
  });

  test("Android cross-fades the content over the whole turn", () => {
    const turn = prototypeWebRotation("android", "landscape");
    expect(turn.durationMs).toBe(500);
    expect(opacities(turn.outgoing)).toEqual([1, 0]);
    expect(opacities(turn.incoming)).toEqual([0, 1]);
  });

  test("iOS hands over to the new layout in the first quarter of the turn", () => {
    const turn = prototypeWebRotation("ios", "landscape");
    expect(turn.durationMs).toBe(400);
    expect(turn.incoming.map((frame) => [frame.offset, frame.opacity])).toEqual([
      [0, 0],
      [0.25, 1],
      [1, 1],
    ]);
    expect(turn.outgoing[1]).toEqual({
      transform: "translate(-50%, -50%) rotate(-22.5deg)",
      opacity: 0,
      offset: 0.25,
    });
  });

  test("ends every turn upright, so the end state is the plain landscape view", () => {
    for (const platform of ["android", "ios"]) {
      for (const to of ["portrait", "landscape"] as const) {
        expect(prototypeWebRotation(platform, to).incoming.at(-1)).toMatchObject({
          transform: "translate(-50%, -50%) rotate(0deg)",
          opacity: 1,
        });
      }
    }
  });

  test("watches and TVs never rotate", () => {
    expect(["phone", "tablet", "foldable", "automotive"].map(prototypeWebFrameRotates)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(prototypeWebFrameRotates("watch")).toBe(false);
    expect(prototypeWebFrameRotates("tv")).toBe(false);
  });

  test("tells the runtime the frame's platform and inlines the rotation rule", () => {
    const ios = buildPrototypeWebPage({ ...input, frame: "iphone-16" });
    expect(ios.html).toContain('data-platform="ios"');
    expect(buildPrototypeWebPage(input).html).toContain('data-platform="android"');
    expect(PROTOTYPE_WEB_RUNTIME).toContain("rotation: ");
    expect(PROTOTYPE_WEB_RUNTIME).toContain("prefers-reduced-motion: reduce");
  });
});
