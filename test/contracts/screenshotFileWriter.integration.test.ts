import { mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultScreenshotFileWriter } from "../../src/features/observe/screenshot/ScreenshotFileWriter";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { runScreenshotFileWriterContract } from "./ScreenshotFileWriterContract";

runScreenshotFileWriterContract("FakeScreenshotFileWriter", async () => {
  const writer = new FakeScreenshotFileWriter();
  return { writer, root: "/fake-captures", exists: async (p) => writer.has(p) };
});

// The real side runs over a private mkdtemp directory removed afterwards (#11868).
runScreenshotFileWriterContract("defaultScreenshotFileWriter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-screenshot-writer-contract-"));
  return {
    writer: defaultScreenshotFileWriter,
    root,
    exists: (p) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
