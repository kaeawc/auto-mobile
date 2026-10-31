/**
 * OEM identity descriptors (#14059): the `Build.*` props and system features an opt-in lane would
 * present so an app under test takes its own `if (Build.MANUFACTURER == …)` branches on an
 * emulator. A descriptor is data only. AutoMobile ships no OEM APKs or images and installs no root
 * tooling; applying a descriptor is a later, separately reviewed step
 * (docs/design-docs/plat/android/oem-identity-lane.md).
 */
import { z } from "zod/v4";
import { MANUFACTURER_PROFILE_IDS } from "../../models/ManufacturerProfileIds";
import { PERSONA_EVIDENCE_STATUSES } from "./OemPersonas";

/** The `Build` fields an app branches on, each read from `ro.product[.<partition>].<field>`. */
export const OEM_IDENTITY_BUILD_FIELDS = [
  "manufacturer",
  "brand",
  "model",
  "device",
  "name",
] as const;

/** Partitions `Build` resolves product props from (`ro.product.property_source_order`). */
const PRODUCT_PROP_PARTITIONS = ["system", "vendor", "odm", "product", "system_ext"];

/**
 * Only identity props. Fingerprint, tags, build type, `ro.debuggable`, `ro.secure` and boot state
 * are integrity signals, and spoofing them is out of scope: this lane is QA, never a way past
 * Play Integrity.
 */
const IDENTITY_PROP = new RegExp(
  `^ro\\.product\\.(?:(?:${PRODUCT_PROP_PARTITIONS.join("|")})\\.)?(?:${OEM_IDENTITY_BUILD_FIELDS.join("|")})$`,
);

/** A value safe to pass to `setprop` or a `build.prop` line: no quoting, no metacharacters. */
const PROP_VALUE = /^[A-Za-z0-9 ._/+:-]{1,91}$/;

/**
 * An OEM feature name, for example `com.samsung.feature.samsung_experience_mobile`. `android.*`
 * features describe platform hardware and software, not OEM identity, so they are refused.
 */
const OEM_FEATURE = /^(?!android\.)[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export const oemIdentityDescriptorSchema = z
  .object({
    personaId: z.enum(MANUFACTURER_PROFILE_IDS),
    version: z.number().int().positive(),
    // Keys are checked in a refinement: zod reports a failed record key only as "Invalid key".
    props: z
      .record(
        z.string(),
        z.string().regex(PROP_VALUE, "prop values are 1-91 characters of [A-Za-z0-9 ._/+:-]"),
      )
      .superRefine((props, ctx) => {
        for (const key of Object.keys(props).filter((name) => !IDENTITY_PROP.test(name))) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is not an identity prop (ro.product[.<partition>].<field>)`,
          });
        }
      }),
    features: z
      .array(z.string().regex(OEM_FEATURE, "not an OEM feature name"))
      .refine((names) => new Set(names).size === names.length, "features must not repeat"),
    evidence: z
      .object({
        status: z.enum(PERSONA_EVIDENCE_STATUSES),
        note: z.string().min(1),
        source: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (descriptor) => Object.keys(descriptor.props).length > 0 || descriptor.features.length > 0,
    "a descriptor needs at least one prop or feature",
  );
