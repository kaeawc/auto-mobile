import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeEmergencyLog } from "../../src/utils/loggingConfig";

const originalFormat = process.env.AUTOMOBILE_LOG_FORMAT;

afterEach(() => {
  if (originalFormat === undefined) {
    delete process.env.AUTOMOBILE_LOG_FORMAT;
  } else {
    process.env.AUTOMOBILE_LOG_FORMAT = originalFormat;
  }
});

describe("writeEmergencyLog", () => {
  test("emits one valid JSON record in structured mode", () => {
    process.env.AUTOMOBILE_LOG_FORMAT = "json";
    const writes: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      writeEmergencyLog("Fatal startup failure", new Error("database unavailable"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      level: "error",
      component: "process",
      event: "log.emergency",
      message: expect.stringContaining("Fatal startup failure"),
    });
  });
});
