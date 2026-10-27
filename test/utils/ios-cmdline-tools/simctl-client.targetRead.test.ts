import { beforeEach, expect, spyOn, test } from "bun:test";
import capturedListing from "../../fixtures/ios-simctl/list-devices.json";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimulatorDeviceTypeProfiles } from "../../fakes/FakeSimulatorDeviceTypeProfiles";
import { SimCtlClient, type AppleDevice } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { resetSimCtlSharedStateForTesting } from "../../../src/utils/ios-cmdline-tools/SimCtlSharedState";
import { createExecResult } from "../../../src/utils/execResult";
import { IosBaselineReset } from "../../../src/daemon/sessionBroker/iosBaselineReset";

const displays = loadDuoEnumerate();

function harness(otherBooted = 0) {
  const timer = new FakeTimer();
  const [runtime, devices] = Object.entries(capturedListing.devices).find(([, devices]) =>
    devices.some((device) => device.deviceTypeIdentifier.endsWith(".iPhone-18-Pro")),
  )!;
  const target: AppleDevice = {
    ...devices.find((device) => device.deviceTypeIdentifier.endsWith(".iPhone-18-Pro"))!,
    state: "Booted",
  };
  const listing = {
    devices: {
      [runtime]: [
        target,
        ...Array.from({ length: otherBooted }, (_, index) => ({
          ...target,
          udid: `other-${index}`,
        })),
      ],
    },
  };
  let lists = 0;
  let enumerations = 0;
  let failure: Error | undefined;
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      if (args.join(" ") === "simctl list devices --json") {
        lists++;
        if (failure) {
          throw failure;
        }
        return createExecResult(JSON.stringify(listing), "");
      }
      if (args[1] === "io" && args[3] === "enumerate") {
        enumerations++;
        return createExecResult(displays, "");
      }
      if (args[1] === "bootstatus") {
        target.state = "Booted";
        return createExecResult("", "");
      }
      if (args[1] === "erase") {
        return createExecResult("", "");
      }
      throw new Error(`Unexpected fake command: ${args.join(" ")}`);
    },
    {
      timer,
      platform: "darwin",
      deviceTypeProfiles: new FakeSimulatorDeviceTypeProfiles(),
      simulatorAppPresenter: { presentAfterStart: async () => {} },
    },
  );
  return {
    client,
    timer,
    target,
    listing,
    runtime,
    counts: () => ({ lists, enumerations }),
    fail: (error: Error) => {
      failure = error;
    },
  };
}

beforeEach(() => {
  resetSimCtlSharedStateForTesting();
  SimCtlClient.invalidateDeviceListCache();
});

test.each([0, 1, 3])(
  "boot state reads avoid enrichment with %i other booted simulators",
  async (k) => {
    const h = harness(k);
    const enriched = spyOn(h.client, "listSimulatorImages");
    await h.client.startSimulator(h.target.udid);
    await h.client.waitForSimulatorReady(h.target.udid, 1000, { assumeBooted: true });
    console.log(`start+ready k=${k}: ${JSON.stringify(h.counts())}`);
    expect(h.counts()).toEqual({ lists: 2, enumerations: 0 });
    expect(enriched).not.toHaveBeenCalled();
  },
);

test.each([0, 1, 3])(
  "baseline reset avoids enrichment with %i other booted simulators",
  async (k) => {
    const h = harness(k);
    const enriched = spyOn(h.client, "listSimulatorImages");
    const resetter = new IosBaselineReset(
      {
        simctl: h.client,
        iosBootInstrumentation: { run: async (_request, boot) => boot(1000) },
        stopDevice: async () => {
          h.target.state = "Shutdown";
        },
      },
      h.timer,
    );
    await resetter.reset(
      { name: h.target.name, deviceId: h.target.udid, platform: "ios" },
      {
        platform: "ios",
        metadataState: "current",
        simulatorDeviceTypeIdentifier: h.target.deviceTypeIdentifier!,
        runtimeId: h.runtime,
        osVersion: "27",
        modelIdentifier: "iPhone19,1",
        archetype: "phone",
        modelType: { family: "iphone", variant: "pro" },
        compatibility: "supported",
      },
      async () => {},
    );
    console.log(`reset k=${k}: ${JSON.stringify(h.counts())}`);
    expect(h.counts()).toEqual({ lists: 4, enumerations: 0 });
    expect(enriched).not.toHaveBeenCalled();
  },
);

test.each(["bootSimulator", "waitForSimulatorReady"] as const)(
  "%s reuses its verified row for resolution",
  async (method) => {
    const h = harness();
    expect((await h.client[method](h.target.udid)).deviceId).toBe(h.target.udid);
    expect(h.counts()).toEqual({ lists: 1, enumerations: 0 });
  },
);

test("target reads return raw identity fields and remain fresh without invalidating display caching", async () => {
  const h = harness();
  await h.client.listSimulatorImages();
  h.target.state = "Shutdown";
  h.target.os_version = "27.1";
  expect(await h.client.readSimulatorTarget(h.target.udid)).toEqual({
    ...h.target,
    runtime: h.runtime,
  });
  h.target.state = "Booted";
  expect((await h.client.readSimulatorTarget(h.target.udid))?.state).toBe("Booted");
  h.timer.advanceTime(5001);
  await h.client.listSimulatorImages();
  expect(h.counts()).toEqual({ lists: 4, enumerations: 1 });
});

test("target reads require exactly one matching UDID across runtimes", async () => {
  const h = harness();
  expect(await h.client.readSimulatorTarget("missing")).toBeUndefined();
  h.listing.devices["other-runtime"] = [{ ...h.target }];
  expect(await h.client.readSimulatorTarget(h.target.udid)).toBeUndefined();
  delete h.listing.devices["other-runtime"];
  h.listing.devices[h.runtime]!.push({ ...h.target });
  expect(await h.client.readSimulatorTarget(h.target.udid)).toBeUndefined();
});

test("target reads propagate discovery errors instead of falling back to inventory", async () => {
  const h = harness();
  await h.client.listSimulatorImages();
  const failure = new Error("fresh raw list failed");
  h.fail(failure);
  await expect(h.client.readSimulatorTarget(h.target.udid)).rejects.toBe(failure);
});

test.each(["timeout", "abort"])("target reads honor %s without enrichment", async (mode) => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  const failure = new Error("cancel raw read");
  let commandSignal: AbortSignal | undefined;
  const commands: string[][] = [];
  const client = new SimCtlClient(
    null,
    async (_file, args, _maxBuffer, signal) => {
      commands.push(args);
      commandSignal = signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    { timer, platform: "darwin" },
  );
  const read = client.readSimulatorTarget("target", 7, controller.signal);
  if (mode === "abort") {
    controller.abort(failure);
  } else {
    timer.advanceTime(7);
  }
  if (mode === "abort") {
    await expect(read).rejects.toBe(failure);
  } else {
    await expect(read).rejects.toThrow("Command timed out after 7ms");
  }
  expect(commandSignal?.aborted).toBe(true);
  expect(commands).toEqual([["simctl", "list", "devices", "--json"]]);
});
