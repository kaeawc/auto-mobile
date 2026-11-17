import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { FADE_EDGES_PAGE_CSS } from "../../../../src/features/prototype/web/webStylePolish";
import { diffPngs } from "../../../../src/features/visual/VisualDiff";
import { buildPrototypeWebLibrary } from "../../../../packages/prototype-web/build";

/**
 * The prototype-web library build in headless Chromium (#16453): `mount` builds the DOM from the
 * same element tree the web page serializes, so its pixels must match the still's HTML drawn the
 * same way. Opt-in, like the page check: run through `bash scripts/prototype/web-screenshots.sh`.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const describeBrowser = RUN ? describe : describe.skip;
const OUT_DIR =
  process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT ??
  join(import.meta.dir, "../../../../scratch/prototype-web-screenshots");
const PAGE_URL = "http://prototype-web.test/";
const VIEWPORT = { width: 600, height: 1000 };
const CASE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** The mount's shell font and box model, given to the reference so only the DOM path differs. */
const SHARED_CSS = `*{box-sizing:border-box}body{margin:0}${FADE_EDGES_PAGE_CSS}`;
const CENTERED =
  "position:absolute;left:50%;top:50%;transform-origin:center;transform:translate(-50%, -50%) scale(1)";
const BOX = `position:relative;overflow:hidden;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;font:14px system-ui,-apple-system,Roboto,sans-serif`;

