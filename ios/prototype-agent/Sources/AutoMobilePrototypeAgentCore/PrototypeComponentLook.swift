import Foundation

/// A small per-node decision seam. Coverage alone cannot opt a renderer into native drawing:
/// a registered decision and its reachable identifiers must agree with the contract.
enum PrototypeComponentLook {
    case material, platform

    struct Coverage: Decodable, Sendable {
        let ios: String
        let parts: [String]?
        let reason: String?
    }

    static let registeredParts: [String: [String]] = [
        "button": ["self"], "slider": ["self"], "datePicker": ["self"],
        "timePicker": ["self"], "pasteButton": ["self"], "switch": ["self"], "checkbox": ["self"],
    ]

    static let coverage: [String: Coverage] = {
        struct Contract: Decodable { let designCoverage: [String: Coverage] }
        return (try? JSONDecoder().decode(Contract.self, from: Data(prototypeSpecContractData.utf8)))?
            .designCoverage ?? [:]
    }()

    static func resolve(type: String, design: PrototypeDesign?) -> Self {
        guard design != .material, let entry = coverage[type], entry.ios == "native",
              let parts = registeredParts[type], !parts.isEmpty, entry.parts == parts
        else { return .material }
        return .platform
    }

    enum IdentifierOwner { case renderer, toggle }

    /// The styled toggle's Button owns its tag; an outer wrapper must not create a second element.
    static func identifier(
        type: String,
        design: PrototypeDesign?,
        testTag: String?,
        owner: IdentifierOwner,
        part: String = "self"
    )
        -> String?
    {
        let ownsToggle = (type == "switch" || type == "checkbox") && resolve(type: type, design: design) == .platform
        guard owner == (ownsToggle ? .toggle : .renderer) else { return nil }
        return testTag.map { part == "self" ? $0 : "\($0).\(part)" }
    }

    static func toggleAccessibilityValue(type: String, isOn: Bool) -> String {
        type == "checkbox" ? (isOn ? "checked" : "unchecked") : (isOn ? "1" : "0")
    }

    static func capability(for type: String) -> String { "prototype_design_ios_\(type)_v1" }

    static var capabilities: [String] {
        registeredParts.keys.sorted().filter { resolve(type: $0, design: .platform) == .platform }
            .map { capability(for: $0) }
    }

    /// Native toggles have no completion callback. Bound their activity conservatively to the
    /// explicit transaction duration; off has no animation or pending timer.
    static func trackToggleMotion(profile: PrototypeMotionProfile, owner: UUID, activity: PrototypeKeyframeActivity) {
        let duration = toggleDurationMs(profile: profile)
        if duration == 0 { activity.stop(owner: owner) }
        else { activity.play(owner: owner, durationMs: duration) }
    }

    static func toggleDurationMs(profile: PrototypeMotionProfile) -> Int {
        profile == .off ? 0 : 300
    }
}
