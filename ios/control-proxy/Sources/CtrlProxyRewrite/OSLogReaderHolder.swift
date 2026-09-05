import Foundation

/// Process-wide holder for the single `OSLogReader`, used to wire the
/// connection's `drainLogEvents` seam to `GET /sdk-events`. Ported from the reference
/// `OSLogReader.swift`.
///
/// `Sendable` with no `@unchecked`: it holds only an immutable `let reader`, and
/// `OSLogReader` is itself a queue-confined `Sendable`.
public final class OSLogReaderHolder: Sendable {
    public static let shared = OSLogReaderHolder()
    private let reader = OSLogReader()

    private init() {}

    public func start() { reader.start() }
    public func stop() { reader.stop() }
    public func drain() -> [Data] { reader.drain() }
}
