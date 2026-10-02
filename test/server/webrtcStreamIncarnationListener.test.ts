import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createWebRtcStreamDeviceIncarnationListener } from "../../src/server/webrtcStreamIncarnationListener";

describe("WebRTC incarnation listener", () => {
  test("retires the device before restore and repeats cleanup safely after restore", async () => {
    const active = new Set(["device-a", "device-b"]);
    const stopped: string[] = [];
    const listener = createWebRtcStreamDeviceIncarnationListener({
      stopStreamsForDevice: async (deviceId) => {
        if (active.delete(deviceId)) {
          stopped.push(deviceId);
        }
      },
    });
    await listener.prepareForIncarnationChange?.("device-a");
    expect(stopped).toEqual(["device-a"]);
    await listener.onDeviceIncarnationChanged("device-a");
    expect(stopped).toEqual(["device-a"]);
    expect([...active]).toEqual(["device-b"]);
    active.add("device-a");
    await listener.onDeviceIncarnationChanged("device-a");
    expect(stopped).toEqual(["device-a", "device-a"]);
  });

  test("boot listener has only the dependency-free incarnation registry as a runtime import", () => {
    const source = readFileSync(
      new URL("../../src/server/webrtcStreamIncarnationListener.ts", import.meta.url),
      "utf8",
    );
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);
    expect(imports).toEqual([{ kind: "import-statement", path: "../utils/deviceIncarnation" }]);
  });
});
