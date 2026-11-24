import Foundation

/// Sends one HID step to the simulator; the helper's SimulatorKit backend in production.
/// Any error it throws counts as "the message may have reached the simulator", except
/// `SimHidNotSent`, which a sender throws only when nothing was handed to SimulatorKit.
public protocol SimHidSender {
    func send(_ step: SimHidStep) throws
    func sleep(milliseconds: Double)
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
        for step in steps {
            if case let .wait(ms) = step {
                sender.sleep(milliseconds: ms)
                continue
            }
            do {
                try sender.send(step)
            } catch let notSent as SimHidNotSent {
                return SimHidAck(id: request.id, ok: false, sent: sent, error: notSent.error)
            } catch {
                // A failure after hand-off (completion error, timeout) may still have delivered
                // the message, so the caller must not replay it on another input path.
                return SimHidAck(id: request.id, ok: false, sent: true, error: simHidError(error))
            }
            sent = true
        }
        return SimHidAck(id: request.id, ok: true, sent: sent, elapsedMs: rounded(sender.nowMs() - start))
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
