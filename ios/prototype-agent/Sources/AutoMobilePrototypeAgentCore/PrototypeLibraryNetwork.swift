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
                onLocalNetworkDenied: { epoch in networkSwitch.denyLocalNetwork(epoch: epoch) },
                pinned: { cleartext, epoch in
                    PrototypeNetworkConfiguration(device: PrototypePinnedHttpClient(
                        allowsCleartext: cleartext,
                        onLocalNetworkDenied: { Task { @MainActor in networkSwitch.denyLocalNetwork(epoch: epoch) } }
                    ))
                }
            )
        }
    #endif

    @MainActor
    public static func configuration(
        gate: PrototypeLibraryNetworkGate, allowsCleartext: Bool,
        onLocalNetworkDenied: @escaping @MainActor @Sendable (PrototypeConsentEpoch) -> Void = { _ in },
        pinned: @escaping @MainActor @Sendable (Bool, PrototypeConsentEpoch) -> PrototypeNetworkConfiguration
    )
        -> PrototypeNetworkConfiguration
    {
        PrototypeNetworkConfiguration(device: PrototypeLibraryGatedClient(
            gate: gate, factory: { epoch in pinned(allowsCleartext, epoch) }, onLocalNetworkDenied: onLocalNetworkDenied
        ))
    }
}
