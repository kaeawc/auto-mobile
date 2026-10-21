export interface StaleDisplayDetails {
  observedGeneration: number;
  currentGeneration: number;
  currentDisplayKey?: string;
  retry: "observe";
}
