#if canImport(UIKit)
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

        private typealias FontRegistry = PrototypeFontFaceLedger<CGFont, SHA256.Digest>

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
            let registered = fontRegistry.register(
                face: face,
                digest: SHA256.hash(data: data),
                font: font,
                register: Self.registerGraphicsFont,
                unregister: Self.unregisterGraphicsFont
            )
            guard registered else { return nil }
            return face
        }

        // CoreText's font manager is thread-safe; nonisolated so the ledger can call these directly.
        private nonisolated static func registerGraphicsFont(_ font: CGFont) -> PrototypeFontRegistrationResult {
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterGraphicsFont(font, &error) { return .registered }
            guard let registrationError = error?.takeRetainedValue() else { return .failed }
            let alreadyRegistered = CFErrorGetDomain(registrationError) as String == kCTFontManagerErrorDomain as String
                && CFErrorGetCode(registrationError) == CTFontManagerError.alreadyRegistered.rawValue
            return alreadyRegistered ? .alreadyRegistered : .failed
        }

        private nonisolated static func unregisterGraphicsFont(_ font: CGFont) {
            CTFontManagerUnregisterGraphicsFont(font, nil)
        }
    }
#endif
