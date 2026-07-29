package dev.jasonpearson.automobile.desktop.domain

/**
 * Relative aspect-ratio tolerance shared by the legacy control check and touch-feedback retention.
 *
 * The two checks protect different operations, but a frame shape considered consistent enough for
 * control must also retain pulses captured against that shape.
 */
internal const val GEOMETRY_ASPECT_TOLERANCE: Float = 0.05f
