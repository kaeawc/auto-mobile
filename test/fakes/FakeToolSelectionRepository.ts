import type { SessionToolSelectionRepository } from "../../src/features/toolSelection/SessionToolSelectionService";

type Entry = { toolName: string; enabled: boolean };
type Write = [string, string, boolean];

/** Captures the two existing batch views without changing their assertions. */
export class FakeToolSelectionRepository implements SessionToolSelectionRepository {
  readonly rows = new Map<string, Map<string, boolean>>();
  readonly singleWrites: Write[] = [];
  readonly writes: Write[] = [];
  readonly batches: Array<[string, ReadonlyArray<Entry>] | Write[]> = [];
  failBatchWith?: Error;
  failListWith?: Error;

  constructor(private readonly batchView: "service" | "server" = "service") {}

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    if (this.failListWith) {
      throw this.failListWith;
    }
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    const write: Write = [sessionUuid, toolName, enabled];
    this.singleWrites.push(write);
    this.writes.push(write);
    if (this.batchView === "server") {
      this.batches.push([write]);
    }
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    values.set(toolName, enabled);
    this.rows.set(sessionUuid, values);
  }

  async setMany(sessionUuid: string, entries: ReadonlyArray<Entry>): Promise<void> {
    if (this.failBatchWith) {
      throw this.failBatchWith;
    }
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    if (this.batchView === "service") {
      this.batches.push([sessionUuid, entries]);
    } else {
      const writes: Write[] = entries.map((entry) => [sessionUuid, entry.toolName, entry.enabled]);
      this.batches.push(writes);
      this.writes.push(...writes);
    }
    for (const entry of entries) {
      values.set(entry.toolName, entry.enabled);
    }
    this.rows.set(sessionUuid, values);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}
