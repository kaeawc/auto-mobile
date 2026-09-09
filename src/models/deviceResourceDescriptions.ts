/** Public resource scopes. Each setting is independent and opt-in. */
export const deviceResourceDescriptions = {
  wallpaperRendering:
    "Home and Lock Screen wallpaper rendering; excludes widgets and Live Activities.",
  widgets: "Widget refresh, including app widgets; excludes wallpaper and Live Activities.",
  liveActivities: "Live Activities and Dynamic Island updates; excludes wallpaper and widgets.",
  healthServices:
    "HealthKit data and Health app background work. Health integrations become unavailable.",
  homeServices: "HomeKit accessories and automations. Home integrations become unavailable.",
  fitnessServices: "Apple Fitness, coaching, activity awards, and activity sharing.",
  familyServices:
    "Family Sharing, family approvals, and parental controls. Changes restriction behavior.",
  screenTime: "Screen Time limits and usage tracking. Changes restriction behavior.",
  newsServices: "Apple News background content.",
  weatherServices: "Apple Weather background forecasts.",
  tipsServices: "Apple Tips background content.",
  gameServices: "Game Center and saved-game synchronization; excludes controller input.",
  mapsSync:
    "Maps favorites, history, background updates, and suggested destinations; excludes MapKit rendering and location services.",
  advertising:
    "Promoted Apple content; excludes advertising privacy preferences and app integrity services.",
  diagnosticReporting:
    "Diagnostic collectors, feedback, location analytics, and call-quality reporting; reduces diagnostic evidence, not call transport.",
  photoAnalysis:
    "Background Photos analysis; may reduce photo search and recognition. Preserves library access, cloud transfers, and shared media-analysis infrastructure.",
  assistantSuggestions:
    "Siri inference, knowledge, and proactive suggestions; preserves speech, system voices, and shared language/model infrastructure.",
  appleIntelligence:
    "Apple Intelligence orchestration and generative experiences; system writing tools and intelligence integrations may become unavailable. Preserves shared model and speech services.",
  searchIndexing:
    "Spotlight and Settings search, including app-provided system indexes; excludes an app's own search service.",
  appStoreServices:
    "App Store installation/update services; excludes push and StoreKit payment services.",
  appleMediaSync:
    "Apple Music and subscribed/purchased media background services; excludes generic audio/video playback and StoreKit payments.",
  mailServices:
    "Apple Mail background services. Mail-based sign-in email workflows may be unavailable.",
  calendarServices:
    "Local Calendar database access; excludes server-side calendar integrations in apps.",
  reminderServices:
    "Apple Reminders database and background work; excludes reminders maintained by other apps.",
  personalDataSync:
    "Exchange, CalDAV, and CardDAV synchronization; preserves local Contacts database access.",
  safariSync:
    "Safari bookmark/history synchronization; preserves associated domains, shared credentials, browsing protections, and WebKit.",
  icloudSettingsSync:
    "iCloud system-settings synchronization and storage-plan recommendations; preserves accounts, credentials, CloudKit data, Drive, and Photos transfers.",
  messagingMaintenance:
    "Apple Messages history cleanup, attachment transfer, and FaceTime message storage; preserves identity, message database XPC helpers, and system calling services.",
  watchConnectivity: "Paired Watch and companion-device communication.",
  carPlay: "CarPlay vehicle connectivity.",
  tvRemote: "Apple TV discovery and remote control.",
  findMy: "Find My device-location services; excludes general location APIs.",
  continuity:
    "Nearby-device Continuity discovery; cross-device workflows may stop working. Preserves system share sheets.",
  walletServices:
    "Wallet, Apple Pay, digital identity, and merchant services. Payment sheets, including dependent StoreKit workflows, may fail.",
  businessServices: "Apple business messaging services; excludes ordinary app messaging.",
  backgroundSync:
    "General OS background app scheduling. Control is unsupported to preserve application behavior.",
  animations: "System UI animations. Control is currently unsupported.",
  googlePlayServices:
    "Google Play infrastructure. Control is unsupported to preserve application behavior.",
  icloudSync:
    "Broad iCloud/account synchronization. Control is unsupported; use the narrower icloudSettingsSync setting.",
} as const;

export type ConfigurableDeviceResource = keyof typeof deviceResourceDescriptions;
