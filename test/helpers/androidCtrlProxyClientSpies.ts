/**
 * Typed seam for substituting the Android CtrlProxy client in tests; the Android
 * counterpart of {@link ./iosCtrlProxyClientSpies}.
 *
 * The substitute is a real {@link AndroidCtrlProxyClient} built through its
 * `createForTesting` factory with a fake adb executor, and only the request methods a
 * test cares about are replaced. Nothing is cast: the spied methods keep the class's own
 * signatures (#11863).
 */

import { spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

/** The client methods the daemon input suites replace; each keeps the real signature. */
export interface AndroidClientOverrides {
  requestSetText?: AndroidCtrlProxyClient["requestSetText"];
  requestImeAction?: AndroidCtrlProxyClient["requestImeAction"];
  validateFrameContext?: AndroidCtrlProxyClient["validateFrameContext"];
  requestTapCoordinates?: AndroidCtrlProxyClient["requestTapCoordinates"];
  getScreenScaleMetadata?: AndroidCtrlProxyClient["getScreenScaleMetadata"];
}

/** A real client over a fake adb executor, with the given methods replaced. */
export function createAndroidTestClient(
  device: BootedDevice,
  overrides: AndroidClientOverrides = {},
): AndroidCtrlProxyClient {
  const client = AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor());
  if (overrides.requestSetText) {
    spyOn(client, "requestSetText").mockImplementation(overrides.requestSetText);
  }
  if (overrides.requestImeAction) {
    spyOn(client, "requestImeAction").mockImplementation(overrides.requestImeAction);
  }
  if (overrides.validateFrameContext) {
    spyOn(client, "validateFrameContext").mockImplementation(overrides.validateFrameContext);
  }
  if (overrides.requestTapCoordinates) {
    spyOn(client, "requestTapCoordinates").mockImplementation(overrides.requestTapCoordinates);
  }
  if (overrides.getScreenScaleMetadata) {
    spyOn(client, "getScreenScaleMetadata").mockImplementation(overrides.getScreenScaleMetadata);
  }
  return client;
}

/** Make `AndroidCtrlProxyClient.getInstance` return a test client until the spy is restored. */
export function spyOnAndroidClientInstance(
  device: BootedDevice,
  overrides: AndroidClientOverrides = {},
) {
  return spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    createAndroidTestClient(device, overrides),
  );
}
