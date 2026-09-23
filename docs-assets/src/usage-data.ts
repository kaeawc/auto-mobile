// Renders the download charts into #dl-metrics on metrics/usage-data.md; a
// no-op on every other page.

const DATA_URL =
  "https://raw.githubusercontent.com/kaeawc/auto-mobile/main/docs/metrics/data/downloads.jsonl";
const SVG_NS = "http://www.w3.org/2000/svg";
// A colorblind-friendly qualitative palette, readable on both themes.
const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

// Asset families for the headline "downloads by type" chart. Order is the
// bottom-to-top stacking order and the legend order. Colors are fixed per
// family (not palette-indexed) so a family keeps its color as releases come
// and go. Mirrors src/metrics/downloadSnapshots.ts (unit-tested there); this
// copy is standalone because the page's script is fetched on its own.
const ASSET_TYPE_ORDER = [
  "android-apk",
  "ios-ipa",
  "desktop-installer",
  "video-jar",
  "screen-capture-helper",
  "other",
];
const ASSET_TYPE_LABELS: Record<string, string> = {
  "android-apk": "Android APK",
  "ios-ipa": "iOS IPA",
  "desktop-installer": "Desktop installers",
  "video-jar": "Video jar",
  "screen-capture-helper": "Screen-capture helper",
  other: "Other",
};
const ASSET_TYPE_COLORS: Record<string, string> = {
  "android-apk": "#4e79a7",
  "ios-ipa": "#f28e2b",
  "desktop-installer": "#b07aa1",
  "video-jar": "#76b7b2",
  "screen-capture-helper": "#9c755f",
  other: "#bab0ac",
};
const MAX_ADOPTION_TAGS = 8;
const NPM_AVERAGE_WINDOW = 7;

interface GithubAsset {
  tag: string;
  asset: string;
  cumulative: number;
  id?: number | string | null;
}

interface NpmDay {
  day: string;
  downloads: number;
}

interface Snapshot {
  date: string;
  github?: GithubAsset[];
  npm?: NpmDay[];
}

interface CumulativePoint {
  date: string;
  value: number;
}

interface DeltaPoint {
  date: string;
  value: number | null;
}

interface AssetSeries {
  tag: string;
  asset: string;
  cumulative: CumulativePoint[];
  delta: DeltaPoint[];
}

interface BuiltSeries {
  dates: string[];
  series: Record<string, AssetSeries>;
}

interface TypeCell {
  downloads: number;
  partial: boolean;
  observed: boolean;
}

interface TypeSeries {
  type: string;
  label: string;
  color: string;
  points: TypeCell[];
  total: number;
}

interface TagPoint {
  date: string;
  value: number | null;
}

interface TagSeries {
  tag: string;
  points: TagPoint[];
  latest: number;
}

interface LineSeries {
  color: string;
  points: Array<{ value: number | null }>;
}

interface LegendEntry {
  label: string;
  color: string;
}

type AttrMap = Record<string, string | number>;

function el(tag: string, attrs?: AttrMap, text?: string | null): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      node.setAttribute(k, String(attrs[k]));
    });
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

function endsWith(str: string, suffix: string): boolean {
  return str.slice(str.length - suffix.length) === suffix;
}

function parseJsonl(text: string): Snapshot[] {
  return text
    .split("\n")
    .map(function (l) {
      return l.trim();
    })
    .filter(function (l) {
      return l.length > 0;
    })
    .map(function (l) {
      return JSON.parse(l) as Snapshot;
    });
}

// assetKey -> stable identity across snapshots.
function key(tag: string, asset: string): string {
  return tag + " · " + asset;
}

// Compare release tags newest-first by numeric version segments, so 0.0.100
// sorts ahead of 0.0.47 (a lexical compare would invert them). Non-numeric
// pre-release labels fall back to a reversed string compare.
function cmpTagDesc(a: string, b: string): number {
  const pa = String(a)
    .replace(/^v/, "")
    .split(/[.\-+]/);
  const pb = String(b)
    .replace(/^v/, "")
    .split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10),
      nb = parseInt(pb[i], 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) {
        return nb - na;
      }
    } else {
      const sa = pa[i] || "",
        sb = pb[i] || "";
      if (sa !== sb) {
        return sa < sb ? 1 : -1;
      }
    }
  }
  return 0;
}

