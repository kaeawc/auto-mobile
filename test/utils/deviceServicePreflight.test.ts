import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DeviceServiceDisabledError } from "../../src/models/DeviceServiceDisabledError";
import { DefaultDeviceServicePreflight } from "../../src/utils/deviceServicePreflight";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import type { PlistReader, PlistReadOptions } from "../../src/utils/ios-cmdline-tools/PlistClient";

const device: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  platform: "ios",
  name: "iPhone",
};
const labels = iosDeviceResourceCatalog.mediaTranscoding;
class FakePlistReader implements Pick<PlistReader, "readJsonFile"> {
  value: unknown = {};
  error?: Error;
  calls: Array<{ path: string; options?: PlistReadOptions }> = [];
  async readJsonFile(path: string, options?: PlistReadOptions): Promise<unknown> {
    this.calls.push({ path, options });
    if (this.error) {
      throw this.error;
    }
    return this.value;
  }
}
afterEach(() => {
  mock.restore();
});
test("disabled label refuses with the full actionable payload", async () => {
  const plist = new FakePlistReader();
  plist.value = { [labels[1]]: true, [labels[0]]: false };
  const error = await new DefaultDeviceServicePreflight({ plist })
    .assertEnabled(device, "putAppFile")
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DeviceServiceDisabledError);
  if (!(error instanceof DeviceServiceDisabledError)) {
    throw new Error("Expected typed refusal");
  }
  expect(error.toPayload()).toEqual({
    code: "device_service_disabled",
    tool: "putAppFile",
    resource: "mediaTranscoding",
    labels,
    disabledLabels: [labels[1]],
    unavailable: expect.any(String),
    howToEnable: expect.any(String),
    retryable: false,
    deviceId: device.deviceId,
  });
  for (const text of [
    "putAppFile",
    "mediaTranscoding",
    ...labels,
    error.unavailable,
    error.howToEnable,
  ]) {
    expect(error.message).toContain(text);
  }
  for (const text of [
    "setDeviceResources",
    '{resources:{mediaTranscoding:"enabled"}}',
    "setToolEnabled",
    "--enable-tool setDeviceResources",
    '{resources:{mediaTranscoding:"disabled"}}',
  ]) {
    expect(error.howToEnable).toContain(text);
  }
});
for (const value of [{}, { [labels[0]]: false }, { [labels[0]]: "true" }]) {
  test(`passes without a boolean disabled override: ${JSON.stringify(value)}`, async () => {
    const plist = new FakePlistReader();
    plist.value = value;
    await new DefaultDeviceServicePreflight({ plist }).assertEnabled(device, "putAppFile");
    expect(plist.calls).toHaveLength(1);
  });
}
for (const message of [
  "ENOENT",
  // Captured from `plutil -convert json` on a nonexistent file (macOS 26).
  "/private/var/tmp/nonexistent-x/disabled.plist: (The file “disabled.plist” couldn’t be opened because there is no such file.)",
  "permission denied",
]) {
  test(`read failure passes: ${message}`, async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const plist = new FakePlistReader();
    plist.error = new Error(message);
    await new DefaultDeviceServicePreflight({ plist }).assertEnabled(device, "putAppFile");
    expect(warn).toHaveBeenCalledTimes(message === "permission denied" ? 1 : 0);
  });
}
test("reads once per call without caching and forwards the signal", async () => {
  const plist = new FakePlistReader();
  const preflight = new DefaultDeviceServicePreflight({ plist });
  const signal = new AbortController().signal;
  await preflight.assertEnabled(device, "putAppFile", signal);
  plist.value = { [labels[0]]: true };
  await expect(preflight.assertEnabled(device, "putAppFile")).rejects.toBeInstanceOf(
    DeviceServiceDisabledError,
  );
  expect(plist.calls).toHaveLength(2);
  expect(plist.calls[0]).toEqual({
    path: `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${device.deviceId}/disabled.plist`,
    options: { signal },
  });
});
test("physical, Android and unmapped tools never read", async () => {
  const plist = new FakePlistReader();
  const preflight = new DefaultDeviceServicePreflight({ plist });
  await preflight.assertEnabled({ ...device, deviceId: "physical" }, "putAppFile");
  await preflight.assertEnabled({ ...device, platform: "android" }, "putAppFile");
  await preflight.assertEnabled(device, "observe");
  expect(plist.calls).toHaveLength(0);
});
test("an already aborted request never reads", async () => {
  const plist = new FakePlistReader();
  const controller = new AbortController();
  controller.abort();
  await expect(
    new DefaultDeviceServicePreflight({ plist }).assertEnabled(
      device,
      "putAppFile",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(plist.calls).toHaveLength(0);
});

test("all disabled labels retain catalog order", async () => {
  const plist = new FakePlistReader();
  plist.value = { [labels[1]]: true, [labels[0]]: true };
  await expect(
    new DefaultDeviceServicePreflight({ plist }).assertEnabled(device, "putAppFile"),
  ).rejects.toMatchObject({ labels, disabledLabels: labels });
});

test("a native ENOENT code passes even without a diagnostic message", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const plist = new FakePlistReader();
  plist.error = Object.assign(new Error("absent"), { code: "ENOENT" });
  await new DefaultDeviceServicePreflight({ plist }).assertEnabled(device, "putAppFile");
  expect(warn).not.toHaveBeenCalled();
});

test("a malformed plist warns and passes", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const plist = new FakePlistReader();
  plist.value = [];
  await new DefaultDeviceServicePreflight({ plist }).assertEnabled(device, "putAppFile");
  expect(warn).toHaveBeenCalledTimes(1);
});

test("cancellation during the plist read remains cancellation", async () => {
  const controller = new AbortController();
  const plist: Pick<PlistReader, "readJsonFile"> = {
    readJsonFile: async () => {
      controller.abort();
      return {};
    },
  };
  await expect(
    new DefaultDeviceServicePreflight({ plist }).assertEnabled(
      device,
      "putAppFile",
      controller.signal,
    ),
  ).rejects.toThrow();
});
