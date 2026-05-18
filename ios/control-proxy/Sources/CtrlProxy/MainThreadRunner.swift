import Foundation
import ObjCExceptionCatcher

/// Executes a throwing closure on the main thread, catching both Swift errors and ObjC NSExceptions.
/// XCUITest APIs must be called on the main thread and can throw NSExceptions
/// (e.g. stale element references) that Swift try/catch cannot catch natively.
func runOnMainThread<T>(_ block: @escaping () throws -> T) throws -> T {
    if Thread.isMainThread {
        return try catchingObjCException { try block() }
    }

    var result: Result<T, Error>?
    DispatchQueue.main.sync {
        let exception = ObjCExceptionCatcher_tryBlock {
            do {
                result = try .success(block())
            } catch {
                result = .failure(error)
            }
        }
        if result == nil, let exception = exception {
            result = .failure(ObjCExceptionError(exception: exception))
        }
    }
    guard let unwrapped = result else {
        throw ObjCExceptionError(
            name: NSExceptionName.internalInconsistencyException.rawValue,
            reason: "runOnMainThread: block produced neither result nor error"
        )
    }
    return try unwrapped.get()
}

/// Non-throwing variant for protocol methods that cannot propagate errors.
/// ObjC exceptions are caught and logged; the fallback value is returned.
func runOnMainThreadNonThrowing<T>(_ block: @escaping () -> T, fallback: T) -> T {
    if Thread.isMainThread {
        var result: T?
        let exception = ObjCExceptionCatcher_tryBlock {
            result = block()
        }
        if let exception = exception {
            print("[MainThread] ObjC exception in non-throwing context: \(exception.name) - \(exception.reason ?? "nil")")
            return fallback
        }
        return result ?? fallback
    }

    var result: T?
    DispatchQueue.main.sync {
        let exception = ObjCExceptionCatcher_tryBlock {
            result = block()
        }
        if let exception = exception {
            print("[MainThread] ObjC exception in non-throwing context: \(exception.name) - \(exception.reason ?? "nil")")
        }
    }
    return result ?? fallback
}
