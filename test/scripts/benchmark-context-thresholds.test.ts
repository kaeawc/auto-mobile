import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  estimateDefinitions,
  evaluateMeasurements,
  measureJson,
  measureToolsListResponse,
  parseThresholdConfig,
  TOKEN_ENCODING,
  type ContextMeasurements,
  type ContextMeasurementSet,
  type ThresholdConfig,
} from "../../scripts/benchmark-context-thresholds";

const measurements: ContextMeasurements = {
  coreTools: 100,
  allTools: 300,
  resources: 20,
  resourceTemplates: 40,
  coreTotal: 160,
  allTotal: 360,
};

function scaled(values: ContextMeasurements, factor: number): ContextMeasurements {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value * factor]),
  ) as ContextMeasurements;
}

function measurementSet(compact: ContextMeasurements): ContextMeasurementSet {
  return { compact, compactBytes: scaled(compact, 4), pretty: scaled(compact, 2) };
}

function config(
  thresholds?: ContextMeasurements,
  prettyBaseline?: ContextMeasurements,
): ThresholdConfig {
  return {
    version: "3.0.0",
    metadata: {
      tokenEncoding: TOKEN_ENCODING,
      baseline: measurements,
      ...(prettyBaseline === undefined ? {} : { prettyBaseline }),
    },
    ...(thresholds === undefined ? {} : { thresholds }),
  };
}

// A two-tool `tools/list` response as one stdio line; the em dash makes UTF-8 bytes differ
// from the string length, so a char-count shortcut would be caught.
const fixtureLine = fs
  .readFileSync(
    path.join(import.meta.dir, "../fixtures/context-benchmark/tools-list-response.jsonl"),
    "utf-8",
  )
  .trimEnd();
const fixtureResponse = JSON.parse(fixtureLine) as JSONRPCMessage & {
  result: { tools: Record<string, unknown>[] };
};

describe("context size counter", () => {
  test("counts compact JSON as primary and pretty-printed JSON as secondary", () => {
    const [tapOn, listDevices] = fixtureResponse.result.tools;

    expect(measureJson(tapOn)).toEqual({ compactBytes: 419, compactTokens: 98, prettyTokens: 166 });
    expect(measureJson(listDevices)).toEqual({
      compactBytes: 208,
      compactTokens: 47,
      prettyTokens: 78,
    });
    expect(measureJson(tapOn).compactBytes).toBe(Buffer.byteLength(JSON.stringify(tapOn)));
  });

  test("sums each definition and strips outputSchema from tool definitions", () => {
    const tools = fixtureResponse.result.tools;
    const withOutput = tools.map((tool) => ({ ...tool, outputSchema: { type: "object" } }));

    expect(estimateDefinitions(tools)).toEqual({ compact: 145, compactBytes: 627, pretty: 244 });
    expect(estimateDefinitions(withOutput, true)).toEqual(estimateDefinitions(tools));
    expect(estimateDefinitions(withOutput).compact).toBeGreaterThan(145);
  });

  test("measures a tools/list response on its serialized stdio line", () => {
    expect(measureToolsListResponse(fixtureResponse)).toEqual({
      toolCount: 2,
      response: { bytes: 674, tokens: 161 },
      tools: { bytes: 630, tokens: 146 },
    });
    expect(Buffer.byteLength(fixtureLine)).toBe(674);
    expect(fixtureLine.length).toBeLessThan(674);
  });
});

describe("context baseline benchmark", () => {
  test("reports both profiles against their baselines without enforcing a limit", () => {
    const report = evaluateMeasurements(
      measurementSet({ ...measurements, coreTools: 105, coreTotal: 165 }),
      config(),
    );

    expect(report).toMatchObject({
      passed: true,
      enforcement: { enabled: false },
      tokenEncoding: TOKEN_ENCODING,
      baselines: measurements,
      violations: [],
    });
    expect(report.results.coreTools).toEqual({
      actual: 105,
      baseline: 100,
      delta: 5,
      bytes: 420,
      pretty: { actual: 210 },
    });
    expect(report.results.allTools).toEqual({
      actual: 300,
      baseline: 300,
      delta: 0,
      bytes: 1200,
      pretty: { actual: 600 },
    });
  });

  test("reports the pretty-printed column against its own baseline without gating it", () => {
    const report = evaluateMeasurements(
      measurementSet(measurements),
      config(measurements, scaled(measurements, 1.5)),
    );

    expect(report.passed).toBe(true);
    expect(report.prettyBaselines).toEqual(scaled(measurements, 1.5));
    expect(report.results.coreTools.pretty).toEqual({ actual: 200, baseline: 150, delta: 50 });
  });

  test("enforces every compact measurement once limits are configured", () => {
    const report = evaluateMeasurements(
      measurementSet({ ...measurements, allTools: 301, allTotal: 361 }),
      config(measurements),
    );

    expect(report.enforcement.enabled).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.results.coreTools).toMatchObject({ threshold: 100, passed: true, usage: 100 });
    expect(report.results.allTools).toMatchObject({ threshold: 300, passed: false, usage: 100 });
    expect(report.violations).toEqual([
      "allTools: 301 tokens exceeds threshold of 300 tokens",
      "allTotal: 361 tokens exceeds threshold of 360 tokens",
    ]);
  });

  test("refuses a config not recorded on compact JSON", () => {
    const legacy = config(measurements);
    const metadata: Partial<ThresholdConfig["metadata"]> = { ...legacy.metadata };
    delete metadata.tokenEncoding;

    expect(() => parseThresholdConfig({ ...legacy, metadata } as ThresholdConfig)).toThrow(
      'metadata.tokenEncoding must be "compact-json"',
    );
    expect(() =>
      parseThresholdConfig({
        ...legacy,
        metadata: { ...legacy.metadata, tokenEncoding: "pretty" },
      }),
    ).toThrow("counted on compact JSON");
    expect(parseThresholdConfig(legacy)).toBe(legacy);
  });

  test("the committed config is compact JSON with a pretty-printed comparison baseline", () => {
    const committed = parseThresholdConfig(
      JSON.parse(
        fs.readFileSync(
          path.join(import.meta.dir, "../../scripts/context-thresholds.json"),
          "utf-8",
        ),
      ) as ThresholdConfig,
    );

    expect(committed.metadata.tokenEncoding).toBe(TOKEN_ENCODING);
    expect(committed.metadata.prettyBaseline).toBeDefined();
  });
});
