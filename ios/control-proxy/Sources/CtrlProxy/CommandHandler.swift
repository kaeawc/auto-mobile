import Foundation

enum SdkHierarchyProbeDecision: Equatable {
    case probe
    case skip
    case clear

    static func decide(
        foregroundBundleId: String,
        cachedBundleId: String?,
        appState: ObservedAppState?,
        cacheIsFresh: Bool = true
    )
        -> Self
    {
        if foregroundBundleId == "com.apple.springboard" {
            return cachedBundleId == nil ? .skip : .clear
        }
        if let cachedBundleId, cachedBundleId != foregroundBundleId {
            return .clear
        }
        if appState != .runningForeground {
            return cachedBundleId == nil ? .skip : .clear
        }
        // A same-app snapshot taken before the XCUITest capture can describe the previous
        // screen (in-app navigation delivers no SDK event to this runner), so re-fetch it.
        return cachedBundleId == nil || !cacheIsFresh ? .probe : .skip
    }

    /// Whether `cached` was taken at or after the XCUITest capture it will be merged into.
    /// Both stamps are epoch milliseconds (the merger compares them the same way).
    static func isFresh(cachedTimestamp: Int64?, captureTimestamp: Int64) -> Bool {
        guard let cachedTimestamp else { return true }
        return cachedTimestamp >= captureTimestamp
    }
}

final class CommandHandler: CommandHandling {
    /// `handle(_:)` exhaustively dispatches every decoded request. Filter only
    /// commands whose handler's default collaborator cannot serve this runtime.
    static func supportedRequestTypes(in environment: RunnerEnvironment) -> [RequestType] {
        RequestType.allCases.filter { requestType in
            switch requestType {
            case .setVoiceOverState:
                // DefaultVoiceOverToggle drives Settings on a physical device.
                return environment == .device
            case .setHingeAngle:
                // DefaultHingeAngleSetter has a simulator-only implementation.
                return environment == .simulator
            default:
                // The exhaustive WebSocketRequest decoder and dispatch switch
                // guarantee a dispatch path for every other RequestType.
                return true
            }
        }
    }

    let elementLocator: any ElementLocating
    let gesturePerformer: any GesturePerforming
    let perf: any PerfTracking
    let sdkHierarchyClient: (any SdkHierarchyFetching)?
    let sdkHierarchyCache: (any SdkHierarchyCaching)?
    let sdkDatabaseClient: (any SdkDatabaseFetching)?
    let sdkKeychainClient: (any SdkKeychainDeleting)?
    let sdkPreferenceClient: (any SdkPreferenceFetching)?
    let hierarchyDebouncer: (any HierarchyDebouncing)?
    let voiceOverStateProvider: any VoiceOverStateProviding
    let voiceOverToggle: any VoiceOverToggling
    let locationSimulator: any LocationSimulating
    let hingeAngleSetter: any HingeAngleSetting
    let accessibilityAuditor: any AccessibilityAuditing
    let appearanceControl: any AppearanceControlling
    let siriControl: any SiriControlling
    let frameContext: FrameContext
    let rotationTimer: any ProxyTimer
    let hierarchyPairRecorder: (any HierarchyPairRecording)?

