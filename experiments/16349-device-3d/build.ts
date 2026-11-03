/**
 * THROWAWAY research prototype for #16349. Not for merge.
 *
 * Builds the reference-checkout page, adds the CSS-3D script and styles, measures the bytes it
 * adds, and screenshots the 2D frame and several 3D poses in headless Chromium.
 *
 *   bun experiments/16349-device-3d/build.ts [outDir]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { buildPrototypeWebPage } from "../../src/features/prototype/web/webPage";
import { DEVICE_3D_CSS, device3dRuntime } from "./device3dRuntime";
import {
  DEFAULT_3D_ORBIT,
  FLAT_ORBIT,
  POSTURE_HINGE_DEGREES,
  devicePose,
  postureAtHinge,
} from "./devicePose";

const ROOT = join(import.meta.dir, "../..");
const OUT = process.argv[2] ?? join(ROOT, "scratch/16349-device-3d");
mkdirSync(OUT, { recursive: true });

const RUNTIME = `(${device3dRuntime.toString()})({ pose: ${devicePose.toString()}, postureAt: ${postureAtHinge.toString()}, flat: ${JSON.stringify(FLAT_ORBIT)}, start: ${JSON.stringify(DEFAULT_3D_ORBIT)}, hinges: ${JSON.stringify(POSTURE_HINGE_DEGREES)} });`;

function withDevice3d(html: string, axis: "vertical" | "horizontal"): string {
  const hash = createHash("sha256").update(RUNTIME).digest("base64");
  return html
    .replace(/script-src ('sha256-[^']+')/, `script-src $1 'sha256-${hash}'`)
    .replace("</style>", `${DEVICE_3D_CSS}</style>`)
    .replace("<body ", `<body data-hinge-axis="${axis}" `)
    .replace("</body>", `<script>${RUNTIME}</script></body>`);
}

const spec: unknown = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/prototype-web/reference-checkout.json"), "utf8"),
);
const page = buildPrototypeWebPage({
  title: "reference-checkout",
  frame: "pixel-9",
  variants: [
    {
      id: "reference-checkout",
      label: "c",
      revisions: [{ revision: 1, operation: "show", spec }],
    },
  ],
});
const book = withDevice3d(page.html, "vertical");
const flip = withDevice3d(page.html, "horizontal");
writeFileSync(join(OUT, "book.html"), book);
writeFileSync(join(OUT, "flip.html"), flip);

const minified = await Bun.build({
  entrypoints: [join(import.meta.dir, "entry.ts")],
  minify: true,
});
const minText = await minified.outputs[0]?.text();
const bytes = {
  runtimeRaw: Buffer.byteLength(RUNTIME),
  runtimeGzip: gzipSync(RUNTIME, { level: 9 }).length,
  runtimeMinified: minText ? Buffer.byteLength(minText) : -1,
  runtimeMinifiedGzip: minText ? gzipSync(minText, { level: 9 }).length : -1,
  css: Buffer.byteLength(DEVICE_3D_CSS),
  pageBefore: Buffer.byteLength(page.html),
  pageAfter: Buffer.byteLength(book),
};
writeFileSync(join(OUT, "bytes.json"), `${JSON.stringify(bytes, null, 2)}\n`);
console.log(bytes);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const FONT = '*{font-family:"DejaVu Sans",sans-serif!important}';
type Step = { name: string; html: string; act: string; reduced?: boolean };
const steps: Step[] = [
  { name: "01-flat-2d", html: book, act: "" },
  { name: "02-3d-opened", html: book, act: "toggle" },
  { name: "03-3d-half-opened-book", html: book, act: "posture:half_opened" },
  { name: "04-3d-closed-book", html: book, act: "posture:closed" },
  { name: "05-3d-tent-book", html: book, act: "posture:tent" },
  { name: "06-3d-half-opened-flip", html: flip, act: "posture:half_opened" },
  { name: "07-3d-orbit-keyboard", html: book, act: "keys" },
  { name: "08-back-to-2d", html: book, act: "toggle-twice" },
];
const problems: string[] = [];
for (const step of steps) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const tab = await context.newPage();
  tab.on("console", (m) => m.type() === "error" && problems.push(`${step.name}: ${m.text()}`));
  tab.on("pageerror", (e) => problems.push(`${step.name}: ${e.message}`));
  await tab.route("**/*", (route) =>
    route.request().url() === "http://p.test/"
      ? route.fulfill({ contentType: "text/html", body: step.html })
      : route.abort(),
  );
  await tab.goto("http://p.test/");
  await tab.addStyleTag({ content: FONT }).catch(() => undefined);
  const before = await tab.evaluate(() => document.querySelector("[data-view]:not([hidden])")?.innerHTML.length);
  if (step.act === "toggle" || step.act === "toggle-twice" || step.act === "keys") {
    await tab.click('[data-control="3d"]');
  }
  if (step.act === "toggle-twice") {
    await tab.waitForTimeout(100);
    await tab.click('[data-control="3d"]');
  }
  if (step.act.startsWith("posture:")) {
    await tab.selectOption("[data-control=posture]", step.act.slice("posture:".length));
  }
  if (step.act === "keys") {
    await tab.focus("[data-viewport]");
    for (let i = 0; i < 6; i += 1) {
      await tab.keyboard.press("ArrowRight");
    }
  }
  await tab.waitForTimeout(150);
  const after = await tab.evaluate(() => ({
    shownViews: document.querySelectorAll("[data-view]:not([hidden])").length,
    extras: document.querySelectorAll("[data-back],[data-leaf]").length,
    status: document.querySelector("[data-control=status3d]")?.textContent,
    layout: document.body.dataset.panelLayout,
    frameHtml: document.querySelector("[data-view]:not([hidden])>*")?.innerHTML.length,
  }));
  console.log(step.name, JSON.stringify({ before, ...after }));
  await tab.screenshot({ path: join(OUT, `${step.name}.png`) });
  await context.close();
}
await browser.close();
console.log(problems.length ? problems : "no console or page errors");
