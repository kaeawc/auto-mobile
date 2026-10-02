import { expect, test } from "bun:test";
import { parsePackOutput } from "../../scripts/benchmark-npm-unpacked-size";

test("parses the npm files manifest alongside the existing package report fields", () => {
  const files = [{ path: "dist/src/index.js", size: 10, mode: 493 }];
  expect(
    parsePackOutput(
      JSON.stringify([
        {
          name: "package",
          version: "1",
          filename: "package.tgz",
          size: 12,
          unpackedSize: 20,
          files,
        },
      ]),
    ),
  ).toEqual({
    name: "package",
    version: "1",
    filename: "package.tgz",
    tarballBytes: 12,
    unpackedBytes: 20,
    files,
  });
});

test("rejects missing or malformed manifests rather than silently skipping the asset guard", () => {
  for (const files of [
    undefined,
    null,
    [{}],
    [null],
    [{ path: "index.js", size: "10", mode: 493 }],
  ]) {
    expect(() => parsePackOutput(JSON.stringify([{ unpackedSize: 20, files }]))).toThrow(
      "npm pack output missing or invalid files manifest",
    );
  }
});
