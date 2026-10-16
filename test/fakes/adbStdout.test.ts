import { expect, test } from "bun:test";
import { FakeAdbClient } from "./FakeAdbClient";
import { FakeAdbExecutor } from "./FakeAdbExecutor";

test.each(["client", "executor"] as const)(
  "%s emits response stdout before success or failure",
  async (kind) => {
    for (const fail of [false, true]) {
      const adb = kind === "client" ? new FakeAdbClient() : new FakeAdbExecutor();
      const command = "shell echo tracked";
      if (adb instanceof FakeAdbClient) {
        adb.setCommandResult(command, "4242\n");
      } else {
        adb.setCommandResponse(command, { stdout: "4242\n", stderr: "" });
      }
      const error = new Error("host failed");
      if (fail) {
        adb.setCommandError(command, error);
      }
      const events: string[] = [];
      await adb
        .execute(["shell", "echo", "tracked"], {
          onStdout: (chunk) => events.push(chunk),
        })
        .then(
          () => events.push("success"),
          (failure: unknown) => {
            expect(failure).toBe(error);
            events.push("failure");
          },
        );
      expect(events).toEqual(["4242\n", fail ? "failure" : "success"]);
    }
  },
);

test.each(["client", "executor"] as const)(
  "%s emits configured chunks once before failure",
  async (kind) => {
    const adb = kind === "client" ? new FakeAdbClient() : new FakeAdbExecutor();
    adb.setCommandStdoutChunks("shell echo tracked", ["42", "42\n"]);
    const error = new Error("host failed");
    adb.setCommandError("shell echo tracked", error);
    const chunks: string[] = [];
    await expect(
      adb.execute(["shell", "echo", "tracked"], {
        onStdout: (chunk) => chunks.push(chunk),
      }),
    ).rejects.toBe(error);
    expect(chunks).toEqual(["42", "42\n"]);
  },
);
