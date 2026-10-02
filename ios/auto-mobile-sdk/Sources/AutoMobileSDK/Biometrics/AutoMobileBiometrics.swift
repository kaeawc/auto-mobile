import Foundation
import os

/// Biometric authentication result for test injection.
public enum BiometricResult: Sendable, Equatable {
    case success
    case failure
    case cancel
    case error(code: Int, message: String)
}

/// Test hook for deterministic biometric testing.
/// Allows tests to inject biometric authentication results.
public final class AutoMobileBiometrics: Sendable {
    public static let shared = AutoMobileBiometrics()

    /// Notification posted when a biometric override is set.
    public static let overrideNotification = Notification.Name(
        "dev.jasonpearson.automobile.sdk.BIOMETRIC_OVERRIDE"
    )

    private struct State: Sendable {
        var result: BiometricResult?
        var overrideExpiry: Date?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    private init() {}

    /// Override the next biometric authentication result.
    ///
    /// The override expires after `ttlMs` milliseconds. Any previously stored
    /// override is replaced.
    ///
    /// - Parameters:
    ///   - result: The result to inject into the next authentication attempt.
    ///   - ttlMs: Override lifetime in milliseconds (default: 5000).
    public func overrideResult(_ result: BiometricResult, ttlMs: Int64 = 5000) {
        state.withLock { state in
            state.result = result
            state.overrideExpiry = Date().addingTimeInterval(Double(ttlMs) / 1000.0)
        }

        NotificationCenter.default.post(
            name: Self.overrideNotification,
            object: nil,
            userInfo: ["result": result]
        )
    }

    /// Consume the current override. Returns nil if no override is set or it has expired.
    /// This is a one-shot operation — the override is cleared after consumption.
    public func consumeOverride() -> BiometricResult? {
        state.withLock { state in
            guard let result = state.result, let expiry = state.overrideExpiry else {
                return nil
            }

            // Check if expired
            guard Date() < expiry else {
                state.result = nil
                state.overrideExpiry = nil
                return nil
            }

            state.result = nil
            state.overrideExpiry = nil
            return result
        }
    }

    /// Clear any pending override.
    public func clearOverride() {
        state.withLock { state in
            state.result = nil
            state.overrideExpiry = nil
        }
    }

    /// Whether an override is currently set and not expired.
    public var hasOverride: Bool {
        state.withLock { state in
            guard let expiry = state.overrideExpiry else { return false }
            return Date() < expiry
        }
    }

    // MARK: - Testing Support

    func reset() {
        state.withLock { state in
            state.result = nil
            state.overrideExpiry = nil
        }
    }
}
