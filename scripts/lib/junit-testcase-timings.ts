import { readFileSync } from "node:fs";
import { parseStringPromise } from "xml2js";

const fieldSeparator = "\x1f";

interface XmlNode {
  $?: Record<string, string | undefined>;
  testcase?: XmlNode | XmlNode[];
  testsuite?: XmlNode | XmlNode[];
  testsuites?: XmlNode | XmlNode[];
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Replaces record-breaking values after xml2js has decoded XML entities. */
export const sanitizeJunitField = (value: string): string => value.replace(/[\x1f\r\n]/g, " ");

/**
 * Extracts US-delimited timing rows from one JUnit report.
 *
 * The report id is deliberately the caller-supplied path, matching awk's FILENAME
 * semantics in the timing gate. Occurrence ordinals reset for each invocation.
 */
export async function parseJunitTestcaseTimings(xml: string, reportId: string): Promise<string[]> {
  const document = (await parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: false,
  })) as XmlNode;
  const rows: string[] = [];
  const occurrences = new Map<string, number>();

  const visitSuite = (suite: XmlNode, inheritedFile: string): void => {
    const suiteFile = sanitizeJunitField(suite.$?.file ?? "") || inheritedFile;
    for (const testcase of asArray(suite.testcase)) {
      const name = sanitizeJunitField(testcase.$?.name ?? "");
      const time = testcase.$?.time ?? "";
      if (name === "" || time === "") {
        continue;
      }
      const testFile = sanitizeJunitField(testcase.$?.file ?? "") || suiteFile;
      const classname = sanitizeJunitField(testcase.$?.classname ?? "");
      const key = `${testFile}\0${classname}\0${name}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      rows.push(
        [
          testFile,
          classname,
          name,
          (Number(time) * 1000).toFixed(6),
          String(occurrence),
          reportId,
        ].join(fieldSeparator),
      );
    }
    for (const childSuite of asArray(suite.testsuite)) {
      visitSuite(childSuite, suiteFile);
    }
  };

  const visitRoot = (node: XmlNode): void => {
    for (const suite of asArray(node.testsuite)) {
      visitSuite(suite, "");
    }
    for (const suites of asArray(node.testsuites)) {
      visitRoot(suites);
    }
  };
  visitRoot(document);
  return rows;
}

if (import.meta.main) {
  const reportPaths = process.argv.slice(2);
  if (reportPaths.length === 0) {
    throw new Error(
      "Usage: bun run scripts/lib/junit-testcase-timings.ts <report.xml> [...report.xml]",
    );
  }
  for (const reportPath of reportPaths) {
    const rows = await parseJunitTestcaseTimings(readFileSync(reportPath, "utf8"), reportPath);
    if (rows.length > 0) {
      process.stdout.write(`${rows.join("\n")}\n`);
    }
  }
}
