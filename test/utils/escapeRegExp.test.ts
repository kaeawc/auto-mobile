import { expect, test } from "bun:test";

// RegExp.escape is available and typed in the pinned Bun/tsgo toolchain.
// Input-shape probes verify the standard-library primitive used by launcher parsing.
test.each([
  "com.foo.bar",
  "com.example.app$test",
  "com.example+x",
  "a(b",
  "a[b",
  ".*+?^${}()|[]\\",
])("RegExp.escape makes %j match literally", (value) => {
  const pattern = new RegExp(`^${RegExp.escape(value)}$`);
  expect(pattern.test(value)).toBe(true);
  expect(pattern.test(`${value}extra`)).toBe(false);
});

test("RegExp.escape rejects dot-position look-alikes (input-shape probe)", () => {
  const pattern = new RegExp(RegExp.escape("com.foo.bar"));
  expect(pattern.test("comXfooXbar")).toBe(false);
  expect(pattern.test("com-foo-bar")).toBe(false);
});
