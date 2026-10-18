import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { typeScriptFiles } from "./astGuard";

const ROOT = path.resolve(import.meta.dir, "../..");

// #11817: the control-socket pipeline passes its cancellation signal explicitly
// (RequestContext / IdeMutationCall.signal); no ambient getAbortSignal() reads.
const SOCKET_SERVER = "src/daemon/socketServer.ts";
const DEVICE_ALLOCATION = "src/daemon/deviceAllocation.ts";
const SESSION_MANAGER = "src/daemon/sessionManager.ts";
const SESSION_DEVICE_STATE_RESTORE = "src/daemon/sessionDeviceStateRestore.ts";
const AMBIENT_READ = /\bgetAbortSignal\s*\(/;

describe("control-socket server reads no ambient abort signal (#11817)", () => {
  test("socketServer.ts and socketServer/ submodules never call getAbortSignal()", () => {
    const files = [
      SOCKET_SERVER,
      ...typeScriptFiles(path.join(ROOT, "src/daemon/socketServer")).map((file) =>
        path.relative(ROOT, file).split(path.sep).join("/"),
      ),
    ];
    const offenders = files.filter((file) =>
      AMBIENT_READ.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  // Slice b: DeviceAllocation receives the caller's signal explicitly; DevicePool
  // reads the ambient signal once at its public entry points.
  test("deviceAllocation.ts never calls getAbortSignal()", () => {
    expect(AMBIENT_READ.test(readFileSync(path.join(ROOT, DEVICE_ALLOCATION), "utf8"))).toBe(false);
  });

  // Slice c + d: session creation, rebind and acquisition take the caller's signal in their
  // options, and dispatchDeviceRestore / the device-state restorers take the restore's scope
  // (RestoreSignalOptions: the teardown shield, the forced signal, the caller's signal) explicitly.
  test.each([SESSION_MANAGER, SESSION_DEVICE_STATE_RESTORE])(
    "%s never calls getAbortSignal()",
    (file) => {
      expect(AMBIENT_READ.test(readFileSync(path.join(ROOT, file), "utf8"))).toBe(false);
    },
  );
});
