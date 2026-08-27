import Foundation
import ObjCExceptionCatcher

/// Executes a throwing closure on the main thread, catching both Swift errors and ObjC
/// NSExceptions. XCUITest APIs must be called on the main thread and can throw
/// NSExceptions (e.g. stale element references) that Swift `try`/`catch` cannot catch
/// natively.
///
/// `DispatchQueue.main.sync` is a synchronous barrier — the calling thread blocks until
/// the main-thread closure returns — so `block` and `result` cross threads but never
/// actually race. Region isolation cannot prove that for a non-`Sendable` closure and
/// return type (and we can't constrain `T`/`block` to `Sendable`: the point is to bridge
/// non-`Sendable` XCUITest values on/off main), so the crossing bindings are marked
/// `nonisolated(unsafe)` — the narrowest honest opt-out for this legacy sync bridge.
func runOnMainThread<T>(_ block: @escaping () throws -> T) throws -> T {
    nonisolated(unsafe) let block = block
    if Thread.isMainThread {
        return try catchingObjCException { try block() }
    }

    nonisolated(unsafe) var result: Result<T, Error>?
    DispatchQueue.main.sync {
        let exception = ObjCExceptionCatcher_tryBlock {
            do {
                result = try .success(block())
            } catch {
                result = .failure(error)
            }
        }
        if result == nil, let exception {
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

/// Non-throwing variant for protocol methods that cannot propagate errors. ObjC
/// exceptions are caught and logged; the fallback value is returned. See
/// `runOnMainThread` for why the off-main crossing is `nonisolated(unsafe)`.
func runOnMainThreadNonThrowing<T>(_ block: @escaping () -> T, fallback: T) -> T {
    nonisolated(unsafe) let block = block
    if Thread.isMainThread {
        var result: T?
        let exception = ObjCExceptionCatcher_tryBlock {
            result = block()
        }
        if let exception {
            print("[MainThread] ObjC exception in non-throwing context: \(exception.name) - \(exception.reason ?? "nil")")
            return fallback
        }
        return result ?? fallback
    }

    nonisolated(unsafe) var result: T?
    DispatchQueue.main.sync {
        let exception = ObjCExceptionCatcher_tryBlock {
            result = block()
        }
        if let exception {
            print("[MainThread] ObjC exception in non-throwing context: \(exception.name) - \(exception.reason ?? "nil")")
        }
    }
    return result ?? fallback
}
