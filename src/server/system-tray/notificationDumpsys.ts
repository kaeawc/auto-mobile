/**
 * Correlation evidence for notification shade rows that SystemUI renders
 * without a per-row app-name header (#6875).
 *
 * SystemUI omits the app header for rows in the Silent (low-importance)
 * section, so the rendered shade carries no ownership evidence for them at
 * all. `dumpsys notification` is authoritative about which package posted each
 * notification, so a header-less row can be attributed by correlating the text
 * it renders against the posting record's extras.
 */

/** One posted notification's correlatable content, per posting package. */
export interface DumpsysNotificationRecord {
  pkg: string;
  /** Title-ish extras values (`android.title`, conversation title, ...). */
  titles: string[];
  /** Body-ish extras values (`android.text`, big text, sub text, ...). */
  bodies: string[];
}

const TITLE_EXTRAS = ["android.title", "android.title.big", "android.conversationTitle"];
const BODY_EXTRAS = [
  "android.text",
  "android.bigText",
  "android.summaryText",
  "android.infoText",
  "android.subText",
];

// `NotificationRecord.dump` prints `<key>=<SimpleClassName> (<value>)` for
// CharSequence extras, and `<SimpleClassName> [<n> chars]` when the dump is
// redacted — a redacted dump therefore yields no correlation evidence rather
// than a wrong owner.
const EXTRA_LINE = /^(android\.[A-Za-z0-9_.]+)=[A-Za-z][A-Za-z0-9_$.]*\s+\((.*)\)$/;
const RECORD_LINE = /NotificationRecord\(.*?\bpkg=([^\s]+)/;

/** Parse `dumpsys notification --noredact` into per-package correlation records. */
export const parseDumpsysNotificationRecords = (output: string): DumpsysNotificationRecord[] => {
  const records: DumpsysNotificationRecord[] = [];
  let current: DumpsysNotificationRecord | null = null;
  let inExtras = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const record = RECORD_LINE.exec(trimmed);
    if (record) {
      current = { pkg: record[1], titles: [], bodies: [] };
      records.push(current);
      inExtras = false;
      continue;
    }
    if (!current) {
      continue;
    }
    if (trimmed.startsWith("extras={")) {
      inExtras = true;
      continue;
    }
    if (inExtras && trimmed === "}") {
      inExtras = false;
      continue;
    }
    const extra = inExtras ? EXTRA_LINE.exec(trimmed) : null;
    if (!extra) {
      continue;
    }
    if (TITLE_EXTRAS.includes(extra[1])) {
      current.titles.push(extra[2]);
    } else if (BODY_EXTRAS.includes(extra[1])) {
      current.bodies.push(extra[2]);
    }
  }
  return records;
};

/** The extras categories this record actually populated. */
const populatedCategories = (record: DumpsysNotificationRecord): string[][] =>
  [record.titles, record.bodies].filter((values) => values.length > 0);

const rowRendersAnyOf = (values: readonly string[], rowTexts: ReadonlySet<string>): boolean =>
  values.some((value) => rowTexts.has(value));

// A row renders one layout of a notification, so it need not show every extras
// value; it must however show one value from each category the record
// populated. Matching a title alone against a record that also has body text is
// not ownership evidence.
const recordMatchesRow = (
  record: DumpsysNotificationRecord,
  rowTexts: ReadonlySet<string>,
): boolean => {
  const categories = populatedCategories(record);
  return categories.length > 0 && categories.every((values) => rowRendersAnyOf(values, rowTexts));
};

// The completeness rule above is only sound as a rejection. A collapsed or
// custom row may omit the body its own record populated, so a record that fails
// it is still a plausible owner of the row; using that rejection to promote the
// one record that happens to carry less content would attribute another app's
// row to the requested package. Any record sharing rendered text therefore
// keeps the row ambiguous (#6875).
const recordSharesRowEvidence = (
  record: DumpsysNotificationRecord,
  rowTexts: ReadonlySet<string>,
): boolean => populatedCategories(record).some((values) => rowRendersAnyOf(values, rowTexts));

const packagesMatching = (
  records: readonly DumpsysNotificationRecord[],
  predicate: (record: DumpsysNotificationRecord) => boolean,
): Set<string> => new Set(records.filter(predicate).map((record) => record.pkg));

/**
 * Name the package that posted a header-less row, or `null` when no record
 * matches the rendered text and when more than one package's record could.
 * Ambiguity is reported as "unknown" rather than resolved by preference.
 */
export const attributeRowByDumpsys = (
  records: readonly DumpsysNotificationRecord[],
  rowTexts: ReadonlySet<string>,
): string | null => {
  const plausible = packagesMatching(records, (record) =>
    recordSharesRowEvidence(record, rowTexts),
  );
  if (plausible.size !== 1) {
    return null;
  }
  const owners = packagesMatching(records, (record) => recordMatchesRow(record, rowTexts));
  return owners.size === 1 ? [...owners][0] : null;
};
