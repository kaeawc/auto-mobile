import type { BrokerProvisionRequest } from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
/** Build the broker request directly; launch parsing was removed with managed slots. */
export function buildBrokerProvisionRequest(
  config: BrokerProvisionRequest,
): BrokerProvisionRequest {
  return config;
}
