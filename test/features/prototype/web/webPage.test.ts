import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrototypeWebPage,
  PROTOTYPE_WEB_PAGE_SCRIPT,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";
import { prototypeWebPageBundle } from "../../../../src/features/prototype/web/prototypeWebPageBundle";
import {
  prototypeWebClockDelay,
  prototypeWebClockText,
  prototypeWebFitScale,
  prototypeWebHeldView,
  prototypeWebRelayout,
  prototypeWebRotation,
  prototypeWebScreenView,
  prototypeWebStartClock,
  prototypeWebViewMatches,
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "../../../../src/features/prototype/web/webPageRuntime";
import { webPageData, webPageDrawnViews, webPageShownView } from "./webPageDrawn";

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
/** Every view the page shows once each is visited: the host's first, then the bundle's. */
const drawn = (page: { readonly html: string }) => webPageDrawnViews(page.html);
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

  test("pins its only script, the page bundle, by hash and loads nothing from the network", () => {
    expect(PROTOTYPE_WEB_PAGE_SCRIPT).toBe(prototypeWebPageBundle());
    const hash = createHash("sha256").update(PROTOTYPE_WEB_PAGE_SCRIPT).digest("base64");
    expect(page.html).toContain(
      `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:`,
    );
    // One script runs; the other is the JSON data block, which a browser never executes.
    expect(page.html.match(/<script>/g)).toHaveLength(1);
    expect(
      page.html.match(/<script type="application\/json" data-prototype-page="">/g),
    ).toHaveLength(1);
    expect(page.html.match(/<script/g)).toHaveLength(2);
    const markup = page.html.replace(PROTOTYPE_WEB_PAGE_SCRIPT, "");
    expect(markup).not.toMatch(/\s(src|href)="(?!data:|#)/);
    expect(markup).not.toMatch(/@import|url\((?!data:)/);
    // The script draws only `data:` and in-document `#` references, as the host's stills do.
    expect(PROTOTYPE_WEB_PAGE_SCRIPT).not.toMatch(/@import|url\((?!data:|#)/);
  });

  test("declares an empty icon, so no browser fetches /favicon.ico against the CSP (#16459)", () => {
    expect(page.html).toContain('<link rel="icon" href="data:,">');
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

  test("the data block names every inlined revision's spec, and no spec text can close it", () => {
    const data = webPageData(page.html);
    expect(data.revisions.map((entry) => [entry.variant, entry.revision])).toEqual([
      ["a", 2],
      ["a", 1],
      ["b", 1],
    ]);
    expect(data.revisions[0]!.spec).toEqual(reference);
    expect(data.frame).toBe("pixel-9");
    // The title's `<v2>` is in the page, so a spec holding `</script>` would be escaped too.
    const closing = buildPrototypeWebPage({
      ...input,
      variants: [
        {
          id: "a",
          label: "A",
          revisions: [{ revision: 1, operation: "show", spec: tiny("</script><!--") }],
        },
      ],
    });
    expect(webPageData(closing.html).revisions[0]!.spec).toEqual(tiny("</script><!--"));
    expect(closing.html.match(/<\/script>/g)).toHaveLength(2);
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

  test("the clock writes every mark now and again at each minute boundary (#16585)", () => {
    let nowMs = new Date(2026, 0, 1, 13, 7, 30).getTime();
    const pending: { run: () => void; ms: number }[] = [];
    const clock = {
      now: () => nowMs,
      schedule: (run: () => void, ms: number) => void pending.push({ run, ms }),
    };
    const marks = [{ textContent: "9:41" as string | null }, { textContent: "9:41" }];
    const format = { clockText: prototypeWebClockText, clockDelay: prototypeWebClockDelay };
    prototypeWebStartClock(
      { querySelectorAll: (selector) => (selector === '[data-status="clock"]' ? marks : []) },
      clock,
      format,
    );
    expect(marks.map((mark) => mark.textContent)).toEqual(["1:07", "1:07"]);
    expect(pending.map((entry) => entry.ms)).toEqual([30_000]);
    nowMs += 30_000;
    pending.shift()!.run();
    expect(marks.map((mark) => mark.textContent)).toEqual(["1:08", "1:08"]);
    expect(pending.map((entry) => entry.ms)).toEqual([60_000]);
  });

  test("the clock schedules nothing for a page without clock marks", () => {
    const pending: number[] = [];
    const clock = {
      now: () => 0,
      schedule: (_run: () => void, ms: number) => void pending.push(ms),
    };
    prototypeWebStartClock({ querySelectorAll: () => [] }, clock, {
      clockText: prototypeWebClockText,
      clockDelay: prototypeWebClockDelay,
    });
    expect(pending).toEqual([]);
  });

  test("a view drawn after the start is synced at once and starts the ticks it needs (#16528)", () => {
    let nowMs = new Date(2026, 0, 1, 13, 7, 30).getTime();
    const pending: { run: () => void; ms: number }[] = [];
    const clock = {
      now: () => nowMs,
      schedule: (run: () => void, ms: number) => void pending.push({ run, ms }),
    };
    const marks: { textContent: string | null }[] = [];
    const format = { clockText: prototypeWebClockText, clockDelay: prototypeWebClockDelay };
    const sync = prototypeWebStartClock({ querySelectorAll: () => marks }, clock, format);
    expect(pending).toEqual([]);
    marks.push({ textContent: "9:41" });
    sync();
    expect(marks.map((mark) => mark.textContent)).toEqual(["1:07"]);
    expect(pending.map((entry) => entry.ms)).toEqual([30_000]);
    marks.push({ textContent: "9:41" });
    sync();
    // Already ticking: the new mark is written, and no second tick is scheduled.
    expect(marks.map((mark) => mark.textContent)).toEqual(["1:07", "1:07"]);
    expect(pending).toHaveLength(1);
    nowMs += 30_000;
    pending.shift()!.run();
    expect(marks.map((mark) => mark.textContent)).toEqual(["1:08", "1:08"]);
  });

  test("the page script is the bundle that runs the runtime and draws from the data", () => {
    for (const marker of ['[data-status="clock"]', "data-prototype-page", "[data-view]"]) {
      expect(PROTOTYPE_WEB_PAGE_SCRIPT).toContain(marker);
    }
  });

  test("offers only rotate, zoom and pan, the 3D toggle, a variant switcher and revision history", () => {
    expect(controls(page.html)).toEqual([
      "3d",
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

  test("draws only the view shown first; the bundle draws every other view from the data", () => {
    expect(page.inlinedRevisions).toEqual({ a: [2, 1], b: [1] });
    expect(page.html.match(/data-view=""/g)).toHaveLength(1);
    expect(page.html.match(/data-view="" hidden=""/g)).toBeNull();
    expect(page.html).toContain(
      '<body data-variant="a" data-revision="2" data-platform="android" data-orientation="portrait">',
    );
    // The reference checkout's stack has two screens, so its revision has two views per orientation.
    const views = webPageDrawnViews(page.html);
    expect(views.match(/data-view=""/g)).toHaveLength(8);
    expect(views.match(/data-view="" hidden=""/g)).toHaveLength(7);
    expect(views.startsWith(webPageShownView(page.html))).toBe(true);
  });

  test("lists revisions newest first with the operation that made them", () => {
    const history = page.html.slice(page.html.indexOf('data-control="revisions"'));
    expect(history.indexOf("r2 · patch")).toBeLessThan(history.indexOf("r1 · show"));
  });

  test("escapes the title", () => {
    expect(page.html).toContain("<title>Checkout &lt;v2&gt;</title>");
  });

  test("reports the unsupported nodes of the view shown first", () => {
    // The reference checkout's only former placeholder, a closed menu, now draws as a layer.
    expect(page.unsupportedNodes).toEqual([]);
    const web = buildPrototypeWebPage({
      ...input,
      variants: [
        {
          id: "a",
          label: "A",
          revisions: [
            {
              revision: 1,
              operation: "show",
              spec: {
                ...tiny("x"),
                root: { type: "webView", id: "help", url: "https://example.com" },
              },
            },
          ],
        },
      ],
    });
    expect(web.unsupportedNodes.map((node) => node.type)).toEqual(["webView"]);
  });

  test("drops older revisions to stay within the budget, keeping each variant's latest", () => {
    const maxBytes = Buffer.byteLength(page.html) - 1;
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
    // One byte short of every revision: revision 2, neither latest nor requested, goes.
    const maxBytes = Buffer.byteLength(buildPrototypeWebPage(three).html) - 1;
    const pinned = buildPrototypeWebPage({ ...three, revision: 1, maxBytes });
    expect(pinned.inlinedRevisions.a).toEqual([3, 1]);
    expect(pinned.html).toContain(
      '<body data-variant="a" data-revision="1" data-platform="android" data-orientation="portrait">',
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

  test("refuses when even the latest revisions do not fit, naming the largest revision", () => {
    expect(() => buildPrototypeWebPage({ ...input, maxBytes: 10 * 1024 })).toThrow(
      /would exceed 10240 bytes even with only the latest revision of each variant and the revision shown first\. Largest revision: variant a revision 2 \(\d+ bytes of spec JSON\)/,
    );
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
    expect(drawn(pageOf(stackSpec("a", ["a"])))).not.toContain("data-screen");
    expect(drawn(pageOf(tiny("plain")))).not.toContain("data-screen");
  });

  test("draws both orientations of every screen, start first, and shows the start", () => {
    const page = pageOf(stackSpec("b", ["a", "b", "c"]));
    const html = drawn(page);
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
    expect(picker(page.html)).toEqual(["b", "a", "c"]);
    expect(page.html).toContain('<select aria-label="Screen" data-control="screen">');
    expect(shownScreen(page.html)).toBe("b");
  });

  test("the start screen's view is the page's view without a picker", () => {
    const html = drawn(pageOf(stackSpec("a", ["a", "b"])));
    const single = drawn(pageOf(stackSpec("a", ["a"])));
    const shown = (page: string) =>
      /data-view="">(.*?)<\/div><div data-orientation="landscape"/.exec(page)?.[1];
    expect(shown(html)).toBeDefined();
    expect(shown(html)).toBe(shown(single));
  });

  test("lists the shown revision's screens; every revision keeps its own views", () => {
    const page = pageOf(stackSpec("x", ["x", "y"]), stackSpec("a", ["a", "b", "c"]));
    const html = drawn(page);
    expect(picker(page.html)).toEqual(["a", "b", "c"]);
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

  test("a revision is drawn whole from its one spec, so the latest is never cut to fewer screens", () => {
    const spec = stackSpec("a", ["a", "b", "c"], "x".repeat(4000));
    const page = pageOf(spec);
    expect(attrsOf(drawn(page), "data-screen")).toEqual(["a", "a", "b", "b", "c", "c"]);
    expect(picker(page.html)).toEqual(["a", "b", "c"]);
    // Short of what the one revision's spec needs, the page is refused, not cut to its start.
    expect(() =>
      buildPrototypeWebPage({
        title: "Stack",
        maxBytes: Buffer.byteLength(page.html) - 4000,
        variants: [{ id: "a", label: "A", revisions: [{ revision: 1, operation: "show", spec }] }],
      }),
    ).toThrow(/Largest revision: variant a revision 1/);
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
    expect(attrsOf(drawn(page), "data-screen")).toEqual(["a", "a", "b", "b"]);
    expect(Buffer.byteLength(page.html)).toBeLessThanOrEqual(maxBytes);
  });

  test("an older revision is kept whole or not at all", () => {
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
    expect(page.inlinedRevisions).toEqual({ a: [2] });
    expect(attrsOf(drawn(page), "data-screen")).toEqual(["a", "a", "b", "b"]);
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

  test("a watch has only a portrait view and no rotate control (#16446)", () => {
    const page = buildPrototypeWebPage({ ...input, frame: "wearos-small-round" });
    const html = drawn(page);
    expect(page.html).not.toContain('data-control="rotate"');
    expect(html).not.toContain('data-orientation="landscape"');
    expect(html).toMatch(
      /data-orientation="portrait" data-revision="2"[^>]*data-variant="a" data-view="">/,
    );
  });

  test("a TV or car opens in landscape, its only view, with no rotate control (#16446)", () => {
    for (const frame of ["android-tv-1080p", "apple-tv", "car-1024p-landscape"]) {
      const page = buildPrototypeWebPage({ ...input, frame });
      const html = drawn(page);
      expect(page.html).not.toContain('data-control="rotate"');
      expect(html).not.toContain('data-orientation="portrait"');
      expect(page.html).toMatch(/<body [^>]*data-orientation="landscape"/);
      // The first view is shown: no `hidden` on the single landscape view of the latest revision.
      expect(html).toMatch(
        /data-orientation="landscape" data-revision="2"[^>]*data-variant="a" data-view="">/,
      );
    }
  });

  test("a phone keeps both orientations, opens in portrait and offers rotate", () => {
    const page = buildPrototypeWebPage(input);
    expect(page.html).toContain('data-control="rotate"');
    expect(page.html).toMatch(/<body [^>]*data-orientation="portrait"/);
    expect(drawn(page)).toContain('data-orientation="landscape"');
  });

  test("tells the runtime the frame's platform and inlines the rotation rule", () => {
    const ios = buildPrototypeWebPage({ ...input, frame: "iphone-16" });
    expect(ios.html).toContain('data-platform="ios"');
    expect(buildPrototypeWebPage(input).html).toContain('data-platform="android"');
    expect(PROTOTYPE_WEB_PAGE_SCRIPT).toContain("prefers-reduced-motion: reduce");
  });
});

describe("prototype web page rotation lock (#16587)", () => {
  test("unlocked, the layout follows the frame upright", () => {
    expect(prototypeWebHeldView("portrait", "portrait", false)).toEqual({
      orientation: "portrait",
      degrees: 0,
    });
    expect(prototypeWebHeldView("landscape", "portrait", false)).toEqual({
      orientation: "landscape",
      degrees: 0,
    });
  });

  test("locked, a landscape frame keeps the portrait layout turned a quarter counterclockwise", () => {
    expect(prototypeWebHeldView("landscape", "portrait", true)).toEqual({
      orientation: "portrait",
      degrees: -90,
    });
    expect(prototypeWebHeldView("portrait", "portrait", true)).toEqual({
      orientation: "portrait",
      degrees: 0,
    });
  });

  test("locked, a frame whose natural orientation is landscape keeps it, turned clockwise", () => {
    expect(prototypeWebHeldView("portrait", "landscape", true)).toEqual({
      orientation: "landscape",
      degrees: 90,
    });
  });

  test("a lock change cross-fades the layouts in place with the platform turn's timing", () => {
    const turn = prototypeWebRotation("ios", "landscape");
    const step = prototypeWebRelayout(turn, -90, 0);
    expect([step.durationMs, step.easing]).toEqual([turn.durationMs, turn.easing]);
    expect(step.outgoing).toEqual([
      { transform: "translate(-50%, -50%) rotate(-90deg)", opacity: 1 },
      { transform: "translate(-50%, -50%) rotate(-90deg)", opacity: 0 },
    ]);
    expect(step.incoming).toEqual([
      { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 0 },
      { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
    ]);
  });

  test("the page script watches the body's lock attribute", () => {
    expect(PROTOTYPE_WEB_PAGE_SCRIPT).toContain("data-rotation-lock");
  });
});

describe("prototype web page postures (#16445)", () => {
  const foldInput = (frame: string): PrototypeWebPageInput => ({
    title: "Fold",
    frame,
    variants: [
      { id: "a", label: "A", revisions: [{ revision: 1, operation: "show", spec: tiny("x") }] },
    ],
  });
  const viewKeys = (html: string) =>
    [...html.matchAll(/<div data-orientation="(\w+)" data-posture="(\w+)"[^>]*data-view=""/g)].map(
      (match) => `${match[2]}/${match[1]}`,
    );

  test("a foldable draws every posture in both orientations, opened portrait shown first", () => {
    const page = buildPrototypeWebPage(foldInput("pixel-fold"));
    const html = drawn(page);
    expect(viewKeys(html)).toEqual([
      "opened/portrait",
      "opened/landscape",
      "closed/portrait",
      "closed/landscape",
      "half_opened/portrait",
      "half_opened/landscape",
    ]);
    expect(page.html).toContain(
      'data-orientation="portrait" data-posture="opened" data-hinge-axis=',
    );
    // Only the first view drops `hidden`.
    expect(html.match(/data-view=""(?! hidden)/g)).toHaveLength(1);
    expect(html).toMatch(/data-posture="opened" data-revision="1" data-variant="a" data-view="">/);
    expect(viewKeys(page.html)).toEqual(["opened/portrait"]);
  });

  test("the toolbar offers the frame's postures in registry order, the shown one selected", () => {
    const { html } = buildPrototypeWebPage(foldInput("flip-foldable"));
    const picker = html.match(
      /<select aria-label="Layout posture" data-control="layout-posture">(.*?)<\/select>/,
    )?.[1];
    expect(picker).toBe(
      '<option value="closed">Closed</option><option value="half_opened">Half opened</option><option selected="" value="opened">Opened</option>',
    );
  });

  test("a stack shown only in one posture keeps its screens there (#16632 review)", () => {
    const text = (value: string) => ({ type: "text", text: value });
    const spec = {
      id: "book-only",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "column",
        children: [
          {
            type: "stack",
            visibleWhen: { platform: "/device/posture", equals: "book" },
            start: "list",
            screens: { list: text("list"), detail: text("detail") },
          },
        ],
      },
    };
    const page = buildPrototypeWebPage({
      ...foldInput("pixel-fold"),
      variants: [{ id: "a", label: "A", revisions: [{ revision: 1, operation: "show", spec }] }],
    });
    const html = drawn(page);
    const screens = [
      ...html.matchAll(
        /data-orientation="(\w+)" data-posture="(\w+)" data-revision="1"(?: data-screen="(\w+)")? data-variant="a" data-view=""/g,
      ),
    ].map((match) => `${match[2]}/${match[1]}/${match[3] ?? "-"}`);
    expect(screens.filter((key) => key.startsWith("half_opened/portrait"))).toEqual([
      "half_opened/portrait/list",
      "half_opened/portrait/detail",
    ]);
    expect(screens.filter((key) => key.startsWith("opened/portrait"))).toEqual([
      "opened/portrait/-",
    ]);
    // The picker offers the screens some view has; the runtime narrows it to the shown view's.
    expect(page.html).toMatch(/data-control="screen" hidden=""|data-control="screen"[^>]*>/);
    expect(page.html).toContain('<option value="detail">detail</option>');
  });

  test("a frame without postures has no posture picker, attribute or posture views", () => {
    const page = buildPrototypeWebPage(foldInput("pixel-9"));
    // The page script names the attribute; the page's markup and views carry none.
    const html = page.html.replace(PROTOTYPE_WEB_PAGE_SCRIPT, "");
    expect(html).not.toContain("data-posture");
    expect(drawn(page)).not.toContain("data-posture");
    expect(html).not.toContain('<select aria-label="Layout posture"');
  });

  test("the runtime matches a view by variant, revision, orientation and posture", () => {
    expect(PROTOTYPE_WEB_PAGE_SCRIPT).toContain('"layout-posture"');
    const key = { variant: "a", revision: "1", orientation: "portrait", posture: "closed" };
    const view = { ...key };
    expect(prototypeWebViewMatches(view, key)).toBe(true);
    expect(prototypeWebViewMatches({ ...view, posture: "opened" }, key)).toBe(false);
    expect(prototypeWebViewMatches({ ...view, orientation: "landscape" }, key)).toBe(false);
    expect(prototypeWebViewMatches({ ...view, revision: "2" }, key)).toBe(false);
    // A frame without postures: the key's posture is empty and its views carry none.
    const plain = { variant: "a", revision: "1", orientation: "portrait" };
    expect(prototypeWebViewMatches(plain, { ...key, posture: "" })).toBe(true);
    expect(prototypeWebViewMatches(plain, key)).toBe(false);
  });
});
