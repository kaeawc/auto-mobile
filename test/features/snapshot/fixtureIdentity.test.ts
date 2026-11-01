import { describe, expect, test } from "bun:test";
import {
  checkFixtureValidity,
  type FixtureIdentity,
  type FixtureInvalidationReason,
} from "../../../src/features/snapshot/fixtureIdentity";
import { FakeFixtureIdentityProbe } from "../../fakes/FakeFixtureIdentityProbe";

const recorded: FixtureIdentity = {
  avdName: "pixel-test",
  systemImageId: "system-images;android-35;google_apis;arm64-v8a",
  avdConfigHash: "config-hash",
  emulatorVersion: "35.2.10",
  userdataGeneration: "1234:1730000000000",
};

describe("checkFixtureValidity", () => {
  test("identical identity is valid and queries the recorded AVD once", async () => {
    const probe = new FakeFixtureIdentityProbe({ ...recorded });

    expect(await checkFixtureValidity(recorded, probe)).toEqual({ valid: true });
    expect(probe.queriedAvdNames).toEqual([recorded.avdName]);
  });

  const changes: Array<[keyof FixtureIdentity, FixtureInvalidationReason]> = [
    ["avdName", "avd-changed"],
    ["systemImageId", "system-image-changed"],
    ["avdConfigHash", "avd-config-changed"],
    ["emulatorVersion", "emulator-version-changed"],
    ["userdataGeneration", "userdata-wiped"],
  ];

  test.each(changes)("changing %s yields only %s", async (field, reason) => {
    const probe = new FakeFixtureIdentityProbe({ ...recorded });
    probe.identity = { ...recorded, [field]: `${recorded[field]}-changed` };

    expect(await checkFixtureValidity(recorded, probe)).toEqual({
      valid: false,
      reasons: [reason],
    });
    expect(probe.queriedAvdNames).toEqual([recorded.avdName]);
  });

  test("multiple changes yield every reason in declaration order", async () => {
    const probe = new FakeFixtureIdentityProbe({
      emulatorVersion: "36.0.0",
      avdConfigHash: "different-config-hash",
      systemImageId: "system-images;android-36;google_apis;arm64-v8a",
      avdName: "different-avd",
      userdataGeneration: "5678:1730000999999",
    });

    expect(await checkFixtureValidity(recorded, probe)).toEqual({
      valid: false,
      reasons: [
        "avd-changed",
        "system-image-changed",
        "avd-config-changed",
        "emulator-version-changed",
        "userdata-wiped",
      ],
    });
    expect(probe.queriedAvdNames).toEqual([recorded.avdName]);
  });

  test("probe rejection propagates unchanged", async () => {
    const probe = new FakeFixtureIdentityProbe({ ...recorded });
    const failure = new Error("identity unavailable");
    probe.failWith = failure;

    await expect(checkFixtureValidity(recorded, probe)).rejects.toBe(failure);
    expect(probe.queriedAvdNames).toEqual([recorded.avdName]);
  });
});
