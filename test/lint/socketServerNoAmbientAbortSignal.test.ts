import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { typeScriptFiles } from "./astGuard";

const ROOT = path.resolve(import.meta.dir, "../..");

// #11817: the control-socket pipeline passes its cancellation signal explicitly
// (RequestContext / IdeMutationCall.signal); no ambient getAbortSignal() reads.
const SOCKET_SERVER = "src/daemon/socketServer.ts";
const DEVICE_ALLOCATION = "src/daemon/deviceAllocation.ts";
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
  // reads the ambient signal once at its public entry points. sessionManager.ts
  // still has ambient reads, tracked for a later slice.
  test("deviceAllocation.ts never calls getAbortSignal()", () => {
    expect(AMBIENT_READ.test(readFileSync(path.join(ROOT, DEVICE_ALLOCATION), "utf8"))).toBe(false);
  });
});
