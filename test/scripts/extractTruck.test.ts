import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractTruckFragments } from "../../scripts/desktop/lib/extract-truck";

// Guards the desktop app-icon generator (scripts/desktop/generate-app-icons.sh), which lifts the
// truck out of docs/img/logo.svg. The XML envelope is parsed with xml2js, but contours are selected
// by index within each path's `d`, so these pin the two failure modes that would silently ship a
// wrong icon: a reordered/absolute logo must still produce the layered truck, and a logo re-exported
// with relative moves must fail loudly rather than emit a mis-placed body/tire contour.

describe("extractTruckFragments", () => {
  test("produces the layered colour + mono truck from the real logo", async () => {
    const svg = readFileSync("docs/img/logo.svg", "utf8");
    const { colorFrag, monoFrag } = await extractTruckFragments(svg);

    // White body fill (non-zero), red outline, white tire fill, dark tires, two shading layers.
    expect(colorFrag).toContain(`fill="#fbfbfb" fill-rule="nonzero"`);
    expect(colorFrag).toContain(`fill="#df3028"`);
    expect(colorFrag).toContain(`fill="#ffffff" fill-rule="nonzero"`);
    expect((colorFrag.match(/<path /g) ?? []).length).toBe(6);

    // The mono mask is the outline + tires in solid black.
    expect((monoFrag.match(/fill="#000000"/g) ?? []).length).toBe(2);

    // The body contour is lifted as an absolute moveto (the logo uses absolute coordinates).
    expect(colorFrag.startsWith(`<path d="M`)).toBe(true);
  });

  test("fails loudly when the body contour uses a relative move", async () => {
    // path0: a full-canvas rectangle followed by a truck body contour that begins with a relative
    // `m` — extracting subpath 1 standalone would mis-place it, so this must throw, not guess.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><g>
      <path fill="#fbfbfb" d="M0 0 L400 0 L400 400 L0 400 Z m10 10 c1 1 2 2 3 3 Z"/>
      <path fill="#df3028" d="M0 0 L1 1"/>
      <path fill="#282827" d="M0 0 M2 2 M4 4 M6 6"/>
      <path fill="#f09e98" d="M0 0"/>
      <path fill="#df7c71" d="M0 0"/>
    </g></svg>`;

    await expect(extractTruckFragments(svg)).rejects.toThrow(/relative move/);
  });

  test("reports a missing colour role instead of emitting a broken fragment", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g>
      <path fill="#fbfbfb" d="M0 0 Z M1 1 Z"/>
    </g></svg>`;
    await expect(extractTruckFragments(svg)).rejects.toThrow(/#df3028/);
  });
});
