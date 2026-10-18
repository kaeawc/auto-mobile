import {
  connectPrototypeAgent,
  PROTOTYPE_AGENT_PROTOCOL_VERSION,
} from "../../src/features/prototype/ios/prototypeAgentClient";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../fakes/FakePrototypeAgentSocket";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  CONTRACT_AGENT_CAPABILITIES,
  runPrototypeAgentClientContract,
  type PrototypeAgentClientContractHarness,
} from "./PrototypeAgentClientContract";

/** Agent end of the socket: answers the hello and then every request from a reply queue. */
class ScriptedAgentSocket extends FakePrototypeAgentSocket {
  readonly replies: Array<Record<string, unknown>> = [];

  override write(data: string): void {
    super.write(data);
    for (const line of data.split("\n").filter((entry) => entry.length > 0)) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === "hello") {
        this.push({
          type: "hello_result",
          agentVersion: "contract-agent",
          protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
          capabilities: CONTRACT_AGENT_CAPABILITIES,
        });
      } else {
        this.push({
          type: "prototype_result",
          success: true,
          ...this.replies.shift(),
          requestId: frame.requestId,
        });
      }
    }
  }
}

runPrototypeAgentClientContract("socket client over a scripted agent", async () => {
  const socket = new ScriptedAgentSocket();
  const client = await connectPrototypeAgent({
    port: 4040,
    token: "contract-token",
    connector: new FakePrototypeAgentConnector(socket),
    timer: new FakeTimer(),
  });
  const harness: PrototypeAgentClientContractHarness = {
    client,
    answerNext: (reply) => void socket.replies.push(reply),
    pushEvent: (event) => socket.push(event),
    disconnect: () => socket.closeFromAgent(),
  };
  return harness;
});

runPrototypeAgentClientContract("FakePrototypeAgentClient", async () => {
  const fake = new FakePrototypeAgentClient({
    agentVersion: "contract-agent",
    protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
    capabilities: CONTRACT_AGENT_CAPABILITIES,
  });
  const harness: PrototypeAgentClientContractHarness = {
    client: fake,
    answerNext: (reply) => fake.queueReplies(reply),
    pushEvent: (event) => fake.emit(event),
    disconnect: () => fake.close(),
  };
  return harness;
});
