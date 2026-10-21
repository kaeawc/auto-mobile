import type { Kysely, Transaction } from "kysely";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import type { SessionBrokerTiming } from "../../devices/sessionBrokerResult";
import type { SessionDeviceProfile } from "../../devices/sessionRequirements";
import type { Timer } from "../../utils/SystemTimer";
import type { BrokerRequestRecord, BrokerTimingSample } from "./store";
import { readRequest, readResource } from "./sqliteRecords";
import { parseTimingReceipt } from "./timingSchema";
import { destroyedResetTiming } from "./timingRecorder";

export class SqliteBrokerTimingStore {
  constructor(
    private readonly db: Kysely<BindingRegistryDatabase>,
    private readonly clock: Pick<Timer, "now">,
  ) {}

  async recordTiming(
    requestId: string,
    timing: SessionBrokerTiming,
    profile?: SessionDeviceProfile,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const request = await readRequest(trx, requestId);
      if (!request) {
        return;
      }
      if (
        timing.acquisition?.outcome === "failed" &&
        (request.state !== "failed" || request.timing?.acquisition?.outcome === "ready")
      ) {
        return;
      }
      const reset = await this.finalResetTiming(trx, request, timing.reset);
      await trx
        .updateTable("session_broker_requests")
        .set({
          timing_json: JSON.stringify({
            ...request.timing,
            ...timing,
            ...(reset ? { reset } : {}),
          }),
          ...(profile ? { timing_profile_json: JSON.stringify(profile) } : {}),
          timing_updated_at_ms: this.clock.now(),
        })
        .where("request_id", "=", requestId)
        .execute();
    });
  }

  private async finalResetTiming(
    trx: Transaction<BindingRegistryDatabase>,
    request: BrokerRequestRecord,
    timing: SessionBrokerTiming["reset"],
  ) {
    if (!timing || !request.resourceId) {
      return timing;
    }
    const resource = await readResource(trx, request.resourceId);
    return resource?.requestId === request.requestId && resource.state === "destroyed"
      ? destroyedResetTiming(timing, this.clock.now())
      : timing;
  }

  async timingSamples(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): Promise<BrokerTimingSample[]> {
    const rows = await this.db
      .selectFrom("session_broker_requests")
      .select(["timing_json", "timing_profile_json"])
      .where("timing_updated_at_ms", ">=", sinceMs)
      .where("timing_updated_at_ms", "<=", untilMs)
      .where("timing_json", "is not", null)
      .where("timing_profile_json", "is not", null)
      .orderBy("timing_updated_at_ms", "desc")
      .orderBy("request_id")
      .limit(limit)
      .execute();
    return rows.flatMap((row) => {
      const parsed = parseTimingReceipt(row.timing_json!, row.timing_profile_json);
      return parsed?.profile ? [{ timing: parsed.timing, profile: parsed.profile }] : [];
    });
  }

  async confirmDestroyed(
    trx: Transaction<BindingRegistryDatabase>,
    requestId: string | null,
  ): Promise<void> {
    if (!requestId) {
      return;
    }
    const request = await readRequest(trx, requestId);
    if (request?.timing?.reset && request.timing.reset.outcome !== "destroyed") {
      await trx
        .updateTable("session_broker_requests")
        .set({
          timing_json: JSON.stringify({
            ...request.timing,
            reset: destroyedResetTiming(request.timing.reset, this.clock.now()),
          }),
          timing_updated_at_ms: this.clock.now(),
        })
        .where("request_id", "=", request.requestId)
        .execute();
    }
  }
}
