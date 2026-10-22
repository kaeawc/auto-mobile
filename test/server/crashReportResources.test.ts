import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type {
  NativeCrashReport,
  NativeCrashReportBody,
  NativeCrashReportReader,
} from "../../src/features/crashReports/NativeCrashReport";
import {
  CRASH_REPORT_RESOURCE_TEMPLATE,
  registerCrashReportResources,
} from "../../src/server/crashReportResources";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";

const sessionUuid = "session-123";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const REPORT_ID = "data_app_crash-20261021T100002-4321";
const baseUri = `automobile:device-session/${sessionUuid}/apps/com.example.app/crash-reports`;

function report(appId = "com.example.app"): NativeCrashReport {
  return {
    id: REPORT_ID,
    platform: "android",
    source: "android_dropbox",
    appId,
    exceptionType: "CrashedByAdbException",
    frames: [],
    reportPath: "dumpsys dropbox data_app_crash 2026-10-21 10:00:02",
  };
}

class FakeReader implements NativeCrashReportReader {
  readonly reads: Array<{ reportId: string; signal?: AbortSignal }> = [];
  body: NativeCrashReportBody | undefined = { report: report(), text: "full report text" };
  failure: Error | undefined;

  async read(reportId: string, signal?: AbortSignal) {
    this.reads.push({ reportId, signal });
    if (this.failure) {
      throw this.failure;
    }
    return this.body;
  }
}

function harness(options: { active?: boolean; reader?: FakeReader | null } = {}) {
  const reader = options.reader === null ? undefined : (options.reader ?? new FakeReader());
  const readerRequests: BootedDevice[] = [];
  registerCrashReportResources({
    resolveActiveSession: (uuid) =>
      options.active === false ? undefined : { sessionUuid: uuid, device },
    readerFor: (target) => {
      readerRequests.push(target);
      return reader;
    },
  });
  return { reader, readerRequests };
}

function read(uri: string, context: ResourceReadContext = { sessionUuid }) {
  const match = ResourceRegistry.matchTemplate(uri);
  expect(match).toBeDefined();
  const { template, params } = match!;
  if (!("handlerWithReadContext" in template)) {
    throw new Error("crash report resource must read its session context");
  }
  return template.handlerWithReadContext(params, context);
}

const parse = async (uri: string, context?: ResourceReadContext) =>
  JSON.parse((await read(uri, context)).text!);

describe("crash report resource (#14103)", () => {
  beforeEach(() => ResourceRegistry.clearResources());
  afterEach(() => ResourceRegistry.clearResources());

  test("registers the session-scoped template", () => {
    harness();
    expect(ResourceRegistry.getTemplateDefinitions().map((t) => t.uriTemplate)).toContain(
      CRASH_REPORT_RESOURCE_TEMPLATE,
    );
  });

  test("returns the full report body for the session's own device", async () => {
    const { reader, readerRequests } = harness();
    const controller = new AbortController();

    const body = await parse(`${baseUri}/${REPORT_ID}`, {
      sessionUuid,
      signal: controller.signal,
    });

    expect(body).toEqual({
      reportId: REPORT_ID,
      source: "android_dropbox",
      appId: "com.example.app",
      reportPath: "dumpsys dropbox data_app_crash 2026-10-21 10:00:02",
      byteCount: 16,
      truncated: false,
      text: "full report text",
    });
    expect(readerRequests).toEqual([device]);
    expect(reader!.reads).toEqual([{ reportId: REPORT_ID, signal: controller.signal }]);
  });

  test("bounds the text to maxBytes and reports the full size", async () => {
    harness();
    expect(await parse(`${baseUri}/${REPORT_ID}?maxBytes=4`)).toMatchObject({
      byteCount: 16,
      truncated: true,
      text: "full",
    });
  });

  test.each(["0", "abc", "4194305"])(
    "rejects maxBytes=%s before touching the device",
    async (value) => {
      const { readerRequests } = harness();
      expect(await parse(`${baseUri}/${REPORT_ID}?maxBytes=${value}`)).toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(readerRequests).toEqual([]);
    },
  );

  test("refuses a caller that does not own the session without touching the device", async () => {
    const { readerRequests } = harness();
    expect(await parse(`${baseUri}/${REPORT_ID}`, { sessionUuid: "someone-else" })).toMatchObject({
      code: "SESSION_NOT_BOUND",
    });
    expect(readerRequests).toEqual([]);
  });

  test("reports an inactive session", async () => {
    const { readerRequests } = harness({ active: false });
    expect(await parse(`${baseUri}/${REPORT_ID}`)).toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    expect(readerRequests).toEqual([]);
  });

  test("rejects a malformed report id or app id", async () => {
    const { readerRequests } = harness();
    expect(await parse(`${baseUri}/..%2Fsecret`)).toMatchObject({ code: "INVALID_REQUEST" });
    expect(
      await parse(
        `automobile:device-session/${sessionUuid}/apps/bad%20app/crash-reports/${REPORT_ID}`,
      ),
    ).toMatchObject({ code: "INVALID_REQUEST" });
    expect(readerRequests).toEqual([]);
  });

  test("never serves a report that belongs to another app through this app's URI", async () => {
    const reader = new FakeReader();
    reader.body = { report: report("com.other.app"), text: "someone else's crash" };
    harness({ reader });
    const body = await parse(`${baseUri}/${REPORT_ID}`);
    expect(body).toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(body)).not.toContain("someone else's crash");
  });

  test("reports NOT_FOUND when the report is gone", async () => {
    const reader = new FakeReader();
    reader.body = undefined;
    harness({ reader });
    expect(await parse(`${baseUri}/${REPORT_ID}`)).toMatchObject({ code: "NOT_FOUND" });
  });

  test("reports UNSUPPORTED when the platform has no reader", async () => {
    harness({ reader: null });
    expect(await parse(`${baseUri}/${REPORT_ID}`)).toMatchObject({ code: "UNSUPPORTED" });
  });

  test("turns a reader failure into READ_FAILED", async () => {
    const reader = new FakeReader();
    reader.failure = new Error("adb: device offline");
    harness({ reader });
    expect(await parse(`${baseUri}/${REPORT_ID}`)).toEqual({
      code: "READ_FAILED",
      error: "adb: device offline",
    });
  });
});
