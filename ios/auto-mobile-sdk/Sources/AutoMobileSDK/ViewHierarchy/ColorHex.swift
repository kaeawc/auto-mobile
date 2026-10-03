import Foundation

/// Formats RGBA components as `#RRGGBBAA`.
/// Wide-gamut `UIColor.getRed` returns extended-sRGB values outside 0...1, so
/// clamp finite components before scaling to keep each channel within one byte.
enum ColorHex {
    static func rgbaHex(red: Double, green: Double, blue: Double, alpha: Double) -> String? {
        guard red.isFinite, green.isFinite, blue.isFinite, alpha.isFinite else { return nil }
        return String(
            format: "#%02X%02X%02X%02X",
            Int(min(max(red, 0), 1) * 255),
            Int(min(max(green, 0), 1) * 255),
            Int(min(max(blue, 0), 1) * 255),
            Int(min(max(alpha, 0), 1) * 255)
        )
    }
}