// Map an asset file name to its family (see src/metrics/downloadSnapshots.ts).
function classifyAssetType(asset: string): string {
  const name = String(asset).toLowerCase();
  if (endsWith(name, ".apk")) {
    return "android-apk";
  }
  if (endsWith(name, ".ipa")) {
    return "ios-ipa";
  }
  if (endsWith(name, ".deb") || endsWith(name, ".dmg") || endsWith(name, ".msi")) {
    return "desktop-installer";
  }
  if (endsWith(name, ".jar")) {
    return "video-jar";
  }
  if (name.indexOf("screen-capture-helper") === 0 || endsWith(name, ".zip")) {
    return "screen-capture-helper";
  }
  return "other";
}

// Whole-day difference between two YYYY-MM-DD UTC dates (later - earlier).
function utcDayDifference(earlier: string, later: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(later + "T00:00:00.000Z") - Date.parse(earlier + "T00:00:00.000Z")) / MS_PER_DAY,
  );
}

// Build cumulative series and daily-delta series per asset from all snapshots.
function buildAssetSeries(snapshots: Snapshot[]): BuiltSeries {
  const ordered = snapshots.slice().sort(function (a, b) {
    return a.date < b.date ? -1 : 1;
  });
  const dates = ordered.map(function (s) {
    return s.date;
  });
  const series: Record<string, AssetSeries> = {}; // key -> { tag, asset, cumulative: [{date,value}], delta: [{date,value|null}] }
  const last: Record<string, { cumulative: number; date: string; id?: number | string | null }> =
    {}; // key -> { cumulative, date }
  ordered.forEach(function (snap) {
    (snap.github || []).forEach(function (g) {
      const k = key(g.tag, g.asset);
      if (!series[k]) {
        series[k] = { tag: g.tag, asset: g.asset, cumulative: [], delta: [] };
      }
      const prior = last[k];
      // Only a prior observation on the immediately preceding calendar day
      // yields a real daily delta; a gap (missing intermediate snapshot) is
      // unknowable and rendered as null. A cumulative DECREASE (asset
      // re-published / counter reset) is likewise unknowable, so it is null
      // rather than a false 0. A CHANGED GitHub asset id (asset deleted and
      // re-uploaded under the same tag+filename gets a new id) means the two
      // cumulative counts belong to different counters, so it is null too —
      // even when the value did not decrease.
      let delta: number | null;
      if (prior === undefined || utcDayDifference(prior.date, snap.date) !== 1) {
        delta = null;
      } else if (prior.id != null && g.id != null && prior.id !== g.id) {
        delta = null;
      } else {
        const change = g.cumulative - prior.cumulative;
        delta = change < 0 ? null : change;
      }
      series[k].cumulative.push({ date: snap.date, value: g.cumulative });
      series[k].delta.push({ date: snap.date, value: delta });
      last[k] = { cumulative: g.cumulative, date: snap.date, id: g.id };
    });
  });
  return { dates: dates, series: series };
}

// Collapse per-asset daily deltas into one aligned series per asset FAMILY,
// summed across all releases. Null deltas are excluded from the sum and flag
// the day partial (a lower bound), never invented as zero.
function summarizeDailyByType(built: BuiltSeries): { dates: string[]; series: TypeSeries[] } {
  const dates = built.dates;
  const indexByDate: Record<string, number> = {};
  dates.forEach(function (d, i) {
    indexByDate[d] = i;
  });
  const acc: Record<string, TypeCell[]> = {}; // type -> array aligned to dates of { downloads, partial, observed }
  ASSET_TYPE_ORDER.forEach(function (t) {
    acc[t] = dates.map(function () {
      return { downloads: 0, partial: false, observed: false };
    });
  });
  Object.keys(built.series).forEach(function (k) {
    const s = built.series[k];
    const type = classifyAssetType(s.asset);
    s.delta.forEach(function (p) {
      const cell = acc[type][indexByDate[p.date]];
      cell.observed = true;
      if (p.value == null) {
        cell.partial = true;
      } else {
        cell.downloads += p.value;
      }
    });
  });
  const out: TypeSeries[] = [];
  ASSET_TYPE_ORDER.forEach(function (t) {
    const pts = acc[t];
    let observed = false,
      total = 0;
    pts.forEach(function (p) {
      if (p.observed) {
        observed = true;
      }
      total += p.downloads;
    });
    if (!observed) {
      return;
    }
    out.push({
      type: t,
      label: ASSET_TYPE_LABELS[t],
      color: ASSET_TYPE_COLORS[t],
      points: pts,
      total: total,
    });
  });
  return { dates: dates, series: out };
}

