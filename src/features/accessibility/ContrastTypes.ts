export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorCluster {
  color: RGB;
  count: number;
  coreCount: number;
}

export interface ElementColors {
  textColor: RGB;
  backgroundColor: RGB;
}

export interface RGBA extends RGB {
  a: number;
}

export interface ContrastSample {
  x: number;
  y: number;
  ratio: number;
  backgroundColor: RGB;
}

export type GradientDirection = "horizontal" | "vertical" | "diagonal-down" | "diagonal-up";

export interface GradientInfo {
  isGradient: boolean;
  direction: GradientDirection;
  variance: number;
  startColor: RGB;
  endColor: RGB;
}

export interface ContrastResult {
  ratio: number;
  minRatio: number;
  maxRatio: number;
  avgRatio: number;
  samples: ContrastSample[];
  textColor: RGB;
  backgroundColor: RGB;
  gradient?: GradientInfo;
  shadowDetected: boolean;
  baseRequiredRatio: number;
  meetsAA: boolean;
  meetsAAA: boolean;
  requiredRatio: number;
}

export interface ContrastCheckConfig {
  /** Enable multi-point sampling for contrast (default: true) */
  useMultiPointSampling?: boolean;

  /** Detect gradients and sample along gradient direction (default: true) */
  detectGradients?: boolean;

  /** Composite semi-transparent overlays when sampling colors (default: false) */
  compositeOverlays?: boolean;

  /** Detect text shadows and adjust contrast thresholds (default: false) */
  detectTextShadows?: boolean;

  /** Number of sampling points (default: 9) */
  samplingPoints?: 5 | 9 | 13;

  /** Enable screenshot caching (default: true) */
  enableScreenshotCache?: boolean;

  /** Enable color pair caching (default: true) */
  enableColorPairCache?: boolean;

  /** Enable element result caching (default: true) */
  enableElementCache?: boolean;

  /** Enable background color caching (default: true) */
  enableBackgroundCache?: boolean;

  /** Screenshot cache TTL in milliseconds (default: 60000 = 1 minute) */
  screenshotCacheTTL?: number;

  /** Maximum cache sizes */
  maxCacheSize?: {
    screenshots?: number; // Default: 10
    colorPairs?: number; // Default: 1000
    elements?: number; // Default: 500
    backgrounds?: number; // Default: 200
  };
}

export interface CacheStats {
  screenshots: {
    size: number;
    hits: number;
    misses: number;
  };
  colorPairs: {
    size: number;
    hits: number;
    misses: number;
  };
  elements: {
    size: number;
    hits: number;
    misses: number;
  };
  backgrounds: {
    size: number;
    hits: number;
    misses: number;
  };
}
