import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type {
  Database,
  NewPredictionOutcome,
  NewPredictionTransitionStats,
  PredictionTransitionStats,
} from "./types";
import { normalizeToolArgs } from "../utils/predictionUtils";

export type PredictionErrorType = "wrong_screen" | "missing_elements" | "unexpected_elements";

export interface PredictionOutcomeRecord {
  appId: string;
  predictionId: string;
  timestamp: number;
  fromScreen: string;
  predictedScreen: string;
  actualScreen: string;
  toolName: string;
  toolArgs?: Record<string, any> | null;
  predictedElements: string[];
  foundElements: string[];
  confidence: number;
  matchScore: number;
  correct: boolean;
  partialMatch: boolean;
  errorType?: PredictionErrorType;
}

export interface TransitionKey {
  appId: string;
  fromScreen: string;
  toScreen: string;
  toolName: string;
  toolArgs?: Record<string, any> | null;
}

export class PredictionHistoryRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  private getDb(): Kysely<Database> {
    if (this.db) {
      return this.db;
    }
    return getDatabase();
  }

  async recordOutcome(outcome: PredictionOutcomeRecord): Promise<void> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const toolArgs = normalizeToolArgs(outcome.toolArgs ?? undefined);

    const record: NewPredictionOutcome = {
      app_id: outcome.appId,
      prediction_id: outcome.predictionId,
      timestamp: outcome.timestamp,
      from_screen: outcome.fromScreen,
      predicted_screen: outcome.predictedScreen,
      actual_screen: outcome.actualScreen,
      tool_name: outcome.toolName,
      tool_args: toolArgs,
      predicted_elements:
        outcome.predictedElements.length > 0 ? JSON.stringify(outcome.predictedElements) : null,
      found_elements:
        outcome.foundElements.length > 0 ? JSON.stringify(outcome.foundElements) : null,
      confidence: outcome.confidence,
      match_score: outcome.matchScore,
      correct: outcome.correct ? 1 : 0,
      partial_match: outcome.partialMatch ? 1 : 0,
      error_type: outcome.errorType ?? null,
      created_at: now,
    };

    await db.insertInto("prediction_outcomes").values(record).execute();

    await this.upsertTransitionStats(
      {
        appId: outcome.appId,
        fromScreen: outcome.fromScreen,
        toScreen: outcome.predictedScreen,
        toolName: outcome.toolName,
        toolArgs: outcome.toolArgs,
      },
      outcome.confidence,
      outcome.correct,
    );
  }

  async upsertTransitionStats(
    transition: TransitionKey,
    confidence: number,
    correct: boolean,
  ): Promise<PredictionTransitionStats> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const toolArgs = normalizeToolArgs(transition.toolArgs ?? undefined);
    const brier = Math.pow(confidence - (correct ? 1 : 0), 2);

    const successIncrement = correct ? 1 : 0;

    // Atomic upsert on UNIQUE(app_id, from_screen, to_screen, tool_name, tool_args)
    // (idx_prediction_transition_key). All four accumulators are incremented in SQL so
    // concurrent callers for the same transition key cannot lose increments or throw a
    // UNIQUE-constraint collision on a first insert (R2356). DO UPDATE (never DO NOTHING)
    // guarantees RETURNING yields the row on the conflict path.
    const newStats: NewPredictionTransitionStats = {
      app_id: transition.appId,
      from_screen: transition.fromScreen,
      to_screen: transition.toScreen,
      tool_name: transition.toolName,
      tool_args: toolArgs,
      attempts: 1,
      successes: successIncrement,
      total_confidence: confidence,
      brier_score_sum: brier,
      updated_at: now,
      created_at: now,
    };

    const result = await db
      .insertInto("prediction_transition_stats")
      .values(newStats)
      .onConflict((oc) =>
        oc
          .columns(["app_id", "from_screen", "to_screen", "tool_name", "tool_args"])
          .doUpdateSet((eb) => ({
            attempts: eb("prediction_transition_stats.attempts", "+", 1),
            successes: eb("prediction_transition_stats.successes", "+", successIncrement),
            total_confidence: eb("prediction_transition_stats.total_confidence", "+", confidence),
            brier_score_sum: eb("prediction_transition_stats.brier_score_sum", "+", brier),
            updated_at: now,
          })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  async getTransitionStatsForScreen(
    appId: string,
    fromScreen: string,
  ): Promise<PredictionTransitionStats[]> {
    const db = this.getDb();
    return db
      .selectFrom("prediction_transition_stats")
      .selectAll()
      .where("app_id", "=", appId)
      .where("from_screen", "=", fromScreen)
      .execute();
  }
}
