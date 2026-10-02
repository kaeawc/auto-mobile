import { IOS_RUNNER_FEATURE_COMMANDS } from "./IOSCtrlProxyClient";

export type IosRunnerEnvironment = "simulator" | "physical";
type Applicability = IosRunnerEnvironment | "both";

// Mirrors CommandHandler.swift:54 supportedRequestTypes(in:); unlisted commands apply to both.
// #8547: require "set_hinge_angle" in IOS_RUNNER_FEATURE_COMMANDS and this table only once RELEASE_CHECKSUM_REGISTRY[0] ships it; 0.0.81 predates PR 8343.
export const IOS_RUNNER_COMMAND_APPLICABILITY = {
  request_shake: "both",
  request_press_button: "both",
  request_multi_finger_swipe: "both",
  add_highlight: "both",
  execute_sql: "both",
  set_network_mock_rules: "both",
  set_hinge_angle: "simulator",
  set_voiceover_state: "physical",
} as const satisfies Record<
  (typeof IOS_RUNNER_FEATURE_COMMANDS)[number] | "set_hinge_angle" | "set_voiceover_state",
  Applicability
>;

export interface IosRunnerCommandRequirements {
  requiredCommands: readonly string[];
  applicability: Readonly<Partial<Record<string, Applicability>>>;
}

const defaultRequirements: IosRunnerCommandRequirements = {
  requiredCommands: IOS_RUNNER_FEATURE_COMMANDS,
  applicability: IOS_RUNNER_COMMAND_APPLICABILITY,
};

export function getRequiredIosRunnerFeatureCommands(
  environment?: IosRunnerEnvironment,
  requirements: IosRunnerCommandRequirements = defaultRequirements,
): string[] {
  return requirements.requiredCommands.filter((command) => {
    const applicability = requirements.applicability[command] ?? "both";
    // Unknown environments must never require an environment-restricted command.
    return applicability === "both" || applicability === environment;
  });
}

export function getMissingIosRunnerFeatureCommands(
  advertised: ReadonlySet<string>,
  environment?: IosRunnerEnvironment,
  requirements?: IosRunnerCommandRequirements,
): string[] {
  return getRequiredIosRunnerFeatureCommands(environment, requirements).filter(
    (command) => !advertised.has(command),
  );
}
