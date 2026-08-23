import { z } from "zod/v4";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DeviceSessionManager } from "../../utils/DeviceSessionManager";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  ActionableError,
  BootedDevice,
  HighlightBounds,
  HighlightOperationResult,
  HighlightShape,
  HighlightStyle,
  Platform,
} from "../../models";

const DEFAULT_HIGHLIGHT_TIMEOUT_MS = 5000;

export interface HighlightDeviceClient {
  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult>;
}

const normalizeNullableNumber = (value: number | null | undefined): number | undefined =>
  value === null ? undefined : value;

const normalizeNullableString = (value: string | null | undefined): string | undefined =>
  value === null ? undefined : value;

const highlightBoundsSchema: z.ZodType<HighlightBounds> = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive("bounds.width must be a positive integer"),
    height: z.number().int().positive("bounds.height must be a positive integer"),
    sourceWidth: z.number().int().positive().nullable().optional(),
    sourceHeight: z.number().int().positive().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const sourceWidth = normalizeNullableNumber(value.sourceWidth);
    const sourceHeight = normalizeNullableNumber(value.sourceHeight);
    const hasSourceWidth = sourceWidth !== undefined;
    const hasSourceHeight = sourceHeight !== undefined;

    if (hasSourceWidth !== hasSourceHeight) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bounds.sourceWidth and bounds.sourceHeight must be provided together",
      });
    }
  });

const highlightStyleSchema: z.ZodType<HighlightStyle> = z
  .object({
    strokeColor: z.string().min(1).nullable().optional(),
    strokeWidth: z.number().positive().nullable().optional(),
    dashPattern: z.array(z.number().positive()).nonempty().nullable().optional(),
    smoothing: z.enum(["none", "catmull-rom", "bezier", "douglas-peucker"]).nullable().optional(),
    tension: z.number().min(0).max(1).nullable().optional(),
    capStyle: z.enum(["butt", "round", "square"]).nullable().optional(),
    joinStyle: z.enum(["miter", "round", "bevel"]).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const strokeColor = normalizeNullableString(value.strokeColor);
    const strokeWidth = normalizeNullableNumber(value.strokeWidth);
    const dashPattern = value.dashPattern ?? undefined;
    const smoothing = value.smoothing ?? undefined;
    const tension = normalizeNullableNumber(value.tension);
    const capStyle = value.capStyle ?? undefined;
    const joinStyle = value.joinStyle ?? undefined;

    const hasStroke =
      strokeColor !== undefined ||
      strokeWidth !== undefined ||
      dashPattern !== undefined ||
      smoothing !== undefined ||
      tension !== undefined ||
      capStyle !== undefined ||
      joinStyle !== undefined;

    if (!hasStroke) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Highlight style must include stroke settings",
      });
    }
  });

const highlightPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const highlightBoxShapeSchema = z.object({
  type: z.literal("box"),
  bounds: highlightBoundsSchema,
  style: highlightStyleSchema.nullable().optional(),
});

const highlightCircleShapeSchema = z.object({
  type: z.literal("circle"),
  bounds: highlightBoundsSchema,
  style: highlightStyleSchema.nullable().optional(),
});

const highlightPathShapeSchema = z.object({
  type: z.literal("path"),
  points: z.array(highlightPointSchema).min(2),
  bounds: highlightBoundsSchema.nullable().optional(),
  style: highlightStyleSchema.nullable().optional(),
});

export const highlightShapeSchema: z.ZodType<HighlightShape> = z.discriminatedUnion("type", [
  highlightBoxShapeSchema,
  highlightCircleShapeSchema,
  highlightPathShapeSchema,
]);

const highlightResponseSchema: z.ZodType<HighlightOperationResult> = z
  .object({
    success: z.boolean(),
    error: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

export interface HighlightOptions {
  deviceId?: string;
  platform: Platform;
  device?: BootedDevice;
  sessionUuid?: string;
  timeoutMs?: number;
}

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
    const result = highlightShapeSchema.safeParse(shape);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join("; ");
      throw new ActionableError(message);
    }
    return result.data;
  }

  private parseHighlightResponse(response: HighlightOperationResult): HighlightOperationResult {
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
      return IOSCtrlProxyClient.getInstance(device);
    }
    throw new ActionableError(`Visual highlights are not supported on ${device.platform} devices.`);
  }
}

export class VisualHighlightClient {
  private readonly deviceSessionManager: DeviceSessionManager;
  private readonly visualHighlightFactory: (device: BootedDevice) => VisualHighlight;

  constructor(
    deviceSessionManager: DeviceSessionManager = DeviceSessionManager.getInstance(),
    visualHighlightFactory: (device: BootedDevice) => VisualHighlight = (device) =>
      new VisualHighlight(device),
  ) {
    this.deviceSessionManager = deviceSessionManager;
    this.visualHighlightFactory = visualHighlightFactory;
  }

  async addHighlight(
    id: string,
    shape: HighlightShape,
    options: HighlightOptions,
  ): Promise<HighlightOperationResult> {
    const highlight = await this.resolveHighlight(options);
    const result = await highlight.addHighlight(id, shape, { timeoutMs: options.timeoutMs });
    if (!result.success) {
      throw new ActionableError(result.error || "Failed to add highlight");
    }
    return result;
  }

  private async resolveHighlight(options: HighlightOptions): Promise<VisualHighlight> {
    if (options.device) {
      if (options.device.platform !== options.platform) {
        throw new ActionableError(
          `Highlight platform mismatch: requested ${options.platform}, device is ${options.device.platform}.`,
        );
      }
      return this.visualHighlightFactory(options.device);
    }

    if (options.platform !== "android" && options.platform !== "ios") {
      throw new ActionableError(
        `Visual highlights are not supported on ${options.platform} devices.`,
      );
    }
    const device = await this.deviceSessionManager.ensureDeviceReady(
      options.platform,
      options.deviceId,
    );
    return this.visualHighlightFactory(device);
  }
}
