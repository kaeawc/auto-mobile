import type { ElementBounds } from "../../../models/ElementBounds";

export const RASTER_SCALE_TOLERANCE = 0.02;
export interface ImagePoint {
  x: number;
  y: number;
}
export interface ImageSize {
  width: number;
  height: number;
}

/** Interface-native to raw framebuffer coordinates, matching the iOS crop convention. */
export function nativeToRasterPoint(
  point: ImagePoint,
  screen: ImageSize,
  turn: number,
): ImagePoint {
  const { x, y } = point;
  switch (turn) {
    case 1:
      return { x: screen.height - y, y: x };
    case 2:
      return { x: screen.width - x, y: screen.height - y };
    case 3:
      return { x: y, y: screen.width - x };
    default:
      return point;
  }
}

export function rasterToNativePoint(
  point: ImagePoint,
  screen: ImageSize,
  turn: number,
): ImagePoint {
  const { x, y } = point;
  switch (turn) {
    case 1:
      return { x: y, y: screen.height - x };
    case 2:
      return { x: screen.width - x, y: screen.height - y };
    case 3:
      return { x: screen.width - y, y: x };
    default:
      return point;
  }
}

export function rasterScreenSize(screen: ImageSize, turn: number): ImageSize {
  return turn === 1 || turn === 3 ? { width: screen.height, height: screen.width } : screen;
}

function mapBounds(
  bounds: ElementBounds,
  transform: (point: ImagePoint) => ImagePoint,
): ElementBounds {
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.left, y: bounds.bottom },
    { x: bounds.right, y: bounds.bottom },
  ].map(transform);
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

export function nativeBoundsInRaster(
  bounds: ElementBounds,
  screen: ImageSize,
  turn: number,
): ElementBounds {
  return mapBounds(bounds, (point) => nativeToRasterPoint(point, screen, turn));
}

export function rasterBoundsInNative(
  bounds: ElementBounds,
  screen: ImageSize,
  turn: number,
): ElementBounds {
  return mapBounds(bounds, (point) => rasterToNativePoint(point, screen, turn));
}

export function snapRasterBounds(
  bounds: ElementBounds,
  scale: ImagePoint,
  image: ImageSize,
): ElementBounds {
  return {
    left: Math.max(0, Math.floor(bounds.left * scale.x)),
    top: Math.max(0, Math.floor(bounds.top * scale.y)),
    right: Math.min(image.width, Math.ceil(bounds.right * scale.x)),
    bottom: Math.min(image.height, Math.ceil(bounds.bottom * scale.y)),
  };
}
