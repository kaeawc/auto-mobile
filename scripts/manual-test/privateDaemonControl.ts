import { runPrivateDaemonCommand, type PrivateDaemonCliDeps } from "./private-daemon";

/** Restart operations preserve the same batch namespace and identity-fenced stop implementation. */
export interface PrivateDaemonControl {
  stop(): Promise<void>;
  start(): Promise<void>;
  crash(): Promise<void>;
}
export function createPrivateDaemonControl(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
): PrivateDaemonControl {
  const run = async (op: "stop" | "start", crash = false): Promise<void> => {
    const code = await runPrivateDaemonCommand(
      { op, batchDir, daemon: 1, extraFlags: [], ...(crash ? { crash: true } : {}) },
      deps,
    );
    if (code !== 0) {
      throw new Error(`Private broker daemon ${crash ? "crash" : op} failed (exit ${code}).`);
    }
  };
  return { stop: () => run("stop"), start: () => run("start"), crash: () => run("stop", true) };
}
