import type { ConfigurableDeviceResource } from "../models/deviceResourceDescriptions";

/** Narrow, disjoint groups. Shared app infrastructure is deliberately not in the mutation allowlist. */
export const iosDeviceResourceCatalog = {
  wallpaperRendering: ["com.apple.PosterBoard"],
  widgets: ["com.apple.chronod"],
  liveActivities: ["com.apple.liveactivitiesd"],
  healthServices: [
    "com.apple.healthd",
    "com.apple.healthappd",
    "com.apple.healthcontentd",
    "com.apple.healtheventsd",
    "com.apple.healthrecordsd",
  ],
  homeServices: ["com.apple.homed", "com.apple.homeeventsd"],
  fitnessServices: [
    "com.apple.fitcore",
    "com.apple.fitcore.session",
    "com.apple.fitnesscoachingd",
    "com.apple.fitnessintelligenced",
    "com.apple.activityawardsd",
    "com.apple.activitysharingd",
  ],
  familyServices: [
    "com.apple.familycircled",
    "com.apple.FamilyControlsAgent",
    "com.apple.familynotification",
    "com.apple.askpermissiond",
    "com.apple.asktod",
  ],
  screenTime: [
    "com.apple.ScreenTimeAgent",
    "com.apple.ScreenTimeSettingsAgent",
    "com.apple.UsageTrackingAgent",
  ],
  newsServices: ["com.apple.newsd"],
  weatherServices: ["com.apple.weatherd"],
  tipsServices: ["com.apple.tipsd"],
  gameServices: ["com.apple.gamed", "com.apple.gamesaved"],
  mapsSync: [
    "com.apple.Maps.mapssyncd",
    "com.apple.Maps.mapspushd",
    "com.apple.Maps.geocorrectiond",
    "com.apple.maps.destinationd",
  ],
  advertising: ["com.apple.ap.promotedcontentd"],
  diagnosticReporting: [
    "com.apple.diagnosticextensionsd",
    "com.apple.feedbackd",
    "com.apple.rtcreportingd",
    "com.apple.geoanalyticsd",
  ],
  photoAnalysis: ["com.apple.photoanalysisd"],
  assistantSuggestions: [
    "com.apple.siriinferenced",
    "com.apple.siriknowledged",
    "com.apple.parsecd",
    "com.apple.parsec-fbf",
    "com.apple.proactiveeventtrackerd",
  ],
  // The runtime-gated intelligenceflowd is left to the OS; never force its enablement.
  appleIntelligence: [
    "com.apple.intelligenceplatformd",
    "com.apple.intelligencecontextd",
    "com.apple.intelligencetasksd",
    "com.apple.generativeexperiencesd",
  ],
  searchIndexing: [
    "com.apple.searchd",
    "com.apple.searchtoold",
    "com.apple.spotlightknowledged",
    "com.apple.spotlightknowledged.updater",
    "com.apple.corespotlightservice",
  ],
  appStoreServices: ["com.apple.appstored", "com.apple.appstorecomponentsd"],
  appleMediaSync: [
    "com.apple.itunescloudd",
    "com.apple.musicd",
    "com.apple.videosubscriptionsd",
    "com.apple.assetsubscriptiond",
  ],
  mailServices: ["com.apple.email.maild"],
  calendarServices: ["com.apple.calaccessd"],
  reminderServices: ["com.apple.remindd"],
  personalDataSync: ["com.apple.exchangesyncd", "com.apple.dataaccess.dataaccessd"],
  safariSync: ["com.apple.SafariBookmarksSyncAgent", "com.apple.Safari.History"],
  icloudSettingsSync: [
    "com.apple.cloudsettingssyncagent",
    "com.apple.syncdefaultsd",
    "com.apple.icloudsubscriptionoptimizerd",
  ],
  messagingMaintenance: [
    "com.apple.imautomatichistorydeletionagent",
    "com.apple.imcore.imtransferagent",
    "com.apple.facetimemessagestored",
  ],
  watchConnectivity: ["com.apple.wcd", "com.apple.companiond"],
  carPlay: ["com.apple.carkitd"],
  tvRemote: ["com.apple.tvremoted"],
  findMy: ["com.apple.findmy.findmylocated"],
  continuity: ["com.apple.rapportd"],
  walletServices: [
    "com.apple.passd",
    "com.apple.financed",
    "com.apple.merchantd",
    "com.apple.coreidvd",
  ],
  businessServices: ["com.apple.businessservicesd"],
} as const satisfies Partial<Record<ConfigurableDeviceResource, readonly string[]>>;

/** Runtime filenames whose casing or basename differs from the launchd label. */
export const iosDeviceResourcePlistNames: Readonly<Record<string, string>> = {
  "com.apple.Maps.mapspushd": "com.apple.Maps.pushdaemon.plist",
  "com.apple.imcore.imtransferagent": "com.apple.imtransferagent.plist",
  "com.apple.familynotification": "com.apple.familynotificationd.plist",
  "com.apple.cloudsettingssyncagent": "com.apple.CloudSettingsSyncAgent.plist",
};
