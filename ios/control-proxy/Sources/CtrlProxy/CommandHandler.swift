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
    private let highlightOverlayManager: HighlightOverlayManaging
    private let sdkDatabaseClient: (any SdkDatabaseFetching)?

    public init(
        elementLocator: ElementLocating,
        gesturePerformer: GesturePerforming,
        perfProvider: PerfProvider = PerfProvider.instance,
        storageInspector: StorageInspecting? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        highlightOverlayManager: HighlightOverlayManaging = HighlightOverlayManager(),
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil
    ) {
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.perfProvider = perfProvider
        self.storageInspector = storageInspector
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkHierarchyCache = sdkHierarchyCache
        self.highlightOverlayManager = highlightOverlayManager
        self.sdkDatabaseClient = sdkDatabaseClient
    }

    /// Factory for testing - allows injecting fakes
    public static func createForTesting(
        elementLocator: ElementLocating,
        gesturePerformer: GesturePerforming,
        perfProvider: PerfProvider,
        storageInspector: StorageInspecting? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        highlightOverlayManager: HighlightOverlayManaging = HighlightOverlayManager(),
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil
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
            highlightOverlayManager: highlightOverlayManager,
            sdkDatabaseClient: sdkDatabaseClient
        )
    }

    /// Handle an incoming request and return a response
    public func handle(_ request: WebSocketRequest) -> Any {
        let startTime = Date()

        do {
            switch request.type {
            // View hierarchy commands
            case RequestType.requestHierarchy.rawValue,
                 RequestType.requestHierarchyIfStale.rawValue:
                return try handleRequestHierarchy(request, startTime: startTime)

            case RequestType.requestScreenshot.rawValue:
                return try handleRequestScreenshot(request, startTime: startTime)

            // Gesture commands
            case RequestType.requestTapCoordinates.rawValue:
                return try handleTapCoordinates(request, startTime: startTime)

            case RequestType.requestSwipe.rawValue:
                return try handleSwipe(request, startTime: startTime)

            case RequestType.requestTwoFingerSwipe.rawValue:
                return try handleTwoFingerSwipe(request, startTime: startTime)

            case RequestType.requestMultiFingerSwipe.rawValue:
                return try handleMultiFingerSwipe(request, startTime: startTime)

            case RequestType.requestDrag.rawValue:
                return try handleDrag(request, startTime: startTime)

            case RequestType.requestPinch.rawValue:
                return try handlePinch(request, startTime: startTime)

            // Text input commands
            case RequestType.requestSetText.rawValue:
                return try handleSetText(request, startTime: startTime)

            case RequestType.requestClearText.rawValue:
                return try handleClearText(request, startTime: startTime)

            case RequestType.requestImeAction.rawValue:
                return try handleImeAction(request, startTime: startTime)

            case RequestType.requestSelectAll.rawValue:
                return try handleSelectAll(request, startTime: startTime)

            case RequestType.requestKeyboard.rawValue:
                return try handleKeyboard(request, startTime: startTime)

            case RequestType.requestPressButton.rawValue:
                return try handlePressButton(request, startTime: startTime)

            case RequestType.requestPressHome.rawValue:
                return try handlePressHome(request, startTime: startTime)

            case RequestType.requestPressBack.rawValue:
                return try handlePressBack(request, startTime: startTime)

            case RequestType.requestShake.rawValue:
                return try handleShake(request, startTime: startTime)

            case RequestType.requestRecentApps.rawValue:
                return try handleRecentApps(request, startTime: startTime)

            // Action commands
            case RequestType.requestAction.rawValue:
                return try handleAction(request, startTime: startTime)

            case RequestType.requestLaunchApp.rawValue:
                return try handleLaunchApp(request, startTime: startTime)

            // Device control
            case RequestType.requestRotate.rawValue:
                return try handleRotate(request, startTime: startTime)

            // Clipboard commands
            case RequestType.requestClipboard.rawValue:
                return try handleClipboard(request, startTime: startTime)

            // Accessibility features
            case RequestType.getCurrentFocus.rawValue:
                return try handleGetCurrentFocus(request, startTime: startTime)

            case RequestType.getTraversalOrder.rawValue:
                return try handleGetTraversalOrder(request, startTime: startTime)

            case RequestType.addHighlight.rawValue:
                return try handleAddHighlight(request, startTime: startTime)

            case RequestType.getVoiceOverState.rawValue:
                return try handleGetVoiceOverState(request, startTime: startTime)

            // Storage commands
            case RequestType.listPreferenceFiles.rawValue:
                return handleListPreferenceFiles(request, startTime: startTime)

            case RequestType.getPreferences.rawValue:
                return handleGetPreferences(request, startTime: startTime)

            case RequestType.getPreference.rawValue:
                return handleGetPreference(request, startTime: startTime)

            case RequestType.setPreference.rawValue:
                return try handleSetPreference(request, startTime: startTime)

            case RequestType.removePreference.rawValue:
                return try handleRemovePreference(request, startTime: startTime)

            case RequestType.clearPreferences.rawValue:
                return try handleClearPreferences(request, startTime: startTime)

            // Network mocking
            case RequestType.setNetworkMockRules.rawValue:
                return try handleSetNetworkMockRules(request, startTime: startTime)

            // Database commands
            case RequestType.executeSql.rawValue:
                return handleExecuteSql(request, startTime: startTime)

            case RequestType.listDatabases.rawValue:
                return handleListDatabases(request, startTime: startTime)

            case RequestType.listTables.rawValue:
                return handleListTables(request, startTime: startTime)

            case RequestType.getTableData.rawValue:
                return handleGetTableData(request, startTime: startTime)

            case RequestType.getTableStructure.rawValue:
                return handleGetTableStructure(request, startTime: startTime)

            default:
                return WebSocketResponse.error(
                    type: "error",
                    requestId: request.requestId,
                    error: "Unknown command type: \(request.type)",
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            }
        } catch {
            return WebSocketResponse.error(
                type: responseType(for: request.type),
                requestId: request.requestId,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Network Mocking

    private func handleSetNetworkMockRules(
        _ request: WebSocketRequest,
        startTime: Date
    )
        throws -> SetNetworkMockRulesResponse
    {
        guard let rules = request.rules else {
            throw CommandError.missingParameter("rules")
        }
        let succeeded = sdkHierarchyClient?.setMockRules(rules) ?? false
        return SetNetworkMockRulesResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - View Hierarchy

    private func handleRequestHierarchy(
        _ request: WebSocketRequest,
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
            perfTiming: perfTimings?.first
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

    private func handleRequestScreenshot(_ request: WebSocketRequest, startTime _: Date) throws -> ScreenshotResponse {
        let data = try gesturePerformer.getScreenshot()
        let base64 = data.base64EncodedString()

        return ScreenshotResponse(
            requestId: request.requestId,
            data: base64,
            format: "png"
        )
    }

    // MARK: - Gestures

    private func handleTapCoordinates(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let x = request.x, let y = request.y else {
            throw CommandError.missingParameter("x and y coordinates")
        }

        let duration = request.duration ?? 0
        try gesturePerformer.tap(x: Double(x), y: Double(y), duration: TimeInterval(duration) / 1000.0)

        return WebSocketResponse.success(
            type: ResponseType.tapCoordinatesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSwipe(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let x1 = request.x1, let y1 = request.y1,
              let x2 = request.x2, let y2 = request.y2
        else {
            throw CommandError.missingParameter("x1, y1, x2, y2")
        }

        let duration = request.duration ?? 300
        try gesturePerformer.swipe(
            startX: Double(x1), startY: Double(y1),
            endX: Double(x2), endY: Double(y2),
            duration: TimeInterval(duration) / 1000.0
        )

        return WebSocketResponse.success(
            type: ResponseType.swipeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleTwoFingerSwipe(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        try handleMultiFingerSwipe(request, startTime: startTime, defaultFingers: 2)
    }

    private func handleMultiFingerSwipe(
        _ request: WebSocketRequest,
        startTime: Date,
        defaultFingers: Int = 2
    )
        throws -> WebSocketResponse
    {
        guard let x1 = request.x1, let y1 = request.y1,
              let x2 = request.x2, let y2 = request.y2
        else {
            throw CommandError.missingParameter("x1, y1, x2, y2")
        }

        let fingerCount = request.fingerCount ?? defaultFingers
        let duration = request.duration ?? 300
        let fingerSpacing = request.offset ?? 25

        try gesturePerformer.multiFingerSwipe(
            startX: Double(x1),
            startY: Double(y1),
            endX: Double(x2),
            endY: Double(y2),
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

    private func handleDrag(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let x1 = request.x1, let y1 = request.y1,
              let x2 = request.x2, let y2 = request.y2
        else {
            throw CommandError.missingParameter("x1, y1, x2, y2")
        }

        let pressDuration = request.pressDurationMs ?? request.holdTime ?? 600
        let dragDuration = request.dragDurationMs ?? 300
        let holdDuration = request.holdDurationMs ?? 100

        try gesturePerformer.drag(
            startX: Double(x1), startY: Double(y1),
            endX: Double(x2), endY: Double(y2),
            pressDuration: TimeInterval(pressDuration) / 1000.0,
            dragDuration: TimeInterval(dragDuration) / 1000.0,
            holdDuration: TimeInterval(holdDuration) / 1000.0
        )

        return WebSocketResponse.success(
            type: ResponseType.dragResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePinch(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let centerX = request.centerX, let centerY = request.centerY,
              let distanceStart = request.distanceStart, let distanceEnd = request.distanceEnd
        else {
            throw CommandError.missingParameter("centerX, centerY, distanceStart, distanceEnd")
        }

        try gesturePerformer.pinch(
            centerX: Double(centerX),
            centerY: Double(centerY),
            distanceStart: Double(distanceStart),
            distanceEnd: Double(distanceEnd),
            rotationDegrees: Double(request.rotationDegrees ?? 0),
            duration: TimeInterval(request.duration ?? 300) / 1000.0
        )

        return WebSocketResponse.success(
            type: ResponseType.pinchResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Text Input

    private func handleSetText(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let text = request.text else {
            throw CommandError.missingParameter("text")
        }

        perfProvider.serial("handleSetText")
        defer { perfProvider.end() }

        let resourceId = request.resourceId
        textInputLog
            .debug(
                "handleSetText begin resourceId=\(resourceId ?? "nil", privacy: .public) textLength=\(text.count, privacy: .public) requestId=\(request.requestId ?? "nil", privacy: .public)"
            )

        do {
            if let resourceId = resourceId {
                try perfProvider.track("setText.byResourceId") {
                    try gesturePerformer.setText(resourceId: resourceId, text: text)
                }
            } else {
                try perfProvider.track("typeText") {
                    try gesturePerformer.typeText(text: text)
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

    private func handleClearText(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
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

    private func handleImeAction(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let action = request.action else {
            throw CommandError.missingParameter("action")
        }

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

    private func handleSelectAll(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
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

    private func handleKeyboard(_ request: WebSocketRequest, startTime: Date) throws -> KeyboardResponse {
        guard let action = request.action else {
            throw CommandError.missingParameter("action")
        }

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

    private func handlePressButton(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let button = request.action else {
            throw CommandError.missingParameter("action")
        }

        perfProvider.serial("handlePressButton")
        defer { perfProvider.end() }

        try perfProvider.track("pressButton") {
            try gesturePerformer.pressButton(button)
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

    private func handlePressHome(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handlePressHome")
        defer { perfProvider.end() }

        try perfProvider.track("pressHome") {
            try gesturePerformer.pressHome()
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

    private func handlePressBack(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handlePressBack")
        defer { perfProvider.end() }

        try perfProvider.track("pressBack") {
            try gesturePerformer.pressBack()
        }

        return WebSocketResponse.success(
            type: ResponseType.pressBackResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleShake(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
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

    private func handleRecentApps(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleRecentApps")
        defer { perfProvider.end() }

        try perfProvider.track("openRecentApps") {
            try gesturePerformer.openRecentApps()
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

    private func handleAction(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let action = request.action else {
            throw CommandError.missingParameter("action")
        }

        try gesturePerformer.performAction(action, resourceId: request.resourceId, label: request.label)

        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleLaunchApp(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        perfProvider.serial("handleLaunchApp")
        defer { perfProvider.end() }

        guard let bundleId = request.bundleId else {
            throw CommandError.missingParameter("bundleId")
        }

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

    // MARK: - Device Control

    private func handleRotate(_ request: WebSocketRequest, startTime: Date) throws -> RotateResponse {
        guard let orientation = request.orientation else {
            throw CommandError.missingParameter("orientation")
        }

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

    private func handleClipboard(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let action = request.action else {
            throw CommandError.missingParameter("action")
        }

        let resultText = try gesturePerformer.clipboard(action: action, text: request.text)

        return WebSocketResponse.success(
            type: ResponseType.clipboardResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            text: resultText
        )
    }

    // MARK: - Accessibility Features

    private func handleGetCurrentFocus(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        // Stub: Focus tracking not yet implemented
        return WebSocketResponse.error(
            type: ResponseType.currentFocusResult.rawValue,
            requestId: request.requestId,
            error: "Current focus not yet implemented on iOS",
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleGetTraversalOrder(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        // Stub: Traversal order not yet implemented
        return WebSocketResponse.error(
            type: ResponseType.traversalOrderResult.rawValue,
            requestId: request.requestId,
            error: "Traversal order not yet implemented on iOS",
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleAddHighlight(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let shape = request.shape else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "add_highlight requires a shape",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let highlightId = request.id ?? request.requestId ?? UUID().uuidString
        if sdkHierarchyClient != nil,
           sdkServerMatchesTrackedForegroundApp(),
           sdkHierarchyClient?.addHighlight(id: highlightId, shape: shape) == true
        {
            return WebSocketResponse.success(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard highlightOverlayManager.show(id: highlightId, shape: shape) else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "Unable to render highlight on iOS: target app SDK highlight bridge unavailable and runner overlay fallback failed.",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        return WebSocketResponse.success(
            type: ResponseType.highlightResponse.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleGetVoiceOverState(
        _ request: WebSocketRequest,
        startTime: Date
    )
        throws -> VoiceOverStateResponse
    {
        #if os(iOS)
            let enabled = UIAccessibility.isVoiceOverRunning
        #else
            let enabled = false
        #endif

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

    private func handleListPreferenceFiles(_ request: WebSocketRequest, startTime: Date) -> StorageFilesResponse {
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

    private func handleGetPreferences(_ request: WebSocketRequest, startTime: Date) -> StorageEntriesResponse {
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

    private func handleGetPreference(_ request: WebSocketRequest, startTime: Date) -> StorageEntryResponse {
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

    private func handleSetPreference(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let inspector = storageInspector else {
            return WebSocketResponse.error(
                type: ResponseType.setPreferenceResult.rawValue,
                requestId: request.requestId,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        guard let key = request.key else {
            throw CommandError.missingParameter("key")
        }
        guard let valueType = request.valueType else {
            throw CommandError.missingParameter("valueType")
        }

        let suiteName = resolveSuiteName(request.fileName)
        try inspector.setEntry(suiteName: suiteName, key: key, value: request.value, type: valueType)

        return WebSocketResponse.success(
            type: ResponseType.setPreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleRemovePreference(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
        guard let inspector = storageInspector else {
            return WebSocketResponse.error(
                type: ResponseType.removePreferenceResult.rawValue,
                requestId: request.requestId,
                error: "Storage inspection not available",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        guard let key = request.key else {
            throw CommandError.missingParameter("key")
        }

        let suiteName = resolveSuiteName(request.fileName)
        try inspector.removeEntry(suiteName: suiteName, key: key)

        return WebSocketResponse.success(
            type: ResponseType.removePreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleClearPreferences(_ request: WebSocketRequest, startTime: Date) throws -> WebSocketResponse {
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

    private func handleExecuteSql(_ request: WebSocketRequest, startTime: Date) -> ExecuteSqlResponse {
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
            try validateDatabaseAppId(request)
            let result = try client.executeSQL(databasePath: databasePath, query: query)
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

    private func handleListDatabases(_ request: WebSocketRequest, startTime: Date) -> ListDatabasesResponse {
        guard let client = sdkDatabaseClient else {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try validateDatabaseAppId(request)
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

    private func handleListTables(_ request: WebSocketRequest, startTime: Date) -> ListTablesResponse {
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
            try validateDatabaseAppId(request)
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

    private func handleGetTableData(_ request: WebSocketRequest, startTime: Date) -> TableDataResponse {
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
            try validateDatabaseAppId(request)
            let data = try client.getTableData(
                databasePath: databasePath,
                table: table,
                limit: request.limit ?? 50,
                offset: Int(request.offset ?? 0)
            )
            return TableDataResponse(
                requestId: request.requestId,
                success: true,
                columns: data.columns,
                rows: data.rows,
                total: data.total,
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

    private func handleGetTableStructure(_ request: WebSocketRequest, startTime: Date) -> TableStructureResponse {
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
            try validateDatabaseAppId(request)
            let structure = try client.getTableStructure(databasePath: databasePath, table: table)
            return TableStructureResponse(
                requestId: request.requestId,
                success: true,
                columns: structure.columns,
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

    private func validateDatabaseAppId(_ request: WebSocketRequest) throws {
        guard let requestedAppId = normalizedBundleId(request.appId) else {
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

    private func responseType(for requestType: String) -> String {
        switch requestType {
        case RequestType.requestHierarchy.rawValue,
             RequestType.requestHierarchyIfStale.rawValue:
            return ResponseType.hierarchyUpdate.rawValue
        case RequestType.requestScreenshot.rawValue:
            return ResponseType.screenshot.rawValue
        case RequestType.requestTapCoordinates.rawValue:
            return ResponseType.tapCoordinatesResult.rawValue
        case RequestType.requestSwipe.rawValue:
            return ResponseType.swipeResult.rawValue
        case RequestType.requestTwoFingerSwipe.rawValue,
             RequestType.requestMultiFingerSwipe.rawValue:
            return ResponseType.multiFingerSwipeResult.rawValue
        case RequestType.requestDrag.rawValue:
            return ResponseType.dragResult.rawValue
        case RequestType.requestPinch.rawValue:
            return ResponseType.pinchResult.rawValue
        case RequestType.requestSetText.rawValue:
            return ResponseType.setTextResult.rawValue
        case RequestType.requestClearText.rawValue:
            return ResponseType.clearTextResult.rawValue
        case RequestType.requestImeAction.rawValue:
            return ResponseType.imeActionResult.rawValue
        case RequestType.requestSelectAll.rawValue:
            return ResponseType.selectAllResult.rawValue
        case RequestType.requestKeyboard.rawValue:
            return ResponseType.keyboardResult.rawValue
        case RequestType.requestPressButton.rawValue:
            return ResponseType.pressButtonResult.rawValue
        case RequestType.requestPressHome.rawValue:
            return ResponseType.pressHomeResult.rawValue
        case RequestType.requestPressBack.rawValue:
            return ResponseType.pressBackResult.rawValue
        case RequestType.requestShake.rawValue:
            return ResponseType.shakeResult.rawValue
        case RequestType.requestRecentApps.rawValue:
            return ResponseType.recentAppsResult.rawValue
        case RequestType.requestAction.rawValue:
            return ResponseType.actionResult.rawValue
        case RequestType.requestLaunchApp.rawValue:
            return ResponseType.launchAppResult.rawValue
        case RequestType.requestRotate.rawValue:
            return ResponseType.rotateResult.rawValue
        case RequestType.requestClipboard.rawValue:
            return ResponseType.clipboardResult.rawValue
        case RequestType.getVoiceOverState.rawValue:
            return ResponseType.voiceOverStateResult.rawValue
        case RequestType.listPreferenceFiles.rawValue:
            return ResponseType.preferenceFiles.rawValue
        case RequestType.getPreferences.rawValue:
            return ResponseType.preferences.rawValue
        case RequestType.getPreference.rawValue:
            return ResponseType.getPreferenceResult.rawValue
        case RequestType.setPreference.rawValue:
            return ResponseType.setPreferenceResult.rawValue
        case RequestType.removePreference.rawValue:
            return ResponseType.removePreferenceResult.rawValue
        case RequestType.clearPreferences.rawValue:
            return ResponseType.clearPreferencesResult.rawValue
        case RequestType.setNetworkMockRules.rawValue:
            return ResponseType.setNetworkMockRulesResult.rawValue
        case RequestType.executeSql.rawValue:
            return ResponseType.executeSqlResult.rawValue
        case RequestType.listDatabases.rawValue:
            return ResponseType.listDatabasesResult.rawValue
        case RequestType.listTables.rawValue:
            return ResponseType.listTablesResult.rawValue
        case RequestType.getTableData.rawValue:
            return ResponseType.tableDataResult.rawValue
        case RequestType.getTableStructure.rawValue:
            return ResponseType.tableStructureResult.rawValue
        default:
            return "error"
        }
    }
}

// MARK: - Errors

public enum CommandError: LocalizedError {
    case unknownCommand(String)
    case missingParameter(String)
    case invalidParameter(String, String)
    case elementNotFound(String)
    case executionFailed(String)
    case notSupported(String)

    public var errorDescription: String? {
        switch self {
        case let .unknownCommand(cmd):
            return "Unknown command: \(cmd)"
        case let .missingParameter(param):
            return "Missing required parameter: \(param)"
        case let .invalidParameter(param, value):
            return "Invalid value '\(value)' for parameter '\(param)'"
        case let .elementNotFound(id):
            return "Element not found: \(id)"
        case let .executionFailed(reason):
            return "Command execution failed: \(reason)"
        case let .notSupported(feature):
            return "Feature not supported: \(feature)"
        }
    }
}