// One line per release tag: total cumulative across the tag's assets. A tag
// absent from a snapshot gets a null point so the line breaks rather than
// dropping to zero. Newest releases first, capped to maxTags.
function summarizeCumulativeByTag(
  snapshots: Snapshot[],
  maxTags: number,
): { dates: string[]; series: TagSeries[] } {
  const ordered = snapshots.slice().sort(function (a, b) {
    return a.date < b.date ? -1 : 1;
  });
  const dates = ordered.map(function (s) {
    return s.date;
  });
  const acc: Record<string, Record<string, number>> = {}; // tag -> { date -> sum }
  ordered.forEach(function (snap) {
    (snap.github || []).forEach(function (g) {
      if (!acc[g.tag]) {
        acc[g.tag] = {};
      }
      acc[g.tag][snap.date] = (acc[g.tag][snap.date] || 0) + g.cumulative;
    });
  });
  let tags = Object.keys(acc).sort(cmpTagDesc);
  if (maxTags && tags.length > maxTags) {
    tags = tags.slice(0, maxTags);
  }
  const series = tags.map(function (tag): TagSeries {
    const byDate = acc[tag];
    let latest = 0;
    const points = dates.map(function (d): TagPoint {
      const has = Object.prototype.hasOwnProperty.call(byDate, d);
      const value = has ? byDate[d] : null;
      if (value !== null) {
        latest = value;
      }
      return { date: d, value: value };
    });
    return { tag: tag, points: points, latest: latest };
  });
  return { dates: dates, series: series };
}

// Trailing simple moving average, min-periods 1 (see downloadSnapshots.ts).
function rollingAverage(values: number[], window: number): number[] {
  const size = Math.max(1, Math.floor(window));
  const out: number[] = [],
    q: number[] = [];
  let sum = 0;
  values.forEach(function (v) {
    q.push(v);
    sum += v;
    if (q.length > size) {
      sum -= q.shift() as number;
    }
    out.push(sum / q.length);
  });
  return out;
}

// Merge npm arrays across snapshots, latest snapshot wins per day.
function buildNpmSeries(snapshots: Snapshot[]): NpmDay[] {
  const byDay: Record<string, number> = {};
  snapshots.forEach(function (snap) {
    (snap.npm || []).forEach(function (n) {
      byDay[n.day] = n.downloads;
    });
  });
  return Object.keys(byDay)
    .sort()
    .map(function (day): NpmDay {
      return { day: day, downloads: byDay[day] };
    });
}

function legend(container: HTMLElement, entries: LegendEntry[]): void {
  const box = document.createElement("div");
  box.className = "dl-legend";
  entries.forEach(function (e) {
    const span = document.createElement("span");
    const sw = document.createElement("span");
    sw.className = "dl-swatch";
    sw.style.background = e.color;
    span.appendChild(sw);
    span.appendChild(document.createTextNode(e.label));
    box.appendChild(span);
  });
  container.appendChild(box);
}

const W = 720,
  H = 260,
  ML = 48,
  MR = 12,
  MT = 12,
  MB = 28;

function scaleX(i: number, n: number): number {
  if (n <= 1) {
    return ML + (W - ML - MR) / 2;
  }
  return ML + (i * (W - ML - MR)) / (n - 1);
}
function scaleY(v: number, max: number): number {
  if (max <= 0) {
    return H - MB;
  }
  return MT + (1 - v / max) * (H - MT - MB);
}

function axes(svg: SVGElement, max: number, labels: string[]): void {
  svg.appendChild(el("line", { x1: ML, y1: MT, x2: ML, y2: H - MB, class: "dl-axis" }));
  svg.appendChild(el("line", { x1: ML, y1: H - MB, x2: W - MR, y2: H - MB, class: "dl-axis" }));
  [0, 0.5, 1].forEach(function (f) {
    const v = Math.round(max * f);
    const y = scaleY(v, max);
    svg.appendChild(
      el("text", { x: ML - 6, y: y + 3, "text-anchor": "end", class: "dl-tick-text" }, String(v)),
    );
  });
  const step = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach(function (d, i) {
    if (i % step !== 0 && i !== labels.length - 1) {
      return;
    }
    const x = scaleX(i, labels.length);
    svg.appendChild(
      el(
        "text",
        { x: x, y: H - MB + 14, "text-anchor": "middle", class: "dl-tick-text" },
        String(d).slice(5),
      ),
    );
  });
}

