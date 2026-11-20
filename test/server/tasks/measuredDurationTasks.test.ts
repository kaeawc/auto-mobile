import { beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { TASKS_EXTENSION_ID } from "../../../src/daemon/tasks/mcpTasksExtension";
import {
  TASK_ELIGIBILITY,
  createTaskAwareToolCallExecutor,
} from "../../../src/server/tasks/toolCallTasks";
import type {
  McpToolCallExtra,
  McpToolCallResult,
  ToolCall,
} from "../../../src/server/toolCallDispatch";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";

/*
 * Tools added to TASK_ELIGIBILITY from the measured durations in #13944: explore and killDevice
 * abort on tasks/cancel, deviceSnapshot capture/restore run to completion (detach).
 */

const OWNER = "owner-measured";

/** A tool body parked on a gate until released or aborted; records the signal it ran under. */
class GatedTool {
  readonly signals: AbortSignal[] = [];
  finished = 0;
  private release: (() => void) | undefined;
  private parked: Array<() => void> = [];

  open(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  waitParked(): Promise<void> {
    return this.release ? Promise.resolve() : new Promise((resolve) => this.parked.push(resolve));
  }

  readonly execute = async (call: ToolCall<McpToolCallExtra>): Promise<McpToolCallResult> => {
    const signal = call.extra.signal;
    this.signals.push(signal);
    try {
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        const parked = this.parked;
        this.parked = [];
        parked.forEach((listener) => listener());
      });
    } catch {
      // The tool reports its own abort as an error result, like the real handlers do.
      return { content: [{ type: "text", text: "aborted" }], isError: true };
    }
    this.finished++;
    return { content: [{ type: "text", text: `${call.name} done` }] };
  };
}

function arrange(name: string, args: Record<string, unknown>, declared = true) {
  const manager = new FakeTaskManager({ timer: new FakeTimer() });
  const tool = new GatedTool();
  const execute = createTaskAwareToolCallExecutor({
    taskManager: manager,
    ownerKey: OWNER,
    eligibleTools: TASK_ELIGIBILITY,
    execute: tool.execute,
  });
  const call: ToolCall<McpToolCallExtra> = {
    name,
    args,
    progress: undefined,
    progressToken: undefined,
    extra: {
      signal: new AbortController().signal,
      envelope: declared
        ? { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } } }
        : undefined,
      sendNotification: async () => {},
    },
  };
  return { manager, tool, execute, call };
}

async function settled(manager: FakeTaskManager, taskId: string) {
  for (let turn = 0; turn < 200; turn++) {
    const row = await manager.get(OWNER, taskId);
    if (row.status !== "working" && row.status !== "input_required") {
      return row;
    }
    await Promise.resolve();
  }
  throw new Error("Task did not settle");
}

function taskIdOf(handle: unknown): string {
  if (typeof handle === "object" && handle !== null && "taskId" in handle) {
    const { taskId } = handle;
    if (typeof taskId === "string") {
      return taskId;
    }
  }
  throw new Error("Expected a task handle");
}

describe("measured-duration Tasks additions (#13944)", () => {
  // beforeAll time is excluded from the per-test budget; this absorbs one-time module startup.
  beforeAll(async () => {
    const { manager, tool, execute, call } = arrange("explore", {});
    const handle = execute(call);
    await tool.waitParked();
    tool.open();
    await settled(manager, taskIdOf(await handle));
  });

  test("explore and killDevice are abort-eligible on every call", () => {
    expect(TASK_ELIGIBILITY({ name: "explore", args: {} })).toEqual({ onCancel: "abort" });
    expect(TASK_ELIGIBILITY({ name: "explore", args: { dryRun: true } })).toEqual({
      onCancel: "abort",
    });
    expect(TASK_ELIGIBILITY({ name: "killDevice", args: { force: true } })).toEqual({
      onCancel: "abort",
    });
  });

  test("deviceSnapshot is detach-eligible for capture and restore only", () => {
    for (const action of ["capture", "restore"]) {
      expect(TASK_ELIGIBILITY({ name: "deviceSnapshot", args: { action } })).toEqual({
        onCancel: "detach",
      });
    }
    for (const args of [{ action: "delete" }, {}, { action: "stop" }]) {
      expect(TASK_ELIGIBILITY({ name: "deviceSnapshot", args })).toBeUndefined();
    }
  });

  test("tools measured as interactive or under 2 s stay synchronous", () => {
    for (const name of [
      "tapOn",
      "pressButton",
      "sendKeys",
      "swipeOn",
      "launchApp",
      "terminateApp",
      "uninstallApp",
      "putAppFile",
      "observe",
    ]) {
      expect(TASK_ELIGIBILITY({ name, args: {} })).toBeUndefined();
    }
    expect(TASK_ELIGIBILITY({ name: "launchApp", args: { coldBoot: true } })).toBeUndefined();
  });

  test("a non-declaring explore call stays synchronous and creates no task", async () => {
    const { manager, tool, execute, call } = arrange("explore", {}, false);
    const pending = execute(call);
    await tool.waitParked();
    tool.open();
    const result = await pending;
    expect("resultType" in result && result.resultType === "task").toBe(false);
    expect(manager.calls).toEqual([]);
  });

  test("tasks/cancel aborts an explore task's work signal", async () => {
    const { manager, tool, execute, call } = arrange("explore", { maxInteractions: 50 });
    const taskId = taskIdOf(await execute(call));
    await tool.waitParked();
    expect(tool.signals[0]?.aborted).toBe(false);

    await manager.cancel(OWNER, taskId);
    const done = await settled(manager, taskId);

    expect(done.status).toBe("cancelled");
    expect(tool.signals[0]?.aborted).toBe(true);
    expect(tool.finished).toBe(0);
  });

  test("tasks/cancel aborts a killDevice task's work signal", async () => {
    const { manager, tool, execute, call } = arrange("killDevice", {});
    const taskId = taskIdOf(await execute(call));
    await tool.waitParked();

    await manager.cancel(OWNER, taskId);
    expect((await settled(manager, taskId)).status).toBe("cancelled");
    expect(tool.signals[0]?.aborted).toBe(true);
  });

  test("tasks/cancel leaves a snapshot capture running until it finishes", async () => {
    const { manager, tool, execute, call } = arrange("deviceSnapshot", {
      action: "capture",
      snapshotName: "s1",
    });
    const taskId = taskIdOf(await execute(call));
    await tool.waitParked();

    await manager.cancel(OWNER, taskId);
    expect(tool.signals[0]?.aborted).toBe(false);
    tool.open();
    const done = await settled(manager, taskId);

    expect(tool.finished).toBe(1);
    expect(done.status).toBe("cancelled");
  });

  test("an uncancelled snapshot restore task completes with the tool's result", async () => {
    const { manager, tool, execute, call } = arrange("deviceSnapshot", {
      action: "restore",
      snapshotName: "s1",
    });
    const taskId = taskIdOf(await execute(call));
    await tool.waitParked();
    tool.open();
    const done = await settled(manager, taskId);

    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ content: [{ type: "text", text: "deviceSnapshot done" }] });
  });
});
