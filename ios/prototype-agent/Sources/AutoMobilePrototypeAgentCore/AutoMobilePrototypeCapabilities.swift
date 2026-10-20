/// Spec feature capabilities supported by the native prototype renderer.
public enum AutoMobilePrototypeCapabilities {
    /// Derived from the agent's advertised capabilities so embedded renderers share its contract.
    public static let supported: [String] = PrototypeAgentProtocol.capabilities
        .filter { $0.hasPrefix("prototype_") }
        .sorted()
}
