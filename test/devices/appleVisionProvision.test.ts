import { buildSimulatorProvisioningCatalogEntries } from "../../src/server/simulatorProvisioningCatalog";
import { describe, expect, test } from "bun:test";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { ActionableError } from "../../src/models";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import {
  AppleVisionSimulatorProvisioner,
  type AppleVisionProvisionRequest,
  type AppleVisionSimulatorCreator,
} from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import {
  FakeAppleVisionProvisionSimctl,
  VISION_DEVICE_TYPE,
  VISION_RUNTIME,
  VISION_RUNTIME_ID,
  visionDevice,
} from "../fakes/FakeAppleVisionSimctl";

// provisionDevice for an Apple Vision Pro adopts the exact headset it names, or creates it with
// `simctl create` from a VISIONOS device type and runtime the host lists.

const SPEC = { deviceType: VISION_DEVICE_TYPE.identifier, runtime: VISION_RUNTIME_ID };
const NAME = "AutoMobile Vision";
const EXISTING = visionDevice({ name: NAME });

function arrange(devices = [EXISTING]) {
  const simctl = new FakeAppleVisionProvisionSimctl(devices);
  const provisioner = new AppleVisionSimulatorProvisioner(
    new AppleVisionSimulatorInventory(simctl, "arm64"),
    simctl,
  );
  return { simctl, provisioner };
}

