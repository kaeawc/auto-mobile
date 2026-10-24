import { iosDeviceResourceHazards, type IosDeviceResourceHazard } from "./iosDeviceResourceHazards";
import type { ConfigurableDeviceResource } from "../models/deviceResourceDescriptions";
import type {
  DisabledIosDeviceResource,
  ImpactItem,
  IosDeviceResourceImpact,
} from "../models/DeviceResourceImpact";
import { iosDeviceResourceCatalog } from "./iosDeviceResourceCatalog";

export type {
  DisabledIosDeviceResource,
  ImpactConfidence,
  ImpactItem,
  IosDeviceResourceImpact,
} from "../models/DeviceResourceImpact";

/** #15097 checked the driving surface; combination hazards are reported separately. */
export const coreDrivingImpact: ImpactItem = {
  description:
    "Core driving (startDevice runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected.",
  confidence: "verified",
  evidence:
    "#15097: driving surface passed on iOS 27.0; see unsafeWith / #15218 for combinations that spin the CPU",
};

export const iosDeviceResourceImpact = {
  wallpaperRendering: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Wallpaper visuals may be missing in `observe` results and screenshots.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Home and Lock Screen wallpaper does not render.", confidence: "inferred" },
    ],
  },
  widgets: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Home and Lock Screen widget visuals may be missing or stale in `observe` results and screenshots.",
        confidence: "inferred",
      },
    ],
    appImpact: [{ description: "Widgets do not render or update.", confidence: "inferred" }],
  },
  liveActivities: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Live Activity visuals may be missing in `observe` results and screenshots.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Live Activities and Dynamic Island updates do not show.",
        confidence: "inferred",
      },
    ],
  },
  healthServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect HealthKit-backed data may be unavailable.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "HealthKit data and Health app background functionality are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  homeServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise HomeKit accessories or automations may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "HomeKit accessory control and automations are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  fitnessServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect Fitness coaching, awards, or shared activity may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Fitness coaching, activity awards, and activity sharing may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  familyServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that exercise family approvals or parental controls may behave differently.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Family Sharing approvals and parental controls may stop working.",
        confidence: "inferred",
      },
    ],
  },
  screenTime: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that exercise usage tracking or Screen Time restrictions may behave differently.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Screen Time limits and usage tracking may stop working.",
        confidence: "inferred",
      },
    ],
  },
  newsServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect refreshed Apple News content may see stale content.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Apple News background content may not refresh.", confidence: "inferred" },
    ],
  },
  weatherServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect Apple Weather forecasts may see stale content.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Apple Weather background forecasts may not refresh.",
        confidence: "inferred",
      },
    ],
  },
  tipsServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect Apple Tips content may see stale content.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Apple Tips background content may not refresh.", confidence: "inferred" },
    ],
  },
  gameServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise Game Center or saved-game synchronization may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Game Center and saved-game synchronization may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  mapsSync: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect synced Maps favorites, history, or destinations may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Maps favorites, history, and suggested destinations may not synchronize.",
        confidence: "inferred",
      },
    ],
  },
  advertising: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect promoted Apple content may see missing content.",
        confidence: "inferred",
      },
    ],
    appImpact: [{ description: "Promoted Apple content may not appear.", confidence: "inferred" }],
  },
  diagnosticReporting: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that depend on system diagnostic evidence may have less evidence.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Diagnostic collection, feedback, location analytics, and call-quality reports may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  siriAndAppIntents: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "The future siri tool (#14892) will need these services once shipped, and App Intents workflows may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Siri requests, Shortcuts actions, App Intents, and widget configuration or Controls that use them are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  speechServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise dictation or speech input may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Dictation, speech recognition, and Siri speech synthesis are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  mediaTranscoding: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "`putAppFile` with media_library imports and workflows using photo-picker conversions may fail when transcoding is required.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Image and video transcoding may fail during media imports or photo selection.",
        confidence: "inferred",
      },
    ],
  },
  photoAnalysis: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect photo recognition or photo-search results may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Photo analysis, recognition, and analysis-backed photo search are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  assistantSuggestions: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect Siri or proactive suggestions may see missing suggestions.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Siri inference, knowledge, and proactive suggestions may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  appleIntelligence: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that exercise Writing Tools or Apple Intelligence integrations may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Writing Tools and Apple Intelligence integrations are unavailable.",
        confidence: "inferred",
      },
    ],
  },
  searchIndexing: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that use Spotlight or Settings search lookups may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Spotlight donations do nothing and system-indexed search results may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  appStoreServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that use App Store installation or updates may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "App Store installations and updates may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  appleMediaSync: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect Apple Music or subscribed media may see missing or stale content.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Apple Music and subscribed or purchased media may not synchronize.",
        confidence: "inferred",
      },
    ],
  },
  mailServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that retrieve sign-in email through Apple Mail may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Apple Mail background mail access may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  calendarServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Disabling on a running simulator is refused with unsafe_device_resource_combination because it makes Calendar spin the CPU. Applying before first boot is allowed.",
        confidence: "verified",
        evidence:
          "#15218: calaccessd bootout at 90 s caused MobileCal 100-130% CPU and diagnosticd 20-50%; preboot disable stayed quiet even after Calendar launched.",
      },
      {
        description: "Workflows that inspect or change the local Calendar database may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Local Calendar database access may be unavailable.", confidence: "inferred" },
    ],
  },
  reminderServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect or change Apple Reminders may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Apple Reminders database access and background updates may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  personalDataSync: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect synchronized Exchange, CalDAV, or CardDAV data may see stale data.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Exchange, CalDAV, and CardDAV synchronization may stop working.",
        confidence: "inferred",
      },
    ],
  },
  safariSync: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect synchronized Safari history or bookmarks may see stale data.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Safari bookmarks and history may not synchronize.", confidence: "inferred" },
    ],
  },
  icloudSettingsSync: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect synchronized iCloud system settings may see stale settings.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "iCloud system settings may not synchronize and storage-plan recommendations may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  messagingMaintenance: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that inspect Messages attachment transfers or FaceTime messages may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Messages history cleanup, attachment transfer, and FaceTime message storage may stop working.",
        confidence: "inferred",
      },
    ],
  },
  watchConnectivity: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that exercise paired Watch or companion-device communication may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Paired Watch and companion-device communication may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  carPlay: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise CarPlay connectivity may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "CarPlay vehicle connectivity may be unavailable.", confidence: "inferred" },
    ],
  },
  tvRemote: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise Apple TV discovery or remote control may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Apple TV discovery and remote control may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  findMy: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that inspect Find My device locations may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description: "Find My device-location functionality may be unavailable.",
        confidence: "inferred",
      },
    ],
  },
  continuity: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise cross-device Continuity discovery may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Nearby-device discovery and cross-device Continuity workflows may stop working.",
        confidence: "inferred",
      },
    ],
  },
  walletServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description:
          "Workflows that exercise Wallet, payment sheets, or digital identity may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      {
        description:
          "Wallet, Apple Pay, digital identity, and dependent StoreKit payment sheets may fail.",
        confidence: "inferred",
      },
    ],
  },
  businessServices: {
    automobileImpact: [
      coreDrivingImpact,
      {
        description: "Workflows that exercise Apple business messaging may fail.",
        confidence: "inferred",
      },
    ],
    appImpact: [
      { description: "Apple business messaging may be unavailable.", confidence: "inferred" },
    ],
  },
} satisfies Record<keyof typeof iosDeviceResourceCatalog, IosDeviceResourceImpact>;

