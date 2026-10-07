import thresholds from "../../scripts/npm-unpacked-size-thresholds.json";
import { expect, test } from "bun:test";
import {
  evaluateUnpackedSize,
  trimmedPackEnv,
  validateThresholdConfig,
  parsePackOutput,
} from "../../scripts/benchmark-npm-unpacked-size";
import { REQUIRED_PACKED_RUNTIME_ASSETS } from "../../scripts/build/packed-runtime-assets";

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

const runtimeFiles = REQUIRED_PACKED_RUNTIME_ASSETS.map((path) => ({
  path: path.endsWith("/") ? `${path}migration.ts` : path,
  size: 1,
}));
const evaluate = (actual: number, warnHeadroomBytes?: number) =>
  evaluateUnpackedSize({
    unpackedBytes: actual,
    files: runtimeFiles,
    thresholds: {
      unpackedBytes: 1000,
      ...(warnHeadroomBytes === undefined ? {} : { warnHeadroomBytes }),
    },
  });

test("headroom is cap minus actual and percent rounded to one decimal, including overages", () => {
  for (const [actual, bytes, percent] of [
    [666, 334, 33.4],
    [1001, -1, -0.1],
  ]) {
    expect(evaluate(actual).results.unpackedSize).toMatchObject({
      actual,
      threshold: 1000,
      headroomBytes: bytes,
      headroomPercent: percent,
      usage: Math.round(actual / 10),
      passed: actual <= 1000,
    });
  }
  expect(
    evaluateUnpackedSize({
      unpackedBytes: 2000,
      files: runtimeFiles,
      thresholds: { unpackedBytes: 3000 },
    }).results.unpackedSize.headroomPercent,
  ).toBe(33.3);
  expect(
    evaluateUnpackedSize({
      unpackedBytes: 0,
      files: runtimeFiles,
      thresholds: { unpackedBytes: 0 },
    }).results.unpackedSize.headroomPercent,
  ).toBe(0);
});

for (const [actual, warning, passed] of [
  [100, false, true],
  [900, false, true],
  [901, true, true],
  [1000, true, true],
  [1001, false, false],
] as const) {
  test(`warning boundary at ${actual} bytes`, () => {
    const report = evaluate(actual, 100);
    expect(report.passed).toBe(passed);
    expect(report.results.unpackedSize.warning).toBe(warning);
    expect(report.results.unpackedSize.warnHeadroomBytes).toBe(100);
    expect(report.warnings.length).toBe(warning ? 1 : 0);
  });
}

test("absent warning band never warns and over-cap violation retains its message", () => {
  expect(evaluate(1000).results.unpackedSize.warning).toBe(false);
  expect(evaluate(1001).violations).toContain(
    "Unpacked size 1001 bytes exceeds threshold 1000 bytes",
  );
  expect(evaluate(1001).passed).toBe(false);
});

test("largest files sort by descending size and ascending path, truncate without mutating input", () => {
  const files = Array.from({ length: 15 }, (_, i) => ({
    path: `file-${String(14 - i).padStart(2, "0")}`,
    size: Math.floor(i / 2) + 10,
  }));
  const original = structuredClone(files);
  const report = evaluateUnpackedSize({
    unpackedBytes: 1001,
    files,
    thresholds: { unpackedBytes: 1000 },
  });
  expect(report.package.largestFiles).toEqual(
    [17, 16, 16, 15, 15, 14, 14, 13, 13, 12].map((size, i) => ({
      path: `file-${String(i).padStart(2, "0")}`,
      size,
    })),
  );
  expect(files).toEqual(original);
  expect(evaluate(1000, 100).package.largestFiles).toEqual(
    runtimeFiles
      .map(({ path, size }) => ({ path, size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  expect(evaluate(100).package.largestFiles).toEqual([]);
});

test("report exposes the exact fields consumed by the workflow", () => {
  const report = evaluate(950, 100);
  expect(Object.keys(report.results.unpackedSize).sort()).toEqual(
    [
      "actual",
      "threshold",
      "usage",
      "passed",
      "headroomBytes",
      "headroomPercent",
      "warning",
      "warnHeadroomBytes",
    ].sort(),
  );
  expect(report.warnings).toHaveLength(1);
  expect(report.package.largestFiles[0]).toEqual({
    path: "dist/schemas/test-plan.schema.json",
    size: 1,
  });
  expect(report.violations).toEqual([]);
});

test("asset violations still fail below the cap and show contributors", () => {
  const report = evaluateUnpackedSize({
    unpackedBytes: 100,
    files: [{ path: "schemas/tool-definitions.json", size: 100 }],
    thresholds: { unpackedBytes: 1000 },
  });
  expect(report.passed).toBe(false);
  expect(report.violations).toContain("Forbidden packed asset: schemas/tool-definitions.json");
  expect(report.package.largestFiles).toHaveLength(1);
});

test("optional warning threshold must be finite and non-negative", () => {
  for (const warnHeadroomBytes of [-1, NaN, Infinity, "100", null]) {
    expect(() =>
      validateThresholdConfig({
        version: "1",
        thresholds: { unpackedBytes: 1000, warnHeadroomBytes },
      }),
    ).toThrow("Invalid warnHeadroomBytes threshold");
  }
  for (const thresholds of [
    { unpackedBytes: 1000 },
    { unpackedBytes: 1000, warnHeadroomBytes: 0 },
  ]) {
    expect(validateThresholdConfig({ version: "1", thresholds }).thresholds).toEqual(thresholds);
  }
});

test("benchmark pack enables trim while preserving caller environment", () => {
  const env = { PATH: "/bin", CI: "false", AUTOMOBILE_TRIM_BUNDLED_DEPS: "false" };
  expect(trimmedPackEnv(env)).toEqual({ ...env, AUTOMOBILE_TRIM_BUNDLED_DEPS: "true" });
  expect(env.AUTOMOBILE_TRIM_BUNDLED_DEPS).toBe("false");
});

test("trimmed cap follows measured bytes plus 3 MiB rounded up and rejects lost trimming", () => {
  const measuredTrimmed = 18_345_761;
  const measuredUntrimmed = 23_838_787;
  const mib = 1024 * 1024;
  expect(thresholds.thresholds.unpackedBytes).toBe(
    Math.ceil((measuredTrimmed + 3 * mib) / mib) * mib,
  );
  expect(
    evaluateUnpackedSize({
      unpackedBytes: measuredTrimmed,
      files: runtimeFiles,
      thresholds: thresholds.thresholds,
    }).passed,
  ).toBe(true);
  expect(
    evaluateUnpackedSize({
      unpackedBytes: measuredUntrimmed,
      files: runtimeFiles,
      thresholds: thresholds.thresholds,
    }).passed,
  ).toBe(false);
});
