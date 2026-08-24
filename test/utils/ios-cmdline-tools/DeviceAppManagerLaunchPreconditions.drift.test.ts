import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEVICE_APP_MANAGER = "src/utils/ios-cmdline-tools/DeviceAppManager.ts";

function readSource(): string {
  return readFileSync(join(process.cwd(), DEVICE_APP_MANAGER), "utf8");
}

function extractMethodBody(source: string, methodName: string): string {
  const marker = methodName === "launchApp" ? "public async launchApp(" : `async ${methodName}(`;
  const signatureIndex = source.indexOf(marker);
  if (signatureIndex === -1) {
    throw new Error(`Method ${methodName} not found in ${DEVICE_APP_MANAGER}`);
  }

  let cursor = source.indexOf("(", signatureIndex);
  let parenDepth = 0;
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === "(") {
      parenDepth++;
    } else if (source[cursor] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        cursor++;
        break;
      }
    }
  }

  const bodyStartMatch = /\{\r?\n/.exec(source.slice(cursor));
  if (!bodyStartMatch) {
    throw new Error(`Method ${methodName} body not found in ${DEVICE_APP_MANAGER}`);
  }
  const openBrace = cursor + bodyStartMatch.index;
  let braceDepth = 0;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === "{") {
      braceDepth++;
    } else if (source[index] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }

  throw new Error(`Unbalanced braces scanning ${methodName}`);
}

describe("DeviceAppManager launch precondition drift guard (issue #3123)", () => {
  const source = readSource();

  test("launchApp and launchWithPayloadUrl share one launch precondition helper", () => {
    for (const methodName of ["launchApp", "launchWithPayloadUrl"]) {
      const body = extractMethodBody(source, methodName);
      expect(
        body,
        `${methodName} must use getLaunchPrecondition so non-darwin guards cannot drift.`,
      ).toContain("this.getLaunchPrecondition()");
    }
  });

  test("launch entry points do not duplicate platform guard reads", () => {
    for (const methodName of ["launchApp", "launchWithPayloadUrl"]) {
      const body = extractMethodBody(source, methodName);
      expect(body, `${methodName} must not read the platform gate directly.`).not.toContain(
        "this.deps.platform()",
      );
    }
  });
});
