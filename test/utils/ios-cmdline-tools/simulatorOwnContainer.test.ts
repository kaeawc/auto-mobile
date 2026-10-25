import { describe, expect, test } from "bun:test";
import { cloneContainerFixture } from "../../helpers/simulatorContainerFixture";
import {
  resolveOwnAppContainer,
  SimulatorContainerUnresolvedError,
} from "../../../src/utils/ios-cmdline-tools/simulatorOwnContainer";

const deviceId = "8935BFAD-F01F-40FF-95E0-83FD0FF63DEB";
const bundleId = "com.apple.mobilesafari";
const { own, reported } = cloneContainerFixture(deviceId, bundleId);
function options(stdout = reported, identifier: string | null = bundleId) {
  const clone = cloneContainerFixture(deviceId, identifier);
  const inspected = clone.inspected;
  const commands: string[][] = [];
  return {
    inspected,
    commands,
    options: {
      deviceId,
      bundleId,
      ...clone.ownership,
      container: "data" as const,
      run: async (args: string[]) => {
        commands.push(args);
        return { stdout };
      },
    },
  };
}
describe("resolveOwnAppContainer", () => {
  test("accepts an own normalized path without metadata I/O", async () => {
    const h = options(` ${own}\n`);
    expect(await resolveOwnAppContainer(h.options)).toBe(own);
    expect(h.inspected).toEqual([]);
    expect(h.commands).toEqual([["get_app_container", deviceId, bundleId, "data"]]);
  });
  test("uses captured template registration but only inspects clone metadata", async () => {
    const h = options();
    expect(await resolveOwnAppContainer(h.options)).toBe(own);
    expect(h.inspected).toEqual([own]);
  });
  test.each([null, "another.app"])("refuses unproven clone metadata: %s", async (id) => {
    const h = options(reported, id);
    await expect(resolveOwnAppContainer(h.options)).rejects.toMatchObject({
      reason: "foreign-device-unproven",
      deviceId,
      bundleId,
      reportedPath: reported,
    });
    expect(h.inspected).toEqual([own]);
  });
  test.each([
    "/tmp/x",
    `${own}/..`,
    `${cloneContainerFixture(deviceId, bundleId).ownership.deviceSetRoot}/${deviceId}/data/../../escape`,
  ])("refuses outside or unnormalized path %s", async (path) => {
    await expect(resolveOwnAppContainer(options(path).options)).rejects.toMatchObject({
      reason: "outside-device-set",
    });
  });
  test("empty is typed", async () => {
    await expect(resolveOwnAppContainer(options(" \n").options)).rejects.toBeInstanceOf(
      SimulatorContainerUnresolvedError,
    );
    await expect(resolveOwnAppContainer(options("").options)).rejects.toMatchObject({
      reason: "empty",
    });
  });
  test("UDIDs compare case insensitively", async () => {
    const h = options(own.replace(deviceId, deviceId.toLowerCase()));
    expect(await resolveOwnAppContainer(h.options)).toBe(own);
    expect(h.inspected).toEqual([]);
  });
  test("App Group metadata must match group id", async () => {
    const group = "group.example.logs";
    const h = options(reported.replace("Data/Application", "Shared/AppGroup"), group);
    expect(await resolveOwnAppContainer({ ...h.options, container: "group", groupId: group })).toBe(
      own.replace("Data/Application", "Shared/AppGroup"),
    );
    expect(h.commands[0]?.[3]).toBe(group);
    await expect(
      resolveOwnAppContainer({
        ...options(reported.replace("Data/Application", "Shared/AppGroup")).options,
        container: "group",
        groupId: group,
      }),
    ).rejects.toMatchObject({ reason: "foreign-device-unproven" });
  });
  test("command failure propagates unchanged", async () => {
    const failure = new Error("not installed");
    await expect(
      resolveOwnAppContainer({
        ...options().options,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
  test("invalid device id cannot escape the own data directory", async () => {
    await expect(
      resolveOwnAppContainer({ ...options().options, deviceId: "../escape" }),
    ).rejects.toMatchObject({ reason: "outside-device-set" });
  });
});
