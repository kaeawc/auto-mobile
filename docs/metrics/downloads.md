# Release Downloads

Daily download counts for every AutoMobile release — GitHub release assets (APK, IPA, video jar,
desktop `deb`/`dmg`/`msi`, screen-capture helper) **and** the npm package.

The data is snapshotted daily by the
[`release-downloads-metrics`](https://github.com/kaeawc/auto-mobile/blob/main/.github/workflows/release-downloads-metrics.yml)
workflow into
[`docs/metrics/data/downloads.jsonl`](https://github.com/kaeawc/auto-mobile/blob/main/docs/metrics/data/downloads.jsonl)
on `main`, and this page fetches that file live at view time — so it is always current regardless of
when the docs site was last rebuilt. The three charts below are all re-derived from that one raw
snapshot file at view time, so adding, changing, or re-slicing a chart never requires migrating data.

!!! note "How the daily numbers are derived"
    GitHub's API reports only the **cumulative** `download_count` per asset — there is no per-day
    history. Daily figures are recovered by snapshotting the cumulative count each day and diffing
    consecutive snapshots. **History before the first snapshot is unrecoverable**: the first run
    seeds day-0 with each release's current cumulative total, and true daily deltas begin the day
    *after* the first snapshot. A day whose delta is unknowable — the day-0 seed, a missing
    intermediate snapshot, or a counter reset (asset re-published) — is never invented as a zero;
    it is excluded from the daily total and the affected stacked segment is drawn faded, so the bar
    reads as an honest lower bound. npm is different — its API returns true daily counts directly, so
    its chart is exact from the start. npm daily totals include *all* package downloads (CI, mirrors)
    and dwarf the asset counts, so npm is charted in its own section on its own axis.

<div id="dl-metrics" markdown="0">
  <p id="dl-status">Loading download metrics…</p>
</div>

<style>
  #dl-metrics .dl-section { margin: 1.2rem 0 2rem; }
  #dl-metrics h3 { margin-bottom: 0.2rem; }
  #dl-metrics .dl-sub { font-size: 0.85rem; opacity: 0.75; margin-top: 0; }
  #dl-metrics svg { width: 100%; height: auto; max-width: 100%; overflow: visible; }
  #dl-metrics .dl-legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.8rem; margin: 0.3rem 0 0.6rem; }
  #dl-metrics .dl-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
  #dl-metrics .dl-swatch { width: 0.8rem; height: 0.8rem; border-radius: 2px; display: inline-block; }
  #dl-metrics .dl-error { color: #c0392b; font-weight: 600; }
  #dl-metrics .dl-chart-line { fill: none; stroke-width: 2; }
  #dl-metrics .dl-axis { stroke: currentColor; opacity: 0.35; stroke-width: 1; }
  #dl-metrics .dl-tick-text { font-size: 10px; fill: currentColor; opacity: 0.7; }
  #dl-metrics .dl-bar { opacity: 0.9; }
</style>

<script>
(function () {
  "use strict";

  var DATA_URL =
    "https://raw.githubusercontent.com/kaeawc/auto-mobile/main/docs/metrics/data/downloads.jsonl";
  var SVG_NS = "http://www.w3.org/2000/svg";
  // A colorblind-friendly qualitative palette, readable on both themes.
  var PALETTE = [
    "#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1",
    "#76b7b2", "#edc948", "#ff9da7", "#9c755f", "#bab0ac"
  ];

  // Asset families for the headline "downloads by type" chart. Order is the
  // bottom-to-top stacking order and the legend order. Colors are fixed per
  // family (not palette-indexed) so a family keeps its color as releases come
  // and go. Mirrors src/metrics/downloadSnapshots.ts (unit-tested there); this
  // copy is standalone because the page's script is fetched on its own.
  var ASSET_TYPE_ORDER = [
    "android-apk", "ios-ipa", "desktop-installer", "video-jar",
    "screen-capture-helper", "other"
  ];
  var ASSET_TYPE_LABELS = {
    "android-apk": "Android APK",
    "ios-ipa": "iOS IPA",
    "desktop-installer": "Desktop installers",
    "video-jar": "Video jar",
    "screen-capture-helper": "Screen-capture helper",
    "other": "Other"
  };
  var ASSET_TYPE_COLORS = {
    "android-apk": "#4e79a7",
    "ios-ipa": "#f28e2b",
    "desktop-installer": "#b07aa1",
    "video-jar": "#76b7b2",
    "screen-capture-helper": "#9c755f",
    "other": "#bab0ac"
  };
  var MAX_ADOPTION_TAGS = 8;
  var NPM_AVERAGE_WINDOW = 7;

  function el(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); }); }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function endsWith(str, suffix) {
    return str.slice(str.length - suffix.length) === suffix;
  }

  function parseJsonl(text) {
    return text.split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; })
      .map(function (l) { return JSON.parse(l); });
  }

  // assetKey -> stable identity across snapshots.
  function key(tag, asset) { return tag + " · " + asset; }

  // Compare release tags newest-first by numeric version segments, so 0.0.100
  // sorts ahead of 0.0.47 (a lexical compare would invert them). Non-numeric
  // pre-release labels fall back to a reversed string compare.
  function cmpTagDesc(a, b) {
    var pa = String(a).replace(/^v/, "").split(/[.\-+]/);
    var pb = String(b).replace(/^v/, "").split(/[.\-+]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
      if (!isNaN(na) && !isNaN(nb)) {
        if (na !== nb) { return nb - na; }
      } else {
        var sa = pa[i] || "", sb = pb[i] || "";
        if (sa !== sb) { return sa < sb ? 1 : -1; }
      }
    }
    return 0;
  }

  // Map an asset file name to its family (see src/metrics/downloadSnapshots.ts).
  function classifyAssetType(asset) {
    var name = String(asset).toLowerCase();
    if (endsWith(name, ".apk")) { return "android-apk"; }
    if (endsWith(name, ".ipa")) { return "ios-ipa"; }
    if (endsWith(name, ".deb") || endsWith(name, ".dmg") || endsWith(name, ".msi")) {
      return "desktop-installer";
    }
    if (endsWith(name, ".jar")) { return "video-jar"; }
    if (name.indexOf("screen-capture-helper") === 0 || endsWith(name, ".zip")) {
      return "screen-capture-helper";
    }
    return "other";
  }

  // Whole-day difference between two YYYY-MM-DD UTC dates (later - earlier).
  function utcDayDifference(earlier, later) {
    var MS_PER_DAY = 24 * 60 * 60 * 1000;
    return Math.round(
      (Date.parse(later + "T00:00:00.000Z") - Date.parse(earlier + "T00:00:00.000Z")) / MS_PER_DAY
    );
  }

  // Build cumulative series and daily-delta series per asset from all snapshots.
  function buildAssetSeries(snapshots) {
    var ordered = snapshots.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var dates = ordered.map(function (s) { return s.date; });
    var series = {}; // key -> { tag, asset, cumulative: [{date,value}], delta: [{date,value|null}] }
    var last = {}; // key -> { cumulative, date }
    ordered.forEach(function (snap) {
      (snap.github || []).forEach(function (g) {
        var k = key(g.tag, g.asset);
        if (!series[k]) { series[k] = { tag: g.tag, asset: g.asset, cumulative: [], delta: [] }; }
        var prior = last[k];
        // Only a prior observation on the immediately preceding calendar day
        // yields a real daily delta; a gap (missing intermediate snapshot) is
        // unknowable and rendered as null. A cumulative DECREASE (asset
        // re-published / counter reset) is likewise unknowable, so it is null
        // rather than a false 0. A CHANGED GitHub asset id (asset deleted and
        // re-uploaded under the same tag+filename gets a new id) means the two
        // cumulative counts belong to different counters, so it is null too —
        // even when the value did not decrease.
        var delta;
        if (prior === undefined || utcDayDifference(prior.date, snap.date) !== 1) {
          delta = null;
        } else if (prior.id != null && g.id != null && prior.id !== g.id) {
          delta = null;
        } else {
          var change = g.cumulative - prior.cumulative;
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
  function summarizeDailyByType(built) {
    var dates = built.dates;
    var indexByDate = {};
    dates.forEach(function (d, i) { indexByDate[d] = i; });
    var acc = {}; // type -> array aligned to dates of { downloads, partial, observed }
    ASSET_TYPE_ORDER.forEach(function (t) {
      acc[t] = dates.map(function () { return { downloads: 0, partial: false, observed: false }; });
    });
    Object.keys(built.series).forEach(function (k) {
      var s = built.series[k];
      var type = classifyAssetType(s.asset);
      s.delta.forEach(function (p) {
        var cell = acc[type][indexByDate[p.date]];
        cell.observed = true;
        if (p.value == null) { cell.partial = true; } else { cell.downloads += p.value; }
      });
    });
    var out = [];
    ASSET_TYPE_ORDER.forEach(function (t) {
      var pts = acc[t];
      var observed = false, total = 0;
      pts.forEach(function (p) { if (p.observed) { observed = true; } total += p.downloads; });
      if (!observed) { return; }
      out.push({
        type: t, label: ASSET_TYPE_LABELS[t], color: ASSET_TYPE_COLORS[t],
        points: pts, total: total
      });
    });
    return { dates: dates, series: out };
  }

  // One line per release tag: total cumulative across the tag's assets. A tag
  // absent from a snapshot gets a null point so the line breaks rather than
  // dropping to zero. Newest releases first, capped to maxTags.
  function summarizeCumulativeByTag(snapshots, maxTags) {
    var ordered = snapshots.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var dates = ordered.map(function (s) { return s.date; });
    var acc = {}; // tag -> { date -> sum }
    ordered.forEach(function (snap) {
      (snap.github || []).forEach(function (g) {
        if (!acc[g.tag]) { acc[g.tag] = {}; }
        acc[g.tag][snap.date] = (acc[g.tag][snap.date] || 0) + g.cumulative;
      });
    });
    var tags = Object.keys(acc).sort(cmpTagDesc);
    if (maxTags && tags.length > maxTags) { tags = tags.slice(0, maxTags); }
    var series = tags.map(function (tag) {
      var byDate = acc[tag];
      var latest = 0;
      var points = dates.map(function (d) {
        var has = Object.prototype.hasOwnProperty.call(byDate, d);
        var value = has ? byDate[d] : null;
        if (value !== null) { latest = value; }
        return { date: d, value: value };
      });
      return { tag: tag, points: points, latest: latest };
    });
    return { dates: dates, series: series };
  }

  // Trailing simple moving average, min-periods 1 (see downloadSnapshots.ts).
  function rollingAverage(values, window) {
    var size = Math.max(1, Math.floor(window));
    var out = [], q = [], sum = 0;
    values.forEach(function (v) {
      q.push(v); sum += v;
      if (q.length > size) { sum -= q.shift(); }
      out.push(sum / q.length);
    });
    return out;
  }

  // Merge npm arrays across snapshots, latest snapshot wins per day.
  function buildNpmSeries(snapshots) {
    var byDay = {};
    snapshots.forEach(function (snap) {
      (snap.npm || []).forEach(function (n) { byDay[n.day] = n.downloads; });
    });
    return Object.keys(byDay).sort().map(function (day) {
      return { day: day, downloads: byDay[day] };
    });
  }

  function legend(container, entries) {
    var box = document.createElement("div");
    box.className = "dl-legend";
    entries.forEach(function (e) {
      var span = document.createElement("span");
      var sw = document.createElement("span");
      sw.className = "dl-swatch";
      sw.style.background = e.color;
      span.appendChild(sw);
      span.appendChild(document.createTextNode(e.label));
      box.appendChild(span);
    });
    container.appendChild(box);
  }

  var W = 720, H = 260, ML = 48, MR = 12, MT = 12, MB = 28;

  function scaleX(i, n) {
    if (n <= 1) { return ML + (W - ML - MR) / 2; }
    return ML + (i * (W - ML - MR)) / (n - 1);
  }
  function scaleY(v, max) {
    if (max <= 0) { return H - MB; }
    return MT + (1 - v / max) * (H - MT - MB);
  }

  function axes(svg, max, labels) {
    svg.appendChild(el("line", { x1: ML, y1: MT, x2: ML, y2: H - MB, class: "dl-axis" }));
    svg.appendChild(el("line", { x1: ML, y1: H - MB, x2: W - MR, y2: H - MB, class: "dl-axis" }));
    [0, 0.5, 1].forEach(function (f) {
      var v = Math.round(max * f);
      var y = scaleY(v, max);
      svg.appendChild(el("text", { x: ML - 6, y: y + 3, "text-anchor": "end", class: "dl-tick-text" }, String(v)));
    });
    var step = Math.max(1, Math.ceil(labels.length / 6));
    labels.forEach(function (d, i) {
      if (i % step !== 0 && i !== labels.length - 1) { return; }
      var x = scaleX(i, labels.length);
      svg.appendChild(el("text", { x: x, y: H - MB + 14, "text-anchor": "middle", class: "dl-tick-text" }, String(d).slice(5)));
    });
  }

  function lineChart(title, dates, seriesList, valueFor) {
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
    svg.appendChild(el("title", {}, title));
    // Position each point by its snapshot date's index in the GLOBAL date axis,
    // not its index within one asset's (possibly sparse) series — a release that
    // first appears in a later snapshot must plot at the correct right-hand x.
    var indexByDate = {};
    dates.forEach(function (d, i) { indexByDate[d] = i; });
    var max = 1;
    seriesList.forEach(function (s) {
      s.points.forEach(function (p) { if (valueFor(p) != null && valueFor(p) > max) { max = valueFor(p); } });
    });
    axes(svg, max, dates);
    seriesList.forEach(function (s) {
      var d = "";
      var penUp = true; // start a fresh subpath after any gap (null value)
      var prevDate = null; // last plotted point's snapshot date
      s.points.forEach(function (p) {
        var v = valueFor(p);
        if (v == null) { penUp = true; return; }
        // Lift the pen across absent observations by comparing CALENDAR days, not
        // array indexes: `dates` holds only recorded snapshots, so a fully-missing
        // day (no snapshot at all) leaves adjacent indexes; only utcDayDifference
        // detects it. More than one day between plotted points is a gap → break.
        if (prevDate !== null && utcDayDifference(prevDate, p.date) > 1) { penUp = true; }
        var x = scaleX(indexByDate[p.date], dates.length);
        var y = scaleY(v, max);
        d += (penUp ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
        penUp = false;
        prevDate = p.date;
        svg.appendChild(el("circle", { cx: x, cy: y, r: 2.5, fill: s.color }));
      });
      if (d) { svg.appendChild(el("path", { d: d, class: "dl-chart-line", stroke: s.color })); }
    });
    return svg;
  }

  // Stacked daily bars: one bar per date, segments stacked in seriesList order.
  // A segment whose day is `partial` (some contributing delta unknown) is drawn
  // faded with a dashed outline, signalling the value is a lower bound.
  function stackedBarChart(title, dates, seriesList) {
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
    svg.appendChild(el("title", {}, title));
    var n = dates.length;
    var max = 1;
    for (var i = 0; i < n; i++) {
      var sum = 0;
      seriesList.forEach(function (s) { sum += s.points[i].downloads; });
      if (sum > max) { max = sum; }
    }
    axes(svg, max, dates);
    var bw = Math.max(1, (W - ML - MR) / Math.max(1, n) * 0.7);
    for (var j = 0; j < n; j++) {
      var yBase = H - MB;
      var x = scaleX(j, n) - bw / 2;
      // Capture j for the forEach closure.
      (function (idx, baseX) {
        seriesList.forEach(function (s) {
          var pt = s.points[idx];
          if (pt.downloads <= 0) { return; }
          var h = (pt.downloads / max) * (H - MT - MB);
          var y = yBase - h;
          var attrs = { x: baseX, y: y, width: bw, height: h, fill: s.color, class: "dl-bar" };
          if (pt.partial) {
            attrs["fill-opacity"] = "0.4";
            attrs.stroke = s.color;
            attrs["stroke-dasharray"] = "2 2";
          }
          svg.appendChild(el("rect", attrs));
          yBase = y;
        });
      })(j, x);
    }
    return svg;
  }

  // npm daily bars with a rolling-average line overlaid on the same axis.
  function barsWithAverage(title, labels, values, average, barColor, lineColor) {
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
    svg.appendChild(el("title", {}, title));
    var max = 1;
    values.forEach(function (v) { if (v > max) { max = v; } });
    average.forEach(function (v) { if (v > max) { max = v; } });
    axes(svg, max, labels);
    var n = values.length;
    var bw = Math.max(1, (W - ML - MR) / Math.max(1, n) * 0.7);
    values.forEach(function (v, i) {
      var x = scaleX(i, n) - bw / 2;
      var y = scaleY(v, max);
      svg.appendChild(el("rect", { x: x, y: y, width: bw, height: (H - MB - y), fill: barColor, class: "dl-bar" }));
    });
    var d = "";
    average.forEach(function (v, i) {
      d += (i === 0 ? "M" : "L") + scaleX(i, n).toFixed(1) + " " + scaleY(v, max).toFixed(1) + " ";
    });
    if (d) { svg.appendChild(el("path", { d: d, class: "dl-chart-line", stroke: lineColor })); }
    return svg;
  }

  function section(root, title, subtitle) {
    var wrap = document.createElement("div");
    wrap.className = "dl-section";
    var h = document.createElement("h3");
    h.textContent = title;
    wrap.appendChild(h);
    if (subtitle) {
      var p = document.createElement("p");
      p.className = "dl-sub";
      p.textContent = subtitle;
      wrap.appendChild(p);
    }
    root.appendChild(wrap);
    return wrap;
  }

  function render(root, snapshots) {
    root.innerHTML = "";
    if (!snapshots.length) {
      root.innerHTML = '<p class="dl-error">No snapshot data available yet.</p>';
      return;
    }
    var latest = snapshots[snapshots.length - 1].date;
    var intro = document.createElement("p");
    intro.className = "dl-sub";
    intro.textContent = "Latest snapshot: " + latest + " · " + snapshots.length + " day(s) of history.";
    root.appendChild(intro);

    var built = buildAssetSeries(snapshots);

    // Chart 1 — the headline: total artifact downloads over time, by asset type,
    // with the per-release dimension collapsed away.
    var byType = summarizeDailyByType(built);
    var c1 = section(root, "Artifact downloads over time",
      "Daily GitHub-asset downloads across all releases, stacked by artifact type. Faded, dashed " +
      "segments are partial (a day-0 seed, a snapshot gap, or a counter reset left some counts " +
      "unknown) — read them as a lower bound.");
    legend(c1, byType.series.map(function (s) {
      return { label: s.label + " (" + s.total.toLocaleString() + ")", color: s.color };
    }));
    c1.appendChild(stackedBarChart("Daily artifact downloads by type", byType.dates, byType.series));

    // Chart 2 — version adoption: one line per release, not a chart per release.
    var byTag = summarizeCumulativeByTag(snapshots, MAX_ADOPTION_TAGS);
    var tagColors = {};
    byTag.series.forEach(function (s, i) { tagColors[s.tag] = PALETTE[i % PALETTE.length]; });
    var c2 = section(root, "Version adoption — cumulative downloads per release",
      "One line per release (newest " + MAX_ADOPTION_TAGS + "). Total downloads across each " +
      "release's assets; watch newer releases climb and overtake older ones.");
    legend(c2, byTag.series.map(function (s) {
      return { label: s.tag + " (" + s.latest.toLocaleString() + ")", color: tagColors[s.tag] };
    }));
    c2.appendChild(lineChart("Cumulative downloads per release", byTag.dates,
      byTag.series.map(function (s) { return { color: tagColors[s.tag], points: s.points }; }),
      function (p) { return p.value; }));

    // Chart 3 — npm daily downloads with a 7-day trailing average.
    var npm = buildNpmSeries(snapshots);
    var npmAvg = rollingAverage(npm.map(function (n) { return n.downloads; }), NPM_AVERAGE_WINDOW);
    var c3 = section(root, "npm — @kaeawc/auto-mobile daily downloads",
      "True daily counts from the npm registry (own axis — npm dwarfs asset counts). " +
      "The line is a " + NPM_AVERAGE_WINDOW + "-day trailing average.");
    legend(c3, [
      { label: "Daily downloads", color: "#59a14f" },
      { label: NPM_AVERAGE_WINDOW + "-day average", color: "#e15759" }
    ]);
    c3.appendChild(barsWithAverage("npm @kaeawc/auto-mobile daily downloads with average",
      npm.map(function (n) { return n.day; }),
      npm.map(function (n) { return n.downloads; }),
      npmAvg, "#59a14f", "#e15759"));
  }

  function run() {
    var root = document.getElementById("dl-metrics");
    if (!root) { return; }
    // Bound the fetch with an AbortController so a stalled GitHub response can't
    // leave the page stuck on "Loading…"; clear the timer once it settles.
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    fetch(DATA_URL, { cache: "no-store", signal: controller.signal })
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.text();
      })
      .then(function (text) { render(root, parseJsonl(text)); })
      .catch(function (err) {
        var reason = err && err.name === "AbortError" ? "request timed out" : String(err.message || err);
        root.innerHTML = '<p class="dl-error">Could not load download metrics from GitHub (' +
          reason + '). The data file is committed on main at ' +
          'docs/metrics/data/downloads.jsonl.</p>';
      })
      .finally(function () { clearTimeout(timer); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
</script>
