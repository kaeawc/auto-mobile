import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GrantAndroidPermissions } from "../../../src/features/action/GrantAndroidPermissions";
import { AppPermissions } from "../../../src/features/action/AppPermissions";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import {
  resetAppPermissionsFactory,
  setAppPermissionsFactory,
  setAppPermissionsHandler,
} from "../../../src/server/appTools";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = { platform: "android", name: "emu", deviceId: "emulator-5554" };
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../fixtures/android-dumpsys-package/${name}.txt`, import.meta.url),
    "utf8",
  );
const egg = fixture("dumpsys-package-system-installed");
const playground = fixture("dumpsys-package-installed");
const read = "android.permission.READ_EXTERNAL_STORAGE";
const post = "android.permission.POST_NOTIFICATIONS";
const camera = "android.permission.CAMERA";
const flip = (capture: string, permission: string, granted: boolean) =>
  capture.replace(`${permission}: granted=${!granted}`, `${permission}: granted=${granted}`);
function harness(before = egg, after = before) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponseSequence(
    "shell dumpsys package",
    [before, after].map((stdout) => ({ stdout, stderr: "" })),
  );
  const factory = new FakeAdbClientFactory(adb);
  return {
    adb,
    action: new GrantAndroidPermissions(device, factory, () => new NoOpPerformanceTracker()),
    permissions: new AppPermissions(device, { adbFactory: factory }),
  };
}
afterEach(resetAppPermissionsFactory);

test.each(["grant", "revoke"] as const)(
  "%s rejects unrequested CAMERA before pm, including aggregate counts",
  async (action) => {
    const h = harness(playground);
    const result = await h.action.execute("dev.jasonpearson.automobile.playground", {
      action,
      permissions: [camera],
      userId: 0,
    });
    expect(result.success).toBe(false);
    expect(result.results[0]).toMatchObject({ success: false, countsTowardSuccess: true });
    expect(result.results[0].error).toContain("not requested");
    expect(h.adb.wasCommandExecuted(`shell pm ${action}`)).toBe(false);
    expect(
      await h.permissions.setPermissions("dev.jasonpearson.automobile.playground", {
        action,
        permissions: [camera],
        userId: 0,
      }),
    ).toMatchObject({ success: false, changedCount: 0, failedCount: 1 });
  },
);

test.each([
  { action: "grant", permission: read, granted: true },
  { action: "revoke", permission: post, granted: false },
] as const)("$action verifies a real state change", async ({ action, permission, granted }) => {
  const h = harness(egg, flip(egg, permission, granted));
  const result = await h.permissions.setPermissions("com.android.egg", {
    action,
    permissions: [permission],
    userId: 0,
  });
  expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
  expect(h.adb.getExecutedCommands()).toEqual([
    "shell dumpsys package 'com.android.egg'",
    `shell pm ${action} --user 0 'com.android.egg' '${permission}'`,
    "shell dumpsys package 'com.android.egg'",
  ]);
});

test.each([
  { action: "grant", permission: post, reason: "already granted" },
  { action: "revoke", permission: read, reason: "already revoked" },
] as const)("$action skips unchanged state", async ({ action, permission, reason }) => {
  const h = harness();
  const item = await h.action.execute("com.android.egg", {
    action,
    permissions: [permission],
    userId: 0,
  });
  expect(item.results[0]).toMatchObject({ success: true, skipped: true, skipReason: reason });
  expect(
    await h.permissions.setPermissions("com.android.egg", {
      action,
      permissions: [permission],
      userId: 0,
    }),
  ).toMatchObject({ success: true, changedCount: 0, failedCount: 0 });
  expect(h.adb.wasCommandExecuted(`shell pm ${action}`)).toBe(false);
});

test("install-time permissions fail before pm", async () => {
  const h = harness(playground);
  const result = await h.action.execute("dev.jasonpearson.automobile.playground", {
    permissions: ["android.permission.INTERNET"],
    userId: 0,
  });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("not a runtime/changeable permission");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(false);
});

test.each(["grant", "revoke"] as const)(
  "silent pm %s without a state change fails verification",
  async (action) => {
    const h = harness();
    const result = await h.action.execute("com.android.egg", {
      action,
      permissions: [action === "grant" ? read : post],
      userId: 0,
    });
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("verification");
  },
);

test("mixed list counts only verified changes and handler retains partial success", async () => {
  const h = harness(egg, flip(egg, read, true));
  setAppPermissionsFactory(() => h.permissions);
  const response = await setAppPermissionsHandler(device, {
    appId: "com.android.egg",
    permissions: [read, post, camera],
    userId: 0,
  });
  expect(response.isError ?? false).toBe(false);
  const data = JSON.parse(response.content[0].text);
  expect(data).toMatchObject({ success: false, changedCount: 1, failedCount: 1 });
  expect(data?.operations).toMatchObject([
    {
      result: {
        results: [
          { success: true },
          { success: true, skipped: true },
          { success: false, error: expect.stringContaining("not requested") },
        ],
      },
    },
  ]);
});

test("all failed handler sets isError", async () => {
  const h = harness(playground);
  setAppPermissionsFactory(() => h.permissions);
  const response = await setAppPermissionsHandler(device, {
    appId: "dev.jasonpearson.automobile.playground",
    permissions: [camera],
    userId: 0,
  });
  expect(response.isError).toBe(true);
});

test("all unchanged handler explains that no changes were needed", async () => {
  const h = harness();
  setAppPermissionsFactory(() => h.permissions);
  const response = await setAppPermissionsHandler(device, {
    appId: "com.android.egg",
    permissions: [post],
    userId: 0,
  });
  expect(response.isError ?? false).toBe(false);
  expect(JSON.parse(response.content[0].text)).toMatchObject({
    success: true,
    changedCount: 0,
    message:
      "No app permission changes were needed for com.android.egg (already in the requested state)",
  });
});

test.each([
  "",
  fixture("dumpsys-package-not-installed"),
  egg.replace("requested permissions:", "unreadable permissions:"),
])("unparseable pre-read fails without pm", async (capture) => {
  const h = harness(capture);
  await expect(
    h.action.execute("com.android.egg", { permissions: [read], userId: 0 }),
  ).rejects.toThrow("permission state");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(false);
});

test("post-read failure is a per-permission failure", async () => {
  const h = harness(egg, "");
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 0 });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("permission state");
});

test("explicit user 10 consults its own runtime block", async () => {
  // Derive a second user's block from the captured User 0 block, changing only READ's grant token.
  const block = egg.slice(egg.indexOf("    User 0: ceDataInode"), egg.indexOf("\nQueries:"));
  const twoUsers = egg.replace(
    "\nQueries:",
    `${flip(block.replace("User 0:", "User 10:"), read, true)}\nQueries:`,
  );
  const h = harness(twoUsers);
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 10 });
  expect(result.results[0]).toMatchObject({ success: true, skipped: true });
  expect(h.adb.getExecutedCommands()).toEqual(["shell dumpsys package 'com.android.egg'"]);
});

test("pre-read ADB failure surfaces an actionable error before pm", async () => {
  const h = harness();
  h.adb.setCommandError("shell dumpsys package", new Error("offline"));
  await expect(
    h.action.execute("com.android.egg", { permissions: [read], userId: 0 }),
  ).rejects.toThrow("Cannot read permission state");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(false);
});

test("duplicate runtime permission counts the state change once", async () => {
  const h = harness(egg, flip(egg, read, true));
  expect(
    await h.permissions.setPermissions("com.android.egg", { permissions: [read, read], userId: 0 }),
  ).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
  expect(
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell pm grant")),
  ).toHaveLength(1);
});

test("requested permission without target-user runtime state fails without pm", async () => {
  const h = harness();
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 10 });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("Cannot determine runtime permission state");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(false);
});

test("multiple runtime changes share a single post-read and trimmed names", async () => {
  const write = "android.permission.WRITE_EXTERNAL_STORAGE";
  const h = harness(egg, flip(flip(egg, read, true), write, true));
  expect(
    await h.permissions.setPermissions("com.android.egg", {
      permissions: [`  ${read} `, write],
      userId: 0,
    }),
  ).toMatchObject({ success: true, changedCount: 2, failedCount: 0 });
  expect(h.adb.getExecutedCommands()).toEqual([
    "shell dumpsys package 'com.android.egg'",
    `shell pm grant --user 0 'com.android.egg' '${read}'`,
    `shell pm grant --user 0 'com.android.egg' '${write}'`,
    "shell dumpsys package 'com.android.egg'",
  ]);
});
