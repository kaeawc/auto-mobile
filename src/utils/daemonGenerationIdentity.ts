export interface DaemonGenerationIdentity {
  pid: number;
  startedAt: number;
  processGenerationToken?: string;
  version: string;
  buildId: string;
  entryScript: string;
}
