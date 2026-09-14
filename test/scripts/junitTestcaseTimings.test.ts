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
      ["test/suite.test.ts", "suite", "fast", "1.000000", "1", "report.xml", "occurrence:1"].join(
        separator,
      ),
      ["test/suite.test.ts", "suite", "slow", "200.000000", "1", "report.xml", "occurrence:1"].join(
        separator,
      ),
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
        "occurrence:1",
      ].join(separator),
    ]);
  });

  test("increments duplicate tuple occurrences across suites in one report", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01"/></testsuite><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.02"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[4])).toEqual(["1", "2"]);
    expect(rows.map((row) => row.split(separator)[6])).toEqual(["occurrence:1", "occurrence:2"]);
  });

  test("uses testcase lines as stable identity for duplicate tuples", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01" line="10"/><testcase classname="suite" name="duplicate" time="0.02" line="42"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[6])).toEqual(["line:10", "line:42"]);
  });

  // The gate's aggregation (scripts/validate-bun-test-timings.sh) depends on
  // same-line duplicates sharing an identical identity tuple with distinct
  // durations preserved as separate rows; see
  // test/features/utility/DisplayConfig.test.ts:130-132 for the real shape.
  test("emits identical line identity for same-line duplicate tuples, leaving aggregation to the gate", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01" line="130"/><testcase classname="suite" name="duplicate" time="0.15" line="130"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[6])).toEqual(["line:130", "line:130"]);
    expect(rows.map((row) => row.split(separator)[3])).toEqual(["10.000000", "150.000000"]);
  });

  test("falls back to occurrence identity when duplicate tuples have no lines", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01"/><testcase classname="suite" name="duplicate" time="0.02"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[6])).toEqual(["occurrence:1", "occurrence:2"]);
  });

  test("keeps a missing-line identity distinct from a coincidentally-matching literal line value", async () => {
    const rows = await parseJunitTestcaseTimings(
      `<testsuites><testsuite file="test/case.test.ts"><testcase classname="suite" name="duplicate" time="0.01"/><testcase classname="suite" name="duplicate" time="0.02" line="1"/></testsuite></testsuites>`,
      "report.xml",
    );

    expect(rows.map((row) => row.split(separator)[6])).toEqual(["occurrence:1", "line:1"]);
  });

  test("sanitizes row separators and carriage returns without changing other fields", () => {
    expect(sanitizeJunitField(`slow${separator}case\r\n`)).toBe("slow case  ");
  });
});
