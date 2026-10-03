import Foundation

extension CommandHandler {
    // MARK: - Device Control

    private func readAppAxis() async -> AppAxis? {
        // Hierarchy errors are safe: app axis is optional and XCUIDevice is the fallback.
        guard let hierarchy = try? await elementLocator.getViewHierarchy(disableAllFiltering: false) else {
            return nil
        }
        if let width = hierarchy.screenWidth, let height = hierarchy.screenHeight {
            return AppAxis.from(width: width, height: height)
        }
        guard let bounds = hierarchy.hierarchy?.bounds else { return nil }
        return AppAxis.from(width: bounds.width, height: bounds.height)
    }

    private func performRotation(_ target: RotateTarget) async throws -> RotateResult {
        let appAxisBefore = await readAppAxis()
        let deviceBefore = await gesturePerformer.getOrientation()
        let decision = RotateDecision(target: target, appAxisBefore: appAxisBefore, deviceBefore: deviceBefore)
        if let result = decision.initial().result { return result }
        try await gesturePerformer.setOrientation(target.orientation)
        let deadline = rotationTimer.now() + RotateDecision.timeoutMs
        while true {
            let appAxis = await readAppAxis()
            let device = await gesturePerformer.getOrientation()
            let now = rotationTimer.now()
            let outcome = decision.poll(appAxis: appAxis, device: device, deadlineReached: now >= deadline)
            if let result = outcome.result { return result }
            await rotationTimer.wait(milliseconds: min(RotateDecision.pollIntervalMs, deadline - now))
        }
    }

    func handleRotate(_ request: RequestRotate, startTime: Date) async throws -> RotateResponse {
        guard let target = RotateTarget(request.orientation) else {
            throw CommandError.invalidParameter("orientation", request.orientation)
        }
        let result = try await performRotation(target)
        return RotateResponse(
            requestId: request.requestId,
            success: result.error == nil,
            totalTimeMs: totalTimeMs(from: startTime),
            previousOrientation: result.previousOrientation,
            currentOrientation: result.currentOrientation,
            value: result.value,
            rotationPerformed: result.rotationPerformed,
            error: result.error
        )
    }

    // MARK: - Clipboard

    func handleClipboard(_ request: RequestClipboard, startTime: Date) async throws -> WebSocketResponse {
        let resultText = try await gesturePerformer.clipboard(action: request.action, text: request.text)

        return WebSocketResponse.success(
            type: ResponseType.clipboardResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            text: resultText
        )
    }
}
