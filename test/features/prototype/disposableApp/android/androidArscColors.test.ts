import { expect, test } from "bun:test";
import {
  arsc,
  foregroundPath,
  monochromePath,
  template,
  type FixtureOptions,
} from "./androidArscFixture";
import {
  patchArscColors,
  resolveArscDrawablePaths,
} from "../../../../../src/features/prototype/disposableApp/android/androidArscColors";

const colors = new Map([["prototype_icon_background", 0x80123456]]);

function valueOf(buf: Buffer, data: number): number {
  return buf.indexOf(Buffer.from(new Uint32Array([data]).buffer));
}

test.each([
  ["utf8 pools with 32-bit offsets", { utf8: true }],
  ["utf16 pools", { utf8: false }],
  ["16-bit offsets with missing entries", { offset16: true, holes: 2 }],
  ["32-bit offsets with missing entries", { holes: 3 }],
  ["sparse entries", { sparse: true, holes: 1 }],
  ["compact entries", { compact: true }],
])("patches only the named colour with %s", (_name, options: FixtureOptions) => {
  const input = arsc(template, options);
  const output = patchArscColors(input, colors);
  expect(output.length).toBe(input.length);
  expect(valueOf(output, 0xfff5f5f5)).toBe(-1);
  expect(valueOf(output, 0x80123456)).toBeGreaterThan(0);
  expect(valueOf(output, 0xff263238)).toBe(valueOf(input, 0xff263238));
  expect(valueOf(input, 0xfff5f5f5)).toBeGreaterThan(0);
  const changed = [...input].filter((byte, index) => byte !== output[index]).length;
  // The four data bytes plus the RGB8 -> ARGB8 type byte, nothing else.
  expect(changed).toBeLessThanOrEqual(5);
});

test("an empty colour map returns the bytes unchanged", () => {
  const input = arsc(template);
  expect(patchArscColors(input, new Map()).equals(input)).toBe(true);
});

test("refuses a missing, complex or non-colour entry and a non-table input", () => {
  expect(() => patchArscColors(arsc([template[1]!]), colors)).toThrow("no colour value");
  expect(() => patchArscColors(arsc([{ ...template[0]!, complex: true }]), colors)).toThrow(
    "not a plain colour",
  );
  expect(() => patchArscColors(arsc([{ ...template[0]!, dataType: 0x01 }]), colors)).toThrow(
    "not a literal colour",
  );
  expect(() => patchArscColors(Buffer.from("not an arsc table"), colors)).toThrow("resources.arsc");
  expect(() => patchArscColors(arsc(template).subarray(0, 40), colors)).toThrow();
});

test.each<FixtureOptions>([
  { utf8: false },
  { compact: true, sparse: true, holes: 2 },
  { offset16: true },
])("resolves shortened drawable paths after patching colours (%j)", (options) => {
  const patched = patchArscColors(arsc(template, options), colors);
  const foreground = "prototype_icon_foreground";
  const monochrome = "prototype_icon_monochrome";
  expect(resolveArscDrawablePaths(patched, [foreground, monochrome])).toEqual(
    new Map([
      [foreground, new Set([foregroundPath])],
      [monochrome, new Set([monochromePath])],
    ]),
  );
  expect(valueOf(patched, 0x80123456)).toBeGreaterThan(0);
  expect(() => resolveArscDrawablePaths(patched, ["missing"])).toThrow(
    "no drawable file for missing",
  );
});
