import Foundation

/// A display-frame callback source; the viewer supplies CADisplayLink, tests advance it explicitly.
@MainActor
protocol PrototypeRenderFrameSource: AnyObject {
    func start(_ frame: @escaping @MainActor () -> Void)
    func stop()
}

/// Standalone viewer handshake. A new show invalidates even a same-id render's marker.
@MainActor
final class PrototypeRenderCompleteSignal {
    let path: String
    private let files: any PrototypeEndpointFiles
    private let frames: any PrototypeRenderFrameSource
    private let clock: any PrototypeMonotonicClock
    private var specId: String?
    private var revision: Int?
    private var written = false
    private var polling = false
    private var generation = 0
    private var quietFrames = 0

    init(
        documents: URL, frames: any PrototypeRenderFrameSource,
        clock: any PrototypeMonotonicClock = SystemPrototypeClock(),
        files: any PrototypeEndpointFiles = FoundationPrototypeEndpointFiles()
    ) {
        path = documents.appendingPathComponent("prototype/render-complete").path
        self.frames = frames
        self.clock = clock
        self.files = files
    }

    func beginShow(specId: String, revision: Int) throws {
        cancelPolling()
        self.specId = nil
        self.revision = nil
        written = false
        try files.remove(path: path)
        self.specId = specId
        self.revision = revision
    }

    func cancelPolling() {
        generation += 1
        frames.stop()
        polling = false
        quietFrames = 0
    }

    /// Called after appearance and layout commit. A nil sample withdraws readiness (hidden/stale host).
    func rendered(
        specId: String, revision: Int,
        hasAnimations: @escaping @MainActor () -> Bool?,
        onError: @escaping @MainActor (Error) -> Void
    ) {
        guard self.specId == specId, self.revision == revision, !written, !polling else { return }
        polling = true
        let pollingGeneration = generation
        let started = clock.monotonicMilliseconds
        frames.start { [weak self] in
            guard let self, generation == pollingGeneration, !written else { return }
            guard let animated = hasAnimations() else {
                cancelPolling()
                return
            }
            quietFrames = animated ? 0 : quietFrames + 1
            guard quietFrames >= 10 || clock.monotonicMilliseconds - started >= 5000 else { return }
            do {
                try files.writeAtomically(Data("\(specId)\n".utf8), to: path, mode: 0o600)
                written = true
                cancelPolling()
            } catch {
                onError(error)
            }
        }
    }
}
