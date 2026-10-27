import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { AndroidCtrlProxyAccessibility } from "../../src/ctrlProxy/AndroidCtrlProxyAccessibility";
import { grantLocalNetworkPermission } from "../../src/ctrlProxy/grantLocalNetworkPermission";
import {
  HEADLESS_SYSTEM_USER_PROP,
  resolveSetupUser,
  settingsCommand,
  userFlag,
} from "../../src/ctrlProxy/setupUser";
import { CTRL_PROXY_PACKAGE } from "../../src/ctrlProxy/constants";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const SERVICE = `${CTRL_PROXY_PACKAGE}/${CTRL_PROXY_PACKAGE}.CtrlProxy`;
const respond = (adb: FakeAdbExecutor, pattern: string, stdout: string) =>
  adb.setCommandResponse(pattern, createExecResult(stdout, ""));

function headlessAutomotive(user = "10") {
  const adb = new FakeAdbExecutor();
  respond(adb, HEADLESS_SYSTEM_USER_PROP, "true\n");
  respond(adb, "am get-current-user", `${user}\n`);
  return adb;
}

describe("resolveSetupUser (#14918)", () => {
  test("a headless-system-user automotive device resolves to the foreground user", async () => {
    expect(await resolveSetupUser(headlessAutomotive("10"), { formFactor: "automotive" })).toBe(10);
  });

  test("a phone, or any non-automotive device, issues no command at all", async () => {
    const adb = new FakeAdbExecutor();
    for (const formFactor of [undefined, "phone", "tablet", "foldable", "tv", "watch"] as const) {
      expect(await resolveSetupUser(adb, { formFactor })).toBeUndefined();
    }
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an automotive device whose system user is not headless keeps the default user", async () => {
    const adb = new FakeAdbExecutor();
    respond(adb, HEADLESS_SYSTEM_USER_PROP, "false\n");
    expect(await resolveSetupUser(adb, { formFactor: "automotive" })).toBeUndefined();
    expect(adb.getExecutedCommands().some((c) => c.includes("get-current-user"))).toBe(false);
  });

  test("a foreground user that cannot be read is an actionable user error", async () => {
    const adb = new FakeAdbExecutor();
    respond(adb, HEADLESS_SYSTEM_USER_PROP, "true");
    respond(adb, "am get-current-user", "Error: system server not ready");
    const error = await resolveSetupUser(adb, { formFactor: "automotive" }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("headless system user");
    expect((error as Error).message).toContain("foreground user");
  });

  test("a reported user 0 means there is nothing to target", async () => {
    expect(await resolveSetupUser(headlessAutomotive("0"), { formFactor: "automotive" })).toBe(
      undefined,
    );
  });

  test("command builders add --user only for a resolved user", () => {
    expect(userFlag(undefined)).toBe("");
    expect(userFlag(10)).toBe(" --user 10");
    expect(settingsCommand(undefined, "get secure x")).toBe("shell settings get secure x");
    expect(settingsCommand(10, "get secure x")).toBe("shell settings --user 10 get secure x");
  });
});

function accessibility(adb: FakeAdbExecutor, user: number | undefined) {
  const timer = new FakeTimer();
  const accessibility = new AndroidCtrlProxyAccessibility({
    cachedAvailability: null,
    timer,
    adb,
    readDeviceTraits: async () => ({}) as never,
    statusInspectionDeviceError: () => undefined,
    isInstalled: async () => true,
    isEnabled: async () => true,
    assertNotDrivenByOtherDaemon: async () => {},
    getToggleCapabilities: async () => ({ supportsSettingsToggle: true }) as never,
    clearAvailabilityCache: () => {},
    enableViaSettings: async () => {},
    getApiLevel: async () => [34, true],
    setupUser: async () => user,
  });
  return accessibility;
}

describe("CtrlProxy accessibility setup for the setup user (#14918)", () => {
  test("a headless device checks installation for the foreground user", async () => {
    const adb = new FakeAdbExecutor();
    respond(adb, "pm list packages", `package:${CTRL_PROXY_PACKAGE}\n`);
    expect(await accessibility(adb, 10).isInstalled()).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([
      `shell pm list packages --user 10 ${CTRL_PROXY_PACKAGE}`,
    ]);
  });

  test("a headless device reads and enables the service for the foreground user", async () => {
    const adb = new FakeAdbExecutor();
    respond(adb, "settings --user 10 get secure enabled_accessibility_services", "null\n");
    await accessibility(adb, 10).enableViaSettings();
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings --user 10 get secure enabled_accessibility_services",
      `shell settings --user 10 put secure enabled_accessibility_services "${SERVICE}"`,
      "shell settings --user 10 put secure accessibility_enabled 1",
    ]);
  });

  test("a headless device keeps the user's other services and disables for that user", async () => {
    const adb = new FakeAdbExecutor();
    respond(
      adb,
      "settings --user 10 get secure enabled_accessibility_services",
      `x/y:${SERVICE}\n`,
    );
    await accessibility(adb, 10).disableViaSettings();
    expect(adb.getExecutedCommands()).toEqual([
      "shell settings --user 10 get secure enabled_accessibility_services",
      'shell settings --user 10 put secure enabled_accessibility_services "x/y"',
    ]);
  });

  test("a phone issues exactly the commands it always did", async () => {
    const adb = new FakeAdbExecutor();
    respond(adb, "settings get secure enabled_accessibility_services", "null\n");
    respond(adb, "pm list packages", "");
    const phone = accessibility(adb, undefined);
    await phone.isInstalled();
    await phone.enableViaSettings();
    expect(adb.getExecutedCommands()).toEqual([
      `shell pm list packages ${CTRL_PROXY_PACKAGE}`,
      "shell settings get secure enabled_accessibility_services",
      `shell settings put secure enabled_accessibility_services "${SERVICE}"`,
      "shell settings put secure accessibility_enabled 1",
    ]);
  });

  test("an unresolvable foreground user surfaces as itself, not as an inspection failure", async () => {
    const adb = new FakeAdbExecutor();
    const broken = new AndroidCtrlProxyAccessibility({
      cachedAvailability: null,
      timer: new FakeTimer(),
      adb,
      readDeviceTraits: async () => ({}) as never,
      statusInspectionDeviceError: () => undefined,
      isInstalled: async () => true,
      isEnabled: async () => true,
      assertNotDrivenByOtherDaemon: async () => {},
      getToggleCapabilities: async () => ({ supportsSettingsToggle: true }) as never,
      clearAvailabilityCache: () => {},
      enableViaSettings: async () => {},
      getApiLevel: async () => [34, true],
      setupUser: async () => {
        throw new ActionableError("foreground user unavailable");
      },
    });
    await expect(broken.isInstalled()).rejects.toThrow("foreground user unavailable");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("local-network grant for the setup user", () => {
  test("targets the user when one is given and is unchanged otherwise", async () => {
    const withUser = new FakeAdbExecutor();
    await grantLocalNetworkPermission(withUser, CTRL_PROXY_PACKAGE, 37, 10);
    expect(withUser.getExecutedCommands()).toEqual([
      `shell pm grant --user 10 ${CTRL_PROXY_PACKAGE} android.permission.ACCESS_LOCAL_NETWORK`,
    ]);
    const plain = new FakeAdbExecutor();
    await grantLocalNetworkPermission(plain, CTRL_PROXY_PACKAGE, 37);
    expect(plain.getExecutedCommands()).toEqual([
      `shell pm grant ${CTRL_PROXY_PACKAGE} android.permission.ACCESS_LOCAL_NETWORK`,
    ]);
  });
});
