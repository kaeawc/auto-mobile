import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  endpointFromDescription,
  FileEmulatorGrpcDiscovery,
  parseDiscoveryIni,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";

const HOME = "/home/ci";

describe("endpointFromDescription", () => {
  test("prefers the bearer token when the emulator was launched with -grpc-use-token", () => {
    const ini = parseDiscoveryIni(
      "port.serial=5556\nport.adb=5557\ngrpc.port=8556\ngrpc.token=abc=def\ngrpc.jwks=/j\ngrpc.jwk_active=/j/active.jwk\n",
    );
    expect(endpointFromDescription(42, "/d/pid_42.ini", ini)).toEqual({
      pid: 42,
      consolePort: 5556,
      address: "localhost:8556",
      auth: { kind: "token", token: "abc=def" },
      descriptionFile: "/d/pid_42.ini",
    });
  });

  test("falls back to JWT, then to no auth", () => {
    const jwt = endpointFromDescription(1, "f", {
      "port.serial": "5554",
      "grpc.port": "8558",
      "grpc.jwks": "/j",
      "grpc.jwk_active": "/a",
    });
    expect(jwt?.auth).toEqual({ kind: "jwt", jwksDir: "/j", activeJwksFile: "/a" });
    expect(jwt?.address).toBe("localhost:8558");
    expect(
      endpointFromDescription(1, "f", { "port.serial": "5554", "grpc.port": "8554" })?.auth,
    ).toEqual({ kind: "none" });
  });

  test("grpc.address wins over grpc.port", () => {
    expect(
      endpointFromDescription(1, "f", {
        "port.serial": "5554",
        "grpc.address": "127.0.0.1:9000",
        "grpc.port": "8554",
      })?.address,
    ).toBe("127.0.0.1:9000");
  });

  test("a description with no grpc keys is not a gRPC endpoint and never guesses 8554", () => {
    const ini = parseDiscoveryIni("port.serial=5556\nport.adb=5557\navd.name=sim_rs\n");
    expect(endpointFromDescription(7, "f", ini)).toBeUndefined();
    expect(
      endpointFromDescription(7, "f", { "port.serial": "5556", "grpc.port": "not-a-port" }),
    ).toBeUndefined();
  });

  test("a description without a console port is not an endpoint", () => {
    expect(endpointFromDescription(1, "f", { "grpc.port": "8554" })).toBeUndefined();
  });
});

describe("FileEmulatorGrpcDiscovery", () => {
  const runningDir = path.join(HOME, ".android", "avd", "running");
  const files: Record<string, string> = {
    [path.join(runningDir, "pid_100.ini")]: "port.serial=5554\ngrpc.port=8554\n",
    [path.join(runningDir, "pid_200.ini")]: "port.serial=5556\ngrpc.port=8556\n",
    [path.join(runningDir, "pid_300.ini")]: "port.serial=5556\ngrpc.port=9999\n",
    [path.join(runningDir, "pid_400.ini")]: "port.serial=5560\nport.adb=5561\n",
  };
  const fs = {
    readdir: async (dir: string) => {
      if (dir !== runningDir) {
        throw new Error(`ENOENT: ${dir}`);
      }
      return ["pid_300.ini", "pid_100.ini", "notes.txt", "pid_200.ini", "pid_400.ini"];
    },
    readFile: async (file: string) => {
      const text = files[file];
      if (text === undefined) {
        throw new Error(`ENOENT: ${file}`);
      }
      return text;
    },
  };

  test("finds the live emulator by console port and skips stale files", async () => {
    const discovery = new FileEmulatorGrpcDiscovery(
      fs,
      ["/missing/avd/running", runningDir],
      (pid) => pid !== 200,
    );
    expect((await discovery.findByConsolePort(5556))?.address).toBe("localhost:9999");
    expect((await discovery.findByConsolePort(5554))?.pid).toBe(100);
    expect(await discovery.findByConsolePort(5558)).toBeUndefined();
  });

  test("a live emulator with no grpc keys has no endpoint, even while 8554 is taken", async () => {
    const discovery = new FileEmulatorGrpcDiscovery(fs, [runningDir], () => true);
    expect(await discovery.findByConsolePort(5560)).toBeUndefined();
  });
});
