import { z } from "zod/v4";

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Text must not be blank")
  .refine((value) => !value.includes("\0"), "NUL is not supported");
// Android's content CLI splits bindings on every colon, including string values.
const bindingText = text.refine(
  (value) => !value.includes(":"),
  "Android content bindings cannot contain colons",
);
const instant = z.iso.datetime({ offset: true });
export const CONTENT_KINDS = ["contacts", "calendarEvents", "callLog", "smsInbox"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const seedContentInput = z.object({
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  reset: z
    .boolean()
    .optional()
    .describe(
      "Remove namespace rows before inserting. With arrays, reset those kinds; without arrays, reset all four kinds.",
    ),
  contacts: z
    .array(
      z
        .object({
          name: bindingText,
          phones: z.array(bindingText).optional(),
          emails: z.array(bindingText).optional(),
          photoPath: text
            .regex(
              /\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG])$/,
              "photoPath must end in .png, .jpg or .jpeg",
            )
            .optional()
            .describe(
              "Host PNG/JPEG file path, at most 512 KB (524288 bytes); checked by signature before writes.",
            ),
        })
        .strict(),
    )
    .optional(),
  calendarEvents: z
    .array(
      z
        .object({
          title: text,
          start: instant,
          end: instant,
          allDay: z.boolean().optional(),
          location: text.optional(),
          calendar: text.optional(),
        })
        .strict()
        .refine(
          (event) => Date.parse(event.end) > Date.parse(event.start),
          "end must be after start",
        )
        .refine(
          (event) =>
            !event.allDay ||
            [event.start, event.end].every((value) => Date.parse(value) % 86400000 === 0),
          "allDay start and exclusive end must be UTC midnight",
        ),
    )
    .optional(),
  callLog: z
    .array(
      z
        .object({
          number: bindingText,
          type: z.enum(["incoming", "outgoing", "missed"]),
          date: instant,
          durationSec: z.number().int().min(0).max(2147483647).optional(),
        })
        .strict(),
    )
    .optional(),
  smsInbox: z
    .array(
      z.object({ address: text, body: text, date: instant, read: z.boolean().optional() }).strict(),
    )
    .optional(),
});
export type SeedContentInput = z.output<typeof seedContentInput>;
export type ContentCounts = Record<ContentKind, number>;
export interface SeedContentResult {
  namespace: string;
  inserted: ContentCounts;
  removed: ContentCounts;
}
export const emptyContentCounts = (): ContentCounts => ({
  contacts: 0,
  calendarEvents: 0,
  callLog: 0,
  smsInbox: 0,
});
