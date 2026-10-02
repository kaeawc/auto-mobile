import { Socket } from "node:net";
import { TelemetryPushSocketServer } from "../../src/daemon/telemetryPushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";

import { streamSubscribeAuthCases } from "../helpers/streamSubscribeAuthCases";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";

class AuthTelemetryServer extends TelemetryPushSocketServer {
  private subscribed = 0;
  constructor(timer: FakeTimer, authenticator: StreamSocketAuthenticator) {
    super("/fake/telemetry.sock", timer, { authenticator });
  }
  receive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
  protected override onSubscribed(): void {
    this.subscribed++;
  }
  effects(): number {
    return this.subscribed;
  }
}
streamSubscribeAuthCases(
  "telemetry-push",
  (timer, authenticator) => new AuthTelemetryServer(timer, authenticator),
);
