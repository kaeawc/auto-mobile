import type {
  BrokerScenario,
  BrokerScenarioContext,
} from "../../scripts/manual-test/brokerScenarios";
import { renderClientRequest } from "../../scripts/manual-test/brokerBatch";
import { BrokerDeviceLedger } from "../../scripts/manual-test/brokerDeviceLedger";
import { createFakeBrokerDaemon } from "./fakeBrokerDaemon";

/** Each fake run has its own host and in-memory ledger, never the device batch's ledger. */
export async function createFakeBrokerScenarioContext(
  scenario: BrokerScenario,
  batchDir: string,
  evidence: BrokerScenarioContext["fs"],
) {
  const host = await createFakeBrokerDaemon({ capacity: scenario.capacity });
  const files = new Map<string, string>();
  const fs = {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path) ?? "",
    mkdir: () => {},
    appendFile: (path: string, text: string) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
  };
  const clients = Array.from({ length: scenario.capacity + 1 }, (_, index) => ({
    name: `client-${index + 1}`,
    config: renderClientRequest({ name: `client-${index + 1}`, platform: "ios" }, host.ids.next()),
    token: `private-token-${host.ids.next()}`,
  }));
  const ledger = new BrokerDeviceLedger({
    batchDir,
    fs,
    timer: host.timer,
    tokenFor: (name) => clients.find((c) => c.name === name)?.token ?? "",
  });
  const context: BrokerScenarioContext = {
    batchDir,
    clients,
    daemonClient: host.client,
    prepare: host.prepare,
    ledger,
    timer: host.timer,
    ids: host.ids,
    fs: evidence,
    fake: host.controls,
    preflight: async () => false,
    probe: async () => false,
    record: async (_operation, _request, action) => action(),
  };
  return { host, context, close: host.close };
}
