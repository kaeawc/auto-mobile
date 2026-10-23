/// The HTTP routes the in-app SDK serves and the runner calls, with their methods. The SDK's route
/// table dispatches on this enum and the runner builds its requests from it, so a path or method
/// cannot drift between the two packages.
public enum SdkRoute: String, CaseIterable, Sendable {
    case cachedHierarchy = "/hierarchy"
    case freshHierarchy = "/hierarchy/fresh"
    case health = "/health"
    case networkMock = "/network/mock"
    case networkErrorSimulation = "/network/error-simulation"
    case networkFaultRules = "/network/fault-rules"
    case magicTap = "/accessibility/magic-tap"
    case highlight = "/highlight"
    case dbExecute = "/db/execute"
    case dbList = "/db/list"
    case dbCapabilities = "/db/capabilities"
    case dbTables = "/db/tables"
    case dbTableData = "/db/table-data"
    case dbTableStructure = "/db/table-structure"
    case keychainDelete = "/keychain/delete"
    case preferences = "/preferences"
    case trigger = "/trigger"

    /// The path, starting with `/`.
    public var path: String { rawValue }

    public var method: String {
        switch self {
        case .cachedHierarchy, .freshHierarchy, .health: return "GET"
        default: return "POST"
        }
    }
}