    init(
        elementLocator: any ElementLocating,
        gesturePerformer: any GesturePerforming,
        perf: any PerfTracking,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil,
        sdkKeychainClient: (any SdkKeychainDeleting)? = nil,
        sdkPreferenceClient: (any SdkPreferenceFetching)? = nil,
        hierarchyDebouncer: (any HierarchyDebouncing)? = nil,
        voiceOverStateProvider: any VoiceOverStateProviding = DefaultVoiceOverStateProvider(),
        voiceOverToggle: any VoiceOverToggling = DefaultVoiceOverToggle(),
        locationSimulator: any LocationSimulating = DefaultLocationSimulator(),
        hingeAngleSetter: any HingeAngleSetting = DefaultHingeAngleSetter(),
        accessibilityAuditor: any AccessibilityAuditing = DefaultAccessibilityAuditor(),
        appearanceControl: any AppearanceControlling = DefaultAppearanceControl(),
        siriControl: any SiriControlling = DefaultSiriControl(),
        frameContext: FrameContext = FrameContext(),
        rotationTimer: any ProxyTimer = SystemTimer(),
        hierarchyPairRecorder: (any HierarchyPairRecording)? = nil
    ) {
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.perf = perf
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkHierarchyCache = sdkHierarchyCache
        self.sdkDatabaseClient = sdkDatabaseClient
        self.sdkKeychainClient = sdkKeychainClient
        self.sdkPreferenceClient = sdkPreferenceClient
        self.hierarchyDebouncer = hierarchyDebouncer
        self.voiceOverStateProvider = voiceOverStateProvider
        self.voiceOverToggle = voiceOverToggle
        self.locationSimulator = locationSimulator
        self.hingeAngleSetter = hingeAngleSetter
        self.accessibilityAuditor = accessibilityAuditor
        self.appearanceControl = appearanceControl
        self.siriControl = siriControl
        self.frameContext = frameContext
        self.rotationTimer = rotationTimer
        self.hierarchyPairRecorder = hierarchyPairRecorder
    }

    /// Handle an incoming request and return a response.
    ///
    /// Dispatch is exhaustive over the typed `WebSocketRequest` enum: adding a new
    /// command case without a branch here fails compilation, so the dispatch table can
    /// never silently drop a command.
    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload {
        await handle(request, deadlineMs: nil, monotonicNowMs: { 0 })
    }

    func handle(
        _ request: WebSocketRequest, deadlineMs: Int64?, monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async -> any WebSocketResponsePayload
    {
        let startTime = Date()

        if request.requestType != .requestPressKey {
            await gesturePerformer.invalidateCaretMemo()
        }

        do {
            return try await dispatch(
                request, startTime: startTime, deadlineMs: deadlineMs, monotonicNowMs: monotonicNowMs
            )
        } catch {
            // Frame-context rejection can precede pressKeyOutcome's consume step.
            if request.requestType == .requestPressKey {
                await gesturePerformer.invalidateCaretMemo()
            }
            if case CommandError.deadlineExceeded = error {
                GesturePhaseDiagnostics.current?.markDeadlineExceeded()
            }
            return WebSocketResponse.error(
                type: request.requestType.responseType.rawValue,
                requestId: request.requestId,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime),
                errorCode: WireError.code(for: error)
            )
        }
    }

