import Foundation

extension CommandHandler {
    @discardableResult
    func performContextCheckedGesture<T: Sendable>(
        expected: String?,
        beforeOperation: (@Sendable () throws -> Void)? = nil,
        operation: @escaping @MainActor () throws -> T
    )
        async throws -> T
    {
        guard let expected else {
            try beforeOperation?()
            return try await perf.withScope { try await MainActor.run { try operation() } }
        }

        let hierarchy: ViewHierarchy
        do {
            hierarchy = try enrichWithCachedSdkHierarchy(await captureHierarchy())
        } catch {
            throw CommandError.hierarchyCaptureFailed(reason: WireError.message(for: error))
        }
        try beforeOperation?()

        return try await perf.withScope {
            try await MainActor.run {
                guard self.frameContext.context(for: hierarchy) == expected else {
                    throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
                }
                return try operation()
            }
        }
    }

    /// Async gestures retain the fresh perf scope and validate on the main actor immediately
    /// before starting the operation. The server's serial command chain prevents another
    /// command from interleaving while keyboard polling yields this actor. Awaiting directly
    /// keeps cancellation and task-local diagnostics in the caller's task.
    /// Capture failure rejects the gesture before `beforeOperation` with `hierarchyCaptureFailed`;
    /// no expected context skips capture, and a captured context mismatch retains the stale error.
    @discardableResult
    func performContextCheckedGestureAsync<T: Sendable>(
        expected: String?,
        beforeOperation: (@Sendable () throws -> Void)? = nil,
        operation: @escaping @MainActor () async throws -> T
    )
        async throws -> T
    {
        let hierarchy: ViewHierarchy?
        if expected != nil {
            do {
                hierarchy = try enrichWithCachedSdkHierarchy(await captureHierarchy())
            } catch {
                throw CommandError.hierarchyCaptureFailed(reason: WireError.message(for: error))
            }
        } else {
            hierarchy = nil
        }
        try beforeOperation?()
        return try await perf.withScope {
            try await self.performAsyncGestureOnMainActor(
                expected: expected,
                hierarchy: hierarchy,
                operation: operation
            )
        }
    }

    @MainActor
    private func performAsyncGestureOnMainActor<T: Sendable>(
        expected: String?,
        hierarchy: ViewHierarchy?,
        operation: @MainActor () async throws -> T
    )
        async throws -> T
    {
        if let expected {
            guard let hierarchy, frameContext.context(for: hierarchy) == expected else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }
        }
        return try await operation()
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

    func handleTapCoordinates(
        _ request: RequestTapCoordinates,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        try requireFinite(request.x, field: "x")
        try requireFinite(request.y, field: "y")
        let duration = request.duration ?? 0
        let diagnostics: TapDiagnostics? = try await performContextCheckedGesture(expected: request.frameContext) {
            if request.doubleTap == true {
                try self.gesturePerformer.doubleTap(x: request.x, y: request.y)
                return nil
            }
            if request.diagnostics == true {
                return try self.gesturePerformer.tapWithDiagnostics(
                    x: request.x, y: request.y, durationMs: duration, strategy: request.tapStrategy
                )
            }
            try self.gesturePerformer.tap(
                x: request.x, y: request.y, duration: TimeInterval(duration) / 1000.0, strategy: request.tapStrategy
            )
            return nil
        }
        if let locator = elementLocator as? ElementLocator {
            await locator.clearAppSwitcherHint()
        }

        return WebSocketResponse.success(
            type: ResponseType.tapCoordinatesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            tapDiagnostics: diagnostics
        )
    }

    func handleSwipe(
        _ request: RequestSwipe, startTime: Date, deadlineMs: Int64?,
        monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async throws -> WebSocketResponse
    {
        let checkDeadline: @Sendable () throws -> Void = {
            if let deadlineMs, monotonicNowMs() >= deadlineMs {
                throw CommandError.deadlineExceeded(
                    command: "request_swipe", deadlineMs: deadlineMs, gestureCompleted: false
                )
            }
        }
        try checkDeadline()
        try requireFinite(request.x1, field: "x1")
        try requireFinite(request.y1, field: "y1")
        try requireFinite(request.x2, field: "x2")
        try requireFinite(request.y2, field: "y2")
        let duration = request.duration ?? 300
        let dispatch = swipeDispatchMode(lockScreen: request.lockScreen)
        try await performContextCheckedGesture(expected: request.frameContext, beforeOperation: checkDeadline) {
            GesturePhaseDiagnostics.current?.annotateSwipe(
                dispatch: dispatch, trackedApp: self.elementLocator.foregroundBundleId
            )
            try checkDeadline()
            switch dispatch {
            case .xcuitest:
                try self.gesturePerformer.swipe(
                    startX: request.x1, startY: request.y1,
                    endX: request.x2, endY: request.y2,
                    duration: TimeInterval(duration) / 1000.0
                )
            case .synthesizedLockScreen:
                try self.gesturePerformer.lockScreenSwipe(
                    startX: request.x1, startY: request.y1,
                    endX: request.x2, endY: request.y2,
                    duration: TimeInterval(duration) / 1000.0
                )
            }
            if let deadlineMs, monotonicNowMs() >= deadlineMs {
                throw CommandError.deadlineExceeded(
                    command: "request_swipe", deadlineMs: deadlineMs, gestureCompleted: true
                )
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.swipeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleMultiFingerSwipe(
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

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.multiFingerSwipe(
                startX: request.x1,
                startY: request.y1,
                endX: request.x2,
                endY: request.y2,
                fingerCount: fingerCount,
                fingerSpacing: fingerSpacing,
                duration: TimeInterval(duration) / 1000.0
            )
        }

        return WebSocketResponse.success(
            type: ResponseType.multiFingerSwipeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleDrag(_ request: RequestDrag, startTime: Date) async throws -> WebSocketResponse {
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

    func handlePathGesture(_ request: RequestPathGesture, startTime: Date) async throws -> WebSocketResponse {
        let points = try PathGesturePlan.validate(request.points)
        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.path(points: points)
        }

        return WebSocketResponse.success(
            type: ResponseType.pathGestureResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handlePinch(_ request: RequestPinch, startTime: Date) async throws -> WebSocketResponse {
        try requireFinite(request.centerX, field: "centerX")
        try requireFinite(request.centerY, field: "centerY")
        try requireFinite(request.distanceStart, field: "distanceStart")
        try requireFinite(request.distanceEnd, field: "distanceEnd")
        try requireFinite(Double(request.rotationDegrees ?? 0), field: "rotationDegrees")
        let path = try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.pinch(
                centerX: request.centerX,
                centerY: request.centerY,
                distanceStart: request.distanceStart,
                distanceEnd: request.distanceEnd,
                rotationDegrees: Double(request.rotationDegrees ?? 0),
                duration: TimeInterval(request.duration ?? 300) / 1000.0
            )
        }

        return WebSocketResponse.success(
            type: ResponseType.pinchResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            pinchPath: path.rawValue
        )
    }
}
