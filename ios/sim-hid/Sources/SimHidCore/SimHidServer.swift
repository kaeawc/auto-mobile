import Foundation

/// Sends one HID step to the simulator; the helper's SimulatorKit backend in production.
/// Any error it throws counts as "the message may have reached the simulator", except
/// `SimHidNotSent`, which a sender throws only when nothing was handed to SimulatorKit.
public protocol SimHidSender {
    func send(_ step: SimHidStep) throws
    /// Waits between steps. Returns false when the wait was interrupted (the helper is stopping,
    /// #19163), so the command stops and releases what it holds instead of finishing.
    func sleep(milliseconds: Double) -> Bool
    func nowMs() -> Double
}

/// Thrown by a sender before it hands a message to SimulatorKit (no message was built), so the
/// step certainly did not reach the simulator.
public struct SimHidNotSent: Error, Sendable, Equatable {
    public let error: SimHidError

    public init(_ error: SimHidError) {
        self.error = error
    }
}

/// The reply to one command. `sent` says whether any message reached the simulator, so a
/// failure with `sent: false` is safe to retry on another input path.
public struct SimHidAck: Sendable, Equatable, Encodable {
    public let id: String?
    public let ok: Bool
    public let sent: Bool
    public let elapsedMs: Double?
    public let error: SimHidError?

    public init(id: String?, ok: Bool, sent: Bool, elapsedMs: Double? = nil, error: SimHidError? = nil) {
        self.id = id
        self.ok = ok
        self.sent = sent
        self.elapsedMs = elapsedMs
        self.error = error
    }
}

public struct SimHidServer {
    private let sender: SimHidSender

    public init(sender: SimHidSender) {
        self.sender = sender
    }

    public func handle(line: String) -> SimHidAck {
        let request: SimHidRequest
        let steps: [SimHidStep]
        do {
            request = try SimHidRequestParser.parse(line)
            steps = try SimHidPlanner.steps(for: request.command)
        } catch {
            return SimHidAck(id: SimHidRequestParser.requestID(line), ok: false, sent: false, error: simHidError(error))
        }
        let start = sender.nowMs()
        var sent = false
        var held = SimHidHeldInput()
        for step in steps {
            if case let .wait(ms) = step {
                if sender.sleep(milliseconds: ms) { continue }
                // Stopped mid-hold (a released session's long press, #19163): lift the finger now,
                // or the next helper's first touch-down lands on a touch that is still down.
                release(held)
                return SimHidAck(id: request.id, ok: false, sent: sent, error: SimHidError.interrupted)
            }
            do {
                try sender.send(step)
            } catch let notSent as SimHidNotSent {
                release(held)
                return SimHidAck(id: request.id, ok: false, sent: sent, error: notSent.error)
            } catch {
                // A failure after hand-off (completion error, timeout) may still have delivered
                // the message, so the caller must not replay it on another input path.
                held.record(step)
                release(held)
                return SimHidAck(id: request.id, ok: false, sent: true, error: simHidError(error))
            }
            held.record(step)
            sent = true
        }
        return SimHidAck(id: request.id, ok: true, sent: sent, elapsedMs: rounded(sender.nowMs() - start))
    }

    /// Best-effort release of whatever a failed command may have left down (keys, buttons, a
    /// touch), so the persistent helper never starts the next command with shift or a finger held.
    /// Each release is attempted even when an earlier one fails; release errors are not reported
    /// because the ack already carries the command's own failure.
    private func release(_ held: SimHidHeldInput) {
        for step in held.releaseSteps() {
            try? sender.send(step)
        }
    }

    public static func encode(_ value: some Encodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else {
            return #"{"ok":false,"sent":false,"error":{"code":"encode-failed","message":"Cannot encode reply"}}"#
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func rounded(_ ms: Double) -> Double {
        (ms * 100).rounded() / 100
    }
}

/// Input a command has pressed and not yet released, in press order.
struct SimHidHeldInput {
    private(set) var keys: [UInt32] = []
    private(set) var buttons: [UInt32] = []
    private(set) var touch: (first: SimHidPoint, second: SimHidPoint?)?

    mutating func record(_ step: SimHidStep) {
        switch step {
        case let .key(usage, down):
            keys.removeAll { $0 == usage }
            if down { keys.append(usage) }
        case let .button(source, down):
            buttons.removeAll { $0 == source }
            if down { buttons.append(source) }
        case let .touch(point, second, phase):
            touch = phase == .up ? nil : (point, second)
        case .wait:
            break
        }
    }

    /// Key-ups and button-ups in reverse press order, then a touch-up at the last touch point.
    func releaseSteps() -> [SimHidStep] {
        var steps: [SimHidStep] = keys.reversed().map { .key(usage: $0, down: false) }
        steps += buttons.reversed().map { .button(source: $0, down: false) }
        if let touch {
            steps.append(.touch(touch.first, second: touch.second, phase: .up))
        }
        return steps
    }
}

extension SimHidError {
    static let interrupted = SimHidError("interrupted", "sim-hid-helper stopped before the command finished")
}

public func simHidError(_ error: Error) -> SimHidError {
    (error as? SimHidError) ?? SimHidError("send-failed", error.localizedDescription)
}

/// The first stdout line: the helper opened the device's HID client and accepts commands.
public struct SimHidReady: Sendable, Equatable, Encodable {
    public let event = "ready"
    public let initMs: Double

    public init(initMs: Double) {
        self.initMs = (initMs * 10).rounded() / 10
    }
}

/// Printed instead of `ready` when startup fails; the helper then exits 1.
public struct SimHidStartupFailure: Sendable, Equatable, Encodable {
    public let event = "error"
    public let error: SimHidError

    public init(error: SimHidError) {
        self.error = error
    }
}
