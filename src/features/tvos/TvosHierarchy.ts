import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import { convertToViewHierarchyResult } from "../observe/ios/IosHierarchyConverter";
import type { XCTestHierarchy } from "../observe/ios/types";

const nodeSchema = z.object({
  className: z.string(),
  bounds: z.object({
    left: z.number().finite(),
    top: z.number().finite(),
    right: z.number().finite(),
    bottom: z.number().finite(),
  }),
  text: z.string().optional(),
  "resource-id": z.string().optional(),
  enabled: z.enum(["true", "false"]).optional(),
  focused: z.enum(["true", "false"]).optional(),
  selected: z.enum(["true", "false"]).optional(),
  get node(): z.ZodOptional<z.ZodArray<typeof nodeSchema>> {
    return z.array(nodeSchema).optional();
  },
});
const hierarchySchema = z.object({
  hierarchy: nodeSchema,
  updatedAt: z.number().finite(),
  packageName: z.string(),
  screenWidth: z.number().positive().finite(),
  screenHeight: z.number().positive().finite(),
});
export type TvosHierarchy = XCTestHierarchy;
export function isTvosHierarchy(value: unknown): value is TvosHierarchy {
  return hierarchySchema.safeParse(value).success;
}
export function normalizeTvosHierarchy(value: unknown): ViewHierarchyResult {
  if (!isTvosHierarchy(value)) {
    throw new ActionableError("Invalid tvOS hierarchy; reconnect the runner.");
  }
  return convertToViewHierarchyResult(value);
}
