import Observation

/// Local loop activity; capture holds are driven by the agent's token-counted capture seam.
/// Native symbol effects provide no completion callback, so finite activity is conservative.
@MainActor
@Observable
final class PrototypeIconMotionActivity {
    var capturing = false
    private(set) var loops = 0
    var motionActive: Bool { loops > 0 && !capturing }

    func begin() { loops += 1 }
    func end() { loops = max(0, loops - 1) }
}
