import { z } from "zod";
import { keySchema, pointerSchema } from "./prototypeActionValues";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { colorValueSchema, iconNameSchema } from "./prototypePresentationSchemas";

/** A marker field: a template whose `{alias.field}` placeholders resolve per marker item. */
const mapTemplateSchema = z
  .string()
  .max(256)
  .refine((value) => !prototypeContractPatterns.blankText.test(value));

/** Where the camera looks: a literal camera, or a `{data}` pointer to a camera object (#14309). */
const mapCameraSchema = z.union([
  z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      zoom: z.number().min(0).max(22),
      bearing: z.number().min(0).max(360).optional(),
      tilt: z.number().min(0).max(60).optional(),
    })
    .strict(),
  z.object({ data: pointerSchema }).strict(),
]);

/** One marker per item of the `/data` array at `path`, bound under `as` (#14309). */
const mapMarkersSchema = z
  .object({
    path: pointerSchema,
    as: keySchema,
    id: mapTemplateSchema,
    lat: mapTemplateSchema,
    lng: mapTemplateSchema,
    title: mapTemplateSchema,
    icon: iconNameSchema.optional(),
    // Degrees clockwise from north; `rotation` is a motion field elsewhere in the spec.
    heading: mapTemplateSchema.optional(),
    animateMs: z.number().int().min(0).max(2000).optional(),
  })
  .strict();

/** A line through the `{lat, lng}` points of the `/data` array at `path` (#14309). */
const mapPolylineSchema = z
  .object({
    path: pointerSchema,
    width: z.number().min(1).max(16).optional(),
    color: colorValueSchema.optional(),
  })
  .strict();

/** The `map` node schema (#14309): the shared node fields plus its own. */
export function prototypeMapSchema<T extends z.ZodRawShape, A extends z.ZodTypeAny>(
  common: T,
  actionList: A,
) {
  return z
    .object({
      ...common,
      type: z.enum(["map"]),
      mapStyle: z.enum(["plain", "streets"]).optional(),
      camera: mapCameraSchema.optional(),
      fit: z.enum(["none", "markers", "route"]).optional(),
      markers: mapMarkersSchema.optional(),
      polylines: z.array(mapPolylineSchema).min(1).max(8).optional(),
      showUserLocation: z.boolean().optional(),
      onMarkerTap: actionList.optional(),
      onCameraIdle: z.object({ into: pointerSchema }).strict().optional(),
    })
    .strict();
}
