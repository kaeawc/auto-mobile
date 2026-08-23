import type {
  GetCalendarSystemResult,
  LocalizationSettingsResult,
  Set24HourFormatResult,
  SetCalendarSystemResult,
  SetLocaleResult,
  SetTextDirectionResult,
  SetTimeZoneResult,
} from "../../src/models";
import type {
  BroadcastOptions,
  SystemConfigurationAdapter,
} from "../../src/utils/interfaces/SystemConfigurationAdapter";

/**
 * Minimal recording fake for {@link SystemConfigurationAdapter}.
 * Mirrors the `executedOperations` / `wasMethodCalled` / `getCallCount`
 * / `clearHistory` pattern used by `FakeTapStrategy` and
 * `FakeSnapshotProvider`. Configurable result fields let tests
 * stub specific responses.
 */
export class FakeSystemConfigurationAdapter implements SystemConfigurationAdapter {
  setLocaleResult: SetLocaleResult = { success: true, languageTag: "en-US" };
  setTimeZoneResult: SetTimeZoneResult = { success: true, zoneId: "America/Los_Angeles" };
  setTextDirectionResult: SetTextDirectionResult = { success: true, rtl: false };
  set24HourFormatResult: Set24HourFormatResult = { success: true, enabled: true };
  setCalendarSystemResult: SetCalendarSystemResult = { success: true, calendarSystem: "gregory" };
  getCalendarSystemResult: GetCalendarSystemResult = {
    success: true,
    calendarSystem: "gregory",
    source: "default",
  };
  getLocalizationSettingsResult: LocalizationSettingsResult = {
    success: true,
    locale: "en-US",
    timeZone: "America/Los_Angeles",
    textDirection: "ltr",
    timeFormat: "12",
    calendarSystem: "gregory",
  };
  broadcastLocaleChangeResult: boolean = true;

  private readonly executedOperations: string[] = [];

  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  clearHistory(): void {
    this.executedOperations.length = 0;
  }

  async setLocale(languageTag: string, options: BroadcastOptions): Promise<SetLocaleResult> {
    this.executedOperations.push(`setLocale:${languageTag}:${options.broadcast ?? "default"}`);
    return this.setLocaleResult;
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    this.executedOperations.push(`setTimeZone:${zoneId}`);
    return this.setTimeZoneResult;
  }

  async setTextDirection(rtl: boolean, options: BroadcastOptions): Promise<SetTextDirectionResult> {
    this.executedOperations.push(`setTextDirection:${rtl}:${options.broadcast ?? "default"}`);
    return this.setTextDirectionResult;
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    this.executedOperations.push(`set24HourFormat:${enabled}`);
    return this.set24HourFormatResult;
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    this.executedOperations.push(`setCalendarSystem:${calendarSystem}`);
    return this.setCalendarSystemResult;
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    this.executedOperations.push("getCalendarSystem");
    return this.getCalendarSystemResult;
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    this.executedOperations.push("getLocalizationSettings");
    return this.getLocalizationSettingsResult;
  }

  async broadcastLocaleChange(): Promise<boolean> {
    this.executedOperations.push("broadcastLocaleChange");
    return this.broadcastLocaleChangeResult;
  }
}
