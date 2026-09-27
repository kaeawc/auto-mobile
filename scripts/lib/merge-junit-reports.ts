import { readFileSync, writeFileSync } from "node:fs";
import { Builder, parseStringPromise } from "xml2js";

interface Suite {
  $?: Record<string, string>;
}

interface Report {
  testsuites?: {
    $?: Record<string, string>;
    testsuite?: Suite[];
  };
}

const counters = ["tests", "assertions", "failures", "errors", "skipped", "time"] as const;

export async function mergeJunitReports(xmlReports: string[]): Promise<string> {
  const reports = (await Promise.all(
    xmlReports.map((xml) => parseStringPromise(xml) as Promise<Report>),
  )) as Report[];
  const roots = reports.map((report) => report.testsuites);
  if (roots.some((root) => root === undefined)) {
    throw new Error("Expected a <testsuites> root in every JUnit report");
  }

  const merged = {
    testsuites: {
      $: { ...roots[0]?.$ },
      testsuite: roots.flatMap((root) => root?.testsuite ?? []),
    },
  };
  for (const counter of counters) {
    const values = roots.map((root) => root?.$?.[counter]);
    if (values.every((value) => value !== undefined && Number.isFinite(Number(value)))) {
      merged.testsuites.$[counter] = String(
        values.reduce<number>((sum, value) => sum + Number(value), 0),
      );
    } else {
      delete merged.testsuites.$[counter];
    }
  }
  return new Builder().buildObject(merged);
}

if (import.meta.main) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length < 2) {
    throw new Error(
      "Usage: bun scripts/lib/merge-junit-reports.ts <output> <report> <report> [...]",
    );
  }
  const xml = await mergeJunitReports(inputs.map((input) => readFileSync(input, "utf8")));
  writeFileSync(output, xml);
}
