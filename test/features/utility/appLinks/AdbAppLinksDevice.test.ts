import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AdbAppLinksDevice,
  createAdbAppLinksTarget,
} from "../../../../src/features/utility/appLinks/AdbAppLinksDevice";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/android-app-links/${name}`, import.meta.url), "utf8");

const PKG = "com.example.shop";

describe("AdbAppLinksDevice (#14110)", () => {
  test("reads one user's state with pm get-app-links --user", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "pm get-app-links --user 0 'com.example.shop'",
      createExecResult(fixture("get-app-links-api31-user0.txt"), ""),
    );
    const read = await new AdbAppLinksDevice(adb).read(PKG, 0);
    expect(read.found).toBe(true);
    expect(read.found && read.snapshot.verification.get("shop.example.com")).toBe("verified");
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm get-app-links --user 0 'com.example.shop'",
    ]);
  });

  test("reads without --user when no user is named", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "pm get-app-links 'com.example.shop'",
      createExecResult(fixture("get-app-links-no-user.txt"), ""),
    );
    const read = await new AdbAppLinksDevice(adb).read(PKG);
    expect(read.found && read.snapshot.user).toBeUndefined();
    expect(adb.getExecutedCommands()).toEqual(["shell pm get-app-links 'com.example.shop'"]);
  });

  test("classifies unsupported, empty, and unreadable output", async () => {
    const adb = new FakeAdbExecutor();
    const device = new AdbAppLinksDevice(adb);
    adb.setCommandResponse(
      "get-app-links --user 0 'com.old'",
      createExecResult(fixture("get-app-links-api30-unknown-command.txt"), ""),
    );
    adb.setCommandResponse("get-app-links --user 0 'com.empty'", createExecResult("", ""));
    adb.setCommandResponse(
      "get-app-links --user 0 'com.weird'",
      createExecResult("Something unexpected", ""),
    );
    expect(await device.read("com.old", 0)).toMatchObject({ found: false, kind: "unsupported" });
    expect(await device.read("com.empty", 0)).toMatchObject({ found: false, kind: "noState" });
    expect(await device.read("com.weird", 0)).toMatchObject({
      found: false,
      kind: "unreadable",
      reason: expect.stringContaining("Something unexpected"),
    });
  });

  test("writes quote the package and each domain; all stays bare", async () => {
    const adb = new FakeAdbExecutor();
    const device = new AdbAppLinksDevice(adb);
    await device.setVerificationState(PKG, "approved", ["shop.example.com", "*.example.com"]);
    await device.setVerificationState(PKG, "none", "all");
    await device.setUserSelection(PKG, 10, false, { domains: "all" });
    await device.reverify(PKG);
    expect(adb.getExecutedCommands()).toEqual([
      "shell pm set-app-links --package 'com.example.shop' 2 'shop.example.com' '*.example.com'",
      "shell pm set-app-links --package 'com.example.shop' 0 all",
      "shell pm set-app-links-user-selection --user 10 --package 'com.example.shop' false all",
      "shell pm verify-app-links --re-verify 'com.example.shop'",
    ]);
    expect(adb.getCommandCalls().every((call) => call.noRetry === true)).toBe(true);
  });

  test("a pm refusal printed as Error: fails the write", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "set-app-links --package",
      createExecResult("", "Error: Unable to find package com.example.shop"),
    );
    await expect(
      new AdbAppLinksDevice(adb).setVerificationState(PKG, "approved", "all"),
    ).rejects.toThrow(/set-app-links .* failed: Error: Unable to find package/);
  });

  test("the target reads the API level and current user from adb", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    adb.setCommandResponse("am get-current-user", createExecResult("10\n", ""));
    const target = createAdbAppLinksTarget(adb);
    expect(await target.apiLevel()).toBe(34);
    expect(await target.currentUserId()).toBe(10);
  });
});
