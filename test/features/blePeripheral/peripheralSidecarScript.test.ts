import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = readFileSync(
  fileURLToPath(
    new URL("../../../src/features/blePeripheral/sidecar/peripheral.py", import.meta.url),
  ),
  "utf8",
);

describe("BLE sidecar script", () => {
  test("a transport-open timeout is re-raised with the transport and the bound in its message", () => {
    // asyncio.TimeoutError has an empty message, which reached users as a bare "BLE sidecar: ".
    expect(script).toContain(
      'raise TimeoutError(f"Timed out after {timeout_s} s opening BLE transport {spec}")',
    );
    // Windows checkouts use CRLF, so anchor on the line rather than a literal newline.
    expect(script).toMatch(/^OPEN_TRANSPORT_TIMEOUT_S = 20\r?$/m);
    expect(script).toContain(
      'transport = await open_transport_bounded(open_transport, config["transport"])',
    );
    expect(script).not.toMatch(/wait_for\(open_transport\(/);
  });
});
