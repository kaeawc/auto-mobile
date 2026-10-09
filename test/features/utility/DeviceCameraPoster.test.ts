import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BootedDevice } from "../../../src/models";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { CAMERA_POSTER_POSE_WARNING } from "../../../src/features/utility/DeviceCameraPoster";
import { setDeviceStateSchema } from "../../../src/server/utilityTools";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const emulator: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Pixel" };
const physical: BootedDevice = { platform: "android", deviceId: "R58M12ABCDE", name: "Phone" };
const ios: BootedDevice = { platform: "ios", deviceId: "12345678-1234", name: "iPhone" };
// The tool resolves the poster path on the host, so on Windows "/img/poster.png" becomes
// "<drive>:\img\poster.png". Build the fixture the same way to stay platform-native.
const POSTER_PATH = resolve("/img/poster.png");

function setup(device: BootedDevice = emulator, files: string[] = [POSTER_PATH]) {
  const adbFactory = new FakeAdbClientFactory();
  const written: string[] = [];
  const state = new DeviceState(device, {
    adbFactory,
    cameraPosterFileExists: (path) => files.includes(path),
    cameraPosterQrWriter: {
      writePoster: async (text) => {
        written.push(text);
        return "/posters/qr-abc.png";
      },
    },
  });
  return { adbFactory, client: adbFactory.getFakeClient(), state, written };
}

describe("setDeviceState cameraPoster", () => {
  test("sets an image poster on the wall through the emulator console", async () => {
    const { client, state } = setup();
    const result = await state.setState({
      cameraPoster: { mode: "image", path: POSTER_PATH },
    });
    expect(client.getAllCommands()).toEqual([`emu virtualscene-image wall ${POSTER_PATH}`]);
    expect(result.success).toBe(true);
    expect(result.cameraPoster).toMatchObject({
      supported: true,
      mode: "image",
      surface: "wall",
      path: POSTER_PATH,
      method: "android_emulator_console",
      warning: CAMERA_POSTER_POSE_WARNING,
    });
    expect(result.cameraPoster?.verified).toBeUndefined();
    expect(CAMERA_POSTER_POSE_WARNING).toContain("default camera pose");
  });

  test("renders a QR payload with the existing writer and targets the table", async () => {
    const { client, state, written } = setup(emulator, ["/posters/qr-abc.png"]);
    const result = await state.setState({
      cameraPoster: { mode: "qr", text: "hello", surface: "table" },
    });
    expect(written).toEqual(["hello"]);
    expect(client.getAllCommands()).toEqual(["emu virtualscene-image table /posters/qr-abc.png"]);
    expect(result.cameraPoster).toMatchObject({ mode: "qr", surface: "table" });
  });

  test("clear sends the console command without a path", async () => {
    const { client, state } = setup();
    const result = await state.setState({ cameraPoster: { mode: "clear", surface: "wall" } });
    expect(client.getAllCommands()).toEqual(["emu virtualscene-image wall"]);
    expect(result.success).toBe(true);
    expect(result.cameraPoster?.path).toBeUndefined();
  });

  test("surfaces a console refusal with the virtualscene hint", async () => {
    const { client, state } = setup();
    client.setCommandResult(
      `emu virtualscene-image wall ${POSTER_PATH}`,
      "KO: virtual scene camera is not enabled\n",
    );
    const result = await state.setState({
      cameraPoster: { mode: "image", path: POSTER_PATH },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("KO: virtual scene camera is not enabled");
    expect(result.error).toContain("hw.camera.back=virtualscene");
    expect(result.cameraPoster?.warning).toBeUndefined();
  });

  test.each([
    ["physical Android", physical, "physical Android"],
    ["iOS", ios, "iOS"],
  ])("returns unsupported on %s without issuing a command", async (_name, device, text) => {
    const { client, state } = setup(device);
    const result = await state.setState({ cameraPoster: { mode: "clear" } });
    expect(result.success).toBe(false);
    expect(result.cameraPoster?.supported).toBe(false);
    expect(result.error).toContain(text);
    expect(client.getAllCommands()).toEqual([]);
  });

  test.each([
    ["/img/poster.gif", "PNG, JPG, or JPEG"],
    ["/img/missing.png", "does not exist"],
    ["/img/my poster.png", "whitespace"],
  ])("rejects image path %s before touching the console", async (path, message) => {
    const { client, state } = setup(emulator, ["/img/my poster.png"]);
    const result = await state.setState({ cameraPoster: { mode: "image", path } });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(client.getAllCommands()).toEqual([]);
  });

  test("reports a QR rendering failure as a typed error", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const state = new DeviceState(emulator, {
      adbFactory,
      cameraPosterQrWriter: {
        writePoster: async () => {
          throw new Error("payload too large");
        },
      },
    });
    const result = await state.setState({ cameraPoster: { mode: "qr", text: "x" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("payload too large");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("tool schema accepts cameraPoster alone and rejects unknown shapes", () => {
    expect(
      setDeviceStateSchema.safeParse({ cameraPoster: { mode: "clear", surface: "table" } }).success,
    ).toBe(true);
    expect(setDeviceStateSchema.safeParse({ cameraPoster: { mode: "image" } }).success).toBe(false);
    expect(
      setDeviceStateSchema.safeParse({ cameraPoster: { mode: "clear", surface: "ceiling" } })
        .success,
    ).toBe(false);
  });
});
