import { z } from "zod";
import { daemonOptionsSchema } from "./client";
import { AUXILIARY_SOCKET_CONFIGS_BY_NAME } from "./daemonFiles";
import type { DaemonStatus, PidFileData } from "./types";

/** Stronger than legacy discovery: mutation requires a complete generation tuple. */
export const recoveryOwnerSchema = z.object({
  running: z.literal(true),
  pid: z.number().int().positive(),
  startedAt: z.number().positive(),
  processStartedAt: z.number().positive().optional(),
  processGenerationToken: z.string().min(1).optional(),
  version: z.string().min(1),
  buildId: z.string().min(1),
  entryScript: z.string().min(1),
  socketPath: z.string().min(1),
});

export const republishResultSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});

const completeRecordSchema = recoveryOwnerSchema.omit({ running: true }).extend({
  port: z.number().int().positive(),
  dbPath: z.string().min(1),
  daemonSessionId: z.string().min(1),
  launchLogPath: z.string().nullable(),
  options: daemonOptionsSchema,
  sockets: z.record(z.string(), z.string().min(1)),
});

/** Acknowledgement alone is insufficient: verify the daemon-owned complete record. */
export function isCompleteRecoveryRecord(record: PidFileData | null): record is PidFileData {
  const parsed = completeRecordSchema.safeParse(record);
  if (!parsed.success) {
    return false;
  }
  const { sockets, socketPath } = parsed.data;
  return (
    sockets.control === socketPath &&
    Object.keys(AUXILIARY_SOCKET_CONFIGS_BY_NAME).every((name) => typeof sockets[name] === "string")
  );
}

export interface IdentityRecoveryIO {
  socketExists(): boolean;
  readRecord(): PidFileData | null;
  probe(): Promise<DaemonStatus>;
}

export interface IdentityPublisherIO {
  readRecord(): PidFileData | null;
  writeRecord(): Promise<void>;
  isProcessRunning(pid: number): boolean;
}

/** The incumbent owns the complete writer; callers never reconstruct its PID record. */
export async function republishOwnedIdentity(
  ready: boolean,
  owner: Pick<PidFileData, "pid" | "startedAt" | "processGenerationToken">,
  io: IdentityPublisherIO,
): Promise<boolean> {
  if (!ready) {
    return false;
  }
  const record = io.readRecord();
  if (
    isCompleteRecoveryRecord(record) &&
    record.pid === owner.pid &&
    record.startedAt === owner.startedAt &&
    record.processGenerationToken === owner.processGenerationToken
  ) {
    return true;
  }
  // Preserve another live contender's early owner record while its bind settles.
  if (record && record.pid !== owner.pid && io.isProcessRunning(record.pid)) {
    return false;
  }
  await io.writeRecord();
  return true;
}
