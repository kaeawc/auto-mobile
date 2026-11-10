import { describe, expect, test } from "bun:test";
import * as realManager from "../../src/daemon/webrtcStreamManager";
import {
  WebRtcStreamSocketServer,
  type WebRtcStreamManagerModule,
} from "../../src/daemon/webrtcStreamSocketServer";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "../../src/daemon/webrtcStreamSocketTypes";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import { permissiveDeviceAdmissionGate } from "../../src/utils/deviceAdmissionGate";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { LAZY_IMPORT_FAILURE, recoveringLazyModule } from "../helpers/recoveringLazyModule";

const allowAll: StreamSocketAuthenticator = { authorize: () => {} };

class TestableServer extends WebRtcStreamSocketServer {
  async simulate(
    socket: FakeSocket<WebRtcStreamSocketResponse>,
    request: WebRtcStreamSocketRequest,
  ): Promise<void> {
    await this.processLine(socket, JSON.stringify(request));
    await this.pendingBySocket.get(socket);
  }
}

describe("WebRTC stream manager import failure (#17721)", () => {
  test("a request answers the load error and the next one loads the manager", async () => {
    // The real manager's exports, with a stream list that touches no shared manager state.
    const manager: WebRtcStreamManagerModule = { ...realManager, listWebRtcStreams: () => [] };
    const lazy = recoveringLazyModule("WebRTC", () => manager);
    const server = new TestableServer("/fake/webrtc-stream.sock", new FakeTimer(), undefined, {
      authenticator: allowAll,
      admissionGate: permissiveDeviceAdmissionGate,
      managerModule: lazy.module,
    });
    const socket = new FakeSocket<WebRtcStreamSocketResponse>();

    await server.simulate(socket, { action: "list", id: "first" });
    expect(socket.responses).toEqual([
      {
        id: "first",
        success: false,
        type: "webrtc_stream_response",
        error: `Failed to load the WebRTC module: ${LAZY_IMPORT_FAILURE}`,
      },
    ]);

    lazy.recover();
    await server.simulate(socket, { action: "list", id: "second" });
    expect(socket.responses[1]).toMatchObject({ id: "second", success: true, streams: [] });
    expect(lazy.attempts()).toBe(2);
  });
});
