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
  animations:
    "Android system animation scales: disabled sets all three to zero; enabled sets them to one. Excludes app-owned animation.",
  screensavers: "Android dream/screensaver activation; excludes wallpaper and widgets.",
  backup:
    "Android Backup Manager scheduling for the current user; disables backup and restore test behavior.",
  mailApp:
    "Android optional mail apps, including Gmail. Removes mail intent handlers; preserves other apps' messaging.",
  calendarApp: "Android Calendar app availability; preserves CalendarProvider.",
  contactsApp: "Android Contacts app availability; preserves ContactsProvider.",
  mapsApp: "Android Google Maps app; external navigation intents become unavailable.",
  videoApp: "Android YouTube app; native video links become unavailable.",
  musicApp: "Android YouTube Music app; preserves shared audio playback.",
  photosApp:
    "Android Google Photos app; changes cloud photo sources and choosers. Preserves MediaProvider and DocumentsUI.",
  assistantApp:
    "Android Google Search/Assistant app, including voice and home-search integrations.",
  digitalWellbeing: "Android Digital Wellbeing usage tracking, focus, and app limits.",
  printing: "Android print spooler and print recommendations; printing becomes unavailable.",
  accessibilityApps:
    "Optional Android accessibility apps. Active accessibility services are protected.",
  textToSpeech:
    "Android Google speech synthesis; speech-dependent functionality becomes unavailable.",
  storeApp: "Android Play Store app; installation, updates, billing and licensing may fail.",
  healthConnect:
    "Android Health Connect controller and backup app; health integrations become unavailable.",
  adServices:
    "Android AdServices API package; advertising/privacy APIs may fail. Does not remove mainline/APEX infrastructure.",
  onDevicePersonalization:
    "Android on-device personalization service package; dependent APIs may fail.",
  wallpaperApps:
    "Android wallpaper picker and optional live-wallpaper apps; changes wallpaper selection. Does not disable the shared wallpaper framework or widgets.",
  dialerApp: "Optional Android dialer apps. Default role holders remain protected.",
  messagesApp:
    "Optional Android SMS/Messages apps. Default role holders remain protected; excludes other apps' messaging.",
  googleServicesFramework:
    "Android Google Services Framework; aggressive control that can break Google account and push integrations.",
  googlePlayServices:
    "Android Google Play services; aggressive control that breaks dependent push, authentication, location and other integrations. Keep enabled for Slack-compatible workflows.",
  icloudSync:
    "Broad iCloud/account synchronization. Control is unsupported; use the narrower icloudSettingsSync setting.",
} as const;

export type ConfigurableDeviceResource = keyof typeof deviceResourceDescriptions;

export const androidOnlyDeviceResources = [
  "screensavers",
  "backup",
  "mailApp",
  "calendarApp",
  "contactsApp",
  "mapsApp",
  "videoApp",
  "musicApp",
  "photosApp",
  "assistantApp",
  "digitalWellbeing",
  "printing",
  "accessibilityApps",
  "textToSpeech",
  "storeApp",
  "healthConnect",
  "adServices",
  "onDevicePersonalization",
  "wallpaperApps",
  "dialerApp",
  "messagesApp",
  "googleServicesFramework",
  "googlePlayServices",
] as const satisfies readonly ConfigurableDeviceResource[];
export type AndroidOnlyDeviceResource = (typeof androidOnlyDeviceResources)[number];
