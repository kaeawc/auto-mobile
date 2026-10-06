export interface SetTimeZoneResult {
  success: boolean;
  zoneId: string;
  previousZoneId?: string | null;
  method?: string;
  /**
   * Set on success when the only check available was the stored value reading
   * back: the zone was persisted, not confirmed to be in effect for running
   * apps or the system clock.
   */
  warning?: string;
  error?: string;
}
