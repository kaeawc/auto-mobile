import { describe, expect, test } from "bun:test";
import {
  parseJunitTestcaseTimings,
  sanitizeJunitField,
} from "../../scripts/lib/junit-testcase-timings";

const separator = "\x1f";

describe("parseJunitTestcaseTimings", () => {
  test("extracts timing rows with suite file fallback and six-decimal milliseconds", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/suite.test.ts"><testcase classname="suite" name="fast" time="0.001"/><testcase classname="suite" name="slow" time="0.2"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows).toEqual([
      ["test/suite.test.ts", "suite", "fast", "1.000000", "1", "report.xml"].join(separator),
      ["test/suite.test.ts", "suite", "slow", "200.000000", "1", "report.xml"].join(separator),
    ]);
  });

  test("keeps newline-bearing names in one row and decodes XML entities", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite><testcase file="test/case.test.ts" classname="suite" name="slow\n&amp; &lt;case&gt; &quot;quoted&quot; &apos;apostrophe&apos;" time="0.15"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows).toEqual([
      [
        "test/case.test.ts",
        "suite",
        "slow & <case> \"quoted\" 'apostrophe'",
        "150.000000",
        "1",
        "report.xml",
      ].join(separator),
    ]);
  });

  test("increments duplicate tuple occurrences across suites in one report", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01"/></testsuite><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.02"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[4])).toEqual(["1", "2"]);
  });

  test("sanitizes row separators and carriage returns without changing other fields", () => {
    expect(sanitizeJunitField(`slow${separator}case\r\n`)).toBe("slow case  ");
  });
});
