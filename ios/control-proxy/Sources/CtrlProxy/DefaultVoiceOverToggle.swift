import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Physical-device VoiceOver toggle by automating Settings → Accessibility.
///
/// Deep-links straight to the Accessibility pane (`App-Prefs:root=ACCESSIBILITY`) to
/// avoid locale-fragile navigation. Prefer a stable element identifier, then the
/// known English label; on the VoiceOver sub-page its sole switch also works
/// with an unknown locale. Stateless → genuinely `Sendable`.
struct DefaultVoiceOverToggle: VoiceOverToggling {
    private static let settingsBundleId = "com.apple.Preferences"
    private static let accessibilityDeepLink = "App-Prefs:root=ACCESSIBILITY"
    private static let switchExistenceTimeout: TimeInterval = 5

    struct Candidate: Equatable {
        let identifier: String
        let label: String
    }

    enum Location {
        case accessibilityRow
        case directSwitch
        case subpageSwitch
    }

    /// Returns an unambiguous candidate. The first row is the structural fallback
    /// for an unlabelled Accessibility pane; a switch is structural only after
    /// opening that row, so another switch on the root cannot be toggled blindly.
    static func matchingIndex(in candidates: [Candidate], at location: Location) -> Int? {
        let identifiers = candidates.indices.filter { candidates[$0].identifier == "VoiceOver" }
        guard identifiers.count <= 1 else { return nil }
        if let index = identifiers.first {
            return index
        }
        let labels = candidates.indices.filter { candidates[$0].label == "VoiceOver" }
        guard labels.count <= 1 else { return nil }
        if let index = labels.first {
            return index
        }
        switch location {
        case .accessibilityRow:
            return candidates.isEmpty ? nil : 0
        case .directSwitch:
            return nil
        case .subpageSwitch:
            return candidates.count == 1 ? 0 : nil
        }
    }

    @MainActor
    func setVoiceOver(enabled: Bool) throws {
        #if canImport(XCTest) && os(iOS)
            let settings = XCUIApplication(bundleIdentifier: Self.settingsBundleId)
            settings.activate()
            if let url = URL(string: Self.accessibilityDeepLink) {
                XCUIDevice.shared.system.open(url)
            }
            let directSwitches = settings.switches.allElementsBoundByIndex
            let directIndex = Self.matchingIndex(
                in: directSwitches.map { Candidate(identifier: $0.identifier, label: $0.label) },
                at: .directSwitch
            )
            let voSwitch: XCUIElement
            if let directIndex {
                voSwitch = directSwitches[directIndex]
            } else {
                guard settings.cells.firstMatch.waitForExistence(timeout: Self.switchExistenceTimeout) else {
                    throw VoiceOverToggleError.switchNotFound
                }
                let rows = settings.cells.allElementsBoundByIndex
                guard let rowIndex = Self.matchingIndex(
                    in: rows.map { Candidate(identifier: $0.identifier, label: $0.label) },
                    at: .accessibilityRow
                ) else {
                    throw VoiceOverToggleError.switchNotFound
                }
                rows[rowIndex].tap()
                guard settings.switches.firstMatch.waitForExistence(timeout: Self.switchExistenceTimeout) else {
                    throw VoiceOverToggleError.switchNotFound
                }
                let subpageSwitches = settings.switches.allElementsBoundByIndex
                guard let switchIndex = Self.matchingIndex(
                    in: subpageSwitches.map { Candidate(identifier: $0.identifier, label: $0.label) },
                    at: .subpageSwitch
                ) else {
                    throw VoiceOverToggleError.switchNotFound
                }
                voSwitch = subpageSwitches[switchIndex]
            }
            guard voSwitch.waitForExistence(timeout: Self.switchExistenceTimeout) else {
                throw VoiceOverToggleError.switchNotFound
            }
            if try VoiceOverSwitchState.decision(for: voSwitch.value, enabled: enabled) == .tapNeeded {
                voSwitch.tap()
            }
        #else
            throw VoiceOverToggleError.unsupportedPlatform
        #endif
    }
}
