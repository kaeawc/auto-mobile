import CoreText
import CryptoKit
import UIKit

@MainActor
final class PrototypeAssetRegistrar: PrototypeAssetRegistering {
    let model: PrototypeModel
    enum FontRegistrationScope {
        case registrar
        case process
    }

    private final class FontRegistry {
        var registeredFontDigests: [String: SHA256.Digest] = [:]
    }

    private static let processFontRegistry = FontRegistry()
    private let fontRegistry: FontRegistry

    init(model: PrototypeModel, fontRegistrationScope: FontRegistrationScope = .registrar) {
        self.model = model
        // Viewer launches track only their own fonts; embedded presentations share process registrations.
        fontRegistry = fontRegistrationScope == .process ? Self.processFontRegistry : FontRegistry()
    }

    func registerImage(id: String, data: Data) -> Bool {
        guard let image = UIImage(data: data) else { return false }
        model.putAsset(id, image)
        return true
    }

    func registerFont(id _: String, data: Data) -> String? {
        guard let provider = CGDataProvider(data: data as CFData),
              let font = CGFont(provider), let name = font.postScriptName
        else { return nil }
        let face = name as String
        let digest = SHA256.hash(data: data)
        if let registeredDigest = fontRegistry.registeredFontDigests[face], registeredDigest != digest { return nil }
        var error: Unmanaged<CFError>?
        let registered = CTFontManagerRegisterGraphicsFont(font, &error)
        let registrationError = error?.takeRetainedValue()
        var alreadyRegistered = false
        if let registrationError, fontRegistry.registeredFontDigests[face] == digest {
            alreadyRegistered = CFErrorGetDomain(registrationError) as String == kCTFontManagerErrorDomain as String
                && CFErrorGetCode(registrationError) == CTFontManagerError.alreadyRegistered.rawValue
        }
        guard registered || alreadyRegistered else { return nil }
        fontRegistry.registeredFontDigests[face] = digest
        return face
    }
}
