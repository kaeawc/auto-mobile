import Foundation

/// The OS major version a capability is advertised against. Injected so tests cover every tier
/// without a simulator (#15242).
protocol OSVersionProvider {
    var majorVersion: Int { get }
}

struct ProcessInfoOSVersion: OSVersionProvider {
    var majorVersion: Int { ProcessInfo.processInfo.operatingSystemVersion.majorVersion }
}

/// Minimum iOS major version for each capability whose renderer needs a runtime newer than the
/// package floor (iOS 17), for example `prototype_zoom_transition_v1: 18` or `prototype_glass_v1: 26`.
/// A capability absent from the table runs on the floor. Every renderer branch behind `#available`
/// needs an entry here, and the host table `PROTOTYPE_IOS_MINIMUM_OS` in
/// `src/features/prototype/prototypeIosMinimumOs.ts` must carry the same entries so its refusal can
/// name the version; `test/features/prototype/prototypeIosMinimumOs.test.ts` fails when they drift.
enum PrototypeCapabilityMinimumOS {
    static let table = [
        "prototype_icon_effects_v1": 17,
        "prototype_glass_v1": 26,
        "prototype_keyframes_v1": 17,
        "prototype_zoom_transition_v1": 18,
    ]
}

extension PrototypeAgentProtocol {
    /// The capabilities to advertise on this OS: the full list minus those whose minimum is newer.
    static func advertisedCapabilities(
        os: any OSVersionProvider = ProcessInfoOSVersion(),
        minimumOS: [String: Int] = PrototypeCapabilityMinimumOS.table,
        registryCapabilities: [String] = []
    )
        -> [String]
    {
        (capabilities + registryCapabilities.filter { !capabilities.contains($0) }.sorted())
            .filter { (minimumOS[$0] ?? 0) <= os.majorVersion }
    }
}

/// Spec feature capabilities supported by the native prototype renderer.
public enum AutoMobilePrototypeCapabilities {
    /// Derived from the agent's advertised capabilities so embedded renderers share its contract.
    public static let supported: [String] = PrototypeAgentProtocol.advertisedCapabilities()
        .filter { $0.hasPrefix("prototype_") }
        .sorted()
}
