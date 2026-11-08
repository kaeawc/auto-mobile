import { z } from "zod/v4";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { SimulatorHighlights } from "./SimulatorHighlights";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  ActionableError,
  BootedDevice,
  HighlightBounds,
  HighlightOperationResult,
  HighlightShape,
} from "../../models";

const DEFAULT_HIGHLIGHT_TIMEOUT_MS = 5000;

export interface HighlightDeviceClient {
  /** The device reply is untrusted wire data: `VisualHighlight` validates it against a schema. */
  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<unknown>;
}

const normalizeNullableNumber = (value: number | null | undefined): number | undefined =>
  value === null ? undefined : value;

const highlightBoundsFields = {
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive("bounds.width must be a positive integer"),
  height: z.number().int().positive("bounds.height must be a positive integer"),
  sourceWidth: z.number().int().positive().nullable().optional(),
  sourceHeight: z.number().int().positive().nullable().optional(),
};

const refineSourceDimensions = (
  value: Pick<HighlightBounds, "sourceWidth" | "sourceHeight" | "sourceScale">,
  ctx: z.RefinementCtx,
): void => {
  const hasSourceWidth = normalizeNullableNumber(value.sourceWidth) !== undefined;
  const hasSourceHeight = normalizeNullableNumber(value.sourceHeight) !== undefined;

  if (hasSourceWidth !== hasSourceHeight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounds.sourceWidth and bounds.sourceHeight must be provided together",
    });
  }
  if (normalizeNullableNumber(value.sourceScale) !== undefined && !hasSourceWidth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounds.sourceScale requires bounds.sourceWidth and bounds.sourceHeight",
    });
  }
};

const shapeSchemaFor = (bounds: z.ZodType<HighlightBounds>): z.ZodType<HighlightShape> =>
  z.object({ type: z.literal("circle"), bounds }).strict();

/** The `highlight` tool's caller-facing shape: the daemon, not the caller, supplies the scale. */
export const highlightShapeSchema = shapeSchemaFor(
  z.object(highlightBoundsFields).strict().superRefine(refineSourceDimensions),
);

/** A shape the daemon sends to a device: the tool shape plus the daemon-resolved `sourceScale`. */
export const deviceHighlightShapeSchema = shapeSchemaFor(
  z
    .object({
      ...highlightBoundsFields,
      sourceScale: z.number().finite().positive().nullable().optional(),
    })
    .strict()
    .superRefine(refineSourceDimensions),
);

const highlightResponseSchema: z.ZodType<HighlightOperationResult> = z
  .object({
    success: z.boolean(),
    error: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

interface HighlightOperationOptions {
  timeoutMs?: number;
}

export class VisualHighlight {
  private device: BootedDevice;
  private adbFactory: AdbClientFactory;
  private highlightClient: HighlightDeviceClient;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    highlightClient?: HighlightDeviceClient,
  ) {
    this.device = device;
    // Detect if the argument is a factory (has create method) or an executor
    if (device.platform === "ios") {
      this.adbFactory = defaultAdbClientFactory;
    } else if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adbFactory = adbFactoryOrExecutor as AdbClientFactory;
    } else if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies
      const executor = adbFactoryOrExecutor as AdbExecutor;
      this.adbFactory = { create: () => executor };
    } else {
      this.adbFactory = defaultAdbClientFactory;
    }
    this.highlightClient = highlightClient || this.createDefaultHighlightClient(device);
  }

  async addHighlight(
    id: string,
    shape: HighlightShape,
    options: HighlightOperationOptions = {},
  ): Promise<HighlightOperationResult> {
    const highlightId = this.parseHighlightId(id);
    const highlightShape = this.parseHighlightShape(shape);
    const timeoutMs = options.timeoutMs ?? DEFAULT_HIGHLIGHT_TIMEOUT_MS;
    const response = await this.highlightClient.requestAddHighlight(
      highlightId,
      highlightShape,
      timeoutMs,
      new NoOpPerformanceTracker(),
    );
    return this.parseHighlightResponse(response);
  }

  private parseHighlightId(id: string): string {
    const result = z.string().min(1, "Highlight id must be a non-empty string").safeParse(id);
    if (!result.success) {
      throw new ActionableError(result.error.issues.map((issue) => issue.message).join("; "));
    }
    return result.data;
  }

  private parseHighlightShape(shape: HighlightShape): HighlightShape {
    const result = deviceHighlightShapeSchema.safeParse(shape);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join("; ");
      throw new ActionableError(message);
    }
    return result.data;
  }

  private parseHighlightResponse(response: unknown): HighlightOperationResult {
    const result = highlightResponseSchema.safeParse(response);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join("; ");
      throw new ActionableError(`Invalid highlight response: ${message}`);
    }
    return result.data;
  }

  private createDefaultHighlightClient(device: BootedDevice): HighlightDeviceClient {
    if (device.platform === "android") {
      return AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    }
    if (device.platform === "ios") {
      if (resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator") {
        return new SimulatorHighlights(device);
      }
      return IOSCtrlProxyClient.getInstance(device);
    }
    throw new ActionableError(`Visual highlights are not supported on ${device.platform} devices.`);
  }
}
