export interface SetTimeZoneResult {
  success: boolean;
  zoneId: string;
  previousZoneId?: string | null;
  method?: string;
  error?: string;
}
