import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyPersona,
  resetPersona,
  type PersonaFacetExecutors,
} from "../../../src/features/utility/ApplyPersona";
import { applyKillProfile, resetKillProfile } from "../../../src/features/utility/ApplyKillProfile";
import { KillProfileRestoreRegistry } from "../../../src/features/utility/KillProfileRestore";
import { PersonaRestoreRegistry } from "../../../src/features/utility/PersonaRestore";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakePersonaFacetExecutors } from "../../fakes/FakePersonaFacetExecutors";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

/** The persona layer over the real kill executor, so its preconditions and record are real. */
describe("persona over the real kill profile executor (#14055)", () => {
  let adb: FakeAdbExecutor;
  let killRegistry: KillProfileRestoreRegistry;
  let registry: PersonaRestoreRegistry;
  let executors: PersonaFacetExecutors;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    adb.setCommandResponse("shell appops get", createExecResult("No operations.\n", ""));
    killRegistry = new KillProfileRestoreRegistry();
    registry = new PersonaRestoreRegistry();
    const fakes = new FakePersonaFacetExecutors();
    const killDeps = { shell: adb, registry: killRegistry };
    executors = {
      keyboard: fakes.keyboard,
      display: fakes.display,
      kill: {
        apply: (appId, profile, owner) =>
          applyKillProfile(emulator, appId, profile, { ...killDeps, owner }),
        reset: (appId, owner) => resetKillProfile(emulator, appId, {}, { ...killDeps, owner }),
        hasPending: (appId) =>
          killRegistry
            .pendingFor(emulator.deviceId, appId)
            .some((action) => action.appId === appId),
      },
    };
  });

  test("a package the kill facet could not change does not wedge later resets", async () => {
    adb.setCommandResponse("shell pm path", createExecResult("", ""));
    const applied = await applyPersona(
      emulator,
      "samsung-oneui",
      { appId: "com.example.typo" },
      { executors, registry },
    );
    expect(applied.status).toBe("partial");
    expect(registry.get(emulator.deviceId)?.killAppIds).toEqual([]);

    await resetPersona(emulator, {}, { executors, registry });
    await resetPersona(emulator, {}, { executors, registry });
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("a package uninstalled after its kill record was restored does not wedge reset", async () => {
    adb.setCommandResponse("shell pm path", createExecResult("package:/data/app/base.apk\n", ""));
    await applyPersona(emulator, "motorola", { appId: "com.example.app" }, { executors, registry });
    expect(registry.get(emulator.deviceId)?.killAppIds).toEqual(["com.example.app"]);

    // Session release restores and drops the kill record; then the app is uninstalled.
    killRegistry.takeOwnedBy(emulator.deviceId, "session-1");
    killRegistry.retireDevice(emulator.deviceId);
    adb.setCommandResponse("shell pm path", createExecResult("", ""));

    const result = await resetPersona(emulator, {}, { executors, registry });
    expect(result.facets.map((facet) => facet.facet)).toEqual(["display", "keyboard"]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });
});
