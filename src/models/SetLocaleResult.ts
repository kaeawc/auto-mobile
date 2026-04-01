export interface SetLocaleResult {
  success: boolean;
  languageTag: string;
  previousLanguageTag?: string | null;
  appliedLanguages?: string[];
  method?: string;
  broadcasted?: boolean;
  error?: string;
}
