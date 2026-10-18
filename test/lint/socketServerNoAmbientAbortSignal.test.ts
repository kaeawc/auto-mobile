import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { typeScriptFiles } from "./astGuard";

const ROOT = path.resolve(import.meta.dir, "../..");

// #11817: the control-socket pipeline passes its cancellation signal explicitly
// (RequestContext / IdeMutationCall.signal); no ambient getAbortSignal() reads.
const SOCKET_SERVER = "src/daemon/socketServer.ts";
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
});
