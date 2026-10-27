import Foundation

/// Formatting-independent ASCII number used only to choose text motion.
func parseContentTransitionNumber(_ text: String) -> Double? {
    var token = ""
    var digits = false
    var decimal = false
    for character in text.unicodeScalars {
        if character.value >= 48, character.value <= 57 {
            token.unicodeScalars.append(character)
            digits = true
        } else if character == ".", !decimal {
            token.unicodeScalars.append(character)
            decimal = true
        } else if character == "-", token.isEmpty {
            token = "-"
        }
    }
    guard digits, let value = Double(token), value.isFinite else { return nil }
    return value
}

func contentTransitionDirection(previous: String, next: String) -> String {
    guard let before = parseContentTransitionNumber(previous),
          let after = parseContentTransitionNumber(next), before != after else { return "crossfade" }
    return after > before ? "up" : "down"
}
