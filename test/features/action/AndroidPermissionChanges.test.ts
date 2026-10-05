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
const development = "android.permission.WRITE_SECURE_SETTINGS";
// Derive an install-time development permission from the captured WRITE_SETTINGS entry.
const developmentDenied = egg
  .replaceAll("android.permission.WRITE_SETTINGS", development)
  .replace(`${development}: granted=true`, `${development}: granted=false`);
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

test("not-changeable install permission fails with pm's SecurityException", async () => {
  const h = harness(playground);
  const reason =
    "java.lang.SecurityException: Permission android.permission.INTERNET requested by dev.jasonpearson.automobile.playground is not a changeable permission type";
  h.adb.setCommandResponse("shell pm revoke", { stdout: "", stderr: reason });
  const result = await h.action.execute("dev.jasonpearson.automobile.playground", {
    action: "revoke",
    permissions: ["android.permission.INTERNET"],
    userId: 0,
  });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toBe(reason);
  expect(h.adb.wasCommandExecuted("shell pm revoke")).toBe(true);
});

test.each(["grant", "revoke"] as const)(
  "%s verifies requested development install permission in its install block",
  async (action) => {
    const granted = flip(developmentDenied, development, true);
    const h = harness(
      action === "grant" ? developmentDenied : granted,
      action === "grant" ? granted : developmentDenied,
    );
    expect(
      await h.permissions.setPermissions("com.android.egg", {
        action,
        permissions: [development],
        userId: 0,
      }),
    ).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell dumpsys package 'com.android.egg'",
      `shell pm ${action} --user 0 'com.android.egg' '${development}'`,
      "shell dumpsys package 'com.android.egg'",
    ]);
  },
);

test.each(["grant", "revoke"] as const)(
  "%s skips install permission already in requested state",
  async (action) => {
    const h = harness(
      action === "grant" ? flip(developmentDenied, development, true) : developmentDenied,
    );
    const result = await h.permissions.setPermissions("com.android.egg", {
      action,
      permissions: [development],
      userId: 0,
    });
    expect(result).toMatchObject({ success: true, changedCount: 0, failedCount: 0 });
    expect(result.operations[0].result).toMatchObject({
      results: [
        {
          success: true,
          skipped: true,
          skipReason: `already ${action === "grant" ? "granted" : "revoked"}`,
        },
      ],
    });
    expect(h.adb.wasCommandExecuted(`shell pm ${action}`)).toBe(false);
  },
);

test("accepted install grant without changed install state fails verification", async () => {
  const h = harness(developmentDenied);
  const result = await h.action.execute("com.android.egg", {
    permissions: [development],
    userId: 0,
  });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("verification failed");
  expect(result.results[0].error).toContain("pm output: (empty)");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(true);
});

test("install verification does not accept a grant recorded only in runtime state", async () => {
  const after = developmentDenied.replace(
    "      runtime permissions:\n",
    `      runtime permissions:\n        ${development}: granted=true\n`,
  );
  const h = harness(developmentDenied, after);
  const result = await h.action.execute("com.android.egg", {
    permissions: [development],
    userId: 0,
  });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("original permission block");
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(true);
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

test("requested permission without target-user state attempts pm and reports absent evidence", async () => {
  const h = harness();
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 10 });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toContain("absent from runtime and install permissions");
  expect(result.results[0].error).toContain("pm output: (empty)");
  expect(h.adb.wasCommandExecuted("shell pm grant --user 10")).toBe(true);
});

test.each(["runtime", "install"] as const)(
  "absent runtime block attempts pm and verifies new %s evidence",
  async (block) => {
    // Rename the captured runtime header so its permission entries are not parsed.
    const before = egg.replace("      runtime permissions:", "      unreadable permissions:");
    const after =
      block === "runtime"
        ? flip(egg, read, true)
        : before.replace(
            "    install permissions:\n",
            `    install permissions:\n      ${read}: granted=true\n`,
          );
    const h = harness(before, after);
    const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 0 });
    expect(result.success).toBe(true);
    expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(true);
    expect(h.adb.getExecutedCommands()).toHaveLength(3);
  },
);

test("absent runtime state retains pm's has-not-requested reason after re-read", async () => {
  const h = harness(egg.replace("      runtime permissions:", "      unreadable permissions:"));
  const reason = `java.lang.SecurityException: Package com.android.egg has not requested permission ${read}`;
  h.adb.setCommandResponse("shell pm grant", { stdout: "", stderr: reason });
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 0 });
  expect(result.success).toBe(false);
  expect(result.results[0].error).toBe(reason);
  expect(h.adb.getExecutedCommands()).toHaveLength(3);
});

test("permission missing from present runtime block attempts pm and verifies re-read", async () => {
  const before = egg
    .split("\n")
    .filter((line) => !line.trim().startsWith(`${read}:`))
    .join("\n");
  const h = harness(before, flip(egg, read, true));
  const result = await h.action.execute("com.android.egg", { permissions: [read], userId: 0 });
  expect(result.success).toBe(true);
  expect(h.adb.wasCommandExecuted("shell pm grant")).toBe(true);
});

test("app installed only for user 10 uses that user for get and grant verification", async () => {
  const user10 = egg.replaceAll("User 0:", "User 10:");
  const h = harness(user10, flip(user10, read, true));
  h.adb.setUsers([
    { userId: 0, name: "Owner", flags: 0x13, running: true },
    { userId: 10, name: "Work", flags: 0x30, running: true },
  ]);
  h.adb.setCommandResponse("shell pm list packages --user 0", { stdout: "", stderr: "" });
  h.adb.setCommandResponse("shell pm list packages --user 10", {
    stdout: "package:com.android.egg",
    stderr: "",
  });
  const before = await h.permissions.getPermissions("com.android.egg", { permissions: [read] });
  expect(before.permissions[0].state).toBe("denied");
  h.adb.setCommandResponseSequence(
    "shell dumpsys package",
    [user10, flip(user10, read, true)].map((stdout) => ({ stdout, stderr: "" })),
  );
  const result = await h.action.execute("com.android.egg", { permissions: [read] });
  expect(result).toMatchObject({ success: true, userId: 10 });
  expect(h.adb.wasCommandExecuted("shell pm grant --user 10")).toBe(true);
  const after = await h.permissions.getPermissions("com.android.egg", { permissions: [read] });
  expect(after.permissions[0].state).toBe("granted");
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
