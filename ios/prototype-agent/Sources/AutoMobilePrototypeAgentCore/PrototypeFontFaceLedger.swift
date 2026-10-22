import Foundation

/// What registering one font with the platform font manager did.
enum PrototypeFontRegistrationResult: Equatable {
    case registered
    /// The manager already holds a face with this font's name.
    case alreadyRegistered
    case failed
}

/// Which bytes back each registered font face. The platform registers a face by its PostScript
/// name, so the UIKit registrar keeps this ledger and supplies the CoreText calls; unit tests
/// supply fakes.
///
/// A replacement presentation whose font keeps the name but changes its bytes used to be refused,
/// because the previous presentation's digest stayed recorded and its text fell back to the
/// system font (#14483). An asset-content change replaces the presentation, so the obsolete face
/// is unregistered and the new bytes take the name.
final class PrototypeFontFaceLedger<Font, Digest: Equatable> {
    private var faces: [String: (digest: Digest, font: Font)] = [:]

    /// Releases this ledger's registrations after its last presentation has stopped.
    func unregisterAll(unregister: (Font) -> Void) {
        let registered = faces.values.map(\.font)
        faces.removeAll()
        for font in registered {
            unregister(font)
        }
    }

    /// Registers `font` as `face`. Returns false when the manager refuses it, or reports the name as
    /// already registered for bytes this ledger did not record.
    func register(
        face: String,
        digest: Digest,
        font: Font,
        register: (Font) -> PrototypeFontRegistrationResult,
        unregister: (Font) -> Void
    )
        -> Bool
    {
        if let current = faces[face], current.digest != digest {
            unregister(current.font)
            faces[face] = nil
        }
        switch register(font) {
        case .registered:
            faces[face] = (digest, font)
            return true
        case .alreadyRegistered:
            // Same bytes registered earlier: keep the recorded font, which is the one to unregister.
            return faces[face]?.digest == digest
        case .failed:
            return false
        }
    }
}
