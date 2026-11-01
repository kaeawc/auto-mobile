import Foundation

// MARK: - Typed request envelope

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
    case pathGesture(RequestPathGesture)

    case setText(RequestSetText)
    case appendText(RequestAppendText)
    case clearText(RequestClearText)
    case imeAction(RequestImeAction)
    case selectAll(RequestEnvelope)
    case pressKey(RequestPressKey)
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
    case location(RequestLocation)
    case setHingeAngle(RequestSetHingeAngle)
    case appearance(RequestAppearance)
    case siri(RequestSiri)
    case clipboard(RequestClipboard)

    case getCurrentFocus(RequestEnvelope)
    case getTraversalOrder(RequestEnvelope)
    case addHighlight(RequestAddHighlight)
    case magicTap(RequestEnvelope)
    case sdkTrigger(RequestSdkTrigger)
    case sdkObservation(RequestEnvelope)
    case sdkAction(RequestSdkAction)
    case sdkWebSnapshot(RequestSdkWebSnapshot)
    case sdkWebAction(RequestSdkWebAction)
    case getVoiceOverState(RequestEnvelope)
    case accessibilityAudit(RequestAccessibilityAudit)
    case setVoiceOverState(RequestSetVoiceOverState)

    case listPreferenceFiles(RequestEnvelope)
    case getPreferences(RequestGetPreferences)
    case getPreference(RequestGetPreference)
    case setPreference(RequestSetPreference)
    case removePreference(RequestRemovePreference)
    case clearPreferences(RequestClearPreferences)
    case deleteKeychainItem(RequestDeleteKeychainItem)

    case setNetworkMockRules(RequestSetNetworkMockRules)
    case setNetworkFaultRules(RequestSetNetworkFaultRules)
    case setNetworkErrorSimulation(RequestSetNetworkErrorSimulation)
    case getSdkCapabilities(RequestEnvelope)

    case queryCoreData(RequestQueryCoreData)
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
            // so the TS client can report an outdated runner.
            throw CommandError.unknownCommand(typeString)
        }

        self = try Self.decode(requestType, from: decoder)
    }

    private static func decode(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestHierarchy, .requestHierarchyIfStale, .setHierarchyPollInterval, .requestScreenshot:
            return try decodeHierarchy(requestType, from: decoder)
        case .requestTapCoordinates, .requestSwipe, .requestTwoFingerSwipe, .requestMultiFingerSwipe, .requestDrag,
             .requestPinch, .requestPathGesture:
            return try decodeGesture(requestType, from: decoder)
        case .requestSetText, .requestAppendText, .requestClearText, .requestImeAction, .requestSelectAll,
             .requestPressKey, .requestKeyboard:
            return try decodeTextInput(requestType, from: decoder)
        case .requestPressButton, .requestPressHome, .requestPressBack, .requestShake, .requestRecentApps:
            return try decodeNavigation(requestType, from: decoder)
        case .requestAction, .requestActivateAccessibilityLink, .requestLaunchApp, .requestResetPermissions,
             .requestRotate, .requestLocation, .setHingeAngle, .requestAppearance, .requestSiri, .requestClipboard:
            return try decodeAppAndDevice(requestType, from: decoder)
        case .getCurrentFocus, .getTraversalOrder, .addHighlight, .magicTap, .sdkTrigger, .getVoiceOverState,
             .setVoiceOverState, .requestAccessibilityAudit, .sdkObservation, .sdkAction, .sdkWebSnapshot,
             .sdkWebAction:
            return try decodeAccessibility(requestType, from: decoder)
        case .listPreferenceFiles, .getPreferences, .getPreference, .setPreference, .removePreference,
             .clearPreferences, .deleteKeychainItem:
            return try decodePreferences(requestType, from: decoder)
        case .setNetworkMockRules, .setNetworkFaultRules, .setNetworkErrorSimulation, .getSdkCapabilities:
            return try decodeNetwork(requestType, from: decoder)
        case .queryCoreData, .executeSql, .listDatabases, .storageCapabilities, .listTables, .getTableData, .getTableStructure:
            return try decodeDatabase(requestType, from: decoder)
        }
    }

    private static func decodeHierarchy(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestHierarchy:
            return try .requestHierarchy(RequestHierarchy(from: decoder))
        case .requestHierarchyIfStale:
            return try .requestHierarchyIfStale(RequestHierarchy(from: decoder))
        case .setHierarchyPollInterval:
            return try .setHierarchyPollInterval(RequestSetHierarchyPollInterval(from: decoder))
        case .requestScreenshot:
            return try .requestScreenshot(RequestEnvelope(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeGesture(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestTapCoordinates:
            return try .tapCoordinates(RequestTapCoordinates(from: decoder))
        case .requestSwipe:
            return try .swipe(RequestSwipe(from: decoder))
        case .requestTwoFingerSwipe:
            return try .twoFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestMultiFingerSwipe:
            return try .multiFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestDrag:
            return try .drag(RequestDrag(from: decoder))
        case .requestPinch:
            return try .pinch(RequestPinch(from: decoder))
        case .requestPathGesture:
            return try .pathGesture(RequestPathGesture(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeTextInput(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestSetText:
            return try .setText(RequestSetText(from: decoder))
        case .requestAppendText:
            return try .appendText(RequestAppendText(from: decoder))
        case .requestClearText:
            return try .clearText(RequestClearText(from: decoder))
        case .requestImeAction:
            return try .imeAction(RequestImeAction(from: decoder))
        case .requestSelectAll:
            return try .selectAll(RequestEnvelope(from: decoder))
        case .requestPressKey:
            return try .pressKey(RequestPressKey(from: decoder))
        case .requestKeyboard:
            return try .keyboard(RequestKeyboard(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeNavigation(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestPressButton:
            return try .pressButton(RequestPressButton(from: decoder))
        case .requestPressHome:
            return try .pressHome(RequestEnvelope(from: decoder))
        case .requestPressBack:
            return try .pressBack(RequestEnvelope(from: decoder))
        case .requestShake:
            return try .shake(RequestEnvelope(from: decoder))
        case .requestRecentApps:
            return try .recentApps(RequestEnvelope(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeAppAndDevice(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .requestAction:
            return try .action(RequestAction(from: decoder))
        case .requestActivateAccessibilityLink:
            return try .activateAccessibilityLink(RequestActivateAccessibilityLink(from: decoder))
        case .requestLaunchApp:
            return try .launchApp(RequestLaunchApp(from: decoder))
        case .requestResetPermissions:
            return try .resetPermissions(RequestResetPermissions(from: decoder))
        case .requestRotate:
            return try .rotate(RequestRotate(from: decoder))
        case .requestLocation:
            return try .location(RequestLocation(from: decoder))
        case .setHingeAngle:
            return try .setHingeAngle(RequestSetHingeAngle(from: decoder))
        case .requestAppearance:
            return try .appearance(RequestAppearance(from: decoder))
        case .requestSiri:
            return try .siri(RequestSiri(from: decoder))
        case .requestClipboard:
            return try .clipboard(RequestClipboard(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeAccessibility(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .getCurrentFocus:
            return try .getCurrentFocus(RequestEnvelope(from: decoder))
        case .getTraversalOrder:
            return try .getTraversalOrder(RequestEnvelope(from: decoder))
        case .addHighlight:
            return try .addHighlight(RequestAddHighlight(from: decoder))
        case .magicTap:
            return try .magicTap(RequestEnvelope(from: decoder))
        case .sdkTrigger:
            return try .sdkTrigger(RequestSdkTrigger(from: decoder))
        case .sdkObservation:
            return try .sdkObservation(RequestEnvelope(from: decoder))
        case .sdkAction:
            return try .sdkAction(RequestSdkAction(from: decoder))
        case .sdkWebSnapshot:
            return try .sdkWebSnapshot(RequestSdkWebSnapshot(from: decoder))
        case .sdkWebAction:
            return try .sdkWebAction(RequestSdkWebAction(from: decoder))
        case .getVoiceOverState:
            return try .getVoiceOverState(RequestEnvelope(from: decoder))
        case .setVoiceOverState:
            return try .setVoiceOverState(RequestSetVoiceOverState(from: decoder))
        case .requestAccessibilityAudit:
            return try .accessibilityAudit(RequestAccessibilityAudit(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodePreferences(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .listPreferenceFiles:
            return try .listPreferenceFiles(RequestEnvelope(from: decoder))
        case .getPreferences:
            return try .getPreferences(RequestGetPreferences(from: decoder))
        case .getPreference:
            return try .getPreference(RequestGetPreference(from: decoder))
        case .setPreference:
            return try .setPreference(RequestSetPreference(from: decoder))
        case .removePreference:
            return try .removePreference(RequestRemovePreference(from: decoder))
        case .deleteKeychainItem:
            return try .deleteKeychainItem(RequestDeleteKeychainItem(from: decoder))
        case .clearPreferences:
            return try .clearPreferences(RequestClearPreferences(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeNetwork(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .setNetworkMockRules:
            return try .setNetworkMockRules(RequestSetNetworkMockRules(from: decoder))
        case .setNetworkFaultRules:
            return try .setNetworkFaultRules(RequestSetNetworkFaultRules(from: decoder))
        case .setNetworkErrorSimulation:
            return try .setNetworkErrorSimulation(RequestSetNetworkErrorSimulation(from: decoder))
        case .getSdkCapabilities:
            return try .getSdkCapabilities(RequestEnvelope(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
        }
    }

    private static func decodeDatabase(_ requestType: RequestType, from decoder: Decoder) throws -> Self {
        switch requestType {
        case .queryCoreData:
            return try .queryCoreData(RequestQueryCoreData(from: decoder))
        case .executeSql:
            return try .executeSql(RequestExecuteSql(from: decoder))
        case .listDatabases:
            return try .listDatabases(RequestListDatabases(from: decoder))
        case .storageCapabilities:
            return try .storageCapabilities(RequestStorageCapabilities(from: decoder))
        case .listTables:
            return try .listTables(RequestListTables(from: decoder))
        case .getTableData:
            return try .getTableData(RequestGetTableData(from: decoder))
        case .getTableStructure:
            return try .getTableStructure(RequestGetTableStructure(from: decoder))
        default:
            throw CommandError.unknownCommand(requestType.rawValue)
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
        case .pathGesture: return .requestPathGesture
        case .setText: return .requestSetText
        case .appendText: return .requestAppendText
        case .clearText: return .requestClearText
        case .imeAction: return .requestImeAction
        case .selectAll: return .requestSelectAll
        case .pressKey: return .requestPressKey
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
        case .location: return .requestLocation
        case .setHingeAngle: return .setHingeAngle
        case .appearance: return .requestAppearance
        case .siri: return .requestSiri
        case .clipboard: return .requestClipboard
        case .getCurrentFocus: return .getCurrentFocus
        case .getTraversalOrder: return .getTraversalOrder
        case .addHighlight: return .addHighlight
        case .magicTap: return .magicTap
        case .sdkTrigger: return .sdkTrigger
        case .sdkObservation: return .sdkObservation
        case .sdkAction: return .sdkAction
        case .sdkWebSnapshot: return .sdkWebSnapshot
        case .sdkWebAction: return .sdkWebAction
        case .getVoiceOverState: return .getVoiceOverState
        case .setVoiceOverState: return .setVoiceOverState
        case .accessibilityAudit: return .requestAccessibilityAudit
        case .listPreferenceFiles: return .listPreferenceFiles
        case .getPreferences: return .getPreferences
        case .getPreference: return .getPreference
        case .setPreference: return .setPreference
        case .removePreference: return .removePreference
        case .deleteKeychainItem: return .deleteKeychainItem
        case .clearPreferences: return .clearPreferences
        case .setNetworkMockRules: return .setNetworkMockRules
        case .setNetworkFaultRules: return .setNetworkFaultRules
        case .setNetworkErrorSimulation: return .setNetworkErrorSimulation
        case .getSdkCapabilities: return .getSdkCapabilities
        case .queryCoreData: return .queryCoreData
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
             let .magicTap(payload),
             let .getVoiceOverState(payload),
             let .listPreferenceFiles(payload),
             let .getSdkCapabilities(payload):
            return payload
        case let .setVoiceOverState(payload): return payload
        case let .accessibilityAudit(payload): return payload
        case let .sdkTrigger(payload): return payload
        case let .sdkObservation(payload): return payload
        case let .sdkAction(payload): return payload
        case let .sdkWebSnapshot(payload): return payload
        case let .sdkWebAction(payload): return payload
        case let .setHingeAngle(payload): return payload
        case let .appearance(payload): return payload
        case let .siri(payload): return payload
        case let .tapCoordinates(payload): return payload
        case let .swipe(payload): return payload
        case let .twoFingerSwipe(payload), let .multiFingerSwipe(payload):
            return payload
        case let .drag(payload): return payload
        case let .pinch(payload): return payload
        case let .pathGesture(payload): return payload
        case let .setText(payload): return payload
        case let .appendText(payload): return payload
        case let .clearText(payload): return payload
        case let .imeAction(payload): return payload
        case let .pressKey(payload): return payload
        case let .keyboard(payload): return payload
        case let .pressButton(payload): return payload
        case let .action(payload): return payload
        case let .activateAccessibilityLink(payload): return payload
        case let .launchApp(payload): return payload
        case let .resetPermissions(payload): return payload
        case let .rotate(payload): return payload
        case let .location(payload): return payload
        case let .clipboard(payload): return payload
        case let .addHighlight(payload): return payload
        case let .getPreferences(payload): return payload
        case let .getPreference(payload): return payload
        case let .setPreference(payload): return payload
        case let .removePreference(payload): return payload
        case let .deleteKeychainItem(payload): return payload
        case let .clearPreferences(payload): return payload
        case let .setNetworkMockRules(payload): return payload
        case let .setNetworkFaultRules(payload): return payload
        case let .setNetworkErrorSimulation(payload): return payload
        case let .queryCoreData(payload): return payload
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
