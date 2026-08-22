import Foundation
#if canImport(os)
    import os
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif
#if os(iOS)
    import UIKit
#endif

/// Text-input command trace logger.
/// See `Logging.swift` for the log-level contract shared across CtrlProxy.
private let textInputLog = Logger(subsystem: ctrlProxyLogSubsystem, category: "CommandHandler.text")

/// Handles WebSocket commands matching Android AccessibilityService protocol
public class CommandHandler: CommandHandling {
    private let elementLocator: ElementLocating
    private let gesturePerformer: GesturePerforming
    private let perfProvider: PerfProvider
    private let storageInspector: StorageInspecting?
    private let sdkHierarchyClient: (any SdkHierarchyFetching)?
    private let sdkHierarchyCache: (any SdkHierarchyCaching)?
    private let sdkDatabaseClient: (any SdkDatabaseFetching)?
    private let hierarchyDebouncer: (any HierarchyDebouncing)?
    private let voiceOverStateProvider: any VoiceOverStateProviding
    private let frameContext: FrameContext

    public init(
        elementLocator: ElementLocating,
        gesturePerformer: GesturePerforming,
        perfProvider: PerfProvider = PerfProvider.instance,
        storageInspector: StorageInspecting? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil,
        hierarchyDebouncer: (any HierarchyDebouncing)? = nil,
        voiceOverStateProvider: any VoiceOverStateProviding = DefaultVoiceOverStateProvider(),
        frameContext: FrameContext = FrameContext()
    ) {
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.perfProvider = perfProvider
        self.storageInspector = storageInspector
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkHierarchyCache = sdkHierarchyCache
        self.sdkDatabaseClient = sdkDatabaseClient
        self.hierarchyDebouncer = hierarchyDebouncer
        self.voiceOverStateProvider = voiceOverStateProvider
        self.frameContext = frameContext
    }

    /// Factory for testing - allows injecting fakes
    public static func createForTesting(
        elementLocator: ElementLocating,
        gesturePerformer: GesturePerforming,
        perfProvider: PerfProvider,
        storageInspector: StorageInspecting? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil,
        hierarchyDebouncer: (any HierarchyDebouncing)? = nil,
        voiceOverStateProvider: any VoiceOverStateProviding = DefaultVoiceOverStateProvider(),
        frameContext: FrameContext = FrameContext()
    )
        -> CommandHandler
    {
        return CommandHandler(
            elementLocator: elementLocator,
            gesturePerformer: gesturePerformer,
            perfProvider: perfProvider,
            storageInspector: storageInspector,
            sdkHierarchyClient: sdkHierarchyClient,
            sdkHierarchyCache: sdkHierarchyCache,
            sdkDatabaseClient: sdkDatabaseClient,
            hierarchyDebouncer: hierarchyDebouncer,
            voiceOverStateProvider: voiceOverStateProvider,
            frameContext: frameContext
        )
    }

