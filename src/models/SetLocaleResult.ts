export interface SetLocaleResult {
  success: boolean;
  languageTag: string;
  previousLanguageTag?: string | null;
  appliedLanguages?: string[];
  method?: string;
  broadcasted?: boolean;
  error?: string;
  /**
   * Scope the locale change was actually applied at.
   *
   * `"app"` means the change was scoped to a single app (Android 13+ / iOS
   * per-app). `"system"` means it changed the whole device — which is what the
   * legacy Android (< 13) path is forced to do even when a per-app change was
   * requested, because the app-scoped `cmd locale` service does not exist there.
   *
   * Callers use this to know whether a per-app request was silently widened to
   * the entire device (issue #6346) so they can restore global state afterwards.
   */
  localeScope?: "app" | "system";
}
