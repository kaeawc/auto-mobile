import Foundation

/// Number-to-text for the prototype feature, byte-identical to the host's `renderScalar`
/// (`src/features/prototype/prototypeTemplate.ts`) and to Android's `PrototypeScalarText`.
/// Integral numbers print as exact plain digits at any magnitude (`1e21` is `1000000000000000000000`,
/// `-0` is `0`); every other finite number prints as JavaScript's `String(number)`: decimal for
/// `1e-7 < |x| < 1e21`, else `d.ddde-x` / `d.ddde+x`. Swift's `description` already yields the
/// shortest round-trip digits, so only the decimal-point placement is redone here.
enum PrototypeScalarText {
    static func render(_ value: Double) -> String {
        // The host would print these as JavaScript does; spec state is JSON, so they cannot occur.
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value.rounded() == value {
            return String(format: "%.0f", value == 0 ? 0 : value)
        }
        return (value < 0 ? "-" : "") + javascriptDecimal(abs(value))
    }

    /// JavaScript Number::toString for a positive, finite, non-integral value.
    private static func javascriptDecimal(_ value: Double) -> String {
        let (digits, pointPosition) = shortestDigits(value)
        let count = digits.count
        // `pointPosition` is JavaScript's n: the value is 0.<digits> x 10^n.
        if count <= pointPosition, pointPosition <= 21 {
            return digits + String(repeating: "0", count: pointPosition - count)
        }
        if 0 < pointPosition, pointPosition <= 21 {
            let split = digits.index(digits.startIndex, offsetBy: pointPosition)
            return digits[..<split] + "." + digits[split...]
        }
        if -6 < pointPosition, pointPosition <= 0 {
            return "0." + String(repeating: "0", count: -pointPosition) + digits
        }
        let exponent = pointPosition - 1
        let sign = exponent < 0 ? "-" : "+"
        let head = String(digits.prefix(1))
        let tail = count > 1 ? "." + digits.dropFirst() : ""
        return head + tail + "e" + sign + String(abs(exponent))
    }

    /// The shortest round-trip significant digits (no leading or trailing zeros) and the position of
    /// the decimal point relative to them, parsed from Swift's `description` (`0.001`, `1e-05`, `1.5e+20`).
    private static func shortestDigits(_ value: Double) -> (digits: String, pointPosition: Int) {
        let parts = value.description.split(separator: "e", maxSplits: 1)
        let exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let pieces = parts[0].split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let whole = String(pieces[0])
        var all = whole + (pieces.count > 1 ? String(pieces[1]) : "")
        var position = whole.count + exponent
        let leading = all.prefix { $0 == "0" }.count
        all.removeFirst(leading)
        position -= leading
        while all.last == "0" { all.removeLast() }
        return (all, position)
    }
}
