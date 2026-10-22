import { describe, expect, test } from "bun:test";
import { parseRunJobOutput } from "../../../src/features/backgroundWork/RunJobOutput";

describe("parseRunJobOutput", () => {
  test("a started job", () => {
    expect(parseRunJobOutput("Running job")).toEqual({ ran: true, forced: false });
  });

  test("a forced job", () => {
    expect(parseRunJobOutput("Running job [FORCED]")).toEqual({ ran: true, forced: true });
  });

  test.each([
    ["Job was not ready to run; constraints unsatisfied. Use -f to force", "job_not_ready"],
    ["Error: package dev.example.absent not found", "package_not_found"],
    ["Job 99 not found for dev.example.playground", "job_not_found"],
    ["java.lang.SecurityException: Permission Denial", "permission_denied"],
    ["something unexpected", "run_failed"],
    ["", "run_failed"],
  ])("%p is %s", (output, errorCode) => {
    expect(parseRunJobOutput(output)).toMatchObject({ ran: false, errorCode });
  });
});
