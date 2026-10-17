import { decodeCtrlProxyMessage } from "../../src/features/observe/ios/decodeCtrlProxyMessage";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { NetworkState } from "../../src/server/NetworkState";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createReplayWebSocketFactory,
  loadRecordedExchanges,
  type RecordedExchange,
} from "../fakes/ReplayCtrlProxyWebSocket";
import {
  runIOSCtrlProxyContract,
  type ContractRequest,
  type IosCtrlProxyHarness,
  type IosCtrlProxyReplies,
} from "./IOSCtrlProxyContract";
import path from "node:path";

// The `connected` handshake a real runner sent (the golden capture), so the client starts up as it does live.
const HANDSHAKES = loadRecordedExchanges(
  path.resolve(import.meta.dir, "../fixtures/ios/ctrlproxy-golden/settings-tap-general"),
).filter((exchange) => exchange.push?.type === "connected");

/** Request fields a caller chose; the rest (ids, deadlines) are transport detail. */
const ARGUMENTS: Record<string, readonly string[]> = {
  request_tap_coordinates: ["x", "y", "duration"],
  request_swipe: ["x1", "y1", "x2", "y2", "duration"],
  request_press_key: ["key", "modifiers"],
};

async function realHarness(replies: IosCtrlProxyReplies): Promise<IosCtrlProxyHarness> {
  IOSCtrlProxyClient.resetInstances();
  NetworkState.resetInstance();
  serverConfig.setNetworkMockableEnabled(false);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const exchanges: RecordedExchange[] = [
    ...HANDSHAKES,
    ...Object.entries(replies).map(([type, response], index) => ({
      fileName: `reply-${index}.json`,
      request: { type },
      response: response as Record<string, unknown>,
    })),
  ];
  const replay = createReplayWebSocketFactory(exchanges, timer);
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "contract-device", platform: "ios", name: "contract" },
    8791,
    replay.factory,
    timer,
  );
  return {
    proxy: client,
    requests: () =>
      replay.sockets
        .flatMap((socket) => socket.sentRequests)
        .map((request): ContractRequest => {
          const type = String(request.type);
          return {
            type,
            ...Object.fromEntries(
              (ARGUMENTS[type] ?? []).flatMap((key) =>
                key in request ? [[key, request[key]]] : [],
              ),
            ),
          };
        }),
    close: async () => {
      await client.close();
      NetworkState.resetInstance();
    },
  };
}

/** The fake takes the very result the real client decodes from the same captured reply. */
async function fakeHarness(replies: IosCtrlProxyReplies): Promise<IosCtrlProxyHarness> {
  const proxy = new FakeIOSCtrlProxy();
  for (const [type, wire] of Object.entries(replies)) {
    const decoded = decodeCtrlProxyMessage({ ...wire, requestId: "contract" });
    const result = decoded && "result" in decoded ? decoded.result : undefined;
    const failure =
      decoded && "errorMessage" in decoded
        ? { success: false, error: decoded.errorMessage }
        : undefined;
    const outcome = (result ?? failure) as never;
    if (type === "request_tap_coordinates") {
      proxy.setTapResult(outcome);
    } else if (type === "request_swipe") {
      proxy.setSwipeResult(outcome);
    } else if (type === "request_press_key") {
      proxy.setPressKeyResult(outcome);
    } else if (type === "request_press_home") {
      proxy.setPressHomeResult(outcome);
    } else if (type === "request_press_back") {
      proxy.setPressBackResult(outcome);
    }
  }
  return {
    proxy,
    requests: () => proxy.getRequestLog().map((request) => ({ ...request })),
    close: async () => {},
  };
}

runIOSCtrlProxyContract("IOSCtrlProxyClient (replayed runner capture)", realHarness);
runIOSCtrlProxyContract("FakeIOSCtrlProxy", fakeHarness);
