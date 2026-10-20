import { expect, test } from "bun:test";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "./FakePrototypeAgentClient";

test("default prototype agent capabilities are isolated between instances and from the defaults", () => {
  const agent = new FakePrototypeAgentClient();
  agent.handshake.capabilities.push("x");

  const nextAgent = new FakePrototypeAgentClient();
  expect(agent.handshake.capabilities).toContain("x");
  expect(nextAgent.handshake.capabilities).not.toContain("x");
  expect(FAKE_PROTOTYPE_AGENT_CAPABILITIES).not.toContain("x");
});
