import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  prototypeNotificationIdOfTag,
  prototypeNotificationsReport,
  prototypeNotificationsReportSchema,
} from "../../../src/features/prototype/prototypeNotificationsReport";

interface ReportCase {
  name: string;
  snapshot: unknown;
  report: unknown;
}

// The shared cases the Kotlin and Swift `PrototypeNotificationsReport` twins replay too.
const cases = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "../../fixtures/prototype-notifications/report.json"),
    "utf8",
  ),
) as ReportCase[];

describe("prototypeNotificationsReport", () => {
  test("the shared fixture holds cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const fixture of cases) {
    test(fixture.name, () => {
      const report = prototypeNotificationsReport(fixture.snapshot);
      expect(report).toEqual(prototypeNotificationsReportSchema.parse(fixture.report));
      expect(prototypeNotificationsReportSchema.safeParse(report).success).toBe(true);
    });
  }

  test("the schema refuses an unknown field and an out-of-range progress", () => {
    const base = { permission: "granted", badge: 0, channels: [], pending: [] };
    const active = {
      id: "a",
      channel: "c",
      title: "t",
      ongoing: false,
      actions: [],
      postedAt: 1,
    };
    expect(
      prototypeNotificationsReportSchema.safeParse({ ...base, active: [active] }).success,
    ).toBe(true);
    expect(
      prototypeNotificationsReportSchema.safeParse({ ...base, active: [{ ...active, extra: 1 }] })
        .success,
    ).toBe(false);
    expect(
      prototypeNotificationsReportSchema.safeParse({
        ...base,
        active: [{ ...active, progress: { value: 2 } }],
      }).success,
    ).toBe(false);
  });

  test("names a prototype id only for a non-empty proto: tag", () => {
    expect(prototypeNotificationIdOfTag("proto:upload")).toBe("upload");
    expect(prototypeNotificationIdOfTag("proto:")).toBeUndefined();
    expect(prototypeNotificationIdOfTag("Discovery")).toBeUndefined();
    expect(prototypeNotificationIdOfTag(null)).toBeUndefined();
  });
});
