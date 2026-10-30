import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  WatchSimulatorProvisioner,
  type WatchProvisionRequest,
} from "../../src/utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import {
  FakeWatchProvisionSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME,
  WATCH_RUNTIME_ID,
  watchDevice,
} from "../fakes/FakeWatchSimctl";

// provisionDevice for an Apple Watch adopts the exact watch it names, or creates it with
// `simctl create` from a watchOS device type and runtime the host lists (#15882).

const SPEC = { deviceType: WATCH_DEVICE_TYPE.identifier, runtime: WATCH_RUNTIME_ID };
const NAME = "AutoMobile Watch";
const EXISTING = watchDevice({ name: NAME });

function arrange(devices = [EXISTING]) {
  const simctl = new FakeWatchProvisionSimctl(devices);
  const provisioner = new WatchSimulatorProvisioner(
    new WatchSimulatorInventory(simctl, "arm64"),
    simctl,
  );
  return { simctl, provisioner };
}

const request = (overrides: Partial<WatchProvisionRequest> = {}): WatchProvisionRequest => ({
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

describe("WatchSimulatorProvisioner", () => {
  test("adopts the watch with that exact name and spec without creating one", async () => {
    const { simctl, provisioner } = arrange();

    const result = await provisioner.provision(request(), { allowCreate: true });

    expect(result.created).toBe(false);
    expect(result.watch).toMatchObject({
      deviceId: EXISTING.udid,
      name: NAME,
      platform: "watchos",
    });
    expect(simctl.commands).toEqual([]);
  });

  test("adopts by UDID, and the name must still match", async () => {
    const { provisioner } = arrange();

    expect(
      (await provisioner.provision(request({ deviceId: EXISTING.udid }), { allowCreate: true }))
        .watch.deviceId,
    ).toBe(EXISTING.udid);
    const renamed = await rejection(
      provisioner.provision(request({ deviceId: EXISTING.udid, name: "Other" }), {
        allowCreate: true,
      }),
    );
    expect(renamed).toBeInstanceOf(ActionableError);
    expect(String(renamed)).toContain(`is named '${NAME}', not 'Other'`);
  });

  test("creates a missing watch from the device type and runtime, then lists it", async () => {
    const { simctl, provisioner } = arrange([]);
    const order: string[] = [];

    const result = await provisioner.provision(request(), {
      allowCreate: true,
      onBeforeCreate: () => order.push(`before ${simctl.commands.length}`),
    });

    expect(result.created).toBe(true);
    expect(result.watch).toMatchObject({ name: NAME, platform: "watchos", state: "Shutdown" });
    expect(simctl.commands).toEqual([`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`]);
    expect(order).toEqual(["before 0"]);
  });

  test("a missing watch is not created while device creation is disabled", async () => {
    const { simctl, provisioner } = arrange([]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: false }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("Device creation is disabled");
    expect(simctl.commands).toEqual([]);
  });

  test("a UDID that names no watch is refused, never created under a new UDID", async () => {
    const { simctl, provisioner } = arrange([]);

    const error = await rejection(
      provisioner.provision(request({ deviceId: EXISTING.udid }), { allowCreate: true }),
    );

    expect(String(error)).toContain(`No Apple Watch simulator has UDID ${EXISTING.udid}`);
    expect(simctl.commands).toEqual([]);
  });

  test("an unknown device type or runtime names the available ones and creates nothing", async () => {
    const { simctl, provisioner } = arrange([]);

    const type = await rejection(
      provisioner.provision(request({ spec: { ...SPEC, deviceType: "Apple-Watch-Ultra-9" } }), {
        allowCreate: true,
      }),
    );
    const runtime = await rejection(
      provisioner.provision(request({ spec: { ...SPEC, runtime: "watchOS-99-0" } }), {
        allowCreate: true,
      }),
    );

    expect(type).toBeInstanceOf(ActionableError);
    expect(String(type)).toContain("Unknown Apple Watch device type 'Apple-Watch-Ultra-9'");
    expect(String(type)).toContain(WATCH_DEVICE_TYPE.identifier);
    expect(runtime).toBeInstanceOf(ActionableError);
    expect(String(runtime)).toContain("Unknown watchOS runtime 'watchOS-99-0'");
    expect(String(runtime)).toContain(WATCH_RUNTIME_ID);
    expect(simctl.commands).toEqual([]);
  });

  test("an iPhone device type or iOS runtime is not a watch spec", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.deviceTypes.push({
      ...WATCH_DEVICE_TYPE,
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

    expect(String(error)).toContain("Unknown Apple Watch device type");
    expect(simctl.commands).toEqual([]);
  });

  test("an unavailable runtime is refused before any create", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.runtimes = [
      { ...WATCH_RUNTIME, isAvailable: false, availabilityError: "not downloaded" },
    ];

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(String(error)).toContain(
      `watchOS runtime '${WATCH_RUNTIME_ID}' is unavailable: not downloaded`,
    );
    expect(simctl.commands).toEqual([]);
  });

  test("an existing watch of another device type or runtime is a conflict, not a match", async () => {
    const { simctl, provisioner } = arrange([
      watchDevice({
        name: NAME,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-SE",
      }),
    ]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Apple Watch simulator '${NAME}' (${EXISTING.udid}) is`);
    expect(String(error)).toContain("Apple-Watch-SE");
    expect(simctl.commands).toEqual([]);
  });

  test("two watches with the requested name need a deviceId", async () => {
    const twin = watchDevice({ name: NAME, udid: "6B1F3C2E-0000-4000-8000-00000000A7C2" });
    const { provisioner } = arrange([EXISTING, twin]);

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(String(error)).toContain(`'${NAME}' is ambiguous`);
    expect(
      (await provisioner.provision(request({ deviceId: twin.udid }), { allowCreate: true })).watch
        .deviceId,
    ).toBe(twin.udid);
  });

  test("a failed simctl create is reported with the request", async () => {
    const { simctl, provisioner } = arrange([]);
    simctl.createError = new Error("simctl create: disk full");

    const error = await rejection(provisioner.provision(request(), { allowCreate: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Failed to create Apple Watch simulator '${NAME}'`);
    expect(String(error)).toContain("disk full");
  });

  test("a failed listing or catalog read is an error, never treated as no watches", async () => {
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

  test("discardCreated deletes the created watch, and reports a delete that failed", async () => {
    const { simctl, provisioner } = arrange([]);
    const { watch } = await provisioner.provision(request(), { allowCreate: true });

    expect(await provisioner.discardCreated(watch)).toEqual({ deleted: true });
    expect(simctl.commands.at(-1)).toBe(`delete ${watch.deviceId}`);
    expect(await provisioner.provision(request(), { allowCreate: false }).catch(String)).toContain(
      "Device creation is disabled",
    );

    simctl.deleteError = new Error("simctl delete: device is busy");
    expect(await provisioner.discardCreated(watch)).toEqual({
      deleted: false,
      error: "simctl delete: device is busy",
    });
  });
});
