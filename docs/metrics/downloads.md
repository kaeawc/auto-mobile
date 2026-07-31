# Release Downloads

Daily download counts for every AutoMobile release — GitHub release assets (APK, IPA, video jar,
screen-capture helper, desktop `deb`/`dmg`/`msi`) **and** the npm package.

The data is snapshotted daily by the
[`release-downloads-metrics`](https://github.com/kaeawc/auto-mobile/blob/main/.github/workflows/release-downloads-metrics.yml)
workflow into
[`docs/metrics/data/downloads.jsonl`](https://github.com/kaeawc/auto-mobile/blob/main/docs/metrics/data/downloads.jsonl)
on `main`, and this page fetches that file live at view time — so it is always current regardless of
when the docs site was last rebuilt.

!!! note "How the daily numbers are derived"
    GitHub's API reports only the **cumulative** `download_count` per asset — there is no per-day
    history. Daily figures are recovered by snapshotting the cumulative count each day and diffing
    consecutive snapshots. **History before the first snapshot is unrecoverable**: the first run
    seeds day-0 with each release's current cumulative total, and true daily deltas begin the day
    *after* the first snapshot. npm is different — its API returns true daily counts directly, so its
    chart is exact from the start. npm daily totals include *all* package downloads (CI, mirrors) and
    dwarf the asset counts, so npm is charted in its own section on its own axis.

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
  #dl-metrics .dl-bar { opacity: 0.85; }
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

  function el(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); }); }
    if (text != null) { node.textContent = text; }
    return node;
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

  function axes(svg, max, dates) {
    svg.appendChild(el("line", { x1: ML, y1: MT, x2: ML, y2: H - MB, class: "dl-axis" }));
    svg.appendChild(el("line", { x1: ML, y1: H - MB, x2: W - MR, y2: H - MB, class: "dl-axis" }));
    [0, 0.5, 1].forEach(function (f) {
      var v = Math.round(max * f);
      var y = scaleY(v, max);
      svg.appendChild(el("text", { x: ML - 6, y: y + 3, "text-anchor": "end", class: "dl-tick-text" }, String(v)));
    });
    var step = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach(function (d, i) {
      if (i % step !== 0 && i !== dates.length - 1) { return; }
      var x = scaleX(i, dates.length);
      svg.appendChild(el("text", { x: x, y: H - MB + 14, "text-anchor": "middle", class: "dl-tick-text" }, d.slice(5)));
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

  function barChart(title, labels, values, color) {
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
    svg.appendChild(el("title", {}, title));
    var max = 1;
    values.forEach(function (v) { if (v > max) { max = v; } });
    axes(svg, max, labels);
    var n = values.length;
    var bw = Math.max(1, (W - ML - MR) / Math.max(1, n) * 0.7);
    values.forEach(function (v, i) {
      var x = scaleX(i, n) - bw / 2;
      var y = scaleY(v, max);
      svg.appendChild(el("rect", { x: x, y: y, width: bw, height: (H - MB - y), fill: color, class: "dl-bar" }));
    });
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
    var keys = Object.keys(built.series).sort();
    var colorFor = {};
    keys.forEach(function (k, i) { colorFor[k] = PALETTE[i % PALETTE.length]; });

    // Group by release tag.
    var tags = [];
    keys.forEach(function (k) { var t = built.series[k].tag; if (tags.indexOf(t) < 0) { tags.push(t); } });
    tags.sort(cmpTagDesc); // newest release first, version-aware (0.0.100 > 0.0.47)

    tags.forEach(function (tag) {
      var tagKeys = keys.filter(function (k) { return built.series[k].tag === tag; });
      var legendEntries = tagKeys.map(function (k) {
        return { label: built.series[k].asset, color: colorFor[k] };
      });

      var cumWrap = section(root, "Release " + tag + " — cumulative downloads", null);
      legend(cumWrap, legendEntries);
      cumWrap.appendChild(lineChart("Release " + tag + " cumulative downloads per asset",
        built.dates, tagKeys.map(function (k) {
          return { color: colorFor[k], points: built.series[k].cumulative };
        }), function (p) { return p.value; }));

      var deltaWrap = section(root, "Release " + tag + " — daily downloads", "First snapshot is a day-0 seed (no delta shown).");
      legend(deltaWrap, legendEntries);
      deltaWrap.appendChild(lineChart("Release " + tag + " daily downloads per asset",
        built.dates, tagKeys.map(function (k) {
          return { color: colorFor[k], points: built.series[k].delta };
        }), function (p) { return p.value; }));
    });

    var npm = buildNpmSeries(snapshots);
    var npmWrap = section(root, "npm — @kaeawc/auto-mobile daily downloads",
      "True daily counts from the npm registry (own axis — npm dwarfs asset counts).");
    npmWrap.appendChild(barChart(
      "npm @kaeawc/auto-mobile daily downloads",
      npm.map(function (n) { return n.day; }),
      npm.map(function (n) { return n.downloads; }),
      "#59a14f"
    ));
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
