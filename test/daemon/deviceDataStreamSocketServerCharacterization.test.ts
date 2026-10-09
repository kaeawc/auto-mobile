import { describe, expect, test } from "bun:test";
import {
  DeviceDataStreamSocketServer,
  type NavigationGraphStreamData,
} from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

const graph: NavigationGraphStreamData = {
  appId: "app",
  nodes: [],
  edges: [],
  currentScreen: null,
};

function setup(authorizationFails = false) {
  const authorizations: Array<{ sessionUuid?: string; deviceId?: string }> = [];
  const apps: Array<string | null | undefined> = [];
  const timer = new FakeTimer();
  timer.setCurrentTime(123);
  const server = new DeviceDataStreamSocketServer("/fake/data.sock", timer, {
    authorize: (request) => {
      authorizations.push(request);
      if (authorizationFails) {
        throw new Error("authorization failed");
      }
    },
  });
  server.setDeviceSessionResolver(new FakeDeviceSessionResolver().bind("device", "epoch"));
  server.setOnNavigationGraphRequested(async (appId) => {
    apps.push(appId);
    return graph;
  });
  const socket = new FakeSocket();
  const send = async (fields: Record<string, unknown>) => {
    await server.dispatchLineForTesting(
      socket,
      JSON.stringify({
        id: "navigation",
        command: "request_navigation_graph",
        sessionUuid: "session",
        ...fields,
      }),
    );
    return socket.getWrittenMessages<Record<string, unknown>>();
  };
  return { server, socket, send, authorizations, apps };
}

describe("navigation request dispatch characterization", () => {
  for (const deviceSessionUuid of [undefined, "epoch"]) {
    for (const appId of [undefined, "app"]) {
      test(`addresses ${deviceSessionUuid ?? "all devices"} with app ${appId ?? "omitted"}`, async () => {
        const { send, authorizations, apps } = setup();
        expect(await send({ deviceSessionUuid, appId })).toEqual([
          {
            id: "navigation",
            type: "navigation_update",
            deviceSessionUuid: deviceSessionUuid ?? null,
            ...(deviceSessionUuid ? { deviceId: "device" } : {}),
            timestamp: 123,
            navigationGraph: graph,
          },
        ]);
        expect(authorizations).toEqual([
          {
            sessionUuid: "session",
            deviceId: deviceSessionUuid ? "device" : undefined,
            // Reading the graph is watching, admitted on a held device too (#10830).
            admitViewer: true,
          },
        ]);
        expect(apps).toEqual([appId ?? null]);
      });
    }
  }

  for (const deviceSessionUuid of ["missing", "", 7]) {
    test(`rejects invalid epoch ${JSON.stringify(deviceSessionUuid)} before authorization`, async () => {
      const { send, authorizations, apps } = setup();
      expect(await send({ deviceSessionUuid })).toMatchObject([
        {
          id: "navigation",
          type: "error",
          success: false,
        },
      ]);
      expect(authorizations).toEqual([]);
      expect(apps).toEqual([]);
    });
  }

  test("reports authorization failure without invoking the graph provider", async () => {
    const { send, authorizations, apps } = setup(true);
    expect(await send({ deviceSessionUuid: "epoch" })).toMatchObject([
      {
        id: "navigation",
        type: "error",
        success: false,
        error: "authorization failed",
      },
    ]);
    expect(authorizations).toHaveLength(1);
    expect(apps).toEqual([]);
  });
});
