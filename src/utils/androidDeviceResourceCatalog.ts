import type { ConfigurableDeviceResource } from "../models/deviceResourceDescriptions";

/** Whole optional apps, never shared providers, overlays, framework or automation packages. */
export const androidDeviceResourceCatalog = {
  mailApp: ["com.google.android.gm", "com.android.email"],
  calendarApp: ["com.google.android.calendar", "com.android.calendar"],
  contactsApp: ["com.google.android.contacts", "com.android.contacts"],
  mapsApp: ["com.google.android.apps.maps"],
  videoApp: ["com.google.android.youtube"],
  musicApp: ["com.google.android.apps.youtube.music"],
  photosApp: ["com.google.android.apps.photos"],
  assistantApp: ["com.google.android.googlequicksearchbox"],
  digitalWellbeing: ["com.google.android.apps.wellbeing"],
  printing: ["com.android.printspooler", "com.google.android.printservice.recommendation"],
  accessibilityApps: [
    "com.google.android.marvin.talkback",
    "com.google.android.accessibility.accessibilitymenu",
  ],
  textToSpeech: ["com.google.android.tts"],
  storeApp: ["com.android.vending"],
  healthConnect: [
    "com.google.android.healthconnect.controller",
    "com.google.android.health.connect.backuprestore",
  ],
  adServices: ["com.google.android.adservices.api"],
  onDevicePersonalization: ["com.google.android.ondevicepersonalization.services"],
  wallpaperApps: [
    "com.google.android.apps.wallpaper",
    "com.google.android.apps.wallpaper.nexus",
    "com.android.wallpaper.livepicker",
    "com.android.wallpaper",
  ],
  dialerApp: ["com.google.android.dialer"],
  messagesApp: ["com.google.android.apps.messaging"],
  googlePlayServices: ["com.google.android.gms"],
  googleServicesFramework: ["com.google.android.gsf"],
} as const satisfies Partial<Record<ConfigurableDeviceResource, readonly string[]>>;

export const androidResourceSettings = {
  animations: {
    namespace: "global",
    keys: ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"],
  },
  screensavers: { namespace: "secure", keys: ["screensaver_enabled"] },
} as const satisfies Partial<
  Record<ConfigurableDeviceResource, { namespace: string; keys: readonly string[] }>
>;