const request = (
  overrides: Partial<AppleVisionProvisionRequest> = {},
): AppleVisionProvisionRequest => ({
  name: NAME,
  spec: SPEC,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("AppleVisionSimulatorProvisioner", () => {
  test("adopts the headset with that exact name and spec without creating one", async () => {
    const { simctl, provisioner } = arrange();

    const result = await provisioner.provision(request(), { allowCreate: true });

    expect(result.created).toBe(false);
    expect(result.headset).toMatchObject({
      deviceId: EXISTING.udid,
      name: NAME,
      platform: "visionos",
    });
    expect(simctl.commands).toEqual([]);
  });

  test("adopts by UDID, and the name must still match", async () => {
    const { provisioner } = arrange();

    expect(
      (await provisioner.provision(request({ deviceId: EXISTING.udid }), { allowCreate: true }))
        .headset.deviceId,
    ).toBe(EXISTING.udid);
    const renamed = await rejection(
      provisioner.provision(request({ deviceId: EXISTING.udid, name: "Other" }), {
        allowCreate: true,
      }),
    );
    expect(renamed).toBeInstanceOf(ActionableError);
    expect(String(renamed)).toContain(`is named '${NAME}', not 'Other'`);
  });

  test("creates a missing headset from the device type and runtime, then lists it", async () => {
    const { simctl, provisioner } = arrange([]);
    const order: string[] = [];

    const catalog = buildSimulatorProvisioningCatalogEntries(
      "visionos",
      simctl.runtimes,
      simctl.deviceTypes,
    );
    const result = await provisioner.provision(
      request({
        spec: {
          deviceType: catalog.deviceTypes[0]!.id,
          runtime: catalog.runtimes[0]!.id,
        },
      }),
      {
        allowCreate: true,
        onBeforeCreate: () => order.push(`before ${simctl.commands.length}`),
      },
    );

    expect(result.created).toBe(true);
    expect(result.headset).toMatchObject({ name: NAME, platform: "visionos", state: "Shutdown" });
    expect(simctl.commands).toEqual([`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`]);
    expect(order).toEqual(["before 0"]);
  });

  for (const mode of ["throws", "omits", "delete fails"] as const) {
    test(`rolls back create when follow-up inventory ${mode}`, async () => {
      const { simctl } = arrange([]);
      const inventory = new AppleVisionSimulatorInventory(simctl, "arm64");
      const provisioner = new AppleVisionSimulatorProvisioner(
        {
          readCatalog: inventory.readCatalog.bind(inventory),
          listAppleVisionSimulators: async (signal) => {
            if (simctl.commands.length > 0) {
              if (mode === "omits") {
                return [];
              }
              throw new Error("inventory unavailable after create");
            }
            return await inventory.listAppleVisionSimulators(signal);
          },
        },
        simctl,
      );
      if (mode === "delete fails") {
        simctl.deleteError = new Error("delete busy");
      }
      const error = await rejection(
        provisioner.provision(request(), {
          allowCreate: true,
          discardUnconfirmed: (headset) => provisioner.discardCreated(headset),
        }),
      );
      const udid = "C0FFEE00-0000-4000-8000-000000000001";
      expect(error).toBeInstanceOf(ActionableError);
      expect(simctl.commands.at(-1)).toBe(`delete ${udid}`);
      expect(String(error)).toContain(
        mode === "omits" ? "does not show it" : "inventory unavailable after create",
      );
      expect(String(error)).not.toContain("it adopts the headset");
      if (mode === "delete fails") {
        expect(String(error)).toContain("delete busy");
        expect(String(error)).toContain("deleteDevice");
      } else {
        expect(String(error)).toContain("the headset was deleted again");
        expect(Object.values(simctl.listing.devices).flat()).toEqual([]);
      }
    });
  }

  test("leaves an unconfirmed headset in place without a lifecycle cleanup callback", async () => {
    const { simctl, provisioner } = arrange([]);
    const create = simctl.createSimulator.bind(simctl);
    simctl.createSimulator = async (...args) => {
      const udid = await create(...args);
      simctl.listingError = new Error("inventory unavailable after create");
      return udid;
    };

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("the headset was left in place");
    expect(String(error)).toContain("delete it with deleteDevice");
    expect(String(error)).toContain("inventory unavailable after create");
    expect(simctl.commands.map((cmd) => cmd.split(" ")[0])).toEqual(["create"]);
    expect(Object.values(simctl.listing.devices).flat()).toHaveLength(1);
  });

  test("a missing headset is not created while device creation is disabled", async () => {
    const { simctl, provisioner } = arrange([]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: false }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("Device creation is disabled");
    expect(simctl.commands).toEqual([]);
  });

  test("a template-reserved name is refused before simctl create", async () => {
    const { simctl, provisioner } = arrange([]);

    const error = await rejection(
      provisioner.provision(request({ name: "automobile-template-0123abcd" }), {
        allowCreate: true,
      }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("reserved for AutoMobile simulator templates");
    expect(simctl.commands).toEqual([]);
  });

  test("a UDID that names no headset is refused, never created under a new UDID", async () => {
    const { simctl, provisioner } = arrange([]);

    const error = await rejection(
      provisioner.provision(request({ deviceId: EXISTING.udid }), { allowCreate: true }),
    );

    expect(String(error)).toContain(`No Apple Vision Pro simulator has UDID ${EXISTING.udid}`);
    expect(simctl.commands).toEqual([]);
  });

  test("an unknown device type or runtime names the available ones and creates nothing", async () => {
    const { simctl, provisioner } = arrange([]);

    const type = await rejection(
      provisioner.provision(request({ spec: { ...SPEC, deviceType: "Apple-headset-Unknown" } }), {
        allowCreate: true,
      }),
    );
    const runtime = await rejection(
      provisioner.provision(request({ spec: { ...SPEC, runtime: "xrOS-99-0" } }), {
        allowCreate: true,
      }),
    );

    expect(type).toBeInstanceOf(ActionableError);
    expect(String(type)).toContain("Unknown Apple Vision Pro device type 'Apple-headset-Unknown'");
    expect(String(type)).toContain(VISION_DEVICE_TYPE.identifier);
    expect(runtime).toBeInstanceOf(ActionableError);
    expect(String(runtime)).toContain("Unknown visionOS runtime 'xrOS-99-0'");
    expect(String(runtime)).toContain(VISION_RUNTIME_ID);
    expect(String(runtime)).toContain("xcodebuild -downloadPlatform visionOS");
    expect(simctl.commands).toEqual([]);
  });

  test("an iPhone device type or iOS runtime is not a headset spec", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.deviceTypes.push({
      ...VISION_DEVICE_TYPE,
      productFamily: "iPhone",
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      name: "iPhone 16",
    });

    const error = await rejection(
      provisioner.provision(
        request({
          spec: { ...SPEC, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
        }),
        { allowCreate: true },
      ),
    );

    expect(String(error)).toContain("Unknown Apple Vision Pro device type");
    expect(simctl.commands).toEqual([]);
  });

  test("a missing visionOS runtime names the requested runtime and installation command", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.runtimes = [];
    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(SPEC.runtime);
    expect(String(error)).toContain("xcodebuild -downloadPlatform visionOS");
    expect(simctl.commands).toEqual([]);
  });

  test("an unavailable runtime is refused before any create", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.runtimes = [
      { ...VISION_RUNTIME, isAvailable: false, availabilityError: "not downloaded" },
    ];

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(String(error)).toContain(
      `visionOS runtime '${VISION_RUNTIME_ID}' is unavailable: not downloaded`,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("xcodebuild -downloadPlatform visionOS");
    expect(simctl.commands).toEqual([]);
  });

  test("an existing headset of another device type or runtime is a conflict, not a match", async () => {
    const { simctl, provisioner } = arrange([
      visionDevice({
        name: NAME,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-headset-Other",
      }),
    ]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Apple Vision Pro simulator '${NAME}' (${EXISTING.udid}) is`);
    expect(String(error)).toContain("Apple-headset-Other");
    expect(simctl.commands).toEqual([]);
  });

  test("rejects a runtime/device-type pair outside the catalog bounds", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.deviceTypes = [{ ...VISION_DEVICE_TYPE, minRuntimeVersionString: "27.0.0" }];
    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("incompatible");
    expect(String(error)).toContain(SPEC.deviceType);
    expect(String(error)).toContain(SPEC.runtime);
    expect(simctl.commands).toEqual([]);
  });

  test("a name on another runtime is a conflict", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.listing.devices["com.apple.CoreSimulator.SimRuntime.xrOS-26-4"] = [EXISTING];
    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("not " + SPEC.deviceType + " on " + SPEC.runtime);
    expect(simctl.commands).toEqual([]);
  });

  test("two Apple Vision Pros with the requested name need a deviceId", async () => {
    const twin = visionDevice({ name: NAME, udid: "6B1F3C2E-0000-4000-8000-00000000A7C2" });
    const { provisioner } = arrange([EXISTING, twin]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(String(error)).toContain(`'${NAME}' is ambiguous`);
    expect(
      (await provisioner.provision(request({ deviceId: twin.udid }), { allowCreate: true })).headset
        .deviceId,
    ).toBe(twin.udid);
  });

  test("a failed simctl create is reported with the request", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.createError = new Error("simctl create: disk full");

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Failed to create Apple Vision Pro simulator '${NAME}'`);
    expect(String(error)).toContain("disk full");
  });

  test("a failed listing or catalog read is an error, never treated as no Apple Vision Pros", async () => {
    const { simctl, provisioner } = arrange();
    simctl.catalogError = new Error("simctl list runtimes: timed out");
    expect(
      String(await rejection(provisioner.provision(request(), { allowCreate: true }))),
    ).toContain("timed out");
    simctl.catalogError = undefined;
    simctl.listingError = new Error("simctl list devices: timed out");
    expect(
      String(await rejection(provisioner.provision(request(), { allowCreate: true }))),
    ).toContain("timed out");
    expect(simctl.commands).toEqual([]);
  });

  test("discardCreated deletes the created headset, and reports a delete that failed", async () => {
    const { simctl, provisioner } = arrange([]);
    const { headset } = await provisioner.provision(request(), { allowCreate: true });

    expect(await provisioner.discardCreated(headset)).toEqual({ deleted: true });
    expect(simctl.commands.at(-1)).toBe(`delete ${headset.deviceId}`);
    expect(await provisioner.provision(request(), { allowCreate: false }).catch(String)).toContain(
      "Device creation is disabled",
    );

    simctl.deleteError = new Error("simctl delete: device is busy");
    expect(await provisioner.discardCreated(headset)).toEqual({
      deleted: false,
      error: "simctl delete: device is busy",
    });
  });

  test("discardCreated deletes after the provision request signal has aborted", async () => {
    const { simctl, provisioner } = arrange([]);
    const controller = new AbortController();
    const deleteSimulator = simctl.deleteSimulator.bind(simctl);
    const cleanupSignals: (AbortSignal | undefined)[] = [];
    const creator: AppleVisionSimulatorCreator = {
      createSimulator: simctl.createSimulator.bind(simctl),
      deleteSimulator: async (udid, options) => {
        const signal = options?.signal ?? getAbortSignal();
        cleanupSignals.push(signal);
        signal?.throwIfAborted();
        await deleteSimulator(udid);
      },
    };
    const signalAware = new AppleVisionSimulatorProvisioner(
      new AppleVisionSimulatorInventory(simctl, "arm64"),
      creator,
    );
    await runWithAbortSignal(controller.signal, async () => {
      const { headset } = await signalAware.provision(request(), {
        allowCreate: true,
        signal: controller.signal,
      });
      controller.abort(new Error("provision cancelled after create"));
      expect(await signalAware.discardCreated(headset)).toEqual({ deleted: true });
      expect(simctl.commands.at(-1)).toBe(`delete ${headset.deviceId}`);
      expect(await provisioner.find(headset.deviceId)).toBeUndefined();
    });
    expect(cleanupSignals[0]).toBeDefined();
    expect(cleanupSignals[0]).not.toBe(controller.signal);
    expect(cleanupSignals[0]?.aborted).toBe(false);
  });

  test("find returns a listed headset by UDID and nothing for an unknown one", async () => {
    const { provisioner } = arrange();

    expect((await provisioner.find(EXISTING.udid))?.name).toBe(NAME);
    expect(await provisioner.find("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  test("deleteAndConfirmAbsent deletes the headset and proves it gone from a fresh listing", async () => {
    const { simctl, provisioner } = arrange();

    await provisioner.deleteAndConfirmAbsent(EXISTING.udid);

    expect(simctl.commands).toEqual([`delete ${EXISTING.udid}`]);
    expect(await provisioner.find(EXISTING.udid)).toBeUndefined();
  });

  test("a headset still listed after simctl delete is a failure, not a success", async () => {
    const { simctl, provisioner } = arrange();
    simctl.deleteSimulator = async (udid: string) => {
      simctl.commands.push(`delete ${udid}`);
    };

    const error = await rejection(provisioner.deleteAndConfirmAbsent(EXISTING.udid));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`still lists Apple Vision Pro simulator ${EXISTING.udid}`);
  });

  test("a failed simctl delete is reported with the headset", async () => {
    const { simctl, provisioner } = arrange();
    simctl.deleteError = new Error("simctl delete: device is busy");

    const error = await rejection(provisioner.deleteAndConfirmAbsent(EXISTING.udid));

    expect(String(error)).toContain(`Failed to delete Apple Vision Pro simulator ${EXISTING.udid}`);
    expect(String(error)).toContain("device is busy");
  });
});
