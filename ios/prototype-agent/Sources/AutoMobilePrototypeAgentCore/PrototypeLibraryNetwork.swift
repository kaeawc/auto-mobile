import Foundation

/// One live consent gate is shared by every request and retained renderer configuration.
public enum PrototypeLibraryNetwork {
    #if canImport(Network)
        @MainActor
        public static func configuration(
            networkSwitch: PrototypeLibraryNetworkSwitch, allowsCleartext: Bool
        )
            -> PrototypeNetworkConfiguration
        {
            configuration(
                gate: networkSwitch.gate, allowsCleartext: allowsCleartext,
                onLocalNetworkDenied: { networkSwitch.denyLocalNetwork() },
                pinned: { cleartext in
                    PrototypeNetworkConfiguration(device: PrototypePinnedHttpClient(
                        allowsCleartext: cleartext,
                        onLocalNetworkDenied: { Task { @MainActor in networkSwitch.denyLocalNetwork() } }
                    ))
                }
            )
        }
    #endif

    @MainActor
    public static func configuration(
        gate: PrototypeLibraryNetworkGate, allowsCleartext: Bool,
        onLocalNetworkDenied: @escaping @MainActor @Sendable () -> Void = {},
        pinned: @escaping @MainActor @Sendable (Bool) -> PrototypeNetworkConfiguration
    )
        -> PrototypeNetworkConfiguration
    {
        PrototypeNetworkConfiguration(device: PrototypeLibraryGatedClient(
            gate: gate, factory: { pinned(allowsCleartext) }, onLocalNetworkDenied: onLocalNetworkDenied
        ))
    }
}
