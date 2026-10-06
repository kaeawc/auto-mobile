import { describe, expect, test } from "bun:test";
import {
  AmbiguousAndroidPreferencesUserError,
  rethrowForRouteWithoutUserId,
  resolveDefaultAndroidPreferencesUser,
} from "../../../src/features/preferences/resolveAndroidPreferencesUser";
import { ActionableError } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const APP = "com.example.app";

const adbOnTwoSecondaryUsers = (): FakeAdbExecutor => {
  const adb = new FakeAdbExecutor();
  adb.setUsers([
    { userId: 0, name: "Owner", flags: 0x4c13, running: true },
    { userId: 10, name: "Work profile", flags: 0x1030, running: true },
    { userId: 11, name: "Second", flags: 0x1030, running: true },
  ]);
  adb.setCommandResponse("shell pm list packages --user 0", createExecResult("", ""));
  adb.setCommandResponse(
    "shell pm list packages --user 10",
    createExecResult(`package:${APP}`, ""),
  );
  adb.setCommandResponse(
    "shell pm list packages --user 11",
    createExecResult(`package:${APP}`, ""),
  );
  return adb;
};

describe("resolveDefaultAndroidPreferencesUser ambiguity (#10021)", () => {
  test("callers that can pass userId are told to", async () => {
    const error = await resolveDefaultAndroidPreferencesUser(adbOnTwoSecondaryUsers(), APP).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AmbiguousAndroidPreferencesUserError);
    expect((error as Error).message).toContain("Pass userId to choose one.");
  });

  test("a route with no userId parameter gets text that does not tell it to pass one", async () => {
    const error = await resolveDefaultAndroidPreferencesUser(adbOnTwoSecondaryUsers(), APP)
      .catch(rethrowForRouteWithoutUserId)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ActionableError);
    const message = (error as Error).message;
    expect(message).toContain(`${APP} is not installed for user 0`);
    expect(message).toContain("10, 11");
    expect(message).toContain("no userId parameter");
    expect(message).toContain("setKeyValue");
    expect(message).not.toContain("Pass userId");
  });

  test("any other failure is rethrown unchanged", () => {
    const original = new Error("adb offline");

    expect(() => rethrowForRouteWithoutUserId(original)).toThrow(original);
  });
});
