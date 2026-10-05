import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TestExecutionRepository } from "../../src/db/testExecutionRepository";
import { buildTestTimingResponse, type TestTimingQueryArgs } from "../../src/server/testTimingData";
import { registerTestTimingResources } from "../../src/server/testTimingResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

const filters: TestTimingQueryArgs = {
  testClass: "Login Test",
  testMethod: "test+login",
  deviceId: "device/one",
  deviceName: "Phone & Tablet",
  devicePlatform: "ios",
  deviceType: "simulator",
  appVersion: "1.2",
  gitCommit: "abc123",
  targetSdk: 35,
  jdkVersion: "21",
  jvmTarget: "17",
  gradleVersion: "8.1",
  isCi: false,
  sessionUuid: "session=a",
};

describe("test timing filter characterization", () => {
  test.each([{}, filters, { targetSdk: 0, isCi: true }, { testClass: "", deviceName: "" }])(
    "preserves filter inclusion and query defaults for %p",
    async (args) => {
      const repository = new TestExecutionRepository(new FakeTimer());
      const query = spyOn(repository, "getTimingStats").mockResolvedValue([]);
      try {
        const response = await buildTestTimingResponse(args, repository);
        expect(query).toHaveBeenCalledWith({
          lookbackDays: 90,
          limit: 1000,
          minSamples: 1,
          orderBy: undefined,
          orderDirection: undefined,
          ...Object.fromEntries(Object.keys(filters).map((key) => [key, undefined])),
          ...args,
        });
        expect(response.filters).toEqual(
          Object.fromEntries(Object.entries(args).filter(([, value]) => value !== "")),
        );
        expect(response.aggregation).toEqual({
          strategy: "mean",
          lookbackDays: 90,
          limit: 1000,
          minSamples: 1,
          orderBy: "lastRun",
          orderDirection: "desc",
        });
        expect(response.testTimings).toEqual([]);
        expect(response.totalTests).toBe(0);
        expect(response.totalSamples).toBe(0);
      } finally {
        query.mockRestore();
      }
    },
  );

  test("preserves sample rates, zero timestamps, ordering overrides and result fields", async () => {
    const repository = new TestExecutionRepository(new FakeTimer());
    const query = spyOn(repository, "getTimingStats").mockResolvedValue([
      {
        testClass: "A",
        testMethod: "a",
        averageDurationMs: 12,
        sampleSize: 3,
        lastRunTimestampMs: 1000,
        passedCount: 2,
        failedCount: 1,
        skippedCount: 0,
        stdDevDurationMs: 2,
      },
      {
        testClass: "B",
        testMethod: "b",
        averageDurationMs: 0,
        sampleSize: 0,
        lastRunTimestampMs: 0,
        passedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        stdDevDurationMs: 0,
      },
    ]);
    try {
      const response = await buildTestTimingResponse(
        { lookbackDays: 7, limit: 2, minSamples: 0, orderBy: "sampleSize", orderDirection: "asc" },
        repository,
      );
      expect(response.testTimings).toEqual([
        {
          testClass: "A",
          testMethod: "a",
          averageDurationMs: 12,
          sampleSize: 3,
          lastRunTimestampMs: 1000,
          lastRun: "1970-01-01T00:00:01.000Z",
          successRate: 0.6667,
          failureRate: 0.3333,
          stdDevDurationMs: 2,
          statusCounts: { passed: 2, failed: 1, skipped: 0 },
        },
        {
          testClass: "B",
          testMethod: "b",
          averageDurationMs: 0,
          sampleSize: 0,
          lastRunTimestampMs: null,
          lastRun: null,
          successRate: 0,
          failureRate: 0,
          stdDevDurationMs: 0,
          statusCounts: { passed: 0, failed: 0, skipped: 0 },
        },
      ]);
      expect(response.totalTests).toBe(2);
      expect(response.totalSamples).toBe(3);
      expect(response.aggregation).toEqual({
        strategy: "mean",
        lookbackDays: 7,
        limit: 2,
        minSamples: 0,
        orderBy: "sampleSize",
        orderDirection: "asc",
      });
      expect(typeof response.generatedAt).toBe("string");
    } finally {
      query.mockRestore();
    }
  });
});

describe("test timing URI characterization", () => {
  afterEach(() => ResourceRegistry.clearResources());

  test.each([
    ["", "automobile:test-timings"],
    ["testClass=&deviceName=", "automobile:test-timings"],
    ["isCi=true&minSamples=0", "automobile:test-timings?minSamples=0&isCi=true"],
    [
      "sessionUuid=session%3Da&isCi=false&gradleVersion=8.1&jvmTarget=17&jdkVersion=21&targetSdk=35&gitCommit=abc123&appVersion=1.2&deviceType=simulator&devicePlatform=ios&deviceName=Phone+%26+Tablet&deviceId=device%2Fone&testMethod=test%2Blogin&testClass=Login+Test&orderDirection=asc&orderBy=averageDuration&minSamples=0&limit=2&lookbackDays=7",
      "automobile:test-timings?lookbackDays=7&limit=2&minSamples=0&orderBy=averageDuration&orderDirection=asc&testClass=Login+Test&testMethod=test%2Blogin&deviceId=device%2Fone&deviceName=Phone+%26+Tablet&devicePlatform=ios&deviceType=simulator&appVersion=1.2&gitCommit=abc123&targetSdk=35&jdkVersion=21&jvmTarget=17&gradleVersion=8.1&isCi=false&sessionUuid=session%3Da",
    ],
  ])("preserves canonical query order and encoding for %s", async (params, expectedUri) => {
    const query = spyOn(TestExecutionRepository.prototype, "getTimingStats").mockResolvedValue([]);
    try {
      registerTestTimingResources();
      const template = ResourceRegistry.getTemplate("automobile:test-timings?{params}");
      if (!template || !("handler" in template)) {
        throw new Error("Missing timing template handler");
      }
      const result = await template.handler({ params });
      expect(result.uri).toBe(expectedUri);
      expect(result.mimeType).toBe("application/json");
      expect(JSON.parse(result.text!).filters).toEqual(
        params.includes("sessionUuid")
          ? filters
          : params.includes("isCi=true")
            ? { isCi: true }
            : {},
      );
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });
});
