import { describe, expect, test } from "bun:test";

import path from "node:path";
import { typeScriptFiles, readGuardFile } from "./astGuard";

const ROOT = path.resolve(import.meta.dir, "../..");

// #11817: the control-socket pipeline passes its cancellation signal explicitly
// (RequestContext / IdeMutationCall.signal); no ambient getAbortSignal() reads.
const SOCKET_SERVER = "src/daemon/socketServer.ts";
const DEVICE_ALLOCATION = "src/daemon/deviceAllocation.ts";
const SESSION_MANAGER = "src/daemon/sessionManager.ts";
const EXPLICIT_DEVICE_BIND = "src/daemon/explicitDeviceBind.ts";
const DEVICE_AUTOLOCK_MANAGER = "src/daemon/deviceAutolockManager.ts";
const DEVICE_RUNTIME_IDENTITY = "src/daemon/deviceRuntimeIdentity.ts";
const AMBIENT_READ = /\bgetAbortSignal\s*\(/;

describe("control-socket server reads no ambient abort signal (#11817)", () => {
  test("socketServer.ts and socketServer/ submodules never call getAbortSignal()", () => {
    const files = [
      SOCKET_SERVER,
      ...[
        ...typeScriptFiles(path.join(ROOT, "src/daemon/socketServer")),
        ...typeScriptFiles(path.join(ROOT, "src/daemon/socketServerParts")),
      ].map((file) => path.relative(ROOT, file).split(path.sep).join("/")),
    ];
    const offenders = files.filter((file) =>
      AMBIENT_READ.test(readGuardFile(path.join(ROOT, file))),
    );
    expect(offenders).toEqual([]);
  });

  // Slice b: DeviceAllocation receives the caller's signal explicitly; DevicePool
  // reads the ambient signal once at its public entry points.
  test("deviceAllocation.ts never calls getAbortSignal()", () => {
    expect(AMBIENT_READ.test(readGuardFile(path.join(ROOT, DEVICE_ALLOCATION)))).toBe(false);
  });

  // Slice c: session creation, rebind and acquisition take the caller's signal in their
  // options. The one remaining read is dispatchDeviceRestore's relay of the teardown-shielded
  // ambient signal into the device restorers, which resolve it themselves; tracked separately.
  test("session manager reads the ambient signal only in the moved dispatchDeviceRestore", () => {
    const source = readGuardFile(path.join(ROOT, SESSION_MANAGER));
    const reads = source.match(new RegExp(AMBIENT_READ.source, "g")) ?? [];
    expect(reads).toHaveLength(0);
    const dispatchSource = readGuardFile(
      path.join(ROOT, "src/daemon/sessionManager/recoveryPublication.ts"),
    );
    expect(dispatchSource.match(new RegExp(AMBIENT_READ.source, "g")) ?? []).toHaveLength(1);
    const dispatch = dispatchSource.slice(dispatchSource.indexOf("async dispatchDeviceRestore("));
    expect(AMBIENT_READ.test(dispatch.slice(0, dispatch.indexOf("\n  }\n")))).toBe(true);
  });

  // Slice e/f: DevicePool.bindOrReuseDeviceSession, autolockDevice and reconcileDiscoveryObservation
  // read the ambient signal once and hand it to ExplicitDeviceBind, the autolock manager and the
  // runtime-identity tracker explicitly.
  test.each([EXPLICIT_DEVICE_BIND, DEVICE_AUTOLOCK_MANAGER, DEVICE_RUNTIME_IDENTITY])(
    "%s never calls getAbortSignal()",
    (file) => {
      expect(AMBIENT_READ.test(readGuardFile(path.join(ROOT, file)))).toBe(false);
    },
  );
});
