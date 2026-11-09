/**
 * File mode for one entry extracted from the CtrlProxy iOS bundle (#17216).
 *
 * adm-zip's `extractAllTo` without `keepOriginalPermission` chmods every file to
 * 0o666, which drops the exec bit from `CtrlProxyUITests-Runner` and the
 * `CtrlProxyUITests.xctest` executable, so the downloaded runner cannot be
 * launched. Keeping the archive's mode verbatim would instead honour whatever
 * group/other bits the archive carries. This keeps only the "is executable"
 * fact from the archive and makes every file owner-only, matching the 0o700
 * extraction root (#4759).
 *
 * @param archiveMode the entry's rwxrwxrwx bits (adm-zip `header.fileAttr`).
 */
export function extractedFileMode(archiveMode: number): number {
  return (archiveMode & 0o111) !== 0 ? 0o700 : 0o600;
}
