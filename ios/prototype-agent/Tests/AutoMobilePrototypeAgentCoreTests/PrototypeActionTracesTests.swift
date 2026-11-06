@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class TraceTimerHandle: PrototypeTimerHandle {
    func cancel() {}
}

/// Time moves only through `PrototypeTimers.advance`, so a trace never waits on the wall clock.
private final class TraceClock: PrototypeClock {
    let nowMilliseconds = 0
    func schedule(afterMilliseconds _: Int, _: @escaping () -> Void) -> PrototypeTimerHandle {
        TraceTimerHandle()
    }
}

/// The session plus its timers, wired as `PrototypeModel` wires them, without UIKit.
private final class TraceHarness {
    var session = PrototypeSession()
    lazy var timers = PrototypeTimers(clock: TraceClock()) { [weak self] in self?.run($0) }

    func run(_ actions: [PrototypeAction]) {
        _ = session.transition { $0.run(actions) }
        timers.perform(session.takeTimerCommands())
    }
}

private struct ActionTrace: Decodable {
    struct Step: Decodable {
        let actions: [JSONValue]?
        let advanceMs: Int?
        let expect: [String: JSONValue]
    }

    let name: String
    let spec: JSONValue
    let steps: [Step]
}

private struct ActionTraceSkip: Decodable {
    let trace: String
    let issue: Int
}

/// Runs the shared action traces (#16456) in `test/fixtures/prototype-spec/action-traces/` on the
/// iOS session: each step runs one tap's actions or advances the fake clock, then the state,
/// `/data`, stack paths, pager pages and shown flag it names are compared. A trace listed under
/// `swift` in `action-trace-skips.json` must still fail here, so a fixed gap shrinks the list.
final class PrototypeActionTracesTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func traces() throws -> [ActionTrace] {
        let directory = fixtureRoot.appendingPathComponent("action-traces")
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .flatMap { try JSONDecoder().decode([ActionTrace].self, from: Data(contentsOf: $0)) }
    }

    private func skipped() throws -> Set<String> {
        let data = try Data(contentsOf: fixtureRoot.appendingPathComponent("action-trace-skips.json"))
        let platforms = try JSONDecoder().decode([String: [ActionTraceSkip]].self, from: data)
        let swift = try XCTUnwrap(platforms["swift"])
        return Set(swift.map(\.trace))
    }

    private func decode<T: Decodable>(_: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }

    func testEveryTraceRunsOnTheSessionUnlessSkipped() throws {
        let skipped = try skipped()
        var failures: [String: String] = [:]
        for trace in try traces() {
            if let failure = try run(trace) { failures[trace.name] = failure }
        }
        let unexpected = failures.filter { !skipped.contains($0.key) }
        XCTAssertTrue(unexpected.isEmpty, "Traces failed on iOS: \(unexpected)")
        let stale = skipped.filter { failures[$0] == nil }.sorted()
        XCTAssertTrue(stale.isEmpty, "Skipped traces now pass; remove them from the skip list: \(stale)")
    }

    /// The first mismatch, or nil when every step matched.
    private func run(_ trace: ActionTrace) throws -> String? {
        let harness = TraceHarness()
        let spec = try decode(PrototypeSpec.self, trace.spec)
        harness.session.show(spec)
        _ = harness.session.transition { _ in [] }
        harness.timers.perform(harness.session.takeTimerCommands())
        for (index, step) in trace.steps.enumerated() {
            if let actions = step.actions {
                let decoded = try actions.map { try decode(PrototypeAction.self, $0) }
                harness.run(decoded)
            } else {
                _ = harness.timers.advance(step.advanceMs ?? 0)
            }
            if let mismatch = mismatch(harness.session, step.expect) { return "step \(index): \(mismatch)" }
        }
        return nil
    }

    private func mismatch(_ session: PrototypeSession, _ expected: [String: JSONValue]) -> String? {
        let actual: [String: JSONValue] = [
            "state": .object(session.state),
            "data": .object(session.data ?? [:]),
            "stacks": .object(session.stacks.mapValues { .array($0.path.map(JSONValue.string)) }),
            "pages": .object(session.pages.mapValues { .number(Double($0)) }),
            "shown": .bool(session.isShown),
        ]
        for key in expected.keys.sorted() where actual[key] != expected[key] {
            return "\(key) expected \(String(describing: expected[key])), got \(String(describing: actual[key]))"
        }
        return nil
    }
}
