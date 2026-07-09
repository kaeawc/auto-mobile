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
  appId?: string;
}

/**
 * Platform-specific surface used by {@link SystemConfigurationManager}
 * so its public methods are free of `device.platform === ...` branches.
 *
 * The manager keeps input validation (e.g. rejecting empty strings) so
 * error wording is identical across platforms; the adapter handles the
 * platform-specific I/O.
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
