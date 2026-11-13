import { describe, expect, test } from "bun:test";
import { androidExistingSizesScript, parseExistingSizes } from "../../src/server/androidFileBackup";

const MARKER = "SIZE";

describe("existing-destination size probe", () => {
  test("the script reports every destination by index and always exits 0", () => {
    const script = androidExistingSizesScript(["/sdcard/a b.png", "/sdcard/c.png"], MARKER);
    expect(script).toContain(`stat -c %s '/sdcard/a b.png'`);
    expect(script).toContain(`echo "${MARKER}:1:$s"`);
    expect(script).toContain(`echo "${MARKER}:1:absent"`);
    expect(script.endsWith("; exit 0")).toBe(true);
  });

  test("parses sizes, treats absent as 0 and leaves missing or garbled lines unknown", () => {
    const stdout = [
      `${MARKER}:0:1048576`,
      `${MARKER}:1:absent\r`,
      `${MARKER}:2:`,
      `OTHER:3:9`,
      `${MARKER}:9:5`,
      `${MARKER}:4:-1`,
    ].join("\n");
    expect(parseExistingSizes(stdout, 5, MARKER)).toEqual([
      1048576,
      0,
      undefined,
      undefined,
      undefined,
    ]);
    expect(parseExistingSizes("", 2, MARKER)).toEqual([undefined, undefined]);
  });
});
