import Foundation

// MARK: - Typed request envelope
//
// Ported from the reference `CtrlProxy` target's `Models.swift`. The WIRE FORMAT
// IS FROZEN: the same `type` discriminator strings (see `RequestType`) and the
// same JSON field names decode here. The ONLY change from the reference is
// Swift-6 concurrency hygiene — every public value type gains an explicit
// `Sendable` conformance (public value types get no implicit inference), so
// decoded payloads can cross the network-queue / actor boundaries the rewrite
// introduces. This target is organized one-type-per-file under `Models/`.
//
// This is the REQUEST (inbound) half of the wire model. The response envelopes +
// SDK result models are ported alongside the server/command layers in a later
// phase.

/// Typed WebSocket request from the automation client. Each case carries only the
/// fields its command uses. Decoded from the flat JSON `{ "type": ... }` envelope
/// by reading the `type` discriminator and decoding the matching payload from the
/// same container. `Sendable` (payloads are all Sendable value types).
public enum WebSocketRequest: Decodable, Sendable {
    case requestHierarchy(RequestHierarchy)
    case requestHierarchyIfStale(RequestHierarchy)
    case setHierarchyPollInterval(RequestSetHierarchyPollInterval)
    case requestScreenshot(RequestEnvelope)

    case tapCoordinates(RequestTapCoordinates)
    case swipe(RequestSwipe)
    case twoFingerSwipe(RequestMultiFingerSwipe)
    case multiFingerSwipe(RequestMultiFingerSwipe)
    case drag(RequestDrag)
    case pinch(RequestPinch)

    case setText(RequestSetText)
    case appendText(RequestAppendText)
    case clearText(RequestClearText)
    case imeAction(RequestImeAction)
    case selectAll(RequestEnvelope)
    case keyboard(RequestKeyboard)
    case pressButton(RequestPressButton)
    case pressHome(RequestEnvelope)
    case pressBack(RequestEnvelope)
    case shake(RequestEnvelope)
    case recentApps(RequestEnvelope)

    case action(RequestAction)
    case activateAccessibilityLink(RequestActivateAccessibilityLink)
    case launchApp(RequestLaunchApp)
    case resetPermissions(RequestResetPermissions)
    case rotate(RequestRotate)
    case clipboard(RequestClipboard)

    case getCurrentFocus(RequestEnvelope)
    case getTraversalOrder(RequestEnvelope)
    case addHighlight(RequestAddHighlight)
    case getVoiceOverState(RequestEnvelope)
    case setVoiceOverState(RequestSetVoiceOverState)

    case listPreferenceFiles(RequestEnvelope)
    case getPreferences(RequestGetPreferences)
    case getPreference(RequestGetPreference)
    case setPreference(RequestSetPreference)
    case removePreference(RequestRemovePreference)
    case clearPreferences(RequestClearPreferences)

    case setNetworkMockRules(RequestSetNetworkMockRules)
    case setNetworkFaultRules(RequestSetNetworkFaultRules)
    case setNetworkErrorSimulation(RequestSetNetworkErrorSimulation)

    case executeSql(RequestExecuteSql)
    case listDatabases(RequestListDatabases)
    case storageCapabilities(RequestStorageCapabilities)
    case listTables(RequestListTables)
    case getTableData(RequestGetTableData)
    case getTableStructure(RequestGetTableStructure)

