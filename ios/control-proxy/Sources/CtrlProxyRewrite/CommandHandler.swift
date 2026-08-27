import Foundation

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
    private let elementLocator: any ElementLocating
    private let gesturePerformer: any GesturePerforming
    private let perf: any PerfTracking
    private let storageInspector: (any StorageInspecting)?
    private let sdkHierarchyClient: (any SdkHierarchyFetching)?
    private let sdkHierarchyCache: (any SdkHierarchyCaching)?
    private let sdkDatabaseClient: (any SdkDatabaseFetching)?
    private let hierarchyDebouncer: (any HierarchyDebouncing)?
    private let voiceOverStateProvider: any VoiceOverStateProviding
    private let voiceOverToggle: any VoiceOverToggling
    private let frameContext: FrameContext

    init(
        elementLocator: any ElementLocating,
        gesturePerformer: any GesturePerforming,
        perf: any PerfTracking,
        storageInspector: (any StorageInspecting)? = nil,
        sdkHierarchyClient: (any SdkHierarchyFetching)? = nil,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        sdkDatabaseClient: (any SdkDatabaseFetching)? = nil,
        hierarchyDebouncer: (any HierarchyDebouncing)? = nil,
        voiceOverStateProvider: any VoiceOverStateProviding = DefaultVoiceOverStateProvider(),
        voiceOverToggle: any VoiceOverToggling = DefaultVoiceOverToggle(),
        frameContext: FrameContext = FrameContext()
    ) {
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.perf = perf
        self.storageInspector = storageInspector
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkHierarchyCache = sdkHierarchyCache
        self.sdkDatabaseClient = sdkDatabaseClient
        self.hierarchyDebouncer = hierarchyDebouncer
        self.voiceOverStateProvider = voiceOverStateProvider
        self.voiceOverToggle = voiceOverToggle
        self.frameContext = frameContext
    }

    /// Handle an incoming request and return a response.
    ///
    /// The `switch` is exhaustive over the typed `WebSocketRequest` enum: adding a new
    /// command case without a branch here fails compilation, so the dispatch table can
    /// never silently drop a command.
    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload {
        let startTime = Date()

        do {
            switch request {
            // View hierarchy commands
            case let .requestHierarchy(payload), let .requestHierarchyIfStale(payload):
                return try await handleRequestHierarchy(payload, startTime: startTime)

            case let .setHierarchyPollInterval(payload):
                return try await handleSetHierarchyPollInterval(payload, startTime: startTime)

            case let .requestScreenshot(payload):
                return try await handleRequestScreenshot(payload, startTime: startTime)

            // Gesture commands
            case let .tapCoordinates(payload):
                return try await handleTapCoordinates(payload, startTime: startTime)

            case let .swipe(payload):
                return try await handleSwipe(payload, startTime: startTime)

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
            return WebSocketResponse.error(
                type: request.requestType.responseType.rawValue,
                requestId: request.requestId,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Perf helpers
    //
    // The rewrite's expression of the reference `PerfProvider.track` over the injected
    // `any PerfTracking` (`serial` opens the scope, `end` closes it in `defer`). `tracked`
    // is `@MainActor` because its only callers are the `@MainActor` gesture operations run
    // inside `performContextCheckedGesture`; `trackedAsync` stays off-actor so a handler can
    // wrap an `await` into a `@MainActor` collaborator (the task-local scope propagates
    // across that hop, so the sub-tree nests exactly as the reference's single-threaded one).

    @MainActor
    @discardableResult
    private func tracked<T>(_ name: String, _ block: @MainActor () throws -> T) rethrows -> T {
        perf.serial(name)
        defer { perf.end() }
        return try block()
    }

    @discardableResult
    private func trackedAsync<T>(_ name: String, _ block: () async throws -> T) async rethrows -> T {
        perf.serial(name)
        defer { perf.end() }
        return try await block()
    }

    // MARK: - Network Mocking

    private func handleSetNetworkMockRules(
        _ request: RequestSetNetworkMockRules,
        startTime: Date
    )
        async -> SetNetworkMockRulesResponse
    {
        let succeeded = await sdkHierarchyClient?.setMockRules(request.rules) ?? false
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
        async -> SetNetworkErrorSimulationResponse
    {
        let config = NetworkErrorSimulationDTO(
            enabled: request.enabled,
            errorType: request.errorType,
            limit: request.limit,
            expiresAtEpochMs: request.expiresAtEpochMs
        )
        let succeeded = await sdkHierarchyClient?.setNetworkErrorSimulation(config) ?? false
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
        async -> SetNetworkFaultRulesResponse
    {
        let succeeded = await sdkHierarchyClient?.setNetworkFaultRules(request.rules) ?? false
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
        async throws -> WebSocketResponse
    {
        guard request.intervalMs > 0 else {
            throw CommandError.invalidParameter("intervalMs", String(request.intervalMs))
        }
        await hierarchyDebouncer?.updatePollIntervalMs(request.intervalMs)
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
        async throws -> HierarchyUpdateResponse
    {
        perf.serial("handleRequestHierarchy")
        defer { perf.end() }

        let disableAllFiltering = request.disableAllFiltering ?? false
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try await trackedAsync("extraction") {
                try await self.elementLocator.getViewHierarchy(disableAllFiltering: disableAllFiltering)
            }
        } catch {
            print("[CommandHandler] Hierarchy extraction failed: \(error)")
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }

        let enriched = await enrichWithMatchingSdkHierarchy(hierarchy)

        // Get accumulated timing for this operation.
        let perfTimings = perf.flush()

        return HierarchyUpdateResponse(
            requestId: request.requestId,
            data: enriched,
            perfTiming: perfTimings?.first,
            frameContext: frameContext.context(for: enriched)
        )
    }

    func enrichWithMatchingSdkHierarchy(_ hierarchy: ViewHierarchy) async -> ViewHierarchy {
        let sdk = await matchingSdkHierarchy(for: hierarchy)
        return HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdk)
    }

    func enrichWithCachedSdkHierarchy(_ hierarchy: ViewHierarchy) -> ViewHierarchy {
        HierarchyMerger.merge(xcuitest: hierarchy, sdk: matchingCachedSdkHierarchy(for: hierarchy))
    }

    /// The cached-only read path (gestures, screenshots, accessibility). Uses the cache's
    /// transactional `reconcile` — read → compare → clear in one `withLock` — closing race #2
    /// (STATUS §6). Behaviorally identical to the reference's `latest` + conditional `clear`
    /// (clearing an empty cache is a no-op).
    private func matchingCachedSdkHierarchy(for hierarchy: ViewHierarchy) -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName) else {
            return nil
        }
        return sdkHierarchyCache?.reconcile(matchingBundleId: foregroundBundleId)
    }

    /// The refresh path (`request_hierarchy`). Ported faithfully with the reference's
    /// `latest` / `clear` / `update` branching interleaved with the async server / fresh
    /// fetches; a fresh walk is only issued when the SDK server owns the foreground app.
    private func matchingSdkHierarchy(for hierarchy: ViewHierarchy) async -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName) else {
            return nil
        }

        if let cached = sdkHierarchyCache?.latest {
            if sdkHierarchy(cached, matches: foregroundBundleId) {
                return cached
            }
            guard await sdkServerMatchesForegroundBundleId(foregroundBundleId) else {
                sdkHierarchyCache?.clear()
                return nil
            }
        } else if sdkHierarchyClient != nil {
            guard await sdkServerMatchesForegroundBundleId(foregroundBundleId) else {
                return nil
            }
        }

        guard let fresh = await sdkHierarchyClient?.fetchFreshHierarchy(),
              sdkHierarchy(fresh, matches: foregroundBundleId)
        else {
            sdkHierarchyCache?.clear()
            return nil
        }
        sdkHierarchyCache?.update(fresh)
        return fresh
    }

    private func sdkServerMatchesForegroundBundleId(_ foregroundBundleId: String) async -> Bool {
        guard let serverBundleId = normalizedBundleId(await sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
            return false
        }
        return serverBundleId == foregroundBundleId
    }

    private func sdkServerMatchesTrackedForegroundApp() async -> Bool {
        guard let foregroundBundleId = normalizedBundleId(await elementLocator.foregroundBundleId) else {
            return false
        }
        return await sdkServerMatchesForegroundBundleId(foregroundBundleId)
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

    private func handleRequestScreenshot(
        _ request: RequestEnvelope,
        startTime _: Date
    )
        async throws -> ScreenshotResponse
    {
        // Frame-context correlation is opt-in: only when the client supplies a `frameContext`
        // does the screenshot pay for the surrounding hierarchy walks. A plain screenshot
        // performs zero extractions and returns `frameContext: nil`.
        //
        // When requested, read the hierarchy on both sides of the pixel capture. A change
        // during capture leaves the context absent, which makes a context-aware client fail
        // closed instead of pairing pixels from one screen with the identity of another.
        let correlate = request.frameContext != nil
        let before = correlate ? await currentFrameContext() : nil
        let screenshot = try await gesturePerformer.getScreenshotCapture()
        let after = correlate ? await currentFrameContext() : nil
        let base64 = screenshot.data.base64EncodedString()

        return ScreenshotResponse(
            requestId: request.requestId,
            data: base64,
            format: "png",
            rotation: screenshot.rotation,
            frameContext: correlate && before == after ? before : nil
        )
    }

    private func currentFrameContext() async -> String? {
        guard let hierarchy = try? await elementLocator.getViewHierarchy(disableAllFiltering: false) else {
            return nil
        }
        return frameContext.context(for: enrichWithCachedSdkHierarchy(hierarchy))
    }

    /// Validate the client's `frameContext` and run `operation` as one `@MainActor`
    /// transaction (no suspension between the generation read and the gesture), preserving
    /// the reference's single-`main.sync` atomicity. Using `MainActor.run` rather than a
    /// blocking `main.sync` is what lets the task-local perf scope reach the gesture-nested
    /// `track`s inside `operation`.
    ///
    /// No expected context means there is nothing to validate: skip the hierarchy extraction
    /// and blocking SDK fetch entirely on the fast path. When context IS supplied, extract
    /// once and prefer the zero-device-cost cached SDK hierarchy (the observe that produced
    /// `expected` warmed that cache) over the slow `/hierarchy/fresh` walk.
    @discardableResult
    private func performContextCheckedGesture<T: Sendable>(
        expected: String?,
        operation: @escaping @MainActor () throws -> T
    )
        async throws -> T
    {
        guard let expected else {
            return try await MainActor.run { try operation() }
        }

        let hierarchy = (try? await elementLocator.getViewHierarchy(disableAllFiltering: false))
            .map(enrichWithCachedSdkHierarchy)

        return try await MainActor.run {
            guard let hierarchy, self.frameContext.context(for: hierarchy) == expected else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }
            return try operation()
        }
    }

    // MARK: - Gestures

    /// Reject a non-finite gesture coordinate (`NaN` / `±Infinity`) at the handler boundary
    /// before it flows into `CGVector` / `XCUICoordinate`. Defense-in-depth for a non-wire
    /// caller or a computed coordinate; JSON cannot carry a non-finite literal (#2991).
    private func requireFinite(_ value: Double, field: String) throws {
        guard value.isFinite else {
            throw CommandError.invalidParameter(field, value.description)
        }
    }

    private func handleTapCoordinates(_ request: RequestTapCoordinates, startTime: Date) async throws -> WebSocketResponse {
        try requireFinite(request.x, field: "x")
        try requireFinite(request.y, field: "y")
        let duration = request.duration ?? 0
        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.tap(x: request.x, y: request.y, duration: TimeInterval(duration) / 1000.0)
        }

        return WebSocketResponse.success(
            type: ResponseType.tapCoordinatesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSwipe(_ request: RequestSwipe, startTime: Date) async throws -> WebSocketResponse {
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        let duration = request.duration ?? 300
        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.swipe(
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
        async throws -> WebSocketResponse
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
        try requireFinite(fingerSpacing, field: "offset")

        try await gesturePerformer.multiFingerSwipe(
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

    private func handleDrag(_ request: RequestDrag, startTime: Date) async throws -> WebSocketResponse {
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        let pressDuration = request.pressDurationMs ?? request.holdTime ?? 600
        let dragDuration = request.dragDurationMs ?? 300
        let holdDuration = request.holdDurationMs ?? 100

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.drag(
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

    private func handlePinch(_ request: RequestPinch, startTime: Date) async throws -> WebSocketResponse {
        try requireFinite(request.centerX, field: "centerX")
        try requireFinite(request.centerY, field: "centerY")
        try requireFinite(request.distanceStart, field: "distanceStart")
        try requireFinite(request.distanceEnd, field: "distanceEnd")
        try requireFinite(Double(request.rotationDegrees ?? 0), field: "rotationDegrees")
        let path = try await gesturePerformer.pinch(
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

    private func handleSetText(_ request: RequestSetText, startTime: Date) async throws -> WebSocketResponse {
        let text = request.text
        let resourceId = request.resourceId

        perf.serial("handleSetText")
        defer { perf.end() }

        do {
            try await performContextCheckedGesture(expected: request.frameContext) {
                if let resourceId {
                    try self.tracked("setText.byResourceId") {
                        try self.gesturePerformer.setText(resourceId: resourceId, text: text)
                    }
                } else {
                    try self.tracked("typeText") {
                        try self.gesturePerformer.typeText(text: text)
                    }
                }
            }
        } catch {
            print("[CommandHandler] handleSetText FAILED resourceId=\(resourceId ?? "nil") error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.setTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleAppendText(_ request: RequestAppendText, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleAppendText")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("appendText") {
                try self.gesturePerformer.appendText(text: request.text)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.appendTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleClearText(_ request: RequestClearText, startTime: Date) async throws -> WebSocketResponse {
        let resourceId = request.resourceId

        perf.serial("handleClearText")
        defer { perf.end() }

        do {
            try await trackedAsync("clearText") {
                try await self.gesturePerformer.clearText(resourceId: resourceId)
            }
        } catch {
            print("[CommandHandler] handleClearText FAILED resourceId=\(resourceId ?? "nil") error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.clearTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleImeAction(_ request: RequestImeAction, startTime: Date) async throws -> WebSocketResponse {
        let action = request.action

        perf.serial("handleImeAction")
        defer { perf.end() }

        do {
            try await trackedAsync("imeAction") {
                try await self.gesturePerformer.performImeAction(action)
            }
        } catch {
            print("[CommandHandler] handleImeAction FAILED action=\(action) error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.imeActionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleSelectAll(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleSelectAll")
        defer { perf.end() }

        do {
            try await trackedAsync("selectAll") {
                try await self.gesturePerformer.selectAll()
            }
        } catch {
            print("[CommandHandler] handleSelectAll FAILED error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.selectAllResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleKeyboard(_ request: RequestKeyboard, startTime: Date) async throws -> KeyboardResponse {
        let action = request.action

        perf.serial("handleKeyboard")
        defer { perf.end() }

        let open = try await trackedAsync("keyboard") {
            try await self.gesturePerformer.keyboard(action: action)
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

    private func handlePressButton(_ request: RequestPressButton, startTime: Date) async throws -> WebSocketResponse {
        let button = request.action

        perf.serial("handlePressButton")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressButton") {
                try self.gesturePerformer.pressButton(button)
            }
        }

        if button.lowercased() == "home" || button.lowercased() == "recent" {
            await trackedAsync("switchForegroundApp") {
                await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
            }
            await trackedAsync("updateApplication") {
                await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressButtonResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePressHome(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handlePressHome")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressHome") {
                try self.gesturePerformer.pressHome()
            }
        }

        // Explicit state transition: home screen means springboard is now foreground.
        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.pressHomeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handlePressBack(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handlePressBack")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressBack") {
                try self.gesturePerformer.pressBack()
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressBackResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleShake(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleShake")
        defer { perf.end() }

        try await trackedAsync("shake") {
            try await self.gesturePerformer.shake()
        }

        return WebSocketResponse.success(
            type: ResponseType.shakeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleRecentApps(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleRecentApps")
        defer { perf.end() }

        let didOpen = try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("openRecentApps") {
                try self.gesturePerformer.openRecentApps()
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

        // Explicit state transition: app switcher is SpringBoard UI.
        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.recentAppsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Actions

    private func handleAction(_ request: RequestAction, startTime: Date) async throws -> WebSocketResponse {
        try await gesturePerformer.performAction(request.action, resourceId: request.resourceId, label: request.label)

        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleActivateAccessibilityLink(
        _ request: RequestActivateAccessibilityLink,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        // Prefer the in-app SDK's per-link geometry: it is the only source that can
        // disambiguate duplicate inline links and see SwiftUI inline links, which
        // XCUITest's `.link` query cannot (issue #5560). A resolved center is tapped
        // directly; otherwise fall back to the XCUITest `.link` path, which still throws
        // cleanly (never a false success) when nothing matches.
        let fresh = await sdkHierarchyClient?.fetchFreshHierarchy()
        if let coordinate = SemanticLinkActivation.coordinate(
            in: fresh,
            ownerResourceId: request.ownerResourceId,
            text: request.text,
            occurrence: request.occurrence
        ) {
            try await gesturePerformer.tap(x: coordinate.x, y: coordinate.y, duration: 0)
        } else {
            try await gesturePerformer.activateAccessibilityLink(
                text: request.text,
                occurrence: request.occurrence,
                ownerResourceId: request.ownerResourceId
            )
        }
        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    private func handleLaunchApp(_ request: RequestLaunchApp, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleLaunchApp")
        defer { perf.end() }

        let bundleId = request.bundleId
        let coldBoot = request.coldBoot ?? false

        // Check current app state to decide launch strategy.
        let appState = await trackedAsync("checkAppState") {
            await self.elementLocator.getAppState(bundleId: bundleId)
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
            // Cold boot: always terminate then launch fresh.
            if appState == .runningForeground || appState == .runningBackground || appState ==
                .runningBackgroundSuspended
            {
                try await trackedAsync("terminateApp") {
                    try await self.gesturePerformer.terminateApp(bundleId: bundleId)
                }
            }
            try await trackedAsync("launchApp") {
                try await self.gesturePerformer.launchApp(bundleId: bundleId)
            }
        } else if appState == .runningForeground {
            // Already in foreground — activate is a no-op but ensures XCTest sync.
            try await trackedAsync("activateApp") {
                try await self.gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else if appState == .runningBackground || appState == .runningBackgroundSuspended {
            // App running but not visible — activate brings to foreground (fast path).
            try await trackedAsync("activateApp") {
                try await self.gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else {
            // App not running — must do full launch.
            try await trackedAsync("launchApp") {
                try await self.gesturePerformer.launchApp(bundleId: bundleId)
            }
        }

        // Explicit state transition: switch tracking to launched app.
        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: bundleId)
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: bundleId)
        }

        // Skip foreground poll when activate() was called on an already-foreground app —
        // activate() is synchronous and the app is guaranteed to remain foreground.
        if !alreadyForeground || coldBoot {
            await trackedAsync("awaitForeground") {
                _ = await self.elementLocator.awaitAppState(bundleId: bundleId, expectedState: .foreground)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.launchAppResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - App Privacy Permissions

    /// Reset privacy authorizations for an app to not-determined. An empty `permissions`
    /// array is rejected so the client gets an actionable error instead of a silent success;
    /// an unmapped resource throws from the gesture performer and surfaces via the catch (#2491).
    private func handleResetPermissions(_ request: RequestResetPermissions, startTime: Date) async throws
        -> WebSocketResponse
    {
        guard !request.permissions.isEmpty else {
            throw CommandError.missingParameter("permissions")
        }
        try await gesturePerformer.resetAuthorizations(bundleId: request.bundleId, resources: request.permissions)
        return WebSocketResponse.success(
            type: ResponseType.resetPermissionsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - Device Control

    private func handleRotate(_ request: RequestRotate, startTime: Date) async throws -> RotateResponse {
        let orientation = request.orientation

        let previousOrientation = await gesturePerformer.getOrientation()

        // Map "landscape" to "landscape_left" (standard rotation direction).
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

        // Normalize to "portrait" or "landscape" for the result.
        let normalizedPrevious = previousOrientation.hasPrefix("landscape") ? "landscape" : "portrait"
        let normalizedTarget = iosOrientation.hasPrefix("landscape") ? "landscape" : "portrait"
        let value = normalizedTarget == "portrait" ? 0 : 1

        // Check if already in the desired orientation.
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

        try await gesturePerformer.setOrientation(iosOrientation)

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

    private func handleClipboard(_ request: RequestClipboard, startTime: Date) async throws -> WebSocketResponse {
        let resultText = try await gesturePerformer.clipboard(action: request.action, text: request.text)

        return WebSocketResponse.success(
            type: ResponseType.clipboardResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            text: resultText
        )
    }

    // MARK: - Accessibility Features

    /// Report the element holding the VoiceOver cursor. The cursor is only visible in-process,
    /// so it reaches us as `accessibility-focused` on the SDK-enriched hierarchy (see
    /// HierarchyMerger, #3924). A null focusedElement is a success, not an error.
    private func handleGetCurrentFocus(_ request: RequestEnvelope, startTime: Date) async throws -> CurrentFocusResponse {
        let enriched = try await enrichedHierarchyForAccessibility()
        let focused = enriched.hierarchy.flatMap { Self.findAccessibilityFocused($0) }
        return CurrentFocusResponse(
            requestId: request.requestId,
            focusedElement: focused,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Report accessibility elements in VoiceOver traversal (depth-first) order, plus the
    /// index of the focused one when the cursor is present (#3924).
    private func handleGetTraversalOrder(_ request: RequestEnvelope, startTime: Date) async throws -> TraversalOrderResponse {
        let enriched = try await enrichedHierarchyForAccessibility()
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

    /// Extract the hierarchy and merge the in-app SDK view tree into it, so accessibility-only
    /// signals (the VoiceOver cursor, `isAccessibilityElement`) are present.
    private func enrichedHierarchyForAccessibility() async throws -> ViewHierarchy {
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try await trackedAsync("extraction") {
                try await self.elementLocator.getViewHierarchy(disableAllFiltering: false)
            }
        } catch {
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }
        return await enrichWithMatchingSdkHierarchy(hierarchy)
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
    /// is the precise signal, carried through from the in-app SDK; containers that merely
    /// hold other elements are skipped but still traversed into.
    static func collectAccessibilityElements(_ element: UIElementInfo, into ordered: inout [UIElementInfo]) {
        if element.extras?["sdk.isAccessibilityElement"] == "true" {
            ordered.append(element)
        }
        for child in element.node ?? [] {
            collectAccessibilityElements(child, into: &ordered)
        }
    }

    private func handleAddHighlight(_ request: RequestAddHighlight, startTime: Date) async -> WebSocketResponse {
        guard let shape = request.shape else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "add_highlight requires a shape",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let highlightId = request.id ?? request.requestId ?? UUID().uuidString
        // When the in-app SDK bridge owns the foreground app, it is the authoritative (and
        // only) highlight path. A rejection there — e.g. missing source dimensions (#2682) —
        // must be reported precisely rather than collapsed into the generic "SDK not embedded"
        // error below, which would mislead since the SDK is in fact embedded. An unreachable
        // bridge falls through to that generic error.
        if sdkHierarchyClient != nil, await sdkServerMatchesTrackedForegroundApp() {
            switch await sdkHierarchyClient?.addHighlight(id: highlightId, shape: shape) {
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
        // iOS cannot draw an overlay into another app from the test runner: the runner's own
        // UIWindow only composites while the runner is foreground, which never happens during
        // automation. Highlighting the app-under-test requires the in-app AutoMobile SDK bridge.
        let foregroundBundleId = await elementLocator.foregroundBundleId ?? "the foreground app"
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
        async -> VoiceOverStateResponse
    {
        let enabled = voiceOverStateProvider.isVoiceOverRunning()

        return VoiceOverStateResponse(
            requestId: request.requestId,
            enabled: enabled,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Enable/disable VoiceOver on a physical device by driving Settings (#2501). Idempotent:
    /// when VoiceOver is already in the requested state this early-returns WITHOUT tapping —
    /// load-bearing, since once VoiceOver is on every tap requires the double-tap idiom, so a
    /// blind re-tap on the switch would be a VoiceOver activation rather than a toggle.
    private func handleSetVoiceOverState(
        _ request: RequestSetVoiceOverState,
        startTime: Date
    )
        async -> VoiceOverSetResponse
    {
        let enabled = request.enabled

        if voiceOverStateProvider.isVoiceOverRunning() == enabled {
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: true,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try voiceOverToggle.setVoiceOver(enabled: enabled)
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: true,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Storage

    /// Resolve suite name from request fileName: nil/empty/"Standard" -> nil (UserDefaults.standard).
    private func resolveSuiteName(_ fileName: String?) -> String? {
        guard let name = fileName, !name.isEmpty, name != "Standard" else { return nil }
        return name
    }

    private func handleListPreferenceFiles(_ request: RequestEnvelope, startTime: Date) async -> StorageFilesResponse {
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

    private func handleGetPreferences(_ request: RequestGetPreferences, startTime: Date) async -> StorageEntriesResponse {
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

    private func handleGetPreference(_ request: RequestGetPreference, startTime: Date) async -> StorageEntryResponse {
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

    private func handleSetPreference(_ request: RequestSetPreference, startTime: Date) async throws -> WebSocketResponse {
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
        async throws -> WebSocketResponse
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
        async throws -> WebSocketResponse
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

    private func handleExecuteSql(_ request: RequestExecuteSql, startTime: Date) async -> ExecuteSqlResponse {
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
            try await validateDatabaseAppId(request.appId)
            let result = try await client.executeSQL(databasePath: databasePath, query: query, sessionId: request.sessionId)
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

    private func handleListDatabases(_ request: RequestListDatabases, startTime: Date) async -> ListDatabasesResponse {
        guard let client = sdkDatabaseClient else {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            return try await ListDatabasesResponse(
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
    )
        async -> StorageCapabilitiesResponse
    {
        guard let client = sdkDatabaseClient else {
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            let capabilities = try await client.storageCapabilities()
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

    private func handleListTables(_ request: RequestListTables, startTime: Date) async -> ListTablesResponse {
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
            try await validateDatabaseAppId(request.appId)
            return try await ListTablesResponse(
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

    private func handleGetTableData(_ request: RequestGetTableData, startTime: Date) async -> TableDataResponse {
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
            try await validateDatabaseAppId(request.appId)
            let data = try await client.getTableData(
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

    /// Convert a wire-supplied table `offset` into a safe non-negative `Int`. `offset` is
    /// decoded as a `Double` and is untrusted: a non-finite value or a magnitude beyond
    /// `Int64` would trap `Int(_:)` and crash the runner (#3616). Non-finite/negative → 0;
    /// values at/above `Int.max` clamp to `Int.max`.
    static func sanitizedTableOffset(_ value: Double?) -> Int {
        guard let value = value, value.isFinite, value >= 0 else { return 0 }
        if value >= Double(Int.max) { return Int.max }
        return Int(value)
    }

    private func handleGetTableStructure(
        _ request: RequestGetTableStructure,
        startTime: Date
    )
        async -> TableStructureResponse
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
            try await validateDatabaseAppId(request.appId)
            let structure = try await client.getTableStructure(databasePath: databasePath, table: table)
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

    private func validateDatabaseAppId(_ appId: String?) async throws {
        guard let requestedAppId = normalizedBundleId(appId) else {
            throw CommandError.missingParameter("appId")
        }

        guard let serverAppId = normalizedBundleId(await sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
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
        Int64(Date().timeIntervalSince(startTime) * 1000)
    }
}