export function getIosDeviceResourceImpact(
  resource: ConfigurableDeviceResource,
  hazards: readonly IosDeviceResourceHazard[] = iosDeviceResourceHazards,
): IosDeviceResourceImpact | undefined {
  if (!Object.hasOwn(iosDeviceResourceImpact, resource)) {
    return undefined;
  }
  const impact = iosDeviceResourceImpact[resource as keyof typeof iosDeviceResourceCatalog];
  const unsafeWith = hazards
    .filter((hazard) => hazard.resources.some((key) => key === resource))
    .map((hazard) => ({
      hazardId: hazard.id,
      appliesTo: hazard.appliesTo,
      withResources: hazard.resources.filter((key) => key !== resource),
      reason: hazard.reason,
      evidence: hazard.evidence,
    }));
  return unsafeWith.length ? { ...impact, unsafeWith } : impact;
}

/** Only proven disabled catalog resources are reported, in stable catalog order. */
export function describeDisabledDeviceResources(
  states: Partial<Record<ConfigurableDeviceResource, { state: string }>>,
  hazards: readonly IosDeviceResourceHazard[] = iosDeviceResourceHazards,
): DisabledIosDeviceResource[] {
  const disabled: DisabledIosDeviceResource[] = [];
  for (const resource of Object.keys(
    iosDeviceResourceCatalog,
  ) as (keyof typeof iosDeviceResourceCatalog)[]) {
    if (states[resource]?.state === "disabled") {
      disabled.push({
        resource,
        labels: [...iosDeviceResourceCatalog[resource]],
        ...getIosDeviceResourceImpact(resource, hazards)!,
      });
    }
  }
  return disabled;
}

/** Keep no-op results unchanged instead of emitting an empty report. */
export function disabledDeviceResourceReport(
  states: Partial<Record<ConfigurableDeviceResource, { state: string }>>,
): { disabledResources?: DisabledIosDeviceResource[] } {
  const disabledResources = describeDisabledDeviceResources(states);
  return disabledResources.length ? { disabledResources } : {};
}
