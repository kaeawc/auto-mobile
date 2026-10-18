import { readFileSync } from "node:fs";
import * as path from "node:path";
import { JimpBackend } from "../../src/utils/image/backend/JimpBackend";
import { SharpBackend } from "../../src/utils/image/backend/SharpBackend";
import { FakeImageBackend } from "../fakes/FakeImageBackend";
import { runImageBackendContract, type ImageBackendFixture } from "./ImageBackendContract";

// Real decoders run over a PNG captured into the repository (IHDR: 20x10); nothing is written (#11868).
const png = readFileSync(
  path.join(import.meta.dir, "..", "fixtures", "screenshots", "small-element.png"),
);
const fixture: ImageBackendFixture = { png, width: 20, height: 10 };

runImageBackendContract(
  "FakeImageBackend",
  ({ png: source, width, height }) => {
    const backend = new FakeImageBackend();
    backend.setMetadataResult({ width, height, format: "png", size: source.length });
    backend.setExecuteResult(Buffer.from(source));
    backend.setRawPixelsResult({ width, height, data: Buffer.alloc(width * height * 4) });
    return backend;
  },
  fixture,
);
runImageBackendContract("JimpBackend", () => new JimpBackend(), fixture);
runImageBackendContract("SharpBackend", () => new SharpBackend(), fixture);
