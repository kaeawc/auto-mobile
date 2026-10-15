#!/usr/bin/env bun
/**
 * bun scripts/ios/prototype-viewer-attach-smoke.ts <udid> <bundleId>
 * Open the viewer from the home screen first. Stdout contains compact JSON lines only.
 */
import {
  createPrototypeViewerAttacher,
  PrototypeViewerConnections,
} from "../../src/features/prototype/ios/prototypeViewerAttach";
import type { BootedDevice } from "../../src/models";

function closedDuringHandshake(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (/closed the connection during the handshake/.test(cause.message)) {
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const [udid, bundleId] = process.argv.slice(2);
  if (udid === undefined || bundleId === undefined) {
    throw new Error("usage: prototype-viewer-attach-smoke.ts <udid> <bundleId>");
  }
  const device: BootedDevice = {
    deviceId: udid,
    name: "Prototype viewer simulator",
    platform: "ios",
  };
  const client = await createPrototypeViewerAttacher().attach(device, bundleId);
  console.error("Viewer attached; checking status and single-host authentication.");
  client.onEvent((event) => console.log(JSON.stringify(event)));
  try {
    console.log(JSON.stringify(await client.request("get_prototype_status")));
    // A separate attacher creates a second connection while the first remains authenticated.
    const second = createPrototypeViewerAttacher({ connections: new PrototypeViewerConnections() });
    let refused = false;
    try {
      const unexpected = await second.attach(device, bundleId);
      unexpected.close();
    } catch (error) {
      refused = closedDuringHandshake(error);
      if (!refused) {
        throw error;
      }
    }
    console.log(JSON.stringify({ type: "second_attach", refused }));
    if (!refused) {
      throw new Error("Viewer unexpectedly accepted a second host.");
    }
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (error) {
  // Keep causes (which may contain endpoint details) out of human-facing output.
  console.error(error instanceof Error ? error.message : "Prototype viewer attach failed.");
  process.exitCode = 1;
}