const readSpec = (path: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures", path), "utf8")) as Record<
    string,
    unknown
  >;
const spec = readSpec("prototype-web/reference-checkout.json");
/** Specs drawn both ways; the chart covers SVG attributes whose case the HTML parser restores. */
const PIXEL_SPECS: Readonly<Record<string, Record<string, unknown>>> = {
  "reference-checkout": spec,
  "chart-variants": readSpec("prototype-spec/valid/chart-variants.json"),
};

function stillOf(drawn: unknown) {
  return renderPrototypeStill(drawn, { frame: "pixel-9", orientation: "portrait", mode: "light" });
}

function referencePage(drawn: unknown): string {
  return `<!doctype html><meta charset="utf-8"><style>${SHARED_CSS}</style><div style="${BOX}"><div style="${CENTERED}">${toHtml(stillOf(drawn).element)}</div></div>`;
}

function libraryPage(library: string, drawn: unknown, controls: false | string[] = false): string {
  const source = Buffer.from(library).toString("base64");
  const options = JSON.stringify({ spec: drawn, mode: "light", zoom: 1, controls });
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><div id="host" style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px"></div>
<script type="module">
import { mount } from "data:text/javascript;base64,${source}";
const events = [];
const handle = mount(document.getElementById("host"), { ...${options}, onRender: (detail) => events.push(["render", detail.unsupportedNodes.length]), onError: (detail) => events.push(["error", detail.code]) });
globalThis.__handle = handle;
globalThis.__library = { events, state: handle.state };
</script>`;
}

async function open(browser: Browser, html: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.route("**/*", (route) =>
    route.request().url() === PAGE_URL
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort("blockedbyclient"),
  );
  await page.goto(PAGE_URL, { waitUntil: "load" });
  return { page, errors };
}

/** A page with `<automobile-prototype>` from the element build, its spec in a child JSON script. */
function elementPage(element: string, drawn: unknown): string {
  const source = Buffer.from(element).toString("base64");
  // `<` is escaped so the spec cannot close the script element it sits in.
  const json = JSON.stringify(drawn).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0}automobile-prototype{width:${VIEWPORT.width}px;height:${VIEWPORT.height}px}</style>
<automobile-prototype id="host" mode="light" zoom="1" controls="none"><script type="application/json">${json}</script></automobile-prototype>
<script type="module">
const host = document.getElementById("host");
const events = [];
for (const type of ["render", "orientationchange", "error"]) {
  host.addEventListener(type, (event) => events.push([type, event.detail.orientation ?? event.detail.code ?? event.detail.unsupportedNodes.length]));
}
globalThis.__events = events;
await import("data:text/javascript;base64,${source}");
globalThis.__element = { events, state: host.state, defined: customElements.get("automobile-prototype") !== undefined };
</script>`;
}

describeBrowser("prototype-web library build in headless Chromium (#16453)", () => {
  let browser: Browser;
  let library: string;
  let element: string;

  beforeAll(async () => {
    library = await buildPrototypeWebLibrary();
    element = await buildPrototypeWebLibrary(undefined, "element");
    browser = await chromium.launch();
  }, LAUNCH_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  for (const [name, drawn] of Object.entries(PIXEL_SPECS)) {
    test(
      `mount draws ${name} as the web page draws it, pixel for pixel`,
      async () => {
        const reference = await open(browser, referencePage(drawn));
        const mounted = await open(browser, libraryPage(library, drawn));
        try {
          await mounted.page.waitForFunction(
            () => Reflect.get(globalThis, "__library") !== undefined,
          );
          const shown = await mounted.page.evaluate(() => Reflect.get(globalThis, "__library"));
          expect(shown.events).toEqual([["render", stillOf(drawn).unsupportedNodes.length]]);
          expect(shown.state).toMatchObject({
            frame: "pixel-9",
            orientation: "portrait",
            scale: 1,
          });
          // The DOM is built with createElement, so the shell holds no inline <style> or markup.
          const styles = await mounted.page.evaluate(
            () => document.getElementById("host")?.shadowRoot?.querySelectorAll("style").length,
          );
          expect(styles).toBe(0);

          const expected = await reference.page.screenshot({
            animations: "disabled",
            caret: "hide",
          });
          const actual = await mounted.page.screenshot({ animations: "disabled", caret: "hide" });
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(join(OUT_DIR, `library-mount--${name}.png`), actual);
          const diff = diffPngs(expected, actual, { perPixelDelta: 0.1, pixelRatio: 0.001 });
          expect(diff === "size_mismatch" ? "size_mismatch" : diff.match).toBe(true);
          expect({ reference: reference.errors, mounted: mounted.errors }).toEqual({
            reference: [],
            mounted: [],
          });
        } finally {
          await reference.page.close();
          await mounted.page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "a zoom the controls chose below 50% survives an unrelated update",
    async () => {
      const html = libraryPage(library, spec, ["zoom"]).replace(
        `width:${VIEWPORT.width}px;height:${VIEWPORT.height}px`,
        "width:200px;height:300px",
      );
      const { page, errors } = await open(browser, html);
      try {
        await page.waitForFunction(() => Reflect.get(globalThis, "__library") !== undefined);
        const scales = await page.evaluate(() => {
          const host = document.getElementById("host")!;
          host.shadowRoot!.querySelector<HTMLButtonElement>('[data-control="zoom-fit"]')!.click();
          const fitted = Reflect.get(globalThis, "__handle").state.scale;
          host.shadowRoot!.querySelector<HTMLButtonElement>('[data-control="zoom-in"]')!.click();
          const stepped = Reflect.get(globalThis, "__handle").state.scale;
          Reflect.get(globalThis, "__handle").update({ mode: "dark" });
          return { fitted, stepped, after: Reflect.get(globalThis, "__handle").state.scale };
        });
        expect(scales.fitted).toBeLessThan(0.4);
        expect(scales.stepped).toBeCloseTo(scales.fitted * 1.25, 5);
        expect(scales.after).toBe(scales.stepped);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "an envelope needing a newer capability draws the error view and emits error",
    async () => {
      const envelope = {
        format: "automobile-prototype-embed",
        version: 1,
        requires: ["prototype_from_the_future_v1"],
        spec,
      };
      const html = libraryPage(library, envelope);
      const { page, errors } = await open(browser, html);
      try {
        await page.waitForFunction(() => Reflect.get(globalThis, "__library") !== undefined);
        const drawn = await page.evaluate(() => Reflect.get(globalThis, "__library"));
        expect(drawn.events).toEqual([["error", "missingCapabilities"]]);
        const alert = await page.locator("#host [data-error]").textContent();
        expect(alert).toContain("prototype_from_the_future_v1");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "<automobile-prototype> draws its child script's spec as mount does, and follows attributes",
    async () => {
      const mounted = await open(browser, libraryPage(library, spec));
      const custom = await open(browser, elementPage(element, spec));
      try {
        await mounted.page.waitForFunction(
          () => Reflect.get(globalThis, "__library") !== undefined,
        );
        await custom.page.waitForFunction(() => Reflect.get(globalThis, "__element") !== undefined);
        const shown = await custom.page.evaluate(() => Reflect.get(globalThis, "__element"));
        expect(shown.defined).toBe(true);
        expect(shown.events).toEqual([["render", stillOf(spec).unsupportedNodes.length]]);
        expect(shown.state).toMatchObject({ frame: "pixel-9", orientation: "portrait", scale: 1 });

        const expected = await mounted.page.screenshot({ animations: "disabled", caret: "hide" });
        const actual = await custom.page.screenshot({ animations: "disabled", caret: "hide" });
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "library-element--reference-checkout.png"), actual);
        const diff = diffPngs(expected, actual, { perPixelDelta: 0.1, pixelRatio: 0.001 });
        expect(diff === "size_mismatch" ? "size_mismatch" : diff.match).toBe(true);

        const rotated = await custom.page.evaluate(() => {
          document.getElementById("host")!.setAttribute("orientation", "landscape");
          return Reflect.get(globalThis, "__events").slice(-2);
        });
        expect(rotated).toEqual([
          ["render", stillOf(spec).unsupportedNodes.length],
          ["orientationchange", "landscape"],
        ]);
        expect({ mounted: mounted.errors, element: custom.errors }).toEqual({
          mounted: [],
          element: [],
        });
      } finally {
        await mounted.page.close();
        await custom.page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "<automobile-prototype> draws a spec set before the element module loaded",
    async () => {
      const source = Buffer.from(element).toString("base64");
      const html = `<!doctype html><meta charset="utf-8"><automobile-prototype id="host" controls="none"></automobile-prototype>
<script type="module">
const host = document.getElementById("host");
const events = [];
host.addEventListener("render", () => events.push("render"));
host.spec = ${JSON.stringify(spec)};
await import("data:text/javascript;base64,${source}");
globalThis.__early = { events, state: host.state, own: Object.prototype.hasOwnProperty.call(host, "spec") };
</script>`;
      const { page, errors } = await open(browser, html);
      try {
        await page.waitForFunction(() => Reflect.get(globalThis, "__early") !== undefined);
        const early = await page.evaluate(() => Reflect.get(globalThis, "__early"));
        expect(early.events).toEqual(["render"]);
        expect(early.own).toBe(false);
        expect(early.state).toMatchObject({ frame: "pixel-9", orientation: "portrait" });
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "<automobile-prototype> draws a JSON script appended after it connected",
    async () => {
      const source = Buffer.from(element).toString("base64");
      const json = JSON.stringify(JSON.stringify(spec));
      const html = `<!doctype html><meta charset="utf-8">
<script type="module">
await import("data:text/javascript;base64,${source}");
const host = document.createElement("automobile-prototype");
const events = [];
host.addEventListener("render", () => events.push("render"));
document.body.append(host);
const before = host.state;
const script = document.createElement("script");
script.type = "application/json";
script.textContent = ${json};
host.append(script);
await new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__late = { events, before: before ?? null, state: host.state };
</script>`;
      const { page, errors } = await open(browser, html);
      try {
        await page.waitForFunction(() => Reflect.get(globalThis, "__late") !== undefined);
        const late = await page.evaluate(() => Reflect.get(globalThis, "__late"));
        expect(late.before).toBeNull();
        expect(late.events).toEqual(["render"]);
        expect(late.state).toMatchObject({ frame: "pixel-9", orientation: "portrait" });
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "<automobile-prototype> reports an invalid JSON script appended after it connected",
    async () => {
      const source = Buffer.from(element).toString("base64");
      const html = `<!doctype html><meta charset="utf-8">
<script type="module">
await import("data:text/javascript;base64,${source}");
const host = document.createElement("automobile-prototype");
const events = [];
host.addEventListener("error", (event) => events.push(event.detail.code));
document.body.append(host);
const script = document.createElement("script");
script.type = "application/json";
script.textContent = "{not json";
host.append(script);
await new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__invalid = { events };
</script>`;
      const { page, errors } = await open(browser, html);
      try {
        await page.waitForFunction(() => Reflect.get(globalThis, "__invalid") !== undefined);
        const invalid = await page.evaluate(() => Reflect.get(globalThis, "__invalid"));
        expect(invalid.events).toEqual(["invalidInput"]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});
