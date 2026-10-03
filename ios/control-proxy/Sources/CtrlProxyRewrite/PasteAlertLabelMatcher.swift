import Foundation

/// Exact UIKitCore paste-permission labels from Tests/PasteAlertStrings (see its README).
/// Unknown labels, including deny actions, must never be accepted by substring matching.
enum PasteAlertLabelMatcher: Sendable {
    /// Original labels, with locale tags for traceability; suitable for an XCUIElementQuery predicate.
    static let allowPasteLabels: Set<String> = [
        "السماح باللصق", // ar
        "Позволи поставяне", // bg
        "পেস্ট করার অনুমতি দিন", // bn
        "Permet enganxar", // ca
        "Permetre enganxar", // ca
        "Povolit vložení", // cs
        "Tillad Sæt ind", // da
        "Einsetzen erlauben", // de
        "Επιτρέπεται η επικόλληση", // el
        "Allow Paste", // en, en_AU, en_CA, en_GB, en_IN, en_PH
        "Permitir pegar", // es, es_419
        "Salli sijoittaminen", // fi
        "Autoriser le collage", // fr
        "Autoriser l’action Coller", // fr_CA
        "પેસ્ટ કરવા દો", // gu
        "אפשר הדבקה", // he
        "הרשאת הדבקה", // he
        "לאפשר הדבקה", // he
        "पेस्ट करने की अनुमति दें", // hi
        "Dozvoli lijepljenje", // hr
        "Beillesztés engedélyezése", // hu
        "Izinkan Tempel", // id
        "Consenti Incolla", // it
        "ペーストを許可", // ja
        "Қоюға рұқсат беру", // kk
        "ಪೇಸ್ಟ್ ಮಾಡುವುದನ್ನು ಅನುಮತಿಸಿ", // kn
        "붙여넣기 허용", // ko
        "Leisti įklijuoti", // lt
        "പേസ്റ്റ് ചെയ്യാൻ അനുവദിക്കൂ", // ml
        "पेस्ट करण्यासाठी अनुमती द्या", // mr
        "Benarkan Menampal", // ms
        "Sta plakken toe", // nl
        "Tillat innliming", // no
        "ପେଷ୍ଟ୍ ପାଇଁ ଅନୁମତି ଦିଅନ୍ତୁ", // or
        "ਪੇਸਟ ਕਰਨ ਦੀ ਆਗਿਆ ਦਿਓ", // pa
        "Pozwól na wklejenie", // pl
        "Permitir Colar", // pt
        "Permitir colar", // pt_PT
        "Permiteți lipirea", // ro
        "Разрешить вставку", // ru
        "Povoliť vkladanie", // sk
        "Povoliť vloženie", // sk
        "Dovoli lepljenje", // sl
        "Tillåt Klistra in", // sv
        "ஒட்ட அனுமதி", // ta
        "పేస్ట్ చేయడానికి అనుమతించండి", // te
        "อนุญาตให้วาง", // th
        "Yapıştırmaya İzin Ver", // tr
        "Дозволити вставлення", // uk
        "پیسٹ کرنے کی اجازت دیں", // ur
        "Cho phép dán", // vi
        "允许粘贴", // zh_CN
        "允許貼上", // zh_HK, zh_TW
    ]

    private static let normalizedAllowPasteLabels = Set(allowPasteLabels.map { normalized($0) })

    static func isAllowPasteLabel(_ label: String) -> Bool {
        normalizedAllowPasteLabels.contains(normalized(label))
    }

    private static func normalized(_ label: String) -> String {
        label.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "‘", with: "'")
    }
}
