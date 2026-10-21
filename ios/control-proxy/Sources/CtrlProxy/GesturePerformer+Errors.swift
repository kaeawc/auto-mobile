import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    public enum GestureError: LocalizedError {
        case noApplication
        case elementNotFound(String)
        case gestureFailed(String)
        case arrowNoEffect
        case arrowBudgetExhausted(step: String, elapsedMs: Int)
        /// XCUITest raised while resolving the focused input before an arrow key was sent
        /// (e.g. a stale element mid-scan). The key was not sent; the request fails cleanly.
        case focusQueryFailed(phase: String, detail: String)
        case notSupported(String)
        case missingParameter(String)
        case clipboardEmpty
        case clipboardReadUnavailable
        case unsupportedAction(String)

        /// Machine-readable code for the wire's additive `errorCode` field (see
        /// `CommandError.wireCode`); `nil` for errors the host tells apart by wording alone.
        /// Pinned against `src/features/observe/ios/runnerErrorCodes.ts` by
        /// `runnerErrorCodes.contract.test.ts`.
        public var wireCode: String? {
            switch self {
            case .focusQueryFailed:
                // The key was never sent: a definite non-delivery, safe to retry after re-observing.
                return "focus_query_failed"
            case .noApplication, .elementNotFound, .gestureFailed, .arrowNoEffect, .arrowBudgetExhausted,
                 .notSupported, .missingParameter, .clipboardEmpty, .clipboardReadUnavailable, .unsupportedAction:
                return nil
            }
        }

        public var errorDescription: String? {
            switch self {
            case .noApplication:
                return "No application available for gestures"
            case let .elementNotFound(id):
                return "Element not found: \(id)"
            case let .gestureFailed(reason):
                return "Gesture failed: \(reason)"
            case .arrowNoEffect:
                return "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead"
            case let .arrowBudgetExhausted(step, elapsedMs):
                return "arrow key was not sent: runner time budget exhausted at \(step) after \(elapsedMs)ms; retry"
            case let .focusQueryFailed(phase, detail):
                return "arrow key was not sent: XCUITest failed while finding the focused text input during \(phase) (\(detail)); the UI likely changed mid-query, so observe again and retry"
            case let .notSupported(feature):
                return "Feature not supported: \(feature)"
            case let .missingParameter(param):
                return "Missing parameter: \(param)"
            case .clipboardEmpty:
                return "Clipboard is empty"
            case .clipboardReadUnavailable:
                return "Clipboard read unavailable; live pasteboard access may be restricted, so shadow clipboard content was not returned"
            case let .unsupportedAction(action):
                return "Unsupported action: \(action)"
            }
        }
    }
}
