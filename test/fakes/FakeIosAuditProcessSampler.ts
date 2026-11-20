import type { IosAuditProcessSampler } from "../../src/features/audit/IosOnDemandAuditEngines";

export class FakeIosAuditProcessSampler implements IosAuditProcessSampler {
  readonly resolvedApps: string[] = [];
  readonly sampledPids: number[] = [];

  constructor(
    private readonly pids: (number | null)[] = [],
    private readonly rssValues: (number | null)[] = [],
  ) {}

  async resolvePid(appId: string): Promise<number | null> {
    this.resolvedApps.push(appId);
    return this.pids.shift() ?? null;
  }

  async readRssKiB(pid: number): Promise<number | null> {
    this.sampledPids.push(pid);
    return this.rssValues.shift() ?? null;
  }
}
