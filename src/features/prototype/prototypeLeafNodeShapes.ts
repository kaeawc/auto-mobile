import { z } from "zod";

/** The `divider` node's own fields; prototypeSpec.ts adds the common node shape. */
export const prototypeDividerShape = {
  type: z.enum(["divider"]),
  orientation: z.enum(["horizontal", "vertical"]).optional(),
};

/** The `badge` node's own fields; prototypeSpec.ts adds the common node shape. */
export const prototypeBadgeShape = {
  type: z.enum(["badge"]),
  text: z.string().min(1).optional(),
};
