import Foundation
import ScreenCaptureCore

/// Reads newline-delimited JSON control commands from the helper's STDIN and
/// dispatches them (issue #4788). Today the only verb is `{"cmd":"forceKeyFrame"}`,
/// the hook that replaces the old encoder-restart keyframe hack. Parsing is
/// permissive — malformed / partial / unknown lines are ignored — matching the
/// repo's minimal-control-surface precedent.
///
/// Only started in `--encode h264` mode, so the default raw path never touches
/// STDIN and its output stays byte-for-byte unchanged.
///
/// `@unchecked Sendable`: `buffer` is mutated only on the serial `queue` (via
/// `ingest`); `handle` and `onCommand` are `let`. This lets the `@Sendable`
/// readability handler capture `self`.
final class ControlChannel: @unchecked Sendable {
    private let handle: FileHandle
    private let onCommand: (EncoderControlCommand) -> Void
    private let queue = DispatchQueue(label: "automobile.screen-capture.control")
    private var buffer = Data()

    init(
        handle: FileHandle = .standardInput,
        onCommand: @escaping (EncoderControlCommand) -> Void
    ) {
        self.handle = handle
        self.onCommand = onCommand
    }

    func start() {
        handle.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                // EOF: the parent closed our stdin. Stop reading; the process
                // stays alive on the capture path until SIGTERM.
                handle.readabilityHandler = nil
                return
            }
            // Bind `self` strongly once so the serial-queue hop captures a value,
            // not the weak optional `var self` (a data race under Swift-6 strict
            // concurrency).
            guard let self else { return }
            self.queue.async { self.ingest(chunk) }
        }
    }

    func stop() {
        handle.readabilityHandler = nil
    }

    /// Split the rolling buffer on newlines and dispatch each complete line.
    /// Exposed (not private) so tests can drive parsing without a real pipe.
    func ingest(_ chunk: Data) {
        buffer.append(chunk)
        let newline = UInt8(ascii: "\n")
        while let index = buffer.firstIndex(of: newline) {
            let lineData = buffer[buffer.startIndex..<index]
            buffer.removeSubrange(buffer.startIndex...index)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            if let command = EncoderControlCommand.parse(line: line) {
                onCommand(command)
            }
        }
    }
}
