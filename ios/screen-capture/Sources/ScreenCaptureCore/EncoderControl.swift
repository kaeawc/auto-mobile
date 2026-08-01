import Foundation

/// The helper's minimal STDIN control surface (issue #4788). Commands arrive as
/// newline-delimited JSON; today the only verb is `forceKeyFrame`, the hook that
/// replaces the old encoder-restart keyframe hack. Parsing is deliberately
/// permissive — malformed or unknown lines are ignored — matching the repo's
/// minimal-control-surface precedent so a future TS writer can add verbs without
/// a version handshake.
public enum EncoderControlCommand: Equatable {
    case forceKeyFrame

    /// Parse a single control line. Returns `nil` for blank, malformed, or
    /// unknown commands (the caller ignores those rather than failing).
    public static func parse(line: String) -> EncoderControlCommand? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            let cmd = dictionary["cmd"] as? String
        else {
            return nil
        }
        switch cmd {
        case "forceKeyFrame":
            return .forceKeyFrame
        default:
            return nil
        }
    }
}

/// Thread-safe one-shot latch coupling `{"cmd":"forceKeyFrame"}` on STDIN (any
/// thread) to the next `encodeFrame` (capture queue). `request()` arms it;
/// `consume()` returns `true` exactly once per arm, so the very next encoded
/// frame is forced to an IDR and subsequent frames are not.
public final class ForceKeyFrameLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = false

    public init() {}

    public func request() {
        lock.lock()
        pending = true
        lock.unlock()
    }

    /// Returns `true` iff a force was pending, clearing it.
    public func consume() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard pending else { return false }
        pending = false
        return true
    }

    public var isPending: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending
    }
}

/// Pure drop-policy decisions for the encoded path (issue #4788). Unlike the raw
/// path's newest-wins replacement — which would corrupt the encoder's reference
/// chain — encoded output drops late frames at the ENCODER INPUT when the
/// encoder is behind, and NEVER drops an emitted encoded record. An overflowing
/// output queue is fatal (the supervisor relaunches) rather than silently
/// corrupting the stream.
public enum EncoderDropPolicy {
    /// Drop this capture frame before `encodeFrame` when the encoder already has
    /// `maxInFlightFrames` (or more) frames submitted but not yet emitted.
    /// Dropping the *input* leaves the already-committed reference chain intact.
    public static func shouldDropBeforeEncode(inFlightFrames: Int, maxInFlightFrames: Int) -> Bool {
        inFlightFrames >= maxInFlightFrames
    }

    /// Whether enqueuing `recordBytes` would overflow the bounded output queue.
    /// Overflow is fatal for encoded output (the caller exits so the supervisor
    /// relaunches with a fresh IDR) — the alternative, dropping an emitted
    /// record, breaks decodability downstream.
    public static func wouldOverflowOutputQueue(
        queuedBytes: Int,
        recordBytes: Int,
        maxQueuedBytes: Int
    ) -> Bool {
        queuedBytes + recordBytes > maxQueuedBytes
    }
}
