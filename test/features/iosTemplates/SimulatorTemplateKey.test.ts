import { expect, test } from "bun:test";
import {
  isTemplateSimName,
  templateName,
  templateKeyHash,
  resolveTemplateCloneEnabled,
  TEMPLATE_CLONE_DEFAULT_ENABLED,
} from "../../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
const key = {
  runtime: "ios",
  runtimeBuild: "A1",
  xcodeBuild: "X1",
  deviceType: "phone",
  profile: "none" as const,
};
test("template names are deterministic, reserved, and sensitive to every key field", () => {
  expect(templateName(key)).toMatch(/^automobile-template-[a-f0-9]{8}$/);
  expect(templateName({ ...key })).toBe(templateName(key));
  for (const other of [
    { ...key, runtime: "other" },
    { ...key, runtimeBuild: "A2" },
    { ...key, xcodeBuild: "X2" },
    { ...key, deviceType: "tablet" },
    { ...key, profile: "minimal" as const },
  ]) {
    expect(templateKeyHash(other)).not.toBe(templateKeyHash(key));
  }
  expect(isTemplateSimName(templateName(key))).toBe(true);
  expect(isTemplateSimName("AutoMobile-phone")).toBe(false);
  expect(isTemplateSimName("automobile-template-mine")).toBe(false);
});
test("clone flag is tri-state with a single disabled default", () => {
  expect(TEMPLATE_CLONE_DEFAULT_ENABLED).toBe(false);
  expect(resolveTemplateCloneEnabled({})).toBe(false);
  for (const value of ["1", "true"]) {
    expect(resolveTemplateCloneEnabled({ AUTOMOBILE_IOS_TEMPLATE_CLONE: value })).toBe(true);
  }
  for (const value of ["0", "false", "invalid"]) {
    expect(resolveTemplateCloneEnabled({ AUTOMOBILE_IOS_TEMPLATE_CLONE: value })).toBe(false);
  }
});
