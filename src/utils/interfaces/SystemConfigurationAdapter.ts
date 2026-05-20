import type {
  GetCalendarSystemResult,
  LocalizationSettingsResult,
  Set24HourFormatResult,
  SetCalendarSystemResult,
  SetLocaleResult,
  SetTextDirectionResult,
  SetTimeZoneResult,
} from "../../models";

/**
 * Options that influence the broadcast / live-apply behaviour of a
 * locale or text-direction change.
 */
export interface BroadcastOptions {
  broadcast?: boolean;
}

/**
 * Platform-specific surface used by {@link SystemConfigurationManager}
 * to keep its public methods free of `device.platform === ...`
 * branches.
 *
 * Implemented by `AndroidSystemConfigurationAdapter` and
 * `IosSystemConfigurationAdapter`; selected once in the manager's
 * constructor via `createSystemConfigurationAdapter`. Each adapter
 * captures its platform dependencies (device, adb / process executor,
 * timer, …) at construction so call sites never need to thread them
 * through.
 *
 * Method signatures and return shapes mirror the manager's public API
 * one-to-one. Input validation (e.g. rejecting empty strings) stays in
 * the manager so error wording is identical across platforms.
 */
export interface SystemConfigurationAdapter {
  /** Set the system locale to the given BCP-47 language tag. */
  setLocale(languageTag: string, options: BroadcastOptions): Promise<SetLocaleResult>;

  /** Set the system time zone to the given IANA zone id. */
  setTimeZone(zoneId: string): Promise<SetTimeZoneResult>;

  /**
   * Set the system text direction. On platforms where RTL is not a
   * standalone setting (iOS), implementations should return a result
   * with `success: false` and an explanatory error message.
   */
  setTextDirection(rtl: boolean, options: BroadcastOptions): Promise<SetTextDirectionResult>;

  /** Enable or disable 24-hour time format. */
  set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult>;

  /** Set the calendar system (e.g. "gregory", "japanese"). */
  setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult>;

  /** Read the current calendar system, falling back to locale-derived or default. */
  getCalendarSystem(): Promise<GetCalendarSystemResult>;

  /** Read the full bundle of localization-related settings. */
  getLocalizationSettings(): Promise<LocalizationSettingsResult>;

  /**
   * Broadcast a locale-change intent so apps refresh their UI. Returns
   * `true` if a broadcast was issued, `false` otherwise (including
   * iOS, which has no equivalent broadcast).
   */
  broadcastLocaleChange(): Promise<boolean>;
}
