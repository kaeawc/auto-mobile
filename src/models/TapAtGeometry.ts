/** Platform-native coordinate provenance; orientation is the observe rotation index (0–3). */
export interface TapAtGeometry {
  platform: "android" | "ios";
  deviceWidth: number;
  deviceHeight: number;
  orientation: number;
  x: number;
  y: number;
}

/** Internal context passed by plan replay and successful-call recording, never advertised. */
export interface TapAtPlanContext {
  geometry?: TapAtGeometry;
  recordedGeometry?: TapAtGeometry;
}
