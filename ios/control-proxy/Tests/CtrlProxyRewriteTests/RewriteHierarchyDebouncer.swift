@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite.HierarchyDebouncer` (`@MainActor` port) through a
/// scripted `DebouncerScenario`, returning a module-agnostic `DebouncerRun`.
/// `@testable` reaches the internal `HierarchyDebouncer` / `HierarchyExtracting` /
/// `HierarchyResult` / `StructuralHasher`. Runs on the main actor so the manual
/// `FakeProxyTimer`'s callbacks fire on the main thread, satisfying the debouncer's
/// `MainActor.assumeIsolated` re-entry.
enum RewriteHierarchyDebouncer {
    @MainActor
    static func run(_ scenario: DebouncerScenario) throws -> DebouncerRun {
        let recorder = DebouncerRecorder()
        let timer = FakeProxyTimer(mode: .manual, initialTime: 0)
        let extractor = FakeHierarchyExtractor()
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: extractor,
            timer: timer,
            pollIntervalMs: scenario.pollIntervalMs
        )

        extractor.onRead = { recorder.readTimes.append(timer.now()) }
        debouncer.setOnResult { result in
            if case let .changed(_, hash, _) = result {
                recorder.events.append(.changed(hash: hash))
            }
        }
        debouncer.setOnTransition { hierarchy in
            recorder.events.append(.transition(hash: StructuralHasher.computeHash(hierarchy)))
        }

        let decoder = JSONDecoder()
        for step in scenario.steps {
            switch step {
            case let .setHierarchy(data):
                extractor.setHierarchy(try decoder.decode(ViewHierarchy.self, from: data))
            case let .setThrow(shouldThrow):
                extractor.setShouldThrow(shouldThrow)
            case .start:
                debouncer.start()
            case .stop:
                debouncer.stop()
            case let .advance(ms):
                timer.advance(by: ms)
            case let .updatePollInterval(ms):
                debouncer.updatePollIntervalMs(ms)
            }
        }

        return DebouncerRun(
            events: recorder.events,
            readTimes: recorder.readTimes,
            extractionCount: extractor.requestCount
        )
    }
}
