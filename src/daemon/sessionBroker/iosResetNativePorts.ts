import { realpath, rm } from "node:fs/promises";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyHealthClient } from "../../ctrlProxy/ios/IosCtrlProxyHealthClient";
import {
  createExitTracker,
  waitForExit,
  ProcessTeardownUnconfirmedError,
} from "../../utils/ChildProcessTracker";
import { errorMessage } from "../../utils/describeUnknownError";
import type { SimCtl, SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { SimulatorTccSqliteClient } from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import type { Timer } from "../../utils/SystemTimer";
import type { IosResetHealthPort } from "./iosKeepBootedReset";
import { IosDeviceMutationResetPort } from "./mutations/iosResetPort";

export function nativeIosMutationResetPort(
  simctl: Pick<SimCtl, "executeCommandArgs" | "startCommandArgs"> &
    Pick<SimCtlClient, "listAppsOrThrow">,
  timer: Timer,
): IosDeviceMutationResetPort {
  const pending = new Set<string>();
  return new IosDeviceMutationResetPort(
    {
      simctl,
      privacyGrants: new SimulatorTccSqliteClient({ timer }),
      files: { realpath, remove: (path) => rm(path, { recursive: true, force: false }) },
      pasteboard: {
        assertSettled: (deviceId) => {
          if (pending.has(deviceId)) {
            throw toActionableError(
              new DOMException("iOS pasteboard child teardown remains unconfirmed", "TimeoutError"),
              "Cannot redrive iOS reset",
            );
          }
        },
        write: async (deviceId, text, signal) => {
          signal.throwIfAborted();
          const child = await simctl.startCommandArgs(["pbcopy", deviceId], {
            stdio: ["pipe", "ignore", "pipe"],
          });
          const tracker = createExitTracker(child, []);
          pending.add(deviceId);
          child.once("exit", () => pending.delete(deviceId));
          const abort = () => {
            child.kill("SIGTERM");
          };
          const stdinError = (error: Error) => {
            abort();
            failure = error;
          };
          let failure: Error | undefined;
          signal.addEventListener("abort", abort, { once: true });
          child.stdin?.on("error", stdinError);
          try {
            if (signal.aborted || !child.stdin) {
              abort();
            } else {
              child.stdin.end(text);
            }
            await waitForExit(child, tracker.exitPromise, {
              timer,
              signal: null,
              timeoutMs: 10_000,
              forceKillTimeoutMs: 1_000,
            });
            signal.throwIfAborted();
            if (failure || !child.stdin || tracker.exitState.exitCode !== 0) {
              throw new ActionableError("iOS reset could not restore the pasteboard", {
                cause: failure,
              });
            }
          } catch (error) {
            if (error instanceof ProcessTeardownUnconfirmedError) {
              throw toActionableError(
                new DOMException(errorMessage(error), "TimeoutError"),
                "iOS pasteboard teardown remains unconfirmed",
              );
            }
            throw toActionableError(error, "iOS reset pasteboard command failed");
          } finally {
            if (
              [child.exitCode !== null, child.signalCode !== null, child.pid === undefined].some(
                Boolean,
              )
            ) {
              pending.delete(deviceId);
            }
            signal.removeEventListener("abort", abort);
            child.stdin?.off("error", stdinError);
          }
        },
      },
    },
    timer,
  );
}

export function nativeIosResetHealth(timer: Timer): IosResetHealthPort {
  return {
    probe: async (device, signal) => {
      const manager = IOSCtrlProxyManager.registry.peek(device.deviceId);
      if (!manager) {
        return false;
      }
      const client = new IosCtrlProxyHealthClient(undefined, timer, {
        deviceId: device.deviceId,
        useRemoteRunner: () => false,
        getHost: () => "127.0.0.1",
      });
      return client.checkHealthEndpointOnPortForDevice(
        manager.getServicePort(),
        device.deviceId,
        5_000,
        { signal, requireDeviceId: true },
      );
    },
  };
}
