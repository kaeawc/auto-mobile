import SwiftUI

/// The host chrome follows the resolved mode, independent of why the prototype chose it.
enum PrototypeChromeAppearance: Equatable {
    case light, dark

    init(dark: Bool) { self = dark ? .dark : .light }

    var colorScheme: ColorScheme {
        switch self {
        case .light: .light
        case .dark: .dark
        }
    }
}

/// First appearance and mode changes report once; changes to resolution source do not re-theme chrome.
struct PrototypeAppearanceReport {
    private(set) var last: PrototypeChromeAppearance?

    mutating func report(dark: Bool) -> PrototypeChromeAppearance? {
        let next = PrototypeChromeAppearance(dark: dark)
        guard next != last else { return nil }
        last = next
        return next
    }
}