function lineChart(
  title: string,
  dates: string[],
  seriesList: LineSeries[],
  valueFor: (p: { value: number | null }) => number | null,
): SVGElement {
  const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
  svg.appendChild(el("title", {}, title));
  // Position each point by its snapshot date's index in the GLOBAL date axis,
  // not its index within one asset's (possibly sparse) series — a release that
  // first appears in a later snapshot must plot at the correct right-hand x.
  const indexByDate: Record<string, number> = {};
  dates.forEach(function (d, i) {
    indexByDate[d] = i;
  });
  let max = 1;
  seriesList.forEach(function (s) {
    s.points.forEach(function (p) {
      const value = valueFor(p);
      if (value != null && value > max) {
        max = value;
      }
    });
  });
  axes(svg, max, dates);
  seriesList.forEach(function (s) {
    let d = "";
    let penUp = true; // start a fresh subpath after any gap (null value)
    let prevDate: string | null = null; // last plotted point's snapshot date
    (s.points as Array<{ value: number | null; date?: string }>).forEach(function (p) {
      const v = valueFor(p);
      if (v == null) {
        penUp = true;
        return;
      }
      // Lift the pen across absent observations by comparing CALENDAR days, not
      // array indexes: `dates` holds only recorded snapshots, so a fully-missing
      // day (no snapshot at all) leaves adjacent indexes; only utcDayDifference
      // detects it. More than one day between plotted points is a gap → break.
      const pointDate = p.date as string;
      if (prevDate !== null && utcDayDifference(prevDate, pointDate) > 1) {
        penUp = true;
      }
      const x = scaleX(indexByDate[pointDate], dates.length);
      const y = scaleY(v, max);
      d += (penUp ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      penUp = false;
      prevDate = pointDate;
      svg.appendChild(el("circle", { cx: x, cy: y, r: 2.5, fill: s.color }));
    });
    if (d) {
      svg.appendChild(el("path", { d: d, class: "dl-chart-line", stroke: s.color }));
    }
  });
  return svg;
}

// Stacked daily bars: one bar per date, segments stacked in seriesList order.
// A segment whose day is `partial` (some contributing delta unknown) is drawn
// faded with a dashed outline, signalling the value is a lower bound.
function stackedBarChart(title: string, dates: string[], seriesList: TypeSeries[]): SVGElement {
  const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
  svg.appendChild(el("title", {}, title));
  const n = dates.length;
  let max = 1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    seriesList.forEach(function (s) {
      sum += s.points[i].downloads;
    });
    if (sum > max) {
      max = sum;
    }
  }
  axes(svg, max, dates);
  const bw = Math.max(1, ((W - ML - MR) / Math.max(1, n)) * 0.7);
  for (let j = 0; j < n; j++) {
    let yBase = H - MB;
    const x = scaleX(j, n) - bw / 2;
    seriesList.forEach(function (s) {
      const pt = s.points[j];
      if (pt.downloads <= 0) {
        return;
      }
      const h = (pt.downloads / max) * (H - MT - MB);
      const y = yBase - h;
      const attrs: AttrMap = { x: x, y: y, width: bw, height: h, fill: s.color, class: "dl-bar" };
      if (pt.partial) {
        attrs["fill-opacity"] = "0.4";
        attrs.stroke = s.color;
        attrs["stroke-dasharray"] = "2 2";
      }
      svg.appendChild(el("rect", attrs));
      yBase = y;
    });
  }
  return svg;
}

// npm daily bars with a rolling-average line overlaid on the same axis.
function barsWithAverage(
  title: string,
  labels: string[],
  values: number[],
  average: number[],
  barColor: string,
  lineColor: string,
): SVGElement {
  const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
  svg.appendChild(el("title", {}, title));
  let max = 1;
  values.forEach(function (v) {
    if (v > max) {
      max = v;
    }
  });
  average.forEach(function (v) {
    if (v > max) {
      max = v;
    }
  });
  axes(svg, max, labels);
  const n = values.length;
  const bw = Math.max(1, ((W - ML - MR) / Math.max(1, n)) * 0.7);
  values.forEach(function (v, i) {
    const x = scaleX(i, n) - bw / 2;
    const y = scaleY(v, max);
    svg.appendChild(
      el("rect", { x: x, y: y, width: bw, height: H - MB - y, fill: barColor, class: "dl-bar" }),
    );
  });
  let d = "";
  average.forEach(function (v, i) {
    d += (i === 0 ? "M" : "L") + scaleX(i, n).toFixed(1) + " " + scaleY(v, max).toFixed(1) + " ";
  });
  if (d) {
    svg.appendChild(el("path", { d: d, class: "dl-chart-line", stroke: lineColor }));
  }
  return svg;
}

