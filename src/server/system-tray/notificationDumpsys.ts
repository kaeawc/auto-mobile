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
  /** Whether a custom `RemoteViews` layout can render unrelated text. */
  hasCustomLayout: boolean;
}

const TITLE_EXTRAS = ["android.title", "android.title.big", "android.conversationTitle"];
const BODY_EXTRAS = [
  "android.text",
  "android.bigText",
  "android.summaryText",
  "android.infoText",
  "android.subText",
];
const CUSTOM_LAYOUT_TEMPLATE = /^android\.app\.Notification\$Decorated(?:Media)?CustomViewStyle$/;

// `NotificationRecord.dump` prints `<key>=<SimpleClassName> (<value>)` for
// CharSequence extras, and `<SimpleClassName> [<n> chars]` when the dump is
// redacted — a redacted dump therefore yields no correlation evidence rather
// than a wrong owner. A value containing newlines is printed verbatim, so the
// closing delimiter can land several physical lines later (#6875).
const EXTRA_START = /^(android\.[A-Za-z0-9_.]+)=[A-Za-z][A-Za-z0-9_$.]*\s+\((.*)$/;
const RECORD_LINE = /NotificationRecord\(.*?\bpkg=([^\s]+)/;
// Every extras entry is printed as `<key>=<value>`, whatever the value's type,
// so a key-shaped line is where the previous entry ended.
const EXTRA_KEY_LINE = /^[A-Za-z][A-Za-z0-9_$.]*=/;
const CUSTOM_LAYOUT_FIELD = /^(?:contentView|bigContentView|headsUpContentView)=(?!null$).+$/;
const RECORD_FLAGS = /^flags=(.+)$/;
const GROUP_SUMMARY_FLAG = 0x200;

// The dump prints several record-bearing sections: the active `Notification
// List:` the shade renders, plus snoozed and enqueued records it does not. A
// record outside the active list cannot own a rendered row, so it is not
// correlation evidence — an opaque one would otherwise make every header-less
// row ambiguous (#6875). A heading is a bare `<Name>:` line, which no record
// body line is: those all carry `=`.
const SECTION_HEADING = /^([A-Za-z][A-Za-z0-9 .'()_$-]*):$/;
const ACTIVE_SECTION = "Notification List";
const MANAGER_STATE_HEADER = "Current Notification Manager state:";
// These print after the omitted active list, so a dump truncated at its header cannot mimic empty.
const EMPTY_ACTIVE_SET_TRAILING_MARKERS = ["mArchive=", "Snoozed notifications:"];

/** A CharSequence extra whose closing delimiter has not been read yet. */
interface PendingExtra {
  key: string;
  lines: string[];
}

interface ParsedDumpsysNotificationRecord {
  correlation: DumpsysNotificationRecord;
  key: string | null;
  isGroupSummary: boolean;
}

interface ParsedDumpsysNotificationSnapshot {
  records: ParsedDumpsysNotificationRecord[];
  activeSectionRecognized: boolean;
  complete: boolean;
}

const addExtra = (record: DumpsysNotificationRecord, key: string, value: string): void => {
  if (key === "android.template" && CUSTOM_LAYOUT_TEMPLATE.test(value)) {
    record.hasCustomLayout = true;
  }
  // An extras value the row could never render is not evidence: hierarchy
  // extraction drops empty strings, so keeping an empty `android.text` would
  // leave the record permanently unmatchable (#6875).
  if (value.trim().length === 0) {
    return;
  }
  if (TITLE_EXTRAS.includes(key)) {
    record.titles.push(value);
  } else if (BODY_EXTRAS.includes(key)) {
    record.bodies.push(value);
  }
};

// A pending value ends where its entry ends: at the next extras key, at the
// end of the extras block, or at the next record. A `)` anywhere earlier is
// part of the printed text, not the dump's closing delimiter (#6875).
const leadingWhitespace = (line: string): string => /^\s*/.exec(line)?.[0] ?? "";

const isExtrasKeyLine = (line: string, keyIndentation: string): boolean =>
  leadingWhitespace(line) === keyIndentation && EXTRA_KEY_LINE.test(line.trim());

const endsExtrasEntry = (line: string | undefined, keyIndentation: string): boolean => {
  if (line === undefined) {
    return true;
  }
  const trimmed = line.trim();
  return trimmed === "}" || isExtrasKeyLine(line, keyIndentation) || RECORD_LINE.test(trimmed);
};

// Read one record's `extras={...}` body. A value containing newlines spans
// physical lines, so accumulate until the closing delimiter of the entry; a
// line that starts another extra ends an unterminated value rather than
// swallowing it.
const applyExtras = (record: DumpsysNotificationRecord, lines: readonly string[]): void => {
  let pending: PendingExtra | null = null;
  const keyIndentation = lines[0] === undefined ? "" : leadingWhitespace(lines[0]);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (pending) {
      if (isExtrasKeyLine(line, keyIndentation)) {
        // The value never reached its closing delimiter; drop it rather than
        // swallow the extra that starts here.
        pending = null;
      } else if (endsExtrasEntry(lines[index + 1], keyIndentation) && line.endsWith(")")) {
        addExtra(record, pending.key, [...pending.lines, line.slice(0, -1)].join("\n"));
        pending = null;
        continue;
      } else {
        pending.lines.push(line);
        continue;
      }
    }
    const extra = EXTRA_START.exec(trimmed);
    if (!extra) {
      continue;
    }
    if (endsExtrasEntry(lines[index + 1], keyIndentation) && extra[2].endsWith(")")) {
      addExtra(record, extra[1], extra[2].slice(0, -1));
    } else {
      pending = { key: extra[1], lines: [extra[2]] };
    }
  }
};

const readNotificationKey = (line: string): string | null => {
  const start = line.indexOf(" key=");
  if (start < 0) {
    return null;
  }
  const valueStart = start + " key=".length;
  const notificationSuffix = line.indexOf(": Notification(", valueStart);
  const valueEnd = notificationSuffix >= 0 ? notificationSuffix : line.lastIndexOf(")");
  return valueEnd > valueStart ? line.slice(valueStart, valueEnd) : null;
};

const startParsedRecord = (
  line: string,
  inActiveSection: boolean,
  records: ParsedDumpsysNotificationRecord[],
): { complete: boolean; current: ParsedDumpsysNotificationRecord | null } => {
  const match = RECORD_LINE.exec(line);
  if (!match) {
    return { complete: !inActiveSection, current: null };
  }
  if (!inActiveSection) {
    return { complete: true, current: null };
  }
  const key = readNotificationKey(line);
  const current = {
    correlation: {
      pkg: match[1],
      titles: [],
      bodies: [],
      hasCustomLayout: false,
    },
    key,
    isGroupSummary: false,
  };
  records.push(current);
  return { complete: key !== null, current };
};

const readRecordMetadata = (current: ParsedDumpsysNotificationRecord, line: string): boolean => {
  current.correlation.hasCustomLayout ||= CUSTOM_LAYOUT_FIELD.test(line);
  const flags = RECORD_FLAGS.exec(line);
  if (flags) {
    const numericFlags = Number(flags[1]);
    current.isGroupSummary ||=
      flags[1].split("|").includes("GROUP_SUMMARY") ||
      (Number.isFinite(numericFlags) && (numericFlags & GROUP_SUMMARY_FLAG) !== 0);
  }
  return line.startsWith("extras={");
};

const parseDumpsysNotificationSnapshot = (output: string): ParsedDumpsysNotificationSnapshot => {
  const records: ParsedDumpsysNotificationRecord[] = [];
  let current: ParsedDumpsysNotificationRecord | null = null;
  // Records before the first heading belong to no declared section: a dump
  // without section headings is read whole rather than discarded.
  let inActiveSection = true;
  let activeSectionRecognized = false;
  let complete = true;
  // The physical lines of the extras block being read, or `null` outside one.
  let extrasLines: string[] | null = null;
  const flushExtras = (): void => {
    if (current && extrasLines) {
      applyExtras(current.correlation, extrasLines);
    }
    extrasLines = null;
  };
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const heading = extrasLines === null ? SECTION_HEADING.exec(trimmed) : null;
    if (heading) {
      inActiveSection = heading[1] === ACTIVE_SECTION;
      activeSectionRecognized ||= inActiveSection;
      current = null;
      continue;
    }
    if (trimmed.includes("NotificationRecord(")) {
      flushExtras();
      const started = startParsedRecord(trimmed, inActiveSection, records);
      current = started.current;
      complete &&= started.complete;
      continue;
    }
    if (!current) {
      continue;
    }
    if (extrasLines === null) {
      if (readRecordMetadata(current, trimmed)) {
        extrasLines = [];
      }
      continue;
    }
    if (trimmed === "}") {
      flushExtras();
      continue;
    }
    extrasLines.push(line);
  }
  flushExtras();
  return { records, activeSectionRecognized, complete };
};

/** Parse `dumpsys notification --noredact` into per-package correlation records. */
export const parseDumpsysNotificationRecords = (output: string): DumpsysNotificationRecord[] =>
  parseDumpsysNotificationSnapshot(output).records.map((record) => record.correlation);

/**
 * Return stable active-record identities for one package, excluding synthetic
 * group summaries. Undefined means the dump was not trustworthy enough for
 * before/after accounting.
 */
export const parseActiveNotificationKeysForApp = (
  output: string,
  appId: string,
): string[] | undefined => {
  const snapshot = parseDumpsysNotificationSnapshot(output);
  // API 36 omits `Notification List:` entirely after the last active
  // notification is cleared. The manager-state header plus the absence of
  // both an active-list heading and records is a complete, trustworthy empty
  // active set; records without an active heading remain untrusted.
  const wellFormedEmptyActiveSet =
    output.includes(MANAGER_STATE_HEADER) &&
    !output.includes(`${ACTIVE_SECTION}:`) &&
    snapshot.records.length === 0 &&
    EMPTY_ACTIVE_SET_TRAILING_MARKERS.some((marker) => output.includes(marker));
  if (!snapshot.complete || (!snapshot.activeSectionRecognized && !wellFormedEmptyActiveSet)) {
    return undefined;
  }
  return [
    ...new Set(
      snapshot.records.flatMap((record) =>
        record.correlation.pkg === appId && !record.isGroupSummary && record.key
          ? [record.key]
          : [],
      ),
    ),
  ];
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

// A record with no readable extras at all — a redacted dump, or a custom
// `RemoteViews` notification whose text lives only in its layout — could have
// posted any header-less row: nothing in it contradicts the rendered text. It
// is therefore a plausible owner of every row, which is what keeps a row whose
// text another package happens to duplicate from being named for that other
// package (#6875).
const recordIsOpaque = (record: DumpsysNotificationRecord): boolean =>
  populatedCategories(record).length === 0;

const packagesMatching = (
  records: readonly DumpsysNotificationRecord[],
  predicate: (record: DumpsysNotificationRecord) => boolean,
): Set<string> => new Set(records.filter(predicate).map((record) => record.pkg));

/**
 * Retain an after-scan record only when its package was the sole plausible
 * owner before scanning and it still matches the row afterward. A missing
 * before snapshot deliberately falls back to after-only correlation,
 * preserving the existing best-effort behavior.
 */
export const intersectDumpsysRecordsForRow = (
  beforeRecords: readonly DumpsysNotificationRecord[] | undefined,
  afterRecords: readonly DumpsysNotificationRecord[],
  rowTexts: ReadonlySet<string>,
): readonly DumpsysNotificationRecord[] => {
  if (beforeRecords === undefined) {
    return afterRecords;
  }
  const beforePackages = packagesMatching(beforeRecords, (record) =>
    recordMatchesRow(record, rowTexts),
  );
  if (beforePackages.size !== 1) {
    return [];
  }
  const [beforePackage] = beforePackages;
  return afterRecords.filter(
    (record) => record.pkg === beforePackage && recordMatchesRow(record, rowTexts),
  );
};

/**
 * Name the package that posted a header-less row, or `null` when no record
 * matches the rendered text and when more than one package's record could.
 * Ambiguity is reported as "unknown" rather than resolved by preference.
 */
export const attributeRowByDumpsys = (
  records: readonly DumpsysNotificationRecord[],
  rowTexts: ReadonlySet<string>,
): string | null => {
  const plausible = packagesMatching(
    records,
    (record) =>
      recordIsOpaque(record) || record.hasCustomLayout || recordSharesRowEvidence(record, rowTexts),
  );
  if (plausible.size !== 1) {
    return null;
  }
  const owners = packagesMatching(records, (record) => recordMatchesRow(record, rowTexts));
  return owners.size === 1 ? [...owners][0] : null;
};
