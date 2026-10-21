import Foundation
#if canImport(XCTest) && os(iOS)
    import CoreLocation
    import XCTest
#endif

/// Reads and sets the system light/dark appearance (#14092). `@MainActor`: the default
/// impl drives `XCUIDevice.shared.appearance`; the async `CommandHandler` `await`s it.
protocol AppearanceControlling: Sendable {
    /// "light", "dark", or "unspecified".
    @MainActor
    func appearance() throws -> String

    @MainActor
    func setAppearance(dark: Bool) throws
}

/// `XCUIDevice.appearance` (iOS 15+) works on simulators and physical devices. Stateless → `Sendable`.
struct DefaultAppearanceControl: AppearanceControlling {
    @MainActor
    func appearance() throws -> String {
        #if canImport(XCTest) && os(iOS)
            switch XCUIDevice.shared.appearance {
            case .light: return "light"
            case .dark: return "dark"
            default: return "unspecified"
            }
        #else
            throw VerbatimLocalizedError(message: "Reading the system appearance requires an iOS runner.")
        #endif
    }

    @MainActor
    func setAppearance(dark: Bool) throws {
        #if canImport(XCTest) && os(iOS)
            XCUIDevice.shared.appearance = dark ? .dark : .light
        #else
            throw VerbatimLocalizedError(message: "Setting the system appearance requires an iOS runner.")
        #endif
    }
}

extension CommandHandler {
    // MARK: - Device Control

    private func readAppAxis() async -> AppAxis? {
        // Hierarchy errors are safe: app axis is optional and XCUIDevice is the fallback.
        guard let hierarchy = try? await captureHierarchy() else {
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

    // MARK: - Appearance

    func handleAppearance(_ request: RequestAppearance, startTime: Date) async throws -> WebSocketResponse {
        if let requested = request.appearance {
            guard requested == "light" || requested == "dark" else {
                throw CommandError.invalidParameter("appearance", requested)
            }
            try await appearanceControl.setAppearance(dark: requested == "dark")
        }
        let current = try await appearanceControl.appearance()
        return WebSocketResponse.success(
            type: ResponseType.appearanceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            text: current
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

// MARK: - Location

/// Sets or clears XCUITest's simulated device location (#14091). `@MainActor`: the default
/// impl drives `XCUIDevice.shared.location` (iOS 16.4+); the async `CommandHandler` `await`s it.
protocol LocationSimulating: Sendable {
    @MainActor
    func setLocation(latitude: Double, longitude: Double, altitude: Double?, horizontalAccuracy: Double?) throws

    @MainActor
    func clearLocation() throws
}

/// Works on physical devices, where simctl has no location verb. Stateless → `Sendable`.
struct DefaultLocationSimulator: LocationSimulating {
    @MainActor
    func setLocation(latitude: Double, longitude: Double, altitude: Double?, horizontalAccuracy: Double?) throws {
        #if canImport(XCTest) && os(iOS)
            let location = CLLocation(
                coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
                altitude: altitude ?? 0,
                horizontalAccuracy: horizontalAccuracy ?? 5,
                verticalAccuracy: altitude == nil ? -1 : 5,
                timestamp: Date()
            )
            XCUIDevice.shared.location = XCUILocation(location: location)
        #else
            throw VerbatimLocalizedError(message: "Simulating location requires an iOS runner.")
        #endif
    }

    @MainActor
    func clearLocation() throws {
        #if canImport(XCTest) && os(iOS)
            XCUIDevice.shared.location = nil
        #else
            throw VerbatimLocalizedError(message: "Clearing a simulated location requires an iOS runner.")
        #endif
    }
}

extension CommandHandler {
    func handleLocation(_ request: RequestLocation, startTime: Date) async throws -> WebSocketResponse {
        if request.clear == true {
            try await locationSimulator.clearLocation()
        } else {
            guard let latitude = request.latitude, latitude.isFinite, (-90 ... 90).contains(latitude) else {
                throw CommandError.invalidParameter("latitude", request.latitude.map { String($0) } ?? "missing")
            }
            guard let longitude = request.longitude, longitude.isFinite, (-180 ... 180).contains(longitude) else {
                throw CommandError.invalidParameter("longitude", request.longitude.map { String($0) } ?? "missing")
            }
            try await locationSimulator.setLocation(
                latitude: latitude,
                longitude: longitude,
                altitude: request.altitude,
                horizontalAccuracy: request.horizontalAccuracy
            )
        }
        return WebSocketResponse.success(
            type: ResponseType.locationResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}