    private func dispatch(
        _ request: WebSocketRequest, startTime: Date, deadlineMs: Int64?,
        monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case .requestHierarchy, .requestHierarchyIfStale, .setHierarchyPollInterval, .requestScreenshot:
            return try await dispatchHierarchy(request, startTime: startTime)
        case .tapCoordinates, .swipe, .twoFingerSwipe, .multiFingerSwipe, .drag, .pinch, .pathGesture:
            return try await dispatchGesture(
                request,
                startTime: startTime,
                deadlineMs: deadlineMs,
                monotonicNowMs: monotonicNowMs
            )
        case .setText, .appendText, .clearText, .imeAction, .selectAll, .pressKey, .keyboard:
            return try await dispatchTextInput(request, startTime: startTime)
        case .pressButton, .pressHome, .pressBack, .shake, .recentApps:
            return try await dispatchNavigation(request, startTime: startTime)
        case .action, .activateAccessibilityLink, .launchApp, .resetPermissions, .rotate, .location, .setHingeAngle,
             .appearance, .siri, .clipboard:
            return try await dispatchAppAndDevice(request, startTime: startTime)
        case .getCurrentFocus, .getTraversalOrder, .addHighlight, .magicTap, .sdkTrigger, .getVoiceOverState,
             .setVoiceOverState, .accessibilityAudit, .sdkObservation, .sdkAction, .sdkWebSnapshot, .sdkWebAction:
            return try await dispatchAccessibility(request, startTime: startTime)
        case .listPreferenceFiles, .getPreferences, .getPreference, .setPreference, .removePreference,
             .clearPreferences, .deleteKeychainItem:
            return try await dispatchPreferences(request, startTime: startTime)
        case .setNetworkMockRules, .setNetworkFaultRules, .setNetworkErrorSimulation, .getSdkCapabilities:
            return try await dispatchNetwork(request, startTime: startTime)
        case .queryCoreData, .executeSql, .listDatabases, .storageCapabilities, .listTables, .getTableData, .getTableStructure:
            return try await dispatchDatabase(request, startTime: startTime)
        }
    }

    // On iOS, request_hierarchy_if_stale always captures fresh, just like
    // request_hierarchy. sinceTimestamp does not enable cache reuse: there is
    // no UI-change signal, and polls can miss a change.
    private func dispatchHierarchy(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .requestHierarchy(payload):
            return try await handleRequestHierarchy(payload, startTime: startTime)
        case let .requestHierarchyIfStale(payload):
            return try await handleRequestHierarchyIfStale(payload, startTime: startTime)
        case let .setHierarchyPollInterval(payload):
            return try await handleSetHierarchyPollInterval(payload, startTime: startTime)
        case let .requestScreenshot(payload):
            return try await handleRequestScreenshot(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchGesture(
        _ request: WebSocketRequest, startTime: Date, deadlineMs: Int64?,
        monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .tapCoordinates(payload):
            return try await handleTapCoordinates(payload, startTime: startTime)
        case let .swipe(payload):
            return try await handleSwipe(
                payload, startTime: startTime, deadlineMs: deadlineMs, monotonicNowMs: monotonicNowMs
            )
        case let .twoFingerSwipe(payload), let .multiFingerSwipe(payload):
            return try await handleMultiFingerSwipe(payload, startTime: startTime)
        case let .drag(payload):
            return try await handleDrag(payload, startTime: startTime)
        case let .pinch(payload):
            return try await handlePinch(payload, startTime: startTime)
        case let .pathGesture(payload):
            return try await handlePathGesture(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchTextInput(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .setText(payload):
            return try await handleSetText(payload, startTime: startTime)
        case let .appendText(payload):
            return try await handleAppendText(payload, startTime: startTime)
        case let .clearText(payload):
            return try await handleClearText(payload, startTime: startTime)
        case let .imeAction(payload):
            return try await handleImeAction(payload, startTime: startTime)
        case let .selectAll(payload):
            return try await handleSelectAll(payload, startTime: startTime)
        case let .pressKey(payload):
            return try await handlePressKey(payload, startTime: startTime)
        case let .keyboard(payload):
            return try await handleKeyboard(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchNavigation(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .pressButton(payload):
            return try await handlePressButton(payload, startTime: startTime)
        case let .pressHome(payload):
            return try await handlePressHome(payload, startTime: startTime)
        case let .pressBack(payload):
            return try await handlePressBack(payload, startTime: startTime)
        case let .shake(payload):
            return try await handleShake(payload, startTime: startTime)
        case let .recentApps(payload):
            return try await handleRecentApps(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchAppAndDevice(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .action(payload):
            return try await handleAction(payload, startTime: startTime)
        case let .activateAccessibilityLink(payload):
            return try await handleActivateAccessibilityLink(payload, startTime: startTime)
        case let .launchApp(payload):
            return try await handleLaunchApp(payload, startTime: startTime)
        case let .resetPermissions(payload):
            return try await handleResetPermissions(payload, startTime: startTime)
        case let .rotate(payload):
            return try await handleRotate(payload, startTime: startTime)
        case let .location(payload):
            return try await handleLocation(payload, startTime: startTime)
        case let .setHingeAngle(payload):
            return await handleSetHingeAngle(payload, startTime: startTime)
        case let .appearance(payload):
            return try await handleAppearance(payload, startTime: startTime)
        case let .siri(payload):
            return try await handleSiri(payload, startTime: startTime)
        case let .clipboard(payload):
            return try await handleClipboard(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchAccessibility(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .getCurrentFocus(payload):
            return try await handleGetCurrentFocus(payload, startTime: startTime)
        case let .getTraversalOrder(payload):
            return try await handleGetTraversalOrder(payload, startTime: startTime)
        case let .addHighlight(payload):
            return await handleAddHighlight(payload, startTime: startTime)
        case let .magicTap(payload):
            return await handleMagicTap(payload, startTime: startTime)
        case let .sdkTrigger(payload):
            return await handleSdkTrigger(payload, startTime: startTime)
        case let .sdkObservation(payload):
            return await handleSdkObservation(payload, startTime: startTime)
        case let .sdkAction(payload):
            return await handleSdkAction(payload, startTime: startTime)
        case let .sdkWebSnapshot(payload):
            return await handleSdkWebSnapshot(payload, startTime: startTime)
        case let .sdkWebAction(payload):
            return await handleSdkWebAction(payload, startTime: startTime)
        case let .getVoiceOverState(payload):
            return await handleGetVoiceOverState(payload, startTime: startTime)
        case let .setVoiceOverState(payload):
            return await handleSetVoiceOverState(payload, startTime: startTime)
        case let .accessibilityAudit(payload):
            return await handleAccessibilityAudit(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchPreferences(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .listPreferenceFiles(payload):
            return await handleListPreferenceFiles(payload, startTime: startTime)
        case let .getPreferences(payload):
            return await handleGetPreferences(payload, startTime: startTime)
        case let .getPreference(payload):
            return await handleGetPreference(payload, startTime: startTime)
        case let .setPreference(payload):
            return try await handleSetPreference(payload, startTime: startTime)
        case let .removePreference(payload):
            return try await handleRemovePreference(payload, startTime: startTime)
        case let .deleteKeychainItem(payload):
            return await handleDeleteKeychainItem(payload, startTime: startTime)
        case let .clearPreferences(payload):
            return try await handleClearPreferences(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchNetwork(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .setNetworkMockRules(payload):
            return await handleSetNetworkMockRules(payload, startTime: startTime)
        case let .setNetworkFaultRules(payload):
            return await handleSetNetworkFaultRules(payload, startTime: startTime)
        case let .setNetworkErrorSimulation(payload):
            return await handleSetNetworkErrorSimulation(payload, startTime: startTime)
        case let .getSdkCapabilities(payload):
            return await handleGetSdkCapabilities(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    private func dispatchDatabase(
        _ request: WebSocketRequest, startTime: Date
    )
        async throws -> any WebSocketResponsePayload
    {
        switch request {
        case let .queryCoreData(payload):
            return await handleQueryCoreData(payload, startTime: startTime)
        case let .executeSql(payload):
            return await handleExecuteSql(payload, startTime: startTime)
        case let .listDatabases(payload):
            return await handleListDatabases(payload, startTime: startTime)
        case let .storageCapabilities(payload):
            return await handleStorageCapabilities(payload, startTime: startTime)
        case let .listTables(payload):
            return await handleListTables(payload, startTime: startTime)
        case let .getTableData(payload):
            return await handleGetTableData(payload, startTime: startTime)
        case let .getTableStructure(payload):
            return await handleGetTableStructure(payload, startTime: startTime)
        default:
            throw CommandError.unknownCommand(request.typeString)
        }
    }

    // MARK: - Perf helpers

    @MainActor
    @discardableResult
    func tracked<T>(_ name: String, _ block: @MainActor () throws -> T) rethrows -> T {
        perf.serial(name)
        defer { perf.end() }
        return try block()
    }

    @discardableResult
    nonisolated(nonsending)
    func trackedAsync<T>(
        _ name: String,
        _ block: nonisolated(nonsending)() async throws -> T
    )
        async rethrows -> T
    {
        perf.serial(name)
        defer { perf.end() }
        return try await block()
    }

    func totalTimeMs(from startTime: Date) -> Int64 {
        Int64(Date().timeIntervalSince(startTime) * 1000)
    }
}
