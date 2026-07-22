import { describe, expect, test } from "bun:test";
import { restoreIosSettings } from "../../../src/utils/ios-cmdline-tools/iosSettings";
import { getAppDataContainerPath } from "../../../src/utils/ios-cmdline-tools/iosAppContainer";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";

const UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";

/**
 * Argument shapes that a string-built command line loses or mangles when it is
 * re-split back into argv. Issue #4196: the empty value is the dangerous one —
 * dropping it shifts every later positional argument, so a `defaults write`
 * silently turns into a shorter, different command.
 */
const TRICKY_VALUES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "empty string", value: "" },
  { label: "newline", value: "line1\nline2" },
  { label: "tab", value: "col1\tcol2" },
  { label: "carriage return", value: "a\rb" },
  { label: "double quote", value: "say \"hi\"" },
  { label: "single quote", value: "it's" },
  { label: "backslash", value: "back\\slash" },
  { label: "literal backslash-n", value: "C:\\new\\tab" },
  { label: "space", value: "two words" },
  { label: "leading/trailing space", value: "  padded  " },
  { label: "shell metacharacters", value: "$HOME `id` ; rm -rf /" },
  { label: "unicode", value: "café — 日本語 🎉" },
];

describe("simctl argv integrity (#4196)", () => {
  describe("restoreIosSettings issues an argv array, preserving every value", () => {
    for (const { label, value } of TRICKY_VALUES) {
      test(`defaults write survives ${label}`, async () => {
        const simctl = new FakeSimCtlClient();

        await restoreIosSettings(simctl as any, UDID, {
          values: { ".GlobalPreferences/AppleLocale": value },
        });

        const argvCalls = simctl.getMethodCalls("executeCommandArgs");
        expect(argvCalls).toHaveLength(1);
        expect(argvCalls[0].args).toEqual([
          "spawn",
          UDID,
          "defaults",
          "write",
          ".GlobalPreferences",
          "AppleLocale",
          value,
        ]);
      });
    }

    test("an empty value keeps `write` as the verb and does not shift positions", async () => {
      const simctl = new FakeSimCtlClient();

      await restoreIosSettings(simctl as any, UDID, {
        values: { ".GlobalPreferences/AppleLocale": "" },
      });

      const args = simctl.getMethodCalls("executeCommandArgs")[0].args as string[];
      expect(args[3]).toBe("write");
      expect(args).toHaveLength(7);
    });

    test("no legacy string command path is used for defaults write", async () => {
      const simctl = new FakeSimCtlClient();
      await restoreIosSettings(simctl as any, UDID, {
        values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
        ui: { appearance: "dark", contentSize: "large" },
      });
      expect(simctl.getMethodCalls("executeCommand")).toEqual([]);
    });
  });

  describe("getAppDataContainerPath issues an argv array", () => {
    for (const { label, value } of TRICKY_VALUES) {
      test(`bundle id survives ${label}`, async () => {
        const simctl = new FakeSimCtlClient();
        simctl.setCommandArgsResult(
          ["get_app_container", UDID, value, "data"],
          "/tmp/container\n"
        );

        const result = await getAppDataContainerPath(simctl as any, UDID, value);

        expect(result).toBe("/tmp/container");
        expect(simctl.getMethodCalls("executeCommandArgs")[0].args).toEqual([
          "get_app_container",
          UDID,
          value,
          "data",
        ]);
      });
    }
  });

  describe("legacy string command path no longer drops empty quoted arguments", () => {
    test("an empty quoted token is preserved as an empty argv entry", async () => {
      const seen: string[][] = [];
      const client = new Simctl(null, async (_file, args) => {
        if (args.join(" ") !== "simctl --version") {
          seen.push(args);
        }
        return createExecResult("", "");
      });

      await client.executeCommand("spawn udid defaults write domain key \"\"");

      expect(seen[0]).toEqual([
        "simctl",
        "spawn",
        "udid",
        "defaults",
        "write",
        "domain",
        "key",
        "",
      ]);
    });
  });
});