    private enum DiscriminatorKey: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKey.self)
        let typeString = try container.decode(String.self, forKey: .type)
        guard let requestType = RequestType(rawValue: typeString) else {
            // Throw CommandError (a LocalizedError) rather than DecodingError so the
            // error surfaced on the wire is "Unknown command type: <type>", matched
            // by the TS client's rewriteUnknownCommandError.
            throw CommandError.unknownCommand(typeString)
        }

        switch requestType {
        case .requestHierarchy:
            self = try .requestHierarchy(RequestHierarchy(from: decoder))
        case .requestHierarchyIfStale:
            self = try .requestHierarchyIfStale(RequestHierarchy(from: decoder))
        case .setHierarchyPollInterval:
            self = try .setHierarchyPollInterval(RequestSetHierarchyPollInterval(from: decoder))
        case .requestScreenshot:
            self = try .requestScreenshot(RequestEnvelope(from: decoder))
        case .requestTapCoordinates:
            self = try .tapCoordinates(RequestTapCoordinates(from: decoder))
        case .requestSwipe:
            self = try .swipe(RequestSwipe(from: decoder))
        case .requestTwoFingerSwipe:
            self = try .twoFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestMultiFingerSwipe:
            self = try .multiFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestDrag:
            self = try .drag(RequestDrag(from: decoder))
        case .requestPinch:
            self = try .pinch(RequestPinch(from: decoder))
        case .requestSetText:
            self = try .setText(RequestSetText(from: decoder))
        case .requestAppendText:
            self = try .appendText(RequestAppendText(from: decoder))
        case .requestClearText:
            self = try .clearText(RequestClearText(from: decoder))
        case .requestImeAction:
            self = try .imeAction(RequestImeAction(from: decoder))
        case .requestSelectAll:
            self = try .selectAll(RequestEnvelope(from: decoder))
        case .requestKeyboard:
            self = try .keyboard(RequestKeyboard(from: decoder))
        case .requestPressButton:
            self = try .pressButton(RequestPressButton(from: decoder))
        case .requestPressHome:
            self = try .pressHome(RequestEnvelope(from: decoder))
        case .requestPressBack:
            self = try .pressBack(RequestEnvelope(from: decoder))
        case .requestShake:
            self = try .shake(RequestEnvelope(from: decoder))
        case .requestRecentApps:
            self = try .recentApps(RequestEnvelope(from: decoder))
        case .requestAction:
            self = try .action(RequestAction(from: decoder))
        case .requestActivateAccessibilityLink:
            self = try .activateAccessibilityLink(RequestActivateAccessibilityLink(from: decoder))
        case .requestLaunchApp:
            self = try .launchApp(RequestLaunchApp(from: decoder))
        case .requestResetPermissions:
            self = try .resetPermissions(RequestResetPermissions(from: decoder))
        case .requestRotate:
            self = try .rotate(RequestRotate(from: decoder))
        case .requestClipboard:
            self = try .clipboard(RequestClipboard(from: decoder))
        case .getCurrentFocus:
            self = try .getCurrentFocus(RequestEnvelope(from: decoder))
        case .getTraversalOrder:
            self = try .getTraversalOrder(RequestEnvelope(from: decoder))
        case .addHighlight:
            self = try .addHighlight(RequestAddHighlight(from: decoder))
        case .getVoiceOverState:
            self = try .getVoiceOverState(RequestEnvelope(from: decoder))
        case .setVoiceOverState:
            self = try .setVoiceOverState(RequestSetVoiceOverState(from: decoder))
        case .listPreferenceFiles:
            self = try .listPreferenceFiles(RequestEnvelope(from: decoder))
        case .getPreferences:
            self = try .getPreferences(RequestGetPreferences(from: decoder))
        case .getPreference:
            self = try .getPreference(RequestGetPreference(from: decoder))
        case .setPreference:
            self = try .setPreference(RequestSetPreference(from: decoder))
        case .removePreference:
            self = try .removePreference(RequestRemovePreference(from: decoder))
        case .clearPreferences:
            self = try .clearPreferences(RequestClearPreferences(from: decoder))
        case .setNetworkMockRules:
            self = try .setNetworkMockRules(RequestSetNetworkMockRules(from: decoder))
        case .setNetworkFaultRules:
            self = try .setNetworkFaultRules(RequestSetNetworkFaultRules(from: decoder))
        case .setNetworkErrorSimulation:
            self = try .setNetworkErrorSimulation(RequestSetNetworkErrorSimulation(from: decoder))
        case .executeSql:
            self = try .executeSql(RequestExecuteSql(from: decoder))
        case .listDatabases:
            self = try .listDatabases(RequestListDatabases(from: decoder))
        case .storageCapabilities:
            self = try .storageCapabilities(RequestStorageCapabilities(from: decoder))
        case .listTables:
            self = try .listTables(RequestListTables(from: decoder))
        case .getTableData:
            self = try .getTableData(RequestGetTableData(from: decoder))
        case .getTableStructure:
            self = try .getTableStructure(RequestGetTableStructure(from: decoder))
        }
    }

    /// The wire discriminator for this command.
    public var requestType: RequestType {
        switch self {
        case .requestHierarchy: return .requestHierarchy
        case .requestHierarchyIfStale: return .requestHierarchyIfStale
        case .setHierarchyPollInterval: return .setHierarchyPollInterval
        case .requestScreenshot: return .requestScreenshot
        case .tapCoordinates: return .requestTapCoordinates
        case .swipe: return .requestSwipe
        case .twoFingerSwipe: return .requestTwoFingerSwipe
        case .multiFingerSwipe: return .requestMultiFingerSwipe
        case .drag: return .requestDrag
        case .pinch: return .requestPinch
        case .setText: return .requestSetText
        case .appendText: return .requestAppendText
        case .clearText: return .requestClearText
        case .imeAction: return .requestImeAction
        case .selectAll: return .requestSelectAll
        case .keyboard: return .requestKeyboard
        case .pressButton: return .requestPressButton
        case .pressHome: return .requestPressHome
        case .pressBack: return .requestPressBack
        case .shake: return .requestShake
        case .recentApps: return .requestRecentApps
        case .action: return .requestAction
        case .activateAccessibilityLink: return .requestActivateAccessibilityLink
        case .launchApp: return .requestLaunchApp
        case .resetPermissions: return .requestResetPermissions
        case .rotate: return .requestRotate
        case .clipboard: return .requestClipboard
        case .getCurrentFocus: return .getCurrentFocus
        case .getTraversalOrder: return .getTraversalOrder
        case .addHighlight: return .addHighlight
        case .getVoiceOverState: return .getVoiceOverState
        case .setVoiceOverState: return .setVoiceOverState
        case .listPreferenceFiles: return .listPreferenceFiles
        case .getPreferences: return .getPreferences
        case .getPreference: return .getPreference
        case .setPreference: return .setPreference
        case .removePreference: return .removePreference
        case .clearPreferences: return .clearPreferences
        case .setNetworkMockRules: return .setNetworkMockRules
        case .setNetworkFaultRules: return .setNetworkFaultRules
        case .setNetworkErrorSimulation: return .setNetworkErrorSimulation
        case .executeSql: return .executeSql
        case .listDatabases: return .listDatabases
        case .storageCapabilities: return .storageCapabilities
        case .listTables: return .listTables
        case .getTableData: return .getTableData
        case .getTableStructure: return .getTableStructure
        }
    }

    /// The wire discriminator string for this command.
    public var typeString: String {
        requestType.rawValue
    }

    /// This command's payload, as the shared `CommandPayload` protocol.
    public var payload: CommandPayload {
        switch self {
        case let .requestHierarchy(payload), let .requestHierarchyIfStale(payload):
            return payload
        case let .setHierarchyPollInterval(payload): return payload
        case let .requestScreenshot(payload),
             let .selectAll(payload),
             let .pressHome(payload),
             let .pressBack(payload),
             let .shake(payload),
             let .recentApps(payload),
             let .getCurrentFocus(payload),
             let .getTraversalOrder(payload),
             let .getVoiceOverState(payload),
             let .listPreferenceFiles(payload):
            return payload
        case let .setVoiceOverState(payload): return payload
        case let .tapCoordinates(payload): return payload
        case let .swipe(payload): return payload
        case let .twoFingerSwipe(payload), let .multiFingerSwipe(payload):
            return payload
        case let .drag(payload): return payload
        case let .pinch(payload): return payload
        case let .setText(payload): return payload
        case let .appendText(payload): return payload
        case let .clearText(payload): return payload
        case let .imeAction(payload): return payload
        case let .keyboard(payload): return payload
        case let .pressButton(payload): return payload
        case let .action(payload): return payload
        case let .activateAccessibilityLink(payload): return payload
        case let .launchApp(payload): return payload
        case let .resetPermissions(payload): return payload
        case let .rotate(payload): return payload
        case let .clipboard(payload): return payload
        case let .addHighlight(payload): return payload
        case let .getPreferences(payload): return payload
        case let .getPreference(payload): return payload
        case let .setPreference(payload): return payload
        case let .removePreference(payload): return payload
        case let .clearPreferences(payload): return payload
        case let .setNetworkMockRules(payload): return payload
        case let .setNetworkFaultRules(payload): return payload
        case let .setNetworkErrorSimulation(payload): return payload
        case let .executeSql(payload): return payload
        case let .listDatabases(payload): return payload
        case let .storageCapabilities(payload): return payload
        case let .listTables(payload): return payload
        case let .getTableData(payload): return payload
        case let .getTableStructure(payload): return payload
        }
    }

    /// The client-supplied correlation id, if any.
    public var requestId: String? {
        payload.requestId
    }
}
