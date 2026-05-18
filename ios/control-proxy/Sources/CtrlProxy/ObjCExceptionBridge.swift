import Foundation
import ObjCExceptionCatcher

/// Error type representing a caught Objective-C NSException.
/// Bridges ObjC exceptions into Swift's error handling so they propagate
/// as WebSocket error responses instead of killing the process.
public struct ObjCExceptionError: LocalizedError {
    public let name: String
    public let reason: String?

    public var errorDescription: String? {
        "NSException(\(name)): \(reason ?? "no reason")"
    }

    public init(name: String, reason: String?) {
        self.name = name
        self.reason = reason
    }

    init(exception: NSException) {
        self.name = exception.name.rawValue
        self.reason = exception.reason
    }
}

/// Executes a throwing closure, catching both Swift errors and ObjC NSExceptions.
/// NSExceptions are converted to `ObjCExceptionError`.
public func catchingObjCException<T>(_ block: () throws -> T) throws -> T {
    var result: T?
    var swiftError: Error?

    let exception = ObjCExceptionCatcher_tryBlock {
        do {
            result = try block()
        } catch {
            swiftError = error
        }
    }

    if let exception = exception {
        throw ObjCExceptionError(exception: exception)
    }
    if let swiftError = swiftError {
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

/// Executes a non-throwing closure, catching ObjC NSExceptions.
/// NSExceptions are converted to `ObjCExceptionError`.
public func catchingObjCException<T>(_ block: () -> T) throws -> T {
    var result: T?

    let exception = ObjCExceptionCatcher_tryBlock {
        result = block()
    }

    if let exception = exception {
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
