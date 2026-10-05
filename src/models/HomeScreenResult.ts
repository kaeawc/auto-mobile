export interface HomeScreenResult {
  success: boolean;
  message?: string;
  navigationMethod?: "gesture" | "hardware" | "element";
  error?: string;
  observation?: any;
}
