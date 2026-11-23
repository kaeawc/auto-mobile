import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { raceWithDeadline } from "../../raceWithDeadline";
import { defaultTimer, type Timer } from "../../SystemTimer";
import type { GrpcAuthorizer } from "./emulatorGrpcAuth";
import { GrpcStatus, type GrpcStatusResult } from "./grpcFraming";
import type { GrpcCall, GrpcTransport } from "./grpcTransport";

export const STREAM_INPUT_EVENT_METHOD =
  "/android.emulation.control.EmulatorController/streamInputEvent";

/** How long the emulator gets to close the stream after the last event before the call fails. */
const STATUS_TIMEOUT_MS = 5_000;

/** One encoded `InputEvent` and the pause before the next one, so the guest sees a press last. */
export interface TimedInputEvent {
  message: Uint8Array;
  delayAfterMs: number;
}

/** Sends encoded `InputEvent`s on one emulator's client-streaming `streamInputEvent` RPC. */
export interface EmulatorInputEventSender {
  send(events: readonly TimedInputEvent[], signal?: AbortSignal): Promise<void>;
}

function rejected(status: GrpcStatusResult): ActionableError {
  const auth =
    status.code === GrpcStatus.PERMISSION_DENIED || status.code === GrpcStatus.UNAUTHENTICATED;
  return new ActionableError(
    `The emulator rejected streamInputEvent with gRPC status ${status.code}: ${status.message || "no message"}.` +
      (auth
        ? " The emulator's gRPC access list or token refused the call; restart the emulator with gRPC enabled on this host."
        : " Check that the emulator is still running and is version 35.4 or newer."),
  );
}

export class EmulatorInputEventClient implements EmulatorInputEventSender {
  constructor(
    private readonly transport: GrpcTransport,
    private readonly authorizer: GrpcAuthorizer,
    private readonly timer: Pick<Timer, "sleep" | "setTimeout" | "clearTimeout"> = defaultTimer,
  ) {}

  async send(events: readonly TimedInputEvent[], signal?: AbortSignal): Promise<void> {
    const authorization = await this.authorizer.authorization(STREAM_INPUT_EVENT_METHOD);
    const call = this.transport.open(
      STREAM_INPUT_EVENT_METHOD,
      authorization ? { authorization } : {},
    );
    try {
      await this.writeAll(call, events, signal);
    } catch (error) {
      call.cancel();
      signal?.throwIfAborted();
      // A server that closed the stream early reports why in its status.
      const status = await this.status(call);
      if (status.code !== GrpcStatus.OK && status.code !== GrpcStatus.CANCELLED) {
        throw rejected(status);
      }
      throw toActionableError(error, "Failed to stream XR input events to the emulator");
    }
    const status = await this.status(call);
    if (status.code !== GrpcStatus.OK) {
      throw rejected(status);
    }
  }

  private async writeAll(
    call: GrpcCall,
    events: readonly TimedInputEvent[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const event of events) {
      signal?.throwIfAborted();
      await call.write(event.message);
      if (event.delayAfterMs > 0) {
        await this.timer.sleep(event.delayAfterMs);
      }
    }
    call.end();
  }

  private status(call: GrpcCall): Promise<GrpcStatusResult> {
    return raceWithDeadline(call.status(), {
      timer: this.timer,
      timeoutMs: STATUS_TIMEOUT_MS,
      label: "Emulator streamInputEvent status",
      onTimeout: () => call.cancel(),
    });
  }
}
