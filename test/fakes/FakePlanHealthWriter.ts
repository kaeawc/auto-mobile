import type { PlanHealthWriter } from "../../src/server/filePlanHealthWriter";
import type { PlanHealthSummary } from "../../src/models/ExecutePlanResult";

export class FakePlanHealthWriter implements PlanHealthWriter {
  readonly written: PlanHealthSummary[] = [];

  async write(summary: PlanHealthSummary): Promise<void> {
    this.written.push(summary);
  }
}
