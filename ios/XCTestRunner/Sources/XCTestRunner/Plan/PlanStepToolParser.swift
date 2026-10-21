import Yams

/// Best-effort recovery labels, taken only from entries of the top-level steps sequence.
public enum PlanStepToolParser {
    public static func toolNames(from yaml: String) -> [String] {
        let placeholders = PlanYamlPlaceholders(yaml)
        do {
            guard let steps = try Yams.compose(yaml: placeholders.yaml)?["steps"]?.sequence else {
                return []
            }
            return steps.map { step in
                guard let tool = step["tool"]?.scalar?.string, !tool.isEmpty else { return "step" }
                return placeholders.restore(tool)
            }
        } catch {
            // Safe to swallow: the recovery agent also receives the full plan.
            print("[AutoMobile][DEBUG] Cannot parse plan step tool names: \(error)")
            return []
        }
    }
}
