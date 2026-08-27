import CtrlProxy
import Foundation

/// Drives the REFERENCE `CtrlProxy.HierarchyDebouncer` through a scripted
/// `DebouncerScenario` (see `RewriteHierarchyDebouncer`), returning a module-agnostic
/// `DebouncerRun`. Imports only `CtrlProxy`; the debouncer, `FakeElementLocator`,
/// `FakeTimer`, `StructuralHasher`, and `HierarchyResult` are all public there.
///
/// The reference module also exports `public class CtrlProxy`, which shadows the module
/// name — so `CtrlProxy.FakeTimer` parses as member access on that type and fails. The
/// test target's own timer fake is therefore named `FakeProxyTimer`, leaving unqualified
/// `FakeTimer` here to resolve to the reference module's public one. Runs on the main
/// actor so the manual timer's callbacks fire on the main thread, exactly as the rewrite
/// driver does.
enum ReferenceHierarchyDebouncer {
    @MainActor
    static func run(_ scenario: DebouncerScenario) throws -> DebouncerRun {
        let recorder = DebouncerRecorder()
        let timer = FakeTimer(mode: .manual, initialTime: 0)
        let locator = FakeElementLocator()
        let debouncer = HierarchyDebouncer(
            elementLocator: locator,
            timer: timer,
            pollIntervalMs: scenario.pollIntervalMs
        )

        locator.onHierarchyRead = { recorder.readTimes.append(timer.now()) }
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
                locator.setHierarchy(try decoder.decode(ViewHierarchy.self, from: data))
            case let .setThrow(shouldThrow):
                locator.setShouldThrow(shouldThrow ? DebouncerFakeError() : nil)
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
            extractionCount: locator.hierarchyRequestCount
        )
    }
}
