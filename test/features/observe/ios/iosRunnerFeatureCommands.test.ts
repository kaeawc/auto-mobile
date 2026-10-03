import { describe, expect, test } from "bun:test";
import { IOS_RUNNER_FEATURE_COMMANDS } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import {
  IOS_RUNNER_COMMAND_APPLICABILITY,
  getRequiredIosRunnerFeatureCommands,
  getMissingIosRunnerFeatureCommands,
  type IosRunnerCommandRequirements,
  type IosRunnerEnvironment,
} from "../../../../src/features/observe/ios/iosRunnerFeatureCommands";

describe("iOS runner feature commands", () => {
  const requirements: IosRunnerCommandRequirements = {
    requiredCommands: [...IOS_RUNNER_FEATURE_COMMANDS, "set_voiceover_state"],
    applicability: IOS_RUNNER_COMMAND_APPLICABILITY,
  };

  test("mirrors exactly CommandHandler.swift supportedRequestTypes(in:) restrictions", () => {
    expect(
      Object.fromEntries(
        Object.entries(IOS_RUNNER_COMMAND_APPLICABILITY).filter(([, value]) => value !== "both"),
      ),
    ).toEqual({ set_hinge_angle: "simulator", set_voiceover_state: "physical" });
  });

  const sharedCommands = IOS_RUNNER_FEATURE_COMMANDS.filter(
    (command) => command !== "set_hinge_angle",
  );

  test("registers the released set_hinge_angle command with simulator-only default requirements", () => {
    expect([...IOS_RUNNER_FEATURE_COMMANDS]).toContain("set_hinge_angle");
    expect(getRequiredIosRunnerFeatureCommands("simulator")).toContain("set_hinge_angle");
    expect(getRequiredIosRunnerFeatureCommands("physical")).not.toContain("set_hinge_angle");
    expect(getRequiredIosRunnerFeatureCommands()).not.toContain("set_hinge_angle");
    expect(getMissingIosRunnerFeatureCommands(new Set(sharedCommands), "physical")).toEqual([]);
  });

  const environments: (IosRunnerEnvironment | undefined)[] = ["simulator", "physical", undefined];
  for (const environment of environments) {
    test(`both consumers' shared check selects applicable requirements for ${environment ?? "unknown"}`, () => {
      const restricted =
        environment === "simulator"
          ? ["set_hinge_angle"]
          : environment === "physical"
            ? ["set_voiceover_state"]
            : [];
      expect(getRequiredIosRunnerFeatureCommands(environment, requirements)).toEqual([
        ...sharedCommands,
        ...restricted,
      ]);
      expect(
        getMissingIosRunnerFeatureCommands(new Set(sharedCommands), environment, requirements),
      ).toEqual(restricted);
      for (const command of requirements.requiredCommands) {
        const advertised = new Set(
          requirements.requiredCommands.filter((value) => value !== command),
        );
        const expected =
          new Set<string>(sharedCommands).has(command) || restricted.includes(command)
            ? [command]
            : [];
        expect(getMissingIosRunnerFeatureCommands(advertised, environment, requirements)).toEqual(
          expected,
        );
      }
      expect(getRequiredIosRunnerFeatureCommands(environment)).toEqual([
        ...sharedCommands,
        ...(environment === "simulator" ? ["set_hinge_angle"] : []),
      ]);
    });
  }

  test("unlisted commands default to both environments", () => {
    const unlisted = { requiredCommands: ["future_shared_command"], applicability: {} };
    for (const environment of environments) {
      expect(getMissingIosRunnerFeatureCommands(new Set(), environment, unlisted)).toEqual([
        "future_shared_command",
      ]);
    }
  });
});
