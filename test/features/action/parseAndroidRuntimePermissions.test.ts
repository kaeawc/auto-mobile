import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAndroidRuntimePermissions } from "../../../src/features/action/parseAndroidRuntimePermissions";
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../fixtures/android-dumpsys-package/${name}.txt`, import.meta.url),
    "utf8",
  );
const playground = fixture("dumpsys-package-installed");
const egg = fixture("dumpsys-package-system-installed");

test("captured Playground requested and install permissions with empty runtime block", () => {
  const state = parseAndroidRuntimePermissions(
    playground,
    "dev.jasonpearson.automobile.playground",
  );
  expect([...state!.requestedPermissions]).toEqual([
    "android.permission.INTERNET",
    "dev.jasonpearson.automobile.playground.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.WAKE_LOCK",
  ]);
  expect(state!.installPermissions.size).toBe(4);
  expect(state!.runtimePermissions.size).toBe(0);
  expect(state!.requestedPermissions.has("android.permission.CAMERA")).toBe(false);
});
test("captured egg install and runtime sections stay distinct", () => {
  const state = parseAndroidRuntimePermissions(egg, "com.android.egg")!;
  expect(state.requestedPermissions.size).toBe(7);
  expect(state.installPermissions.size).toBe(4);
  expect(state.runtimePermissions.size).toBe(3);
  expect(state.runtimePermissions.get("android.permission.POST_NOTIFICATIONS")?.state).toBe(
    "granted",
  );
  expect(state.runtimePermissions.get("android.permission.READ_EXTERNAL_STORAGE")?.state).toBe(
    "denied",
  );
});
test("absent target user block does not fall back to user 0", () => {
  expect(parseAndroidRuntimePermissions(egg, "com.android.egg", 10)!.runtimePermissions.size).toBe(
    0,
  );
});
test("absent runtime section is tolerated", () => {
  // Remove the empty runtime section from the real capture.
  expect(
    parseAndroidRuntimePermissions(
      playground.replace("      runtime permissions:\n", ""),
      "dev.jasonpearson.automobile.playground",
    )!.runtimePermissions.size,
  ).toBe(0);
});
test("missing package, wrong package and malformed output are unparseable", () => {
  expect(
    parseAndroidRuntimePermissions(fixture("dumpsys-package-not-installed"), "com.android.egg"),
  ).toBeUndefined();
  expect(parseAndroidRuntimePermissions(egg, "com.example.other")).toBeUndefined();
  expect(parseAndroidRuntimePermissions("", "com.android.egg")).toBeUndefined();
});
test("CRLF and extra indentation preserve section scoping", () => {
  const state = parseAndroidRuntimePermissions(
    egg
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\r\n"),
    "com.android.egg",
  )!;
  expect(state.runtimePermissions.size).toBe(3);
});

test("multiple users with different captured-derived grant states stay isolated", () => {
  const block = egg.slice(egg.indexOf("    User 0: ceDataInode"), egg.indexOf("\nQueries:"));
  const user10 = block
    .replace("User 0:", "User 10:")
    .replace(
      "android.permission.READ_EXTERNAL_STORAGE: granted=false",
      "android.permission.READ_EXTERNAL_STORAGE: granted=true",
    );
  const capture = egg.replace("\nQueries:", `${user10}\nQueries:`);
  expect(
    parseAndroidRuntimePermissions(capture, "com.android.egg", 0)!.runtimePermissions.get(
      "android.permission.READ_EXTERNAL_STORAGE",
    )?.state,
  ).toBe("denied");
  expect(
    parseAndroidRuntimePermissions(capture, "com.android.egg", 10)!.runtimePermissions.get(
      "android.permission.READ_EXTERNAL_STORAGE",
    )?.state,
  ).toBe("granted");
});

// Issue #10189: restricted permissions in a real dump are plain names. Both captures below
// declare restricted permissions and show them without any `: restricted=true` suffix; the
// restriction is only visible in the runtime `flags=[ ... RESTRICTION_*]` list.
test("captured Messaging requested permissions are all clean names, restricted ones included", () => {
  // The capture is the permissions section only, so prepend the package header it lacks.
  const requested = parseAndroidRuntimePermissions(
    `  Package [com.google.android.apps.messaging] (cf3c20c):\n${fixture("dumpsys-package-messaging-permissions-section")}`,
    "com.google.android.apps.messaging",
  )!.requestedPermissions;
  expect(requested.size).toBe(78);
  for (const name of requested) {
    expect(name).toMatch(/^[A-Za-z0-9_.]+$/);
  }
  for (const restricted of [
    "android.permission.READ_SMS",
    "android.permission.READ_CALL_LOG",
    "android.permission.RECEIVE_SMS",
    "android.permission.READ_EXTERNAL_STORAGE",
  ]) {
    expect(requested.has(restricted)).toBe(true);
  }
});

test("captured egg requested set holds the restricted READ_EXTERNAL_STORAGE as a bare name", () => {
  const requested = parseAndroidRuntimePermissions(egg, "com.android.egg")!.requestedPermissions;
  expect(requested.has("android.permission.READ_EXTERNAL_STORAGE")).toBe(true);
  for (const name of requested) {
    expect(name).not.toMatch(/[:\s]/);
  }
});
