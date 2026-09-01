import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dir, "../..");
const integrationTestPath = "test/integration/webrtcDeviceCapture.integration.test.ts";

test("loads the default skipped device suite without initializing capture", async () => {
  const env = { ...process.env };
  delete env.AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION;
  const { stderr, stdout } = await execFileAsync("bun", ["test", integrationTestPath], {
    cwd: repoRoot,
    env,
    timeout: 10_000,
  });

  expect(`${stdout}\n${stderr}`).toContain("(skip) device capture -> WHIP -> MediaMTX -> WHEP");
}, 15_000);
