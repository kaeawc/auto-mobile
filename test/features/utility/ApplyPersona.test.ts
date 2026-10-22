import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyPersona,
  describePersona,
  listPersonas,
  resetPersona,
} from "../../../src/features/utility/ApplyPersona";
import {
  NON_EMULATABLE_CAPABILITIES,
  OEM_PERSONA_CATALOG_VERSION,
  OEM_PERSONA_IDS,
  OEM_PERSONAS,
  PERSONA_EVIDENCE_STATUSES,
  personaFacets,
} from "../../../src/features/utility/OemPersonas";
import { PersonaRestoreRegistry } from "../../../src/features/utility/PersonaRestore";
import {
  KILL_PROFILE_NON_EMULATABLE,
  KILL_PROFILES,
} from "../../../src/features/utility/KillProfiles";
import type { BootedDevice } from "../../../src/models";
import { FakePersonaFacetExecutors } from "../../fakes/FakePersonaFacetExecutors";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";

describe("OEM persona catalog (#14055)", () => {
  test("ships the starter personas, each versioned, with evidence for every facet it sets", () => {
    expect([...OEM_PERSONA_IDS]).toEqual([
      "pixel-baseline",
      "samsung-oneui",
      "xiaomi-hyperos",
      "oneplus-oxygenos",
      "oppo-coloros",
      "motorola",
    ]);
    for (const id of OEM_PERSONA_IDS) {
      const persona = OEM_PERSONAS[id];
      expect(persona.id).toBe(id);
      expect(persona.version).toBeGreaterThanOrEqual(1);
      expect(Object.keys(persona.evidence).sort()).toEqual(personaFacets(persona).sort());
      for (const evidence of Object.values(persona.evidence)) {
        expect(PERSONA_EVIDENCE_STATUSES).toContain(evidence.status);
        expect(evidence.note.length).toBeGreaterThan(0);
      }
      for (const capability of persona.nonEmulatable) {
        expect(NON_EMULATABLE_CAPABILITIES[capability]).toBeDefined();
      }
    }
  });

  test("every behaviour killProfile cannot reproduce is a non-emulatable capability with its note", () => {
    for (const entry of KILL_PROFILE_NON_EMULATABLE) {
      expect(
        NON_EMULATABLE_CAPABILITIES[entry.id as keyof typeof NON_EMULATABLE_CAPABILITIES],
      ).toBe(entry.note);
    }
  });

  test("a kill facet carries its kill profile's evidence status", () => {
    const persona = OEM_PERSONAS["samsung-oneui"];
    expect(persona.evidence.kill?.status).toBe(KILL_PROFILES["samsung-sleeping"].evidenceStatus);
  });

  test("list reports the catalog version and every persona", () => {
    const catalog = listPersonas();
    expect(catalog.catalogVersion).toBe(OEM_PERSONA_CATALOG_VERSION);
    expect(catalog.personas.map((persona) => persona.id)).toEqual([...OEM_PERSONA_IDS]);
    expect(catalog.evidenceStatuses).toEqual([...PERSONA_EVIDENCE_STATUSES]);
  });

  test("describe reports every facet's evidence status and category, and what cannot be emulated", () => {
    const description = describePersona("samsung-oneui");
    expect(description.catalogVersion).toBe(OEM_PERSONA_CATALOG_VERSION);
    expect(description.persona.version).toBe(1);
    expect(
      description.facets.map((facet) => [facet.facet, facet.category, facet.evidence.status]),
    ).toEqual([
      ["keyboard", "functionalityBreak", "experimental"],
      ["kill", "functionalityBreak", "vendor_documented"],
      ["display", "functionalityBreak", "inferred"],
    ]);
    expect(description.facets[1]?.value).toBe("samsung-sleeping");
    expect(description.nonEmulatable.map((entry) => entry.id)).toContain("samsung-dex");
    expect(description.nonEmulatable.every((entry) => entry.note.length > 0)).toBe(true);
  });
});