function section(root: HTMLElement, title: string, subtitle: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dl-section";
  // Plain HTML elements: el() creates SVG-namespace nodes.
  const heading = document.createElement("h2");
  heading.textContent = title;
  wrap.appendChild(heading);
  const description = document.createElement("p");
  description.textContent = subtitle;
  wrap.appendChild(description);
  root.appendChild(wrap);
  return wrap;
}

function render(root: HTMLElement, snapshots: Snapshot[]): void {
  root.innerHTML = "";
  if (!snapshots.length) {
    root.innerHTML = '<p class="dl-error">No snapshot data available yet.</p>';
    return;
  }
  const built = buildAssetSeries(snapshots);

  // Chart 1 — the headline: total artifact downloads over time, by asset type,
  // with the per-release dimension collapsed away.
  const byType = summarizeDailyByType(built);
  const c1 = section(
    root,
    "Artifact downloads over time",
    "Daily GitHub-asset downloads across all releases, stacked by artifact type. Faded, dashed " +
      "segments are partial (a day-0 seed, a snapshot gap, or a counter reset left some counts " +
      "unknown) — read them as a lower bound.",
  );
  legend(
    c1,
    byType.series.map(function (s): LegendEntry {
      return { label: s.label + " (" + s.total.toLocaleString() + ")", color: s.color };
    }),
  );
  c1.appendChild(stackedBarChart("Daily artifact downloads by type", byType.dates, byType.series));

  // Chart 2 — version adoption: one line per release, not a chart per release.
  const byTag = summarizeCumulativeByTag(snapshots, MAX_ADOPTION_TAGS);
  const tagColors: Record<string, string> = {};
  byTag.series.forEach(function (s, i) {
    tagColors[s.tag] = PALETTE[i % PALETTE.length];
  });
  const c2 = section(
    root,
    "Version adoption — cumulative downloads per release",
    "One line per release (newest " +
      MAX_ADOPTION_TAGS +
      "). Total downloads across each " +
      "release's assets; watch newer releases climb and overtake older ones.",
  );
  legend(
    c2,
    byTag.series.map(function (s): LegendEntry {
      return { label: s.tag + " (" + s.latest.toLocaleString() + ")", color: tagColors[s.tag] };
    }),
  );
  c2.appendChild(
    lineChart(
      "Cumulative downloads per release",
      byTag.dates,
      byTag.series.map(function (s): LineSeries {
        return { color: tagColors[s.tag], points: s.points };
      }),
      function (p) {
        return p.value;
      },
    ),
  );

  // Chart 3 — npm daily downloads with a 7-day trailing average.
  const npm = buildNpmSeries(snapshots);
  const npmAvg = rollingAverage(
    npm.map(function (n) {
      return n.downloads;
    }),
    NPM_AVERAGE_WINDOW,
  );
  const c3 = section(
    root,
    "npm — @kaeawc/auto-mobile daily downloads",
    "True daily counts from the npm registry (own axis — npm dwarfs asset counts). " +
      "The line is a " +
      NPM_AVERAGE_WINDOW +
      "-day trailing average.",
  );
  legend(c3, [
    { label: "Daily downloads", color: "#59a14f" },
    { label: NPM_AVERAGE_WINDOW + "-day average", color: "#e15759" },
  ]);
  c3.appendChild(
    barsWithAverage(
      "npm @kaeawc/auto-mobile daily downloads with average",
      npm.map(function (n) {
        return n.day;
      }),
      npm.map(function (n) {
        return n.downloads;
      }),
      npmAvg,
      "#59a14f",
      "#e15759",
    ),
  );
}

function run(): void {
  const root = document.getElementById("dl-metrics");
  if (!root) {
    return;
  }
  // Bound the fetch with an AbortController so a stalled GitHub response can't
  // leave the page stuck on "Loading…"; clear the timer once it settles.
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, 15000);
  fetch(DATA_URL, { cache: "no-store", signal: controller.signal })
    .then(function (r) {
      if (!r.ok) {
        throw new Error("HTTP " + r.status);
      }
      return r.text();
    })
    .then(function (text) {
      render(root, parseJsonl(text));
    })
    .catch(function (err) {
      const reason =
        err && err.name === "AbortError" ? "request timed out" : String(err.message || err);
      root.innerHTML =
        '<p class="dl-error">Could not load download metrics from GitHub (' +
        reason +
        "). The data file is committed on main at " +
        "docs/metrics/data/downloads.jsonl.</p>";
    })
    .finally(function () {
      clearTimeout(timer);
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}
