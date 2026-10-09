import Foundation

enum SdkHierarchyProbeDecision: Equatable {
    case probe
    case skip
    case clear

    static func decide(
        foregroundBundleId: String,
        cachedBundleId: String?,
        appState: ObservedAppState?
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
        return cachedBundleId == nil ? .probe : .skip
    }
}

/// Routes a decoded `WebSocketRequest` to a typed, `Sendable`, encodable response.
///
/// Rewrite archetype — **`Sendable` POD router, NOT `@MainActor`** (#5374): its blocking
/// SDK HTTP/DB calls must never run on the main actor or they would freeze XCUITest and
/// starve `/health`. It holds `Sendable` collaborators and `await`s the ones that are
/// isolated or async: the `@MainActor` UI domain (`ElementLocating`, `GesturePerforming`,
/// `HierarchyDebouncing`) and the off-main async SDK clients. The lock-confined
/// collaborators (`SdkHierarchyCaching`, `FrameContext`, `StorageInspecting`, VoiceOver
/// providers) are called synchronously — no `await`.
///
/// vs. the reference this changes:
/// - `handle(_:)` is `async` and returns `any WebSocketResponsePayload` (was `-> Any`): a
///   `Sendable & Encodable` existential the server can hand across the command boundary and
///   encode, where `Any` was neither.
/// - `PerfProvider.track` is re-expressed as the private `tracked` / `trackedAsync` helpers
///   over the injected `any PerfTracking` (mirroring `ElementLocator`), so the reference's
///   singleton is gone. The task-local perf scope the server binds (`withScope`) propagates
///   across every `await` into the collaborators, so the emitted tree matches the reference.
/// - `performContextCheckedGesture` validates the frame context and runs the gesture as one
///   `MainActor.run` transaction (was the reference's single `DispatchQueue.main.sync`),
///   preserving atomicity **and** carrying the task-local perf scope onto the main actor so
///   the gesture-nested `track`s still accumulate (a plain `main.sync` would strand them).
/// - the cached-SDK read path uses the cache's transactional `reconcile` (race #2).
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
                // The exhaustive WebSocketRequest decoder and handle(_:) switch
                // guarantee a dispatch path for every other RequestType.
                return true
            }
        }
    }

    let elementLocator: any ElementLocating
    let gesturePerformer: any GesturePerforming
    let perf: any PerfTracking
    private let storageInspector: (any StorageInspecting)?
    let sdkHierarchyClient: (any SdkHierarchyFetching)?
    let sdkHierarchyCache: (any SdkHierarchyCaching)?
    let sdkDatabaseClient: (any SdkDatabaseFetching)?
    let sdkPreferenceClient: (any SdkPreferenceFetching)?
    let hierarchyDebouncer: (any HierarchyDebouncing)?
    let voiceOverStateProvider: any VoiceOverStateProviding
    let voiceOverToggle: any VoiceOverToggling
    let hingeAngleSetter: any HingeAngleSetting
    let frameContext: FrameContext
    let rotationTimer: any ProxyTimer
    let hierarchyPairRecorder: (any HierarchyPairRecording)?

    init(
        elementLocator: any ElementLocating,
        gesturePerformer: any GesturePerforming,
        perf: any PerfTracking,
        storageInspector: (any StorageInspecting)? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil,
        sdkPreferenceClient: (any SdkPreferenceFetching)? = nil,
        hierarchyDebouncer: (any HierarchyDebouncing)? = nil,
        voiceOverStateProvider: any VoiceOverStateProviding = DefaultVoiceOverStateProvider(),
        voiceOverToggle: any VoiceOverToggling = DefaultVoiceOverToggle(),
        hingeAngleSetter: any HingeAngleSetting = DefaultHingeAngleSetter(),
        frameContext: FrameContext = FrameContext(),
        rotationTimer: any ProxyTimer = SystemTimer(),
        hierarchyPairRecorder: (any HierarchyPairRecording)? = nil
    ) {
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.perf = perf
        self.storageInspector = storageInspector
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkHierarchyCache = sdkHierarchyCache
        self.sdkDatabaseClient = sdkDatabaseClient
        self.sdkPreferenceClient = sdkPreferenceClient
        self.hierarchyDebouncer = hierarchyDebouncer
        self.voiceOverStateProvider = voiceOverStateProvider
        self.voiceOverToggle = voiceOverToggle
        self.hingeAngleSetter = hingeAngleSetter
        self.frameContext = frameContext
        self.rotationTimer = rotationTimer
        self.hierarchyPairRecorder = hierarchyPairRecorder
    }

    /// Handle an incoming request and return a response.
    ///
    /// The `switch` is exhaustive over the typed `WebSocketRequest` enum: adding a new
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
            switch request {
            // View hierarchy commands
            case let .requestHierarchy(payload):
                return try await handleRequestHierarchy(payload, startTime: startTime)

            // On iOS, `request_hierarchy_if_stale` always captures fresh, just like
            // `request_hierarchy`. `sinceTimestamp` is accepted but does not enable
            // cache reuse: there is no UI-change signal, and polls can miss a change.
            case let .requestHierarchyIfStale(payload):
                return try await handleRequestHierarchyIfStale(payload, startTime: startTime)

            case let .setHierarchyPollInterval(payload):
                return try await handleSetHierarchyPollInterval(payload, startTime: startTime)

            case let .requestScreenshot(payload):
                return try await handleRequestScreenshot(payload, startTime: startTime)

            // Gesture commands
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

            // Text input commands
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

            // Action commands
            case let .action(payload):
                return try await handleAction(payload, startTime: startTime)

            case let .activateAccessibilityLink(payload):
                return try await handleActivateAccessibilityLink(payload, startTime: startTime)

            case let .launchApp(payload):
                return try await handleLaunchApp(payload, startTime: startTime)

            // App privacy permissions
            case let .resetPermissions(payload):
                return try await handleResetPermissions(payload, startTime: startTime)

            // Device control
            case let .rotate(payload):
                return try await handleRotate(payload, startTime: startTime)

            case let .setHingeAngle(payload):
                return await handleSetHingeAngle(payload, startTime: startTime)

            // Clipboard commands
            case let .clipboard(payload):
                return try await handleClipboard(payload, startTime: startTime)

            // Accessibility features
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

            case let .getVoiceOverState(payload):
                return await handleGetVoiceOverState(payload, startTime: startTime)

            case let .setVoiceOverState(payload):
                return await handleSetVoiceOverState(payload, startTime: startTime)

            // Storage commands
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

            case let .clearPreferences(payload):
                return try await handleClearPreferences(payload, startTime: startTime)

            // Network mocking
            case let .setNetworkMockRules(payload):
                return await handleSetNetworkMockRules(payload, startTime: startTime)

            case let .setNetworkFaultRules(payload):
                return await handleSetNetworkFaultRules(payload, startTime: startTime)

            case let .setNetworkErrorSimulation(payload):
                return await handleSetNetworkErrorSimulation(payload, startTime: startTime)

            case let .getSdkCapabilities(payload):
                return await handleGetSdkCapabilities(payload, startTime: startTime)

            // Database commands
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
            }
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
                errorCode: (error as? CommandError)?.wireCode
            )
        }
    }

    // MARK: - Perf helpers

    //
    // The rewrite's expression of the reference `PerfProvider.track` over the injected
    // `any PerfTracking` (`serial` opens the scope, `end` closes it in `defer`). `tracked`
    // is `@MainActor` because its only callers are the `@MainActor` gesture operations run
    // inside `performContextCheckedGesture`; `trackedAsync` inherits its caller's isolation
    // so both off-actor handlers and main-actor gestures can wrap async work without sending
    // their closures across isolation domains. The task-local scope propagates across awaits.

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