    /// Handle an incoming request and return a response.
    ///
    /// The `switch` is exhaustive over the typed `WebSocketRequest` enum: adding
    /// a new command case without a branch here fails compilation, so the
    /// dispatch table can never silently drop a command.
    public func handle(_ request: WebSocketRequest) -> Any {
        let startTime = Date()

        do {
            switch request {
            // View hierarchy commands
            case let .requestHierarchy(payload), let .requestHierarchyIfStale(payload):
                return try handleRequestHierarchy(payload, startTime: startTime)

            case let .setHierarchyPollInterval(payload):
                return try handleSetHierarchyPollInterval(payload, startTime: startTime)

            case let .requestScreenshot(payload):
                return try handleRequestScreenshot(payload, startTime: startTime)

            // Gesture commands
            case let .tapCoordinates(payload):
                return try handleTapCoordinates(payload, startTime: startTime)

            case let .swipe(payload):
                return try handleSwipe(payload, startTime: startTime)

            case let .twoFingerSwipe(payload), let .multiFingerSwipe(payload):
                return try handleMultiFingerSwipe(payload, startTime: startTime)

            case let .drag(payload):
                return try handleDrag(payload, startTime: startTime)

            case let .pinch(payload):
                return try handlePinch(payload, startTime: startTime)

            // Text input commands
            case let .setText(payload):
                return try handleSetText(payload, startTime: startTime)

            case let .appendText(payload):
                return try handleAppendText(payload, startTime: startTime)

            case let .clearText(payload):
                return try handleClearText(payload, startTime: startTime)

            case let .imeAction(payload):
                return try handleImeAction(payload, startTime: startTime)

            case let .selectAll(payload):
                return try handleSelectAll(payload, startTime: startTime)

            case let .keyboard(payload):
                return try handleKeyboard(payload, startTime: startTime)

            case let .pressButton(payload):
                return try handlePressButton(payload, startTime: startTime)

            case let .pressHome(payload):
                return try handlePressHome(payload, startTime: startTime)

            case let .pressBack(payload):
                return try handlePressBack(payload, startTime: startTime)

            case let .shake(payload):
                return try handleShake(payload, startTime: startTime)

            case let .recentApps(payload):
                return try handleRecentApps(payload, startTime: startTime)

            // Action commands
            case let .action(payload):
                return try handleAction(payload, startTime: startTime)

            case let .launchApp(payload):
                return try handleLaunchApp(payload, startTime: startTime)

            // App privacy permissions
            case let .resetPermissions(payload):
                return try handleResetPermissions(payload, startTime: startTime)

            // Device control
            case let .rotate(payload):
                return try handleRotate(payload, startTime: startTime)

            // Clipboard commands
            case let .clipboard(payload):
                return try handleClipboard(payload, startTime: startTime)

            // Accessibility features
            case let .getCurrentFocus(payload):
                return try handleGetCurrentFocus(payload, startTime: startTime)

            case let .getTraversalOrder(payload):
                return try handleGetTraversalOrder(payload, startTime: startTime)

            case let .addHighlight(payload):
                return try handleAddHighlight(payload, startTime: startTime)

            case let .getVoiceOverState(payload):
                return try handleGetVoiceOverState(payload, startTime: startTime)

            // Storage commands
            case let .listPreferenceFiles(payload):
                return handleListPreferenceFiles(payload, startTime: startTime)

            case let .getPreferences(payload):
                return handleGetPreferences(payload, startTime: startTime)

            case let .getPreference(payload):
                return handleGetPreference(payload, startTime: startTime)

            case let .setPreference(payload):
                return try handleSetPreference(payload, startTime: startTime)

            case let .removePreference(payload):
                return try handleRemovePreference(payload, startTime: startTime)

            case let .clearPreferences(payload):
                return try handleClearPreferences(payload, startTime: startTime)

            // Network mocking
            case let .setNetworkMockRules(payload):
                return try handleSetNetworkMockRules(payload, startTime: startTime)

            case let .setNetworkFaultRules(payload):
                return try handleSetNetworkFaultRules(payload, startTime: startTime)

            case let .setNetworkErrorSimulation(payload):
                return try handleSetNetworkErrorSimulation(payload, startTime: startTime)

            // Database commands
            case let .executeSql(payload):
                return handleExecuteSql(payload, startTime: startTime)

            case let .listDatabases(payload):
                return handleListDatabases(payload, startTime: startTime)

            case let .storageCapabilities(payload):
                return handleStorageCapabilities(payload, startTime: startTime)

            case let .listTables(payload):
                return handleListTables(payload, startTime: startTime)

            case let .getTableData(payload):
                return handleGetTableData(payload, startTime: startTime)

            case let .getTableStructure(payload):
                return handleGetTableStructure(payload, startTime: startTime)
            }
        } catch {
            return WebSocketResponse.error(
                type: request.requestType.responseType.rawValue,
                requestId: request.requestId,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Network Mocking

    private func handleSetNetworkMockRules(
        _ request: RequestSetNetworkMockRules,
        startTime: Date
    )
        throws -> SetNetworkMockRulesResponse
    {
        let succeeded = sdkHierarchyClient?.setMockRules(request.rules) ?? false
        return SetNetworkMockRulesResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSetNetworkErrorSimulation(
        _ request: RequestSetNetworkErrorSimulation,
        startTime: Date
    )
        throws -> SetNetworkErrorSimulationResponse
    {
        let config = NetworkErrorSimulationDTO(
            enabled: request.enabled,
            errorType: request.errorType,
            limit: request.limit,
            expiresAtEpochMs: request.expiresAtEpochMs
        )
        let succeeded = sdkHierarchyClient?.setNetworkErrorSimulation(config) ?? false
        return SetNetworkErrorSimulationResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSetNetworkFaultRules(
        _ request: RequestSetNetworkFaultRules,
        startTime: Date
    )
        throws -> SetNetworkFaultRulesResponse
    {
        let succeeded = sdkHierarchyClient?.setNetworkFaultRules(request.rules) ?? false
        return SetNetworkFaultRulesResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - View Hierarchy

    private func handleSetHierarchyPollInterval(
        _ request: RequestSetHierarchyPollInterval,
        startTime: Date
    )
        throws -> WebSocketResponse
    {
        guard request.intervalMs > 0 else {
            throw CommandError.invalidParameter("intervalMs", String(request.intervalMs))
        }
        hierarchyDebouncer?.updatePollIntervalMs(request.intervalMs)
        return WebSocketResponse.success(
            type: ResponseType.setHierarchyPollIntervalResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleRequestHierarchy(
        _ request: RequestHierarchy,
        startTime _: Date
    )
        throws -> HierarchyUpdateResponse
    {
        perfProvider.serial("handleRequestHierarchy")
        defer { perfProvider.end() }

        let disableAllFiltering = request.disableAllFiltering ?? false
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try perfProvider.track("extraction") {
                try elementLocator.getViewHierarchy(disableAllFiltering: disableAllFiltering)
            }
        } catch {
            print("[CommandHandler] Hierarchy extraction failed: \(error)")
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }

        let enriched = enrichWithMatchingSdkHierarchy(hierarchy)

        // Get accumulated timing for this operation
        let perfTimings = perfProvider.flush()

        return HierarchyUpdateResponse(
            requestId: request.requestId,
            data: enriched,
            perfTiming: perfTimings?.first,
            frameContext: frameContext.context(for: enriched)
        )
    }

    func enrichWithMatchingSdkHierarchy(_ hierarchy: ViewHierarchy) -> ViewHierarchy {
        HierarchyMerger.merge(xcuitest: hierarchy, sdk: matchingSdkHierarchy(for: hierarchy))
    }

    func enrichWithCachedSdkHierarchy(_ hierarchy: ViewHierarchy) -> ViewHierarchy {
        HierarchyMerger.merge(xcuitest: hierarchy, sdk: matchingCachedSdkHierarchy(for: hierarchy))
    }

    private func matchingCachedSdkHierarchy(for hierarchy: ViewHierarchy) -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName),
              let cached = sdkHierarchyCache?.latest
        else {
            return nil
        }
        guard sdkHierarchy(cached, matches: foregroundBundleId) else {
            sdkHierarchyCache?.clear()
            return nil
        }
        return cached
    }

    private func matchingSdkHierarchy(for hierarchy: ViewHierarchy) -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName) else {
            return nil
        }

        if let cached = sdkHierarchyCache?.latest {
            if sdkHierarchy(cached, matches: foregroundBundleId) {
                return cached
            }
            guard sdkServerMatchesForegroundBundleId(foregroundBundleId) else {
                sdkHierarchyCache?.clear()
                return nil
            }
        } else if sdkHierarchyClient != nil {
            guard sdkServerMatchesForegroundBundleId(foregroundBundleId) else {
                return nil
            }
        }

        guard let fresh = sdkHierarchyClient?.fetchFreshHierarchy(),
              sdkHierarchy(fresh, matches: foregroundBundleId)
        else {
            sdkHierarchyCache?.clear()
            return nil
        }
        sdkHierarchyCache?.update(fresh)
        return fresh
    }

    private func sdkServerMatchesForegroundBundleId(_ foregroundBundleId: String) -> Bool {
        guard let serverBundleId = normalizedBundleId(sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
            return false
        }
        return serverBundleId == foregroundBundleId
    }

    private func sdkServerMatchesTrackedForegroundApp() -> Bool {
        guard let foregroundBundleId = normalizedBundleId(elementLocator.foregroundBundleId) else {
            return false
        }
        return sdkServerMatchesForegroundBundleId(foregroundBundleId)
    }

    private func sdkHierarchy(_ sdkHierarchy: SdkViewHierarchy, matches foregroundBundleId: String) -> Bool {
        normalizedBundleId(sdkHierarchy.bundleId) == foregroundBundleId
    }

    private func normalizedBundleId(_ bundleId: String?) -> String? {
        guard let normalized = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty
        else {
            return nil
        }
        return normalized
    }

    private func handleRequestScreenshot(_ request: RequestEnvelope, startTime _: Date) throws -> ScreenshotResponse {
        // Frame-context correlation is opt-in: only when the client supplies a `frameContext`
        // does the screenshot pay for the surrounding hierarchy walks. A plain screenshot
        // performs zero extractions and returns `frameContext: nil`.
        //
        // When requested, read the hierarchy on both sides of the pixel capture. A change during
        // capture leaves the context absent, which makes a context-aware client fail closed
        // instead of pairing pixels from one screen with the identity of another.
        let correlate = request.frameContext != nil
        let before = correlate ? currentFrameContext() : nil
        let screenshot = try gesturePerformer.getScreenshotCapture()
        let after = correlate ? currentFrameContext() : nil
        let base64 = screenshot.data.base64EncodedString()

        return ScreenshotResponse(
            requestId: request.requestId,
            data: base64,
            format: "png",
            rotation: screenshot.rotation,
            frameContext: correlate && before == after ? before : nil
        )
    }

    private func currentFrameContext() -> String? {
        guard let hierarchy = try? elementLocator.getViewHierarchy(disableAllFiltering: false) else {
            return nil
        }
        return frameContext.context(for: enrichWithCachedSdkHierarchy(hierarchy))
    }

    private func performContextCheckedGesture<T>(
        expected: String?,
        operation: () throws -> T
    )
        throws -> T
    {
        // No expected context means there is nothing to validate: `performIfCurrent` returns
        // `operation()` immediately for a nil `expected` (dispatched on the transition executor),
        // so skip the hierarchy extraction and blocking SDK fetch entirely on this fast path.
        // When context IS supplied, extract once and prefer the zero-device-cost cached SDK
        // hierarchy — the observe that produced `expected` also warmed that cache — instead of
        // the slow `/hierarchy/fresh` main-thread walk in the target app.
        let hierarchy = expected == nil
            ? nil
            : (try? elementLocator.getViewHierarchy(disableAllFiltering: false)).map(enrichWithCachedSdkHierarchy)
        return try frameContext.performIfCurrent(
            expected: expected,
            hierarchy: hierarchy,
            operation: operation
        )
    }

    // MARK: - Gestures

    /// Reject a non-finite gesture coordinate (`NaN` / `±Infinity`) at the
    /// handler boundary before it flows into `CGVector` / `XCUICoordinate`.
    ///
    /// JSON has no `NaN`/`Infinity` literal and Apple's `JSONDecoder` rejects an
    /// overflow literal (`1e309`) at pre-parse, so a non-finite value cannot
    /// arrive over the wire today. This guard is defense-in-depth for the
    /// non-wire path — a caller constructing a request directly, or a computed
    /// coordinate (division, `hypot`, normalized offset) that yields a non-finite
    /// `Double`. Non-coordinate gesture inputs that feed the path math (pinch
    /// `rotationDegrees`, multi-finger `offset` spacing) get the same guard
    /// (#2991, mirroring Android #2964). Throwing
    /// `CommandError.invalidParameter` makes `handle`'s catch
    /// return a clean, actionable per-command error response (see #2909's thesis
    /// that the runner must never surface an opaque failure for unusual input)
    /// rather than the silent no-op XCUITest would produce.
    private func requireFinite(_ value: Double, field: String) throws {
        guard value.isFinite else {
            throw CommandError.invalidParameter(field, value.description)
        }
    }

    private func handleTapCoordinates(_ request: RequestTapCoordinates, startTime: Date) throws -> WebSocketResponse {
        try requireFinite(request.x, field: "x")
        try requireFinite(request.y, field: "y")
        let duration = request.duration ?? 0
        try performContextCheckedGesture(expected: request.frameContext) {
            try gesturePerformer.tap(x: request.x, y: request.y, duration: TimeInterval(duration) / 1000.0)
        }

        return WebSocketResponse.success(
            type: ResponseType.tapCoordinatesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSwipe(_ request: RequestSwipe, startTime: Date) throws -> WebSocketResponse {
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        let duration = request.duration ?? 300
        try performContextCheckedGesture(expected: request.frameContext) {
            try gesturePerformer.swipe(
                startX: request.x1, startY: request.y1,
                endX: request.x2, endY: request.y2,
                duration: TimeInterval(duration) / 1000.0
            )
        }

        return WebSocketResponse.success(
            type: ResponseType.swipeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleMultiFingerSwipe(
        _ request: RequestMultiFingerSwipe,
        startTime: Date
    )
        throws -> WebSocketResponse
    {
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        // Both request_two_finger_swipe and request_multi_finger_swipe route here;
        // fingerCount defaults to 2 when the client omits it (two-finger never sends it).
        let fingerCount = request.fingerCount ?? 2
        let duration = request.duration ?? 300
        let fingerSpacing = request.offset ?? 25
        // Android leaves `offset` unguarded because it is an `Int` (cannot be
        // non-finite). On iOS `offset` is a `Double?` feeding the per-finger
        // spacing geometry, so the same defense-in-depth guard applies (#2991).
        try requireFinite(fingerSpacing, field: "offset")

        try gesturePerformer.multiFingerSwipe(
            startX: request.x1,
            startY: request.y1,
            endX: request.x2,
            endY: request.y2,
            fingerCount: fingerCount,
            fingerSpacing: fingerSpacing,
            duration: TimeInterval(duration) / 1000.0
        )

        return WebSocketResponse.success(
            type: ResponseType.multiFingerSwipeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleDrag(_ request: RequestDrag, startTime: Date) throws -> WebSocketResponse {
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        let pressDuration = request.pressDurationMs ?? request.holdTime ?? 600
        let dragDuration = request.dragDurationMs ?? 300
        let holdDuration = request.holdDurationMs ?? 100

        try performContextCheckedGesture(expected: request.frameContext) {
            try gesturePerformer.drag(
                startX: request.x1, startY: request.y1,
                endX: request.x2, endY: request.y2,
                pressDuration: TimeInterval(pressDuration) / 1000.0,
                dragDuration: TimeInterval(dragDuration) / 1000.0,
                holdDuration: TimeInterval(holdDuration) / 1000.0
            )
        }

        return WebSocketResponse.success(
            type: ResponseType.dragResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePinch(_ request: RequestPinch, startTime: Date) throws -> WebSocketResponse {
        try requireFinite(request.centerX, field: "centerX")
        try requireFinite(request.centerY, field: "centerY")
        try requireFinite(request.distanceStart, field: "distanceStart")
        try requireFinite(request.distanceEnd, field: "distanceEnd")
        // `rotationDegrees` is a `Float?` (not a coordinate) but still flows into
        // the gesture-path math (degrees → radians → cos/sin), so a computed
        // non-finite rotation is guarded too — mirroring Android #2964 / PR #2984
        // (#2991). `Double(Float.nan/±infinity)` stays non-finite, so widening
        // before the check loses nothing.
        try requireFinite(Double(request.rotationDegrees ?? 0), field: "rotationDegrees")
        let path = try gesturePerformer.pinch(
            centerX: request.centerX,
            centerY: request.centerY,
            distanceStart: request.distanceStart,
            distanceEnd: request.distanceEnd,
            rotationDegrees: Double(request.rotationDegrees ?? 0),
            duration: TimeInterval(request.duration ?? 300) / 1000.0
        )

        return WebSocketResponse.success(
            type: ResponseType.pinchResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            pinchPath: path.rawValue
        )
    }

    // MARK: - Text Input

    private func handleSetText(_ request: RequestSetText, startTime: Date) throws -> WebSocketResponse {
        let text = request.text

        perfProvider.serial("handleSetText")
        defer { perfProvider.end() }

        let resourceId = request.resourceId
        textInputLog
            .debug(
                "handleSetText begin resourceId=\(resourceId ?? "nil", privacy: .public) textLength=\(text.count, privacy: .public) requestId=\(request.requestId ?? "nil", privacy: .public)"
            )

        do {
            try performContextCheckedGesture(expected: request.frameContext) {
                if let resourceId = resourceId {
                    try perfProvider.track("setText.byResourceId") {
                        try gesturePerformer.setText(resourceId: resourceId, text: text)
                    }
                } else {
                    try perfProvider.track("typeText") {
                        try gesturePerformer.typeText(text: text)
                    }
                }
            }
        } catch {
            let elapsedMs = totalTimeMs(from: startTime)
            textInputLog
                .error(
                    "handleSetText FAILED resourceId=\(resourceId ?? "nil", privacy: .public) error=\(String(describing: error), privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
                )
            throw error
        }

        let elapsedMs = totalTimeMs(from: startTime)
        textInputLog
            .debug(
                "handleSetText OK resourceId=\(resourceId ?? "nil", privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
            )
        return WebSocketResponse.success(
            type: ResponseType.setTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: elapsedMs
        )
    }

    private func handleAppendText(_ request: RequestAppendText, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleAppendText")
        defer { perfProvider.end() }

        try performContextCheckedGesture(expected: request.frameContext) {
            try perfProvider.track("appendText") {
                try gesturePerformer.appendText(text: request.text)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.appendTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleClearText(_ request: RequestClearText, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleClearText")
        defer { perfProvider.end() }

        let resourceId = request.resourceId
        textInputLog
            .debug(
                "handleClearText begin resourceId=\(resourceId ?? "nil", privacy: .public) requestId=\(request.requestId ?? "nil", privacy: .public)"
            )

        do {
            try perfProvider.track("clearText") {
                try gesturePerformer.clearText(resourceId: resourceId)
            }
        } catch {
            let elapsedMs = totalTimeMs(from: startTime)
            textInputLog
                .error(
                    "handleClearText FAILED resourceId=\(resourceId ?? "nil", privacy: .public) error=\(String(describing: error), privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
                )
            throw error
        }

        let elapsedMs = totalTimeMs(from: startTime)
        textInputLog
            .debug(
                "handleClearText OK resourceId=\(resourceId ?? "nil", privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
            )
        return WebSocketResponse.success(
            type: ResponseType.clearTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: elapsedMs
        )
    }

    private func handleImeAction(_ request: RequestImeAction, startTime: Date) throws -> WebSocketResponse {
        let action = request.action

        perfProvider.serial("handleImeAction")
        defer { perfProvider.end() }

        textInputLog
            .debug(
                "handleImeAction begin action=\(action, privacy: .public) requestId=\(request.requestId ?? "nil", privacy: .public)"
            )

        do {
            try perfProvider.track("imeAction") {
                try gesturePerformer.performImeAction(action)
            }
        } catch {
            let elapsedMs = totalTimeMs(from: startTime)
            textInputLog
                .error(
                    "handleImeAction FAILED action=\(action, privacy: .public) error=\(String(describing: error), privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
                )
            throw error
        }

        let elapsedMs = totalTimeMs(from: startTime)
        textInputLog
            .debug(
                "handleImeAction OK action=\(action, privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
            )
        return WebSocketResponse.success(
            type: ResponseType.imeActionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: elapsedMs
        )
    }

    private func handleSelectAll(_ request: RequestEnvelope, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleSelectAll")
        defer { perfProvider.end() }

        textInputLog.debug("handleSelectAll begin requestId=\(request.requestId ?? "nil", privacy: .public)")

        do {
            try perfProvider.track("selectAll") {
                try gesturePerformer.selectAll()
            }
        } catch {
            let elapsedMs = totalTimeMs(from: startTime)
            textInputLog
                .error(
                    "handleSelectAll FAILED error=\(String(describing: error), privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
                )
            throw error
        }

        let elapsedMs = totalTimeMs(from: startTime)
        textInputLog.debug("handleSelectAll OK elapsedMs=\(elapsedMs, privacy: .public)")
        return WebSocketResponse.success(
            type: ResponseType.selectAllResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: elapsedMs
        )
    }

    private func handleKeyboard(_ request: RequestKeyboard, startTime: Date) throws -> KeyboardResponse {
        let action = request.action

        perfProvider.serial("handleKeyboard")
        defer { perfProvider.end() }

        let open = try perfProvider.track("keyboard") {
            try gesturePerformer.keyboard(action: action)
        }
        let success = keyboardActionSucceeded(action: action, open: open)

        return KeyboardResponse(
            requestId: request.requestId,
            success: success,
            open: open,
            totalTimeMs: totalTimeMs(from: startTime),
            error: success ? nil : "Keyboard did not \(action.lowercased())"
        )
    }

    private func keyboardActionSucceeded(action: String, open: Bool) -> Bool {
        switch action.lowercased() {
        case "detect":
            return true
        case "open":
            return open
        case "close":
            return !open
        default:
            return false
        }
    }

    private func handlePressButton(_ request: RequestPressButton, startTime: Date) throws -> WebSocketResponse {
        let button = request.action

        perfProvider.serial("handlePressButton")
        defer { perfProvider.end() }

        try performContextCheckedGesture(expected: request.frameContext) {
            try perfProvider.track("pressButton") {
                try gesturePerformer.pressButton(button)
            }
        }

        if button.lowercased() == "home" || button.lowercased() == "recent" {
            perfProvider.track("switchForegroundApp") {
                elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
            }
            perfProvider.track("updateApplication") {
                gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressButtonResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePressHome(_ request: RequestEnvelope, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handlePressHome")
        defer { perfProvider.end() }

        try performContextCheckedGesture(expected: request.frameContext) {
            try perfProvider.track("pressHome") {
                try gesturePerformer.pressHome()
            }
        }

        // Explicit state transition: home screen means springboard is now foreground
        perfProvider.track("switchForegroundApp") {
            elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        perfProvider.track("updateApplication") {
            gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.pressHomeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePressBack(_ request: RequestEnvelope, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handlePressBack")
        defer { perfProvider.end() }

        try performContextCheckedGesture(expected: request.frameContext) {
            try perfProvider.track("pressBack") {
                try gesturePerformer.pressBack()
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressBackResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleShake(_ request: RequestEnvelope, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleShake")
        defer { perfProvider.end() }

        try perfProvider.track("shake") {
            try gesturePerformer.shake()
        }

        return WebSocketResponse.success(
            type: ResponseType.shakeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleRecentApps(_ request: RequestEnvelope, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleRecentApps")
        defer { perfProvider.end() }

        let didOpen = try performContextCheckedGesture(expected: request.frameContext) {
            try perfProvider.track("openRecentApps") {
                try gesturePerformer.openRecentApps()
            }
        }

        guard didOpen else {
            return WebSocketResponse.error(
                type: ResponseType.recentAppsResult.rawValue,
                requestId: request.requestId,
                error: "iOS App Switcher did not appear after recent apps invocation",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        // Explicit state transition: app switcher is SpringBoard UI
        perfProvider.track("switchForegroundApp") {
            elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        perfProvider.track("updateApplication") {
            gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.recentAppsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Actions

    private func handleAction(_ request: RequestAction, startTime: Date) throws -> WebSocketResponse {
        try gesturePerformer.performAction(request.action, resourceId: request.resourceId, label: request.label)

        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleLaunchApp(_ request: RequestLaunchApp, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleLaunchApp")
        defer { perfProvider.end() }

        let bundleId = request.bundleId
        let coldBoot = request.coldBoot ?? false

        // Check current app state to decide launch strategy
        let appState = perfProvider.track("checkAppState") {
            elementLocator.getAppState(bundleId: bundleId)
        }

        let strategy: String
        let alreadyForeground = appState == .runningForeground
        if coldBoot {
            strategy = appState == .notRunning || appState == .unknown ? "coldBoot:launch" : "coldBoot:terminate+launch"
        } else {
            switch appState {
            case .runningForeground: strategy = "activate(foreground)"
            case .runningBackground, .runningBackgroundSuspended: strategy = "activate(background)"
            default: strategy = "launch(notRunning)"
            }
        }
        print("[CtrlProxy] handleLaunchApp bundleId=\(bundleId) appState=\(appState) strategy=\(strategy)")

        if coldBoot {
            // Cold boot: always terminate then launch fresh
            if appState == .runningForeground || appState == .runningBackground || appState ==
                .runningBackgroundSuspended
            {
                try perfProvider.track("terminateApp") {
                    try gesturePerformer.terminateApp(bundleId: bundleId)
                }
            }
            try perfProvider.track("launchApp") {
                try gesturePerformer.launchApp(bundleId: bundleId)
            }
        } else if appState == .runningForeground {
            // Already in foreground — activate is a no-op but ensures XCTest sync
            try perfProvider.track("activateApp") {
                try gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else if appState == .runningBackground || appState == .runningBackgroundSuspended {
            // App running but not visible — activate brings to foreground (fast path)
            try perfProvider.track("activateApp") {
                try gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else {
            // App not running — must do full launch
            try perfProvider.track("launchApp") {
                try gesturePerformer.launchApp(bundleId: bundleId)
            }
        }

        // Explicit state transition: switch tracking to launched app
        perfProvider.track("switchForegroundApp") {
            elementLocator.switchForegroundApp(bundleId: bundleId)
        }
        perfProvider.track("updateApplication") {
            gesturePerformer.updateApplication(bundleId: bundleId)
        }

        // Skip foreground poll when activate() was called on an already-foreground app —
        // activate() is synchronous and the app is guaranteed to remain foreground.
        if !alreadyForeground || coldBoot {
            perfProvider.track("awaitForeground") {
                _ = elementLocator.awaitAppState(bundleId: bundleId, expectedState: .foreground)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.launchAppResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - App Privacy Permissions

    /// Reset privacy authorizations for an app to not-determined. `bundleId` and
    /// `permissions` are decode-required, so both are present here; an empty
    /// `permissions` array is still rejected so the client gets an actionable error
    /// instead of a silent success. An unmapped resource throws from the gesture
    /// performer and surfaces as a structured error via the `handle(_:)` catch. (#2491)
    private func handleResetPermissions(_ request: RequestResetPermissions, startTime: Date) throws
        -> WebSocketResponse
    {
        guard !request.permissions.isEmpty else {
            throw CommandError.missingParameter("permissions")
        }
        try gesturePerformer.resetAuthorizations(bundleId: request.bundleId, resources: request.permissions)
        return WebSocketResponse.success(
            type: ResponseType.resetPermissionsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Device Control

    private func handleRotate(_ request: RequestRotate, startTime: Date) throws -> RotateResponse {
        let orientation = request.orientation

        let previousOrientation = gesturePerformer.getOrientation()

        // Map "landscape" to "landscape_left" (standard rotation direction)
        let iosOrientation: String
        switch orientation.lowercased() {
        case "portrait":
            iosOrientation = "portrait"
        case "landscape":
            iosOrientation = "landscape_left"
        case "portrait_upside_down", "portraitupsidedown":
            iosOrientation = "portrait_upside_down"
        case "landscape_left", "landscapeleft":
            iosOrientation = "landscape_left"
        case "landscape_right", "landscaperight":
            iosOrientation = "landscape_right"
        default:
            throw CommandError.invalidParameter("orientation", orientation)
        }

        // Normalize to "portrait" or "landscape" for the result
        let normalizedPrevious = previousOrientation.hasPrefix("landscape") ? "landscape" : "portrait"
        let normalizedTarget = iosOrientation.hasPrefix("landscape") ? "landscape" : "portrait"
        let value = normalizedTarget == "portrait" ? 0 : 1

        // Check if already in the desired orientation
        if normalizedPrevious == normalizedTarget {
            return RotateResponse(
                requestId: request.requestId,
                success: true,
                totalTimeMs: totalTimeMs(from: startTime),
                previousOrientation: normalizedPrevious,
                currentOrientation: normalizedTarget,
                value: value,
                rotationPerformed: false
            )
        }

        try gesturePerformer.setOrientation(iosOrientation)

        return RotateResponse(
            requestId: request.requestId,
            success: true,
            totalTimeMs: totalTimeMs(from: startTime),
            previousOrientation: normalizedPrevious,
            currentOrientation: normalizedTarget,
            value: value,
            rotationPerformed: true
        )
    }

    // MARK: - Clipboard

    private func handleClipboard(_ request: RequestClipboard, startTime: Date) throws -> WebSocketResponse {
        let resultText = try gesturePerformer.clipboard(action: request.action, text: request.text)

        return WebSocketResponse.success(
            type: ResponseType.clipboardResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            text: resultText
        )
    }

    // MARK: - Accessibility Features

    /// Report the element holding the VoiceOver cursor. The cursor is only visible
    /// in-process, so it reaches us as `accessibility-focused` on the SDK-enriched
    /// hierarchy (see HierarchyMerger, #3924). Returns a null focusedElement when
    /// nothing is focused — that is a success, not an error.
    private func handleGetCurrentFocus(_ request: RequestEnvelope, startTime: Date) throws -> CurrentFocusResponse {
        let enriched = try enrichedHierarchyForAccessibility()
        let focused = enriched.hierarchy.flatMap { Self.findAccessibilityFocused($0) }
        return CurrentFocusResponse(
            requestId: request.requestId,
            focusedElement: focused,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Report accessibility elements in VoiceOver traversal (depth-first) order,
    /// plus the index of the focused one when the cursor is present (#3924).
    private func handleGetTraversalOrder(_ request: RequestEnvelope, startTime: Date) throws -> TraversalOrderResponse {
        let enriched = try enrichedHierarchyForAccessibility()
        var ordered: [UIElementInfo] = []
        if let root = enriched.hierarchy {
            Self.collectAccessibilityElements(root, into: &ordered)
        }
        let focusedIndex = ordered.firstIndex { $0.accessibilityFocused == "true" }
        return TraversalOrderResponse(
            requestId: request.requestId,
            elements: ordered,
            focusedIndex: focusedIndex,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Extract the hierarchy and merge the in-app SDK view tree into it, so
    /// accessibility-only signals (the VoiceOver cursor, `isAccessibilityElement`)
    /// are present. Shared by the focus and traversal handlers.
    private func enrichedHierarchyForAccessibility() throws -> ViewHierarchy {
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try perfProvider.track("extraction") {
                try elementLocator.getViewHierarchy(disableAllFiltering: false)
            }
        } catch {
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }
        return enrichWithMatchingSdkHierarchy(hierarchy)
    }

    /// Depth-first search for the element carrying the VoiceOver cursor.
    static func findAccessibilityFocused(_ element: UIElementInfo) -> UIElementInfo? {
        if element.accessibilityFocused == "true" {
            return element
        }
        for child in element.node ?? [] {
            if let match = findAccessibilityFocused(child) {
                return match
            }
        }
        return nil
    }

    /// Collect, depth-first, the elements VoiceOver would stop on. `isAccessibilityElement`
    /// is the precise signal and is carried through from the in-app SDK; containers that
    /// merely hold other elements are skipped but still traversed into.
    static func collectAccessibilityElements(_ element: UIElementInfo, into ordered: inout [UIElementInfo]) {
        if element.extras?["sdk.isAccessibilityElement"] == "true" {
            ordered.append(element)
        }
        for child in element.node ?? [] {
            collectAccessibilityElements(child, into: &ordered)
        }
    }

    private func handleAddHighlight(_ request: RequestAddHighlight, startTime: Date) throws -> WebSocketResponse {
        guard let shape = request.shape else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "add_highlight requires a shape",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let highlightId = request.id ?? request.requestId ?? UUID().uuidString
        // When the in-app SDK bridge owns the foreground app, it is the authoritative
        // (and only) highlight path. A rejection there — e.g. missing source dimensions
        // (issue #2682) — must be reported precisely rather than collapsed into the
        // generic "SDK not embedded" error below, which would mislead since the SDK is
        // in fact embedded. An unreachable bridge falls through to that generic error.
        if sdkHierarchyClient != nil, sdkServerMatchesTrackedForegroundApp() {
            switch sdkHierarchyClient?.addHighlight(id: highlightId, shape: shape) {
            case .rendered:
                return WebSocketResponse.success(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .rejected:
                return WebSocketResponse.error(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    error: "Target app SDK highlight bridge rejected the highlight "
                        + "(missing source dimensions or invalid shape).",
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .unavailable, .none:
                break // Bridge unreachable — fall through to the SDK-required error.
            }
        }
        // iOS cannot draw an overlay into another app from the test runner: the runner's
        // own UIWindow only composites while the runner is foreground, which never happens
        // during automation. Highlighting the app-under-test requires the in-app AutoMobile
        // SDK bridge, so report that honestly instead of pretending it rendered.
        let foregroundBundleId = elementLocator.foregroundBundleId ?? "the foreground app"
        return WebSocketResponse.error(
            type: ResponseType.highlightResponse.rawValue,
            requestId: request.requestId,
            error: "Highlighting \(foregroundBundleId) requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner.",
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleGetVoiceOverState(
        _ request: RequestEnvelope,
        startTime: Date
    )
        throws -> VoiceOverStateResponse
    {
        let enabled = voiceOverStateProvider.isVoiceOverRunning()

        return VoiceOverStateResponse(
            requestId: request.requestId,
            enabled: enabled,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Storage

    /// Resolve suite name from request fileName: nil/empty/"Standard" -> nil (UserDefaults.standard)
    private func resolveSuiteName(_ fileName: String?) -> String? {
        guard let name = fileName, !name.isEmpty, name != "Standard" else { return nil }
        return name
    }

    private func handleListPreferenceFiles(_ request: RequestEnvelope, startTime: Date) -> StorageFilesResponse {
        guard let inspector = storageInspector else {
            return StorageFilesResponse(
                requestId: request.requestId,
                success: false,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suites = inspector.listSuites()
        return StorageFilesResponse(
            requestId: request.requestId,
            success: true,
            files: suites,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleGetPreferences(_ request: RequestGetPreferences, startTime: Date) -> StorageEntriesResponse {
        guard let inspector = storageInspector else {
            return StorageEntriesResponse(
                requestId: request.requestId,
                success: false,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suiteName = resolveSuiteName(request.fileName)
        let entries = inspector.getEntries(suiteName: suiteName)
        return StorageEntriesResponse(
            requestId: request.requestId,
            success: true,
            entries: entries,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleGetPreference(_ request: RequestGetPreference, startTime: Date) -> StorageEntryResponse {
        guard let inspector = storageInspector else {
            return StorageEntryResponse(
                requestId: request.requestId,
                success: false,
                found: false,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        guard let key = request.key else {
            return StorageEntryResponse(
                requestId: request.requestId,
                success: false,
                found: false,
                error: "Missing required parameter: key",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suiteName = resolveSuiteName(request.fileName)
        if let entry = inspector.getEntry(suiteName: suiteName, key: key) {
            return StorageEntryResponse(
                requestId: request.requestId,
                success: true,
                found: true,
                key: entry.key,
                value: entry.value,
                valueType: entry.type,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } else {
            return StorageEntryResponse(
                requestId: request.requestId,
                success: true,
                found: false,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    private func handleSetPreference(_ request: RequestSetPreference, startTime: Date) throws -> WebSocketResponse {
        guard let inspector = storageInspector else {
            return WebSocketResponse.error(
                type: ResponseType.setPreferenceResult.rawValue,
                requestId: request.requestId,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suiteName = resolveSuiteName(request.fileName)
        try inspector.setEntry(suiteName: suiteName, key: request.key, value: request.value, type: request.valueType)

        return WebSocketResponse.success(
            type: ResponseType.setPreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleRemovePreference(
        _ request: RequestRemovePreference,
        startTime: Date
    )
        throws -> WebSocketResponse
    {
        guard let inspector = storageInspector else {
            return WebSocketResponse.error(
                type: ResponseType.removePreferenceResult.rawValue,
                requestId: request.requestId,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suiteName = resolveSuiteName(request.fileName)
        try inspector.removeEntry(suiteName: suiteName, key: request.key)

        return WebSocketResponse.success(
            type: ResponseType.removePreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleClearPreferences(
        _ request: RequestClearPreferences,
        startTime: Date
    )
        throws -> WebSocketResponse
    {
        guard let inspector = storageInspector else {
            return WebSocketResponse.error(
                type: ResponseType.clearPreferencesResult.rawValue,
                requestId: request.requestId,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        let suiteName = resolveSuiteName(request.fileName)
        try inspector.clearEntries(suiteName: suiteName)

        return WebSocketResponse.success(
            type: ResponseType.clearPreferencesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Database

    private func handleExecuteSql(_ request: RequestExecuteSql, startTime: Date) -> ExecuteSqlResponse {
        guard let client = sdkDatabaseClient else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let query = request.query else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("query").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            let result = try client.executeSQL(databasePath: databasePath, query: query, sessionId: request.sessionId)
            if let error = result.error {
                return ExecuteSqlResponse(
                    requestId: request.requestId,
                    success: false,
                    error: error,
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            }
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: true,
                queryType: result.queryType,
                columns: result.columns,
                    rows: result.rows,
                    rowsAffected: result.rowsAffected,
                    diagnostic: result.diagnostic,
                    truncated: result.truncated,
                    totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    private func handleListDatabases(_ request: RequestListDatabases, startTime: Date) -> ListDatabasesResponse {
        guard let client = sdkDatabaseClient else {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            return try ListDatabasesResponse(
                requestId: request.requestId,
                success: true,
                databases: client.listDatabases(),
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    private func handleStorageCapabilities(
        _ request: RequestStorageCapabilities,
        startTime: Date
    ) -> StorageCapabilitiesResponse {
        guard let client = sdkDatabaseClient else {
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            let capabilities = try client.storageCapabilities()
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: true,
                capabilities: capabilities,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    private func handleListTables(_ request: RequestListTables, startTime: Date) -> ListTablesResponse {
        guard let client = sdkDatabaseClient else {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            return try ListTablesResponse(
                requestId: request.requestId,
                success: true,
                tables: client.listTables(databasePath: databasePath),
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    private func handleGetTableData(_ request: RequestGetTableData, startTime: Date) -> TableDataResponse {
        guard let client = sdkDatabaseClient else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let table = request.table else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("table").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            let data = try client.getTableData(
                databasePath: databasePath,
                table: table,
                limit: request.limit ?? 50,
                offset: Self.sanitizedTableOffset(request.offset)
            )
            return TableDataResponse(
                requestId: request.requestId,
                success: true,
                columns: data.columns,
                rows: data.rows,
                total: data.total,
                diagnostic: data.diagnostic,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    /// Convert a wire-supplied table `offset` into a safe non-negative `Int`.
    ///
    /// `offset` is decoded as a `Double` (see `Models.swift`) and is untrusted:
    /// a non-finite value (`NaN`/`±Inf`) or a magnitude beyond `Int64` would trap
    /// `Int(_:)` and crash the runner (issue #3616). Non-finite or negative values
    /// clamp to 0; values at/above `Int.max` clamp to `Int.max`.
    static func sanitizedTableOffset(_ value: Double?) -> Int {
        guard let value = value, value.isFinite, value >= 0 else { return 0 }
        if value >= Double(Int.max) { return Int.max }
        return Int(value)
    }

    private func handleGetTableStructure(
        _ request: RequestGetTableStructure,
        startTime: Date
    )
        -> TableStructureResponse
    {
        guard let client = sdkDatabaseClient else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let table = request.table else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("table").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request.appId)
            let structure = try client.getTableStructure(databasePath: databasePath, table: table)
            return TableStructureResponse(
                requestId: request.requestId,
                success: true,
                columns: structure.columns,
                diagnostic: structure.diagnostic,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Helpers

    private var databaseUnavailableMessage: String {
        "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
    }

    private func validateDatabaseAppId(_ appId: String?) throws {
        guard let requestedAppId = normalizedBundleId(appId) else {
            throw CommandError.missingParameter("appId")
        }

        guard let serverAppId = normalizedBundleId(sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
            throw CommandError.executionFailed(
                "\(databaseUnavailableMessage); unable to verify SDK server bundle for requested appId \(requestedAppId)"
            )
        }

        guard serverAppId == requestedAppId else {
            throw CommandError.executionFailed(
                "SDK server bundle \(serverAppId) does not match requested appId \(requestedAppId)"
            )
        }
    }

    private func totalTimeMs(from startTime: Date) -> Int64 {
        return Int64(Date().timeIntervalSince(startTime) * 1000)
    }
}

// MARK: - Errors

public enum CommandError: LocalizedError {
    case unknownCommand(String)
    case missingParameter(String)
    case invalidParameter(String, String)
    case executionFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .unknownCommand(cmd):
            // Wire text must stay "Unknown command type: <type>" — the TS client's
            // rewriteUnknownCommandError matches it to warn the runner is stale.
            return "Unknown command type: \(cmd)"
        case let .missingParameter(param):
            return "Missing required parameter: \(param)"
        case let .invalidParameter(param, value):
            return "Invalid value '\(value)' for parameter '\(param)'"
        case let .executionFailed(reason):
            return "Command execution failed: \(reason)"
        }
    }
}
