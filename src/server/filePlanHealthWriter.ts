import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { PlanHealthSummary } from "../models/ExecutePlanResult";
import { createTimestampedId, defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/** Persists a summary; the production implementation writes JSON under a directory. */
export interface PlanHealthWriter {
  write(summary: PlanHealthSummary): Promise<void>;
}

export class FilePlanHealthWriter implements PlanHealthWriter {
  constructor(
    private readonly dir: string,
    private readonly timer: Pick<Timer, "now">,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}

  async write(summary: PlanHealthSummary): Promise<void> {
    try {
      await fsPromises.mkdir(this.dir, { recursive: true });
      const name = `${createTimestampedId("plan-health", this.timer, this.idGenerator)}.json`;
      await fsPromises.writeFile(path.join(this.dir, name), JSON.stringify(summary, null, 2));
    } catch (error) {
      // Diagnostics must never fail the plan; leave a trace and carry on.
      logger.warn(`Failed to write plan health summary to ${this.dir}: ${errorMessage(error)}`);
    }
  }
}
