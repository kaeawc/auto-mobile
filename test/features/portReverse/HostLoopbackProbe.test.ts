import { describe, expect, test } from "bun:test";
import {
  hostLoopbackProbeFor,
  tcpHostLoopbackProbe,
  unknownHostLoopbackProbe,
} from "../../../src/features/portReverse/HostLoopbackProbe";

describe("hostLoopbackProbeFor", () => {
  test("a local adb server gets the real loopback probe", () => {
    expect(hostLoopbackProbeFor({})).toBe(tcpHostLoopbackProbe);
    expect(hostLoopbackProbeFor({ ANDROID_ADB_SERVER_ADDRESS: "127.0.0.1" })).toBe(
      tcpHostLoopbackProbe,
    );
    expect(hostLoopbackProbeFor({ ADB_SERVER_SOCKET: "tcp:5038" })).toBe(tcpHostLoopbackProbe);
  });

  test("a remote or non-TCP adb server never claims to know the host target", () => {
    expect(hostLoopbackProbeFor({ ANDROID_ADB_SERVER_ADDRESS: "10.0.0.5" })).toBe(
      unknownHostLoopbackProbe,
    );
    expect(hostLoopbackProbeFor({ ADB_SERVER_SOCKET: "tcp:build-host:5037" })).toBe(
      unknownHostLoopbackProbe,
    );
    expect(
      hostLoopbackProbeFor({ ADB_SERVER_SOCKET: "tcp:localhost-remote.example.com:5037" }),
    ).toBe(unknownHostLoopbackProbe);
    expect(hostLoopbackProbeFor({ ANDROID_ADB_SERVER_ADDRESS: "localhost-build" })).toBe(
      unknownHostLoopbackProbe,
    );
    expect(hostLoopbackProbeFor({ ADB_SERVER_SOCKET: "localfilesystem:/tmp/adb" })).toBe(
      unknownHostLoopbackProbe,
    );
  });
});
