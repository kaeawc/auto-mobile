import Foundation

/// Null count is infinite. The shared validator checks the authored 1...20 range.
struct PrototypeIconEffectRepeat: Codable, Equatable, Sendable {
    let count: Int?
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if (try? value.decode(String.self)) == "infinite" { count = nil }
        else { count = try value.decode(Int.self) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        if let count { try value.encode(count) } else { try value.encode("infinite") }
    }
}

/// The renderer consumes this pure table; no SwiftUI availability or device state leaks into it.
enum PrototypeIconEffectKind: String, CaseIterable {
    case bounce, pulse, scale, variableColor, wiggle, rotate, breathe, replace, drawOn

    func resolved(majorVersion: Int) -> PrototypeIconEffectKind? {
        guard majorVersion >= 17 else { return nil }
        switch self {
        case .wiggle: return majorVersion >= 18 ? .wiggle : .bounce
        case .rotate: return majorVersion >= 18 ? .rotate : nil
        case .breathe: return majorVersion >= 18 ? .breathe : .pulse
        case .drawOn: return majorVersion >= 26 ? .drawOn : .replace
        default: return self
        }
    }
}
