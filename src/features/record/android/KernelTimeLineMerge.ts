import type { Timer } from "../../../utils/SystemTimer";
import { KernelTimeReorderBuffer } from "./KernelTimeReorderBuffer";

type LineHandler = (line: string, arrivedAt: number) => void;

export interface KernelTimeLineMergeScope {
  register(nodeKey: string, handler: LineHandler): () => void;
  push(nodeKey: string, line: string, arrivedAt: number): void;
}

/** One recording's kernel-time ordering across independently managed node readers. */
export class KernelTimeLineMerge implements KernelTimeLineMergeScope {
  private readonly handlers = new Map<string, LineHandler>();
  private readonly buffer: KernelTimeReorderBuffer;

  constructor(opts: { timer: Timer; windowMs?: number }) {
    this.buffer = new KernelTimeReorderBuffer({
      ...opts,
      onLine: ({ nodeKey, line, arrivedAt }) => this.handlers.get(nodeKey)?.(line, arrivedAt),
    });
  }

  register(nodeKey: string, handler: LineHandler): () => void {
    this.buffer.dropNode(nodeKey);
    // A unique wrapper keeps an old unregister from removing a newer registration.
    const registered: LineHandler = (line, arrivedAt) => handler(line, arrivedAt);
    this.handlers.set(nodeKey, registered);
    return () => {
      if (this.handlers.get(nodeKey) !== registered) {
        return;
      }
      this.handlers.delete(nodeKey);
      this.buffer.dropNode(nodeKey);
      if (this.handlers.size === 0) {
        this.buffer.clear();
      }
    };
  }

  push(nodeKey: string, line: string, arrivedAt: number): void {
    if (this.handlers.has(nodeKey)) {
      this.buffer.push(nodeKey, line, arrivedAt);
    }
  }
}
