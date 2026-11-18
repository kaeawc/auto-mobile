package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** Plain JVM: resource ids are compared, never resolved, so no Robolectric start-up. */
class ImportMessagesTest {
  @Test
  fun everyImporterReasonTokenHasItsOwnMessage() {
    val expected =
      mapOf(
        IMPORT_REASON_URI_REQUIRED to R.string.import_reason_uri_required,
        IMPORT_REASON_TOO_LARGE to R.string.import_reason_too_large,
        IMPORT_REASON_UNREADABLE to R.string.import_reason_unreadable,
        IMPORT_REASON_INVALID_IMAGE to R.string.import_reason_invalid_image,
        UNSUPPORTED_PROTOTYPE_REASON to R.string.unsupported,
      )
    expected.forEach { (reason, message) ->
      assertEquals(
        reason,
        message,
        importRejectionReason(LibraryImportResult.Rejected("x", reason)),
      )
    }
  }

  @Test
  fun specPolicyMessagesAreNotShownVerbatim() {
    val rejected = LibraryImportResult.Rejected("spec.json:$.root", "English validator text")
    assertEquals(R.string.import_reason_spec_invalid, importRejectionReason(rejected))
  }

  @Test
  fun libraryAndBundleCodesMapThroughTheirEnums() {
    LibraryError.entries.forEach { error ->
      assertEquals(
        libraryErrorReason(error),
        importRejectionReason(LibraryImportResult.Rejected("library", error.name)),
      )
    }
    PrototypeBundleErrorCode.entries.forEach { code ->
      val message = importRejectionReason(LibraryImportResult.Rejected("bundle", code.name))
      assertEquals(bundleErrorReason(code), message)
      assertNotEquals(code.name, R.string.import_reason_invalid, message)
    }
  }

  @Test
  fun unknownReasonsFallBackToAGenericMessage() {
    assertEquals(
      R.string.import_reason_invalid,
      importRejectionReason(LibraryImportResult.Rejected("spec.json", "Invalid")),
    )
    assertEquals(
      R.string.import_reason_invalid,
      importRejectionReason(LibraryImportResult.Rejected("library", "NotAnError")),
    )
  }

  @Test
  fun shareWarningCodesAreTranslatedAndUnknownCodesStillRender() {
    assertEquals(R.string.share_warning_credential_header, shareWarningText("credential_header"))
    assertEquals(R.string.share_warning_credential_query, shareWarningText("credential_query"))
    assertEquals(R.string.share_warning_private_host, shareWarningText("private_host"))
    assertEquals(R.string.share_warning_other, shareWarningText("future_code"))
  }
}
