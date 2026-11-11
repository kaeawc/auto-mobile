import { SeedContent, type SeedContentDependencies } from "../features/contentSeed/SeedContent";
import { seedContentInput } from "../features/contentSeed/seedContentInput";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool, type ToolRegistrar, type DeviceToolHandler } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { seedContentResultSchema } from "./contentSeedToolOutputSchemas";

export const createSeedContentHandler =
  (
    dependencies: (device: BootedDevice) => SeedContentDependencies = (device) => ({
      adb: defaultAdbClientFactory.create(device),
    }),
  ): DeviceToolHandler<typeof seedContentInput> =>
  async (device, args, _progress, signal) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "seedContent supports Android only. Select an Android device to seed contacts, calendar events, call history or SMS; iOS system providers cannot be seeded by this tool.",
      );
    }
    const { namespace, reset, contacts, calendarEvents, callLog, smsInbox } = args;
    const result = await new SeedContent(dependencies(device)).seed(
      { namespace, reset, contacts, calendarEvents, callLog, smsInbox },
      signal,
    );
    return createStructuredToolResponse(result);
  };
const tool = defineDeviceTool({
  name: "seedContent",
  description:
    "Seed Android contacts, calendar events, call history and SMS inbox, tagged automobile.<namespace>. reset removes only this namespace before inserts (supplied kinds, or all kinds if no arrays). Contacts/calendar/SMS require the debug content-seeder APK and grant its SMS role and runtime permissions. Optional contact photoPath reads a host PNG/JPEG up to 512 KB. Dates are ISO 8601 with timezone; all-day events use UTC midnight and exclusive end. Data persists until reset. iOS is unsupported.",
  input: seedContentInput,
  handler: createSeedContentHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: seedContentResultSchema },
});
export const seedContentSchema = tool.schema;
export function registerContentSeedTools(registry?: ToolRegistrar): void {
  tool.register(registry);
}
