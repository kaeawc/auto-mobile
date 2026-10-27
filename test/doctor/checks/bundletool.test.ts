import { describe, expect, test } from "bun:test";
import { checkBundletool } from "../../../src/doctor/checks/bundletool";
import { FakeBundletoolLocator } from "../../fakes/FakeBundletoolLocator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

const exec = (stdout: string) => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (search: string) => stdout.includes(search),
});

describe("checkBundletool", () => {
  test("passes with the version and reports the location as the value", async () => {
    const hostExecutor = new FakeHostCommandExecutor();
    hostExecutor.setCommandResponse("bundletool version", exec("1.18.1\n"));
    const signal = new AbortController().signal;

    const result = await checkBundletool(
      { timeoutMs: 5000, signal },
      { locator: new FakeBundletoolLocator(), hostExecutor },
    );

    expect(result).toEqual({
      name: "bundletool",
      status: "pass",
      message: "bundletool 1.18.1",
      value: "/usr/local/bin/bundletool",
    });
    expect(hostExecutor.getExecutedCalls()).toEqual([
      {
        command: "/usr/local/bin/bundletool",
        args: ["version"],
        options: { timeoutMs: 5000, signal },
      },
    ]);
  });

  test("warns with the install steps when bundletool is missing", async () => {
    const locator = new FakeBundletoolLocator();
    locator.setMissing("bundletool is not on PATH");
    const hostExecutor = new FakeHostCommandExecutor();

    const result = await checkBundletool({}, { locator, hostExecutor });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("bundletool is not on PATH");
    expect(result.recommendation).toContain("brew install bundletool");
    expect(hostExecutor.getExecutedCalls()).toEqual([]);
  });

  test("fails when a located bundletool does not run", async () => {
    const hostExecutor = new FakeHostCommandExecutor();
    hostExecutor.setCommandError("version", new Error("Unsupported class file major version"));

    const result = await checkBundletool(
      {},
      { locator: new FakeBundletoolLocator(), hostExecutor },
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("Unsupported class file major version");
  });
});