describe("applyPersona / resetPersona (#14055)", () => {
  let executors: FakePersonaFacetExecutors;
  let registry: PersonaRestoreRegistry;

  beforeEach(() => {
    executors = new FakePersonaFacetExecutors();
    registry = new PersonaRestoreRegistry();
  });

  test("apply composes the keyboard, kill and display executors in order", async () => {
    const result = await applyPersona(
      emulator,
      "samsung-oneui",
      { appId: APP },
      { executors, registry, owner: "session-1" },
    );
    expect(result.status).toBe("applied");
    expect(executors.calls).toEqual([
      { facet: "keyboard", action: "set", profile: "samsung", owner: "session-1" },
      {
        facet: "kill",
        action: "apply",
        appId: APP,
        profile: "samsung-sleeping",
        owner: "session-1",
      },
      {
        facet: "display",
        action: "apply",
        input: { cutout: "hole", navigationMode: "threebutton" },
        owner: "session-1",
      },
    ]);
    if (result.status === "route_to_real_device") {
      throw new Error("unexpected route");
    }
    expect(result.persona).toEqual({
      id: "samsung-oneui",
      version: 1,
      displayName: "Samsung One UI",
    });
    expect(result.facets.map((facet) => [facet.facet, facet.status])).toEqual([
      ["keyboard", "applied"],
      ["kill", "applied"],
      ["display", "applied"],
    ]);
  });

  test("a persona without kill or display facets only sets the keyboard and needs no appId", async () => {
    const result = await applyPersona(emulator, "pixel-baseline", {}, { executors, registry });
    expect(result.status).toBe("applied");
    expect(executors.calls).toEqual([{ facet: "keyboard", action: "set", profile: "gboard" }]);
  });

  test("a persona with a kill facet needs appId before anything changes", async () => {
    await expect(
      applyPersona(emulator, "samsung-oneui", {}, { executors, registry }),
    ).rejects.toThrow("needs appId");
    expect(executors.calls).toEqual([]);
  });

  test("a required non-emulatable capability routes to a real device without changing anything", async () => {
    const result = await applyPersona(
      emulator,
      "samsung-oneui",
      { appId: APP, requires: ["samsung-dex", "oem-systemui"] },
      { executors, registry },
    );
    expect(result).toMatchObject({
      status: "route_to_real_device",
      persona: { id: "samsung-oneui" },
      capabilities: [
        { id: "samsung-dex", note: NON_EMULATABLE_CAPABILITIES["samsung-dex"] },
        { id: "oem-systemui", note: NON_EMULATABLE_CAPABILITIES["oem-systemui"] },
      ],
    });
    expect(executors.calls).toEqual([]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("a required capability the persona can emulate does not route", async () => {
    const result = await applyPersona(
      emulator,
      "oneplus-oxygenos",
      { appId: APP, requires: ["samsung-dex"] },
      { executors, registry },
    );
    expect(result.status).toBe("applied");
  });

  test("one failed facet makes the persona partial; the others still run", async () => {
    executors.killError = new Error("appops refused");
    const result = await applyPersona(
      emulator,
      "samsung-oneui",
      { appId: APP },
      { executors, registry },
    );
    expect(result.status).toBe("partial");
    if (result.status === "route_to_real_device") {
      throw new Error("unexpected route");
    }
    const kill = result.facets.find((facet) => facet.facet === "kill");
    expect(kill?.status).toBe("failed");
    expect(kill?.detail).toContain("appops refused");
    expect(executors.calls.map((call) => call.facet)).toEqual(["keyboard", "kill", "display"]);
  });

  test("facets the device cannot apply are reported unsupported and leave the persona partial", async () => {
    executors.killStatus = "unsupported";
    executors.displayStatus = "unsupported";
    const result = await applyPersona(
      emulator,
      "xiaomi-hyperos",
      { appId: APP },
      { executors, registry },
    );
    expect(result.status).toBe("partial");
    if (result.status === "route_to_real_device") {
      throw new Error("unexpected route");
    }
    expect(result.facets.map((facet) => facet.status)).toEqual([
      "applied",
      "unsupported",
      "unsupported",
    ]);
  });

  test("a persona that changes nothing because every facet failed is an error", async () => {
    executors.keyboardError = new Error("no ctrl proxy");
    executors.killError = new Error("no adb");
    await expect(
      applyPersona(emulator, "motorola", { appId: APP }, { executors, registry }),
    ).rejects.toThrow("changed nothing");
  });

  test("reset restores display, kill and the keyboard recorded before the first apply, in reverse", async () => {
    executors.activeKeyboardProfile = "direct";
    await applyPersona(emulator, "samsung-oneui", { appId: APP }, { executors, registry });
    await applyPersona(emulator, "samsung-oneui", { appId: "com.other" }, { executors, registry });
    executors.calls.length = 0;

    const result = await resetPersona(emulator, {}, { executors, registry, owner: "session-1" });
    expect(result.personaId).toBe("samsung-oneui");
    expect(executors.calls).toEqual([
      { facet: "display", action: "reset", owner: "session-1" },
      { facet: "kill", action: "reset", appId: APP, owner: "session-1" },
      { facet: "kill", action: "reset", appId: "com.other", owner: "session-1" },
      { facet: "keyboard", action: "reset", profile: "direct" },
    ]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("applying a different persona resets the recorded one first, so its facets do not linger", async () => {
    executors.activeKeyboardProfile = "direct";
    await applyPersona(emulator, "samsung-oneui", { appId: APP }, { executors, registry });
    executors.calls.length = 0;

    const result = await applyPersona(emulator, "pixel-baseline", {}, { executors, registry });
    expect(result).toMatchObject({ status: "applied", replaced: "samsung-oneui" });
    expect(executors.calls).toEqual([
      { facet: "display", action: "reset", owner: undefined },
      { facet: "kill", action: "reset", appId: APP, owner: undefined },
      { facet: "keyboard", action: "reset", profile: "direct" },
      { facet: "keyboard", action: "set", profile: "gboard" },
    ]);
    expect(registry.get(emulator.deviceId)).toEqual({
      personaId: "pixel-baseline",
      keyboard: true,
      killAppIds: [],
    });
    expect(executors.keyboardBefore).toBe("direct");
  });

  test("re-applying the same persona does not reset it", async () => {
    await applyPersona(emulator, "motorola", { appId: APP }, { executors, registry });
    executors.calls.length = 0;
    const result = await applyPersona(
      emulator,
      "motorola",
      { appId: APP },
      { executors, registry },
    );
    expect(result).not.toHaveProperty("replaced");
    expect(executors.calls.map((call) => call.action)).toEqual(["set", "apply"]);
  });

  test("cancellation during apply ends the call instead of failing the remaining facets", async () => {
    const controller = new AbortController();
    const keyboardSet = executors.keyboard.set;
    executors.keyboard.set = async (profile, owner, signal) => {
      const result = await keyboardSet(profile, owner, signal);
      controller.abort();
      return result;
    };
    await expect(
      applyPersona(
        emulator,
        "samsung-oneui",
        { appId: APP },
        { executors, registry, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(executors.calls.map((call) => call.facet)).toEqual(["keyboard"]);
  });

  test("a recorded package with nothing left to restore is forgotten, not reset", async () => {
    await applyPersona(emulator, "motorola", { appId: APP }, { executors, registry });
    // Session release restored the kill record on its own.
    executors.killPending.clear();
    executors.calls.length = 0;
    await resetPersona(emulator, {}, { executors, registry });
    expect(executors.calls.map((call) => `${call.facet}:${call.action}`)).toEqual([
      "display:reset",
      "keyboard:reset",
    ]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("a keyboard profile session release already restored is forgotten, not written again", async () => {
    await applyPersona(emulator, "pixel-baseline", {}, { executors, registry, owner: "s-1" });
    // Session release restored the keyboard record on its own.
    executors.keyboardBefore = undefined;
    executors.calls.length = 0;
    const result = await resetPersona(emulator, {}, { executors, registry });
    expect(executors.calls).toEqual([{ facet: "display", action: "reset", owner: undefined }]);
    expect(result.facets.map((facet) => facet.facet)).toEqual(["display"]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("reset restores a keyboard profile a direct setProfile changed, as the record is shared", async () => {
    executors.keyboardBefore = "direct";
    await resetPersona(emulator, {}, { executors, registry });
    expect(executors.calls.at(-1)).toEqual({
      facet: "keyboard",
      action: "reset",
      profile: "direct",
    });
    expect(executors.keyboardBefore).toBeUndefined();
  });

  test("a keyboard profile the device refuses on reset keeps the persona recorded", async () => {
    await applyPersona(emulator, "pixel-baseline", {}, { executors, registry });
    executors.keyboardError = new Error("ctrl proxy gone");
    await expect(resetPersona(emulator, {}, { executors, registry })).rejects.toThrow(
      "ctrl proxy gone",
    );
    expect(registry.get(emulator.deviceId)).toMatchObject({
      personaId: "pixel-baseline",
      keyboard: true,
    });
    expect(executors.keyboardBefore).toBe("gboard");
  });

  test("a second reset restores nothing it already restored", async () => {
    await applyPersona(emulator, "samsung-oneui", { appId: APP }, { executors, registry });
    await resetPersona(emulator, {}, { executors, registry });
    executors.calls.length = 0;
    await resetPersona(emulator, {}, { executors, registry });
    expect(executors.calls).toEqual([{ facet: "display", action: "reset", owner: undefined }]);
  });

  test("reset with appId resets that package's kill facet even when nothing is recorded", async () => {
    await resetPersona(emulator, { appId: APP }, { executors, registry });
    expect(executors.calls).toEqual([
      { facet: "display", action: "reset", owner: undefined },
      { facet: "kill", action: "reset", appId: APP, owner: undefined },
    ]);
  });

  test("a facet the device refuses on reset stays recorded and the reset is an error", async () => {
    await applyPersona(emulator, "samsung-oneui", { appId: APP }, { executors, registry });
    executors.killError = new Error("appops refused");
    await expect(resetPersona(emulator, {}, { executors, registry })).rejects.toThrow(
      "appops refused",
    );
    expect(registry.get(emulator.deviceId)?.killAppIds).toEqual([APP]);
    expect(registry.get(emulator.deviceId)?.keyboard).toBe(false);
    expect(executors.keyboardBefore).toBeUndefined();
  });
});

describe("acquisition-time manufacturer profiles (#14058)", () => {
  let executors: FakePersonaFacetExecutors;
  let registry: PersonaRestoreRegistry;

  beforeEach(() => {
    executors = new FakePersonaFacetExecutors();
    registry = new PersonaRestoreRegistry();
  });

  test("deferKill reports the kill facet as deferred instead of refusing without an app", async () => {
    const result = await applyPersona(
      emulator,
      "samsung-oneui",
      { deferKill: true },
      { executors, registry, owner: "session-1" },
    );

    expect(result).toMatchObject({ status: "applied" });
    if (result.status === "route_to_real_device") {
      throw new Error("unexpected route");
    }
    expect(result.facets.map((facet) => [facet.facet, facet.status])).toEqual([
      ["keyboard", "applied"],
      ["kill", "deferred"],
      ["display", "applied"],
    ]);
    expect(executors.calls.some((call) => call.facet === "kill")).toBe(false);
    expect(registry.get(emulator.deviceId)?.killAppIds).toEqual([]);
  });

  test("without deferKill a kill-bearing profile still needs appId", async () => {
    await expect(
      applyPersona(emulator, "samsung-oneui", {}, { executors, registry }),
    ).rejects.toThrow("apply needs appId");
  });

  test("an acquisition-time apply names the owning session on the keyboard write, so its release restores it", async () => {
    await applyPersona(
      emulator,
      "samsung-oneui",
      { deferKill: true },
      { executors, registry, owner: "session-1" },
    );

    expect(executors.calls).toContainEqual({
      facet: "keyboard",
      action: "set",
      profile: "samsung",
      owner: "session-1",
    });
    expect(registry.get(emulator.deviceId)?.keyboard).toBe(true);
  });
});
