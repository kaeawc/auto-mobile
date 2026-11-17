import { beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { TASKS_EXTENSION_ID } from "../../../src/daemon/tasks/mcpTasksExtension";
import { createSetUIStateHandler, type SetUIStateArgs } from "../../../src/server/formTools";
import {
  TASK_ELIGIBILITY,
  createTaskAwareToolCallExecutor,
} from "../../../src/server/tasks/toolCallTasks";
import type {
  McpToolCallExtra,
  McpToolCallResult,
  ToolCall,
} from "../../../src/server/toolCallDispatch";
import type { BootedDevice } from "../../../src/models";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";

/*
 * setUIState as an MCP task (#18531): the real setUIState handler over a fake executor that
 * applies fields one at a time and checks its signal between them, like SetUIState does.
 */

const OWNER = "owner-form";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const ARGS: SetUIStateArgs = {
  fields: [
    { selector: { elementId: "first" }, value: "Grace" },
    { selector: { elementId: "last" }, value: "Hopper" },
    { selector: { elementId: "agree" }, selected: true },
  ],
};

/** Applies each field after its gate opens; aborting stops before the next field. */
class FieldByFieldForm {
  readonly applied: string[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  /** When true, each field waits for {@link openNext} or an abort. */
  gated = false;
  private release: (() => void) | undefined;
  private reachedListeners: Array<() => void> = [];

  openNext(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  /** Resolves once a field is parked on its gate. */
  waitForGate(): Promise<void> {
    return this.release
      ? Promise.resolve()
      : new Promise((resolve) => this.reachedListeners.push(resolve));
  }

  private gate(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.release = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
        once: true,
      });
      const listeners = this.reachedListeners;
      this.reachedListeners = [];
      listeners.forEach((listener) => listener());
    });
  }

  readonly executor = {
    execute: async (
      options: { fields: Array<{ selector: { elementId?: string; text?: string } }> },
      _progress?: unknown,
      signal?: AbortSignal,
    ) => {
      this.signals.push(signal);
      for (const field of options.fields) {
        signal?.throwIfAborted();
        if (this.gated) {
          await this.gate(signal);
        }
        this.applied.push(field.selector.elementId ?? "");
      }
      return {
        success: true,
        fields: options.fields.map((field) => ({
          selector: field.selector,
          success: true,
          attempts: 1,
        })),
        totalAttempts: options.fields.length,
      };
    },
  };
}

function arrange(declared: boolean) {
  const manager = new FakeTaskManager({ timer: new FakeTimer() });
  const form = new FieldByFieldForm();
  const handler = createSetUIStateHandler({ setUIStateFactory: () => form.executor });
  const execute = createTaskAwareToolCallExecutor({
    taskManager: manager,
    ownerKey: OWNER,
    eligibleTools: TASK_ELIGIBILITY,
    execute: async (received): Promise<McpToolCallResult> => {
      const response = await handler(
        device,
        received.args as SetUIStateArgs,
        undefined,
        received.extra.signal,
      );
      return { content: response.content, ...("isError" in response && { isError: true }) };
    },
  });
  const call: ToolCall<McpToolCallExtra> = {
    name: "setUIState",
    args: { ...ARGS },
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
  return { manager, form, execute, call };
}

async function settled(manager: FakeTaskManager, taskId: string) {
  for (let turn = 0; turn < 200; turn++) {
    const row = await manager.get(OWNER, taskId);
    if (row.status !== "working" && row.status !== "input_required") {
      return row;
    }
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

describe("setUIState as an MCP task (#18531)", () => {
  // beforeAll time is excluded from the per-test budget; this absorbs one-time module startup.
  beforeAll(async () => {
    const { manager, execute, call } = arrange(true);
    await settled(manager, taskIdOf(await execute(call)));
  });

  test("every setUIState call is task-eligible under abort, whatever its field count", () => {
    expect(TASK_ELIGIBILITY({ name: "setUIState", args: { fields: [ARGS.fields[0]] } })).toEqual({
      onCancel: "abort",
    });
    expect(TASK_ELIGIBILITY({ name: "setUIState", args: { ...ARGS } })).toEqual({
      onCancel: "abort",
    });
    expect(TASK_ELIGIBILITY({ name: "tapOn", args: {} })).toBeUndefined();
  });

  test("a non-declaring call stays synchronous and creates no task", async () => {
    const { manager, form, execute, call } = arrange(false);
    const result = await execute(call);
    expect("resultType" in result && result.resultType === "task").toBe(false);
    expect(form.applied).toEqual(["first", "last", "agree"]);
    expect(manager.calls).toEqual([]);
  });

  test("a declaring call gets a task that completes with the synchronous result", async () => {
    const sync = arrange(false);
    const syncResult = await sync.execute(sync.call);
    const { manager, form, execute, call } = arrange(true);
    const handle = await execute(call);
    expect(handle).toMatchObject({ resultType: "task", status: "working" });
    const done = await settled(manager, taskIdOf(handle));
    expect(done.status).toBe("completed");
    expect(done.result).toEqual(JSON.parse(JSON.stringify(syncResult)));
    expect(form.applied).toEqual(["first", "last", "agree"]);
  });

  test("tasks/cancel aborts the work signal and no further field is applied", async () => {
    const { manager, form, execute, call } = arrange(true);
    form.gated = true;
    const taskId = taskIdOf(await execute(call));
    await form.waitForGate();
    form.openNext();
    await form.waitForGate();
    expect(form.applied).toEqual(["first"]);
    expect(form.signals[0]?.aborted).toBe(false);

    await manager.cancel(OWNER, taskId);
    const done = await settled(manager, taskId);

    expect(done.status).toBe("cancelled");
    expect(form.signals[0]?.aborted).toBe(true);
    form.openNext();
    expect(form.applied).toEqual(["first"]);
  });
});
