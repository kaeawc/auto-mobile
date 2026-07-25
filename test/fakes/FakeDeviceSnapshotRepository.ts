import type {
  DeviceSnapshotQuery,
  DeviceSnapshotRecord,
} from "../../src/db/deviceSnapshotRepository";

export class FakeDeviceSnapshotRepository {
  private readonly records = new Map<string, DeviceSnapshotRecord>();

  async insertSnapshot(record: DeviceSnapshotRecord): Promise<void> {
    // Mirror the real upsert: an overwrite preserves the original created_at (#3498).
    const existing = this.records.get(record.snapshotName);
    this.records.set(record.snapshotName, {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
    });
  }

  async updateSnapshot(
    snapshotName: string,
    update: Partial<DeviceSnapshotRecord>
  ): Promise<void> {
    const existing = this.records.get(snapshotName);
    if (!existing) {
      return;
    }
    const updated = { ...existing };
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        (updated as Record<string, unknown>)[key] = value;
      }
    }
    this.records.set(snapshotName, updated);
  }

  async getSnapshot(snapshotName: string): Promise<DeviceSnapshotRecord | null> {
    return this.records.get(snapshotName) ?? null;
  }

  async listSnapshots(query: DeviceSnapshotQuery = {}): Promise<DeviceSnapshotRecord[]> {
    let results = Array.from(this.records.values());

    if (query.deviceId) {
      results = results.filter(record => record.deviceId === query.deviceId);
    }
    if (query.platform) {
      results = results.filter(record => record.platform === query.platform);
    }
    if (query.snapshotType) {
      results = results.filter(record => record.snapshotType === query.snapshotType);
    }
    // Mirror the real SQL, which emits the ORDER BY clauses in the same order the
    // repository adds them: last_accessed_at FIRST (primary), created_at SECOND
    // (tie-break). Applying two SEPARATE stable sorts inverts that precedence —
    // the last sort wins — so a single combined comparator is required (#4186).
    const comparators: Array<(record: DeviceSnapshotRecord) => number> = [];
    if (query.orderByLastAccessed) {
      const sign = query.orderByLastAccessed === "asc" ? 1 : -1;
      comparators.push(record => Date.parse(record.lastAccessedAt) * sign);
    }
    if (query.orderByCreatedAt) {
      const sign = query.orderByCreatedAt === "asc" ? 1 : -1;
      comparators.push(record => Date.parse(record.createdAt) * sign);
    }
    if (comparators.length > 0) {
      results.sort((left, right) => {
        for (const key of comparators) {
          const delta = key(left) - key(right);
          if (delta !== 0) {
            return delta;
          }
        }
        return 0;
      });
    }
    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async touchSnapshot(snapshotName: string, timestamp: string): Promise<void> {
    await this.updateSnapshot(snapshotName, { lastAccessedAt: timestamp });
  }

  async deleteSnapshot(snapshotName: string): Promise<boolean> {
    return this.records.delete(snapshotName);
  }
}
