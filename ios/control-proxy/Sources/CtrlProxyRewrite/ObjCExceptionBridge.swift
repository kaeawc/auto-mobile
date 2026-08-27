import Foundation
import ObjCExceptionCatcher

/// Error bridging a caught Objective-C `NSException` into Swift error handling, so
/// XCUITest exceptions (e.g. stale element references) propagate as WebSocket error
/// responses instead of crashing the process. `Sendable` for propagation across
/// isolation domains.
struct ObjCExceptionError: LocalizedError, Sendable {
    let name: String
    let reason: String?

    var errorDescription: String? {
        "NSException(\(name)): \(reason ?? "no reason")"
    }

    init(name: String, reason: String?) {
        self.name = name
        self.reason = reason
    }

    init(exception: NSException) {
        name = exception.name.rawValue
        reason = exception.reason
    }
}

/// Executes a throwing closure, converting a caught ObjC `NSException` into `ObjCExceptionError`.
func catchingObjCException<T>(_ block: () throws -> T) throws -> T {
    var result: T?
    var swiftError: Error?

    let exception = ObjCExceptionCatcher_tryBlock {
        do {
            result = try block()
        } catch {
            swiftError = error
        }
    }

    if let exception {
        throw ObjCExceptionError(exception: exception)
    }
    if let swiftError {
        throw swiftError
    }
    guard let value = result else {
        throw ObjCExceptionError(
            name: NSExceptionName.internalInconsistencyException.rawValue,
            reason: "Block completed without producing a result or error"
        )
    }
    return value
}

/// Executes a non-throwing closure, converting a caught ObjC `NSException` into `ObjCExceptionError`.
func catchingObjCException<T>(_ block: () -> T) throws -> T {
    var result: T?

    let exception = ObjCExceptionCatcher_tryBlock {
        result = block()
    }

    if let exception {
        throw ObjCExceptionError(exception: exception)
    }
    guard let value = result else {
        throw ObjCExceptionError(
            name: NSExceptionName.internalInconsistencyException.rawValue,
            reason: "Block completed without producing a result"
        )
    }
    return value
}
