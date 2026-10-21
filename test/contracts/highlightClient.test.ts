import { VisualHighlight } from "../../src/features/debug/VisualHighlight";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlightClient";
import type { HighlightOperationResult } from "../../src/models";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { runHighlightClientContract } from "./HighlightClientContract";

runHighlightClientContract("FakeHighlightClient", () => {
  const client = new FakeHighlightClient();
  return { client, failNext: (message) => client.failNext(message) };
});

runHighlightClientContract("VisualHighlightClient (scripted device-side client)", () => {
  let failure: string | undefined;
  const deviceClient = {
    requestAddHighlight: async (): Promise<HighlightOperationResult> => {
      const error = failure;
      failure = undefined;
      return error === undefined ? { success: true } : { success: false, error };
    },
  };
  const client = new VisualHighlightClient(
    new FakeDeviceReadiness(),
    (device) => new VisualHighlight(device, null, deviceClient),
  );
  return {
    client,
    failNext: (message) => {
      failure = message;
    },
  };
});
