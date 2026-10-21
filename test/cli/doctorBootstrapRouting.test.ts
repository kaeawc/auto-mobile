import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";
import { describe, expect, test } from "bun:test";
import { cliCommandSkipsServerBootstrap } from "../../src/cli";
import { ToolRegistry } from "../../src/server/toolRegistry";

isolateEmptyToolRegistry();

describe("cliCommandSkipsServerBootstrap", () => {
  test.each([
    [["doctor", "--help"]],
    [["doctor", "--help", "yes"]],
    [["doctor", "--json", "--help"]],
    [["--session-uuid", "session-abc", "doctor", "--help"]],
    [["doctor", "--bogus"]],
    [["doctor", "--repair"]],
    [["doctor", "--timeout-ms", "5000"]],
    [["doctor", "--__proto__"]],
    [["doctor", "--constructor"]],
  ])("answers usage- or error-only doctor invocation %p before the bootstrap", (cliArgs) => {
    expect(cliCommandSkipsServerBootstrap(cliArgs)).toBe(true);
  });

  test.each([
    [[]],
    [["help"]],
    [["doctor"]],
    [["doctor", "--android", "--ios", "--json"]],
    [["doctor", "--help=false"]],
    [["doctor", "--session-uuid", "session-abc"]],
    [["doctor", "--session-uuid", ""]],
    [["doctor", "bogus"]],
    [["observe", "--help"]],
    [["observe", "--bogus"]],
  ])("keeps the normal startup path for %p", (cliArgs) => {
    expect(cliCommandSkipsServerBootstrap(cliArgs)).toBe(false);
  });

  test("classifies without registering the CLI tools ahead of the bootstrap", () => {
    cliCommandSkipsServerBootstrap(["doctor", "--help"]);
    cliCommandSkipsServerBootstrap(["observe", "--platform", "android"]);
    expect(ToolRegistry.getEveryRegisteredTool()).toEqual([]);
  });
});
