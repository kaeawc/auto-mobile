import Foundation

/// Screen navigation animation, shared by a stack and its push/replace overrides.
/// Omission means platform; motion none and system reduced motion disable animation.
enum PrototypeStackTransition: String, Codable, CaseIterable {
    case platform, slide, fade, none
}
