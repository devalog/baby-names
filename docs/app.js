"use strict";

const STATE_NAMES = {
  AK: "Alaska", AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CA: "California", CO: "Colorado",
  CT: "Connecticut", DC: "District of Columbia", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", IA: "Iowa", ID: "Idaho", IL: "Illinois", IN: "Indiana", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", MA: "Massachusetts", MD: "Maryland", ME: "Maine",
  MI: "Michigan", MN: "Minnesota", MO: "Missouri", MS: "Mississippi", MT: "Montana",
  NC: "North Carolina", ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NV: "Nevada", NY: "New York", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VA: "Virginia", VT: "Vermont", WA: "Washington",
  WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming",
};
const SEX_WORD = { F: "girls", M: "boys" };
const MAX_SERIES = 8;
const LIST_PREVIEW = 6;
const METRIC_LABEL = { rank: "Rank", count: "Births", per1k: "Per 1,000 births" };

const $ = (sel) => document.querySelector(sel);
const app = {
  meta: null,
  shards: new Map(),     // shard key -> Promise<object>
  main: null,            // entry for the searched name
  alts: [],              // entries for the searched name's other spellings
  extra: [],             // entries checked in the sidebar
  expanded: new Set(),   // sidebar lists showing every name
  colors: new Map(),     // series key -> color slot (stable while the search lasts)
  charts: [],
  sortCol: 0,
  sortDir: 1,
};

// ---------- data ----------

function loadShard(name) {
  const key = name.toLowerCase().slice(0, app.meta.shardLen);
  if (!app.shards.has(key)) {
    app.shards.set(key, fetch(`data/names/${encodeURIComponent(key)}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})));
  }
  return app.shards.get(key);
}

async function lookup(name) {
  const shard = await loadShard(name);
  return shard[name.toLowerCase()] || null;
}

function at(series, year) {
  if (!series) return null;
  const i = year - series.y0;
  if (i < 0 || i >= series.c.length || !series.c[i]) return null;
  return { count: series.c[i], rank: series.r[i] };
}

function totalAt(place, sex, year) {
  const t = place === "US" ? app.meta.totals.nat[sex] : app.meta.totals.st[place]?.[sex];
  if (!t) return null;
  return t.t[year - t.y0] || null;
}

function placeSeries(entry, sex, place) {
  const s = entry[sex];
  if (!s) return null;
  return place === "US" ? s.nat : s.st?.[place];
}

// Count distributions: how many names had each count, per place/sex/year.
// Used to rank a combined count against every other name.
const distFiles = new Map();  // "place/CA" or "year/2025" -> Promise<object>
const distCache = new Map();  // "CA|F|2025" -> { vals, above }

function loadDistFile(path) {
  if (!distFiles.has(path)) {
    const p = fetch(`data/dist/${path}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    p.then((obj) => { p.value = obj; });
    distFiles.set(path, p);
  }
  return distFiles.get(path);
}

function distFor(place, sex, year) {
  const key = `${place}|${sex}|${year}`;
  if (distCache.has(key)) return distCache.get(key);
  const enc = distFiles.get(`place/${place}`)?.value?.[`${sex}${year}`]
    || distFiles.get(`year/${year}`)?.value?.[`${place}${sex}`];
  if (!enc) return null;
  const [deltas, howMany] = enc;
  const vals = [], above = [];
  let v = 0, n = 0;
  deltas.forEach((d, i) => {
    v = i === 0 ? d : v - d;
    vals.push(v);
    above.push(n);         // names with a count strictly higher than vals[i]
    n += howMany[i];
  });
  const dist = { vals, above, total: n };
  distCache.set(key, dist);
  return dist;
}

function rankOfCount(dist, count) {
  // vals is high to low; find the first value <= count.
  let lo = 0, hi = dist.vals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist.vals[mid] > count) lo = mid + 1;
    else hi = mid;
  }
  return (lo < dist.vals.length ? dist.above[lo] : dist.total) + 1;
}

async function ensureDists(o, series) {
  if (!series.some((s) => s.combined)) return;
  const tableYear = parseInt($("#table-year").value, 10) || o.to;
  const loads = ["US", ...o.states].map((p) => loadDistFile(`place/${p}`));
  for (const y of new Set([o.to, tableYear])) loads.push(loadDistFile(`year/${y}`));
  await Promise.all(loads);
}

// One series' count and rank at a place and year. Combined series add up their
// members' counts and rank the total against every other name.
function seriesAt(s, place, year) {
  if (!s.combined) return at(placeSeries(s.entry, s.sex, place), year);
  let count = 0;
  for (const e of s.members) {
    const v = at(placeSeries(e, s.sex, place), year);
    if (v) count += v.count;
  }
  if (!count) return null;
  const dist = distFor(place, s.sex, year);
  return { count, rank: dist ? rankOfCount(dist, count) : null };
}

function seriesValue(s, place, year, metric) {
  const v = seriesAt(s, place, year);
  if (!v) return null;
  if (metric === "rank") return v.rank;
  if (metric === "count") return v.count;
  const total = totalAt(place, s.sex, year);
  return total ? (v.count / total) * 1000 : null;
}

// ---------- options ----------

function opts() {
  const [minY, maxY] = app.meta.years;
  let from = clamp(parseInt($("#from").value, 10) || minY, minY, maxY);
  let to = clamp(parseInt($("#to").value, 10) || maxY, minY, maxY);
  if (from > to) [from, to] = [to, from];
  return {
    sex: document.querySelector("input[name=sex]:checked").value,
    metric: document.querySelector("input[name=metric]:checked").value,
    from, to,
    nat: $("#nat").checked,
    states: [...document.querySelectorAll("#states input:checked")].map((i) => i.value),
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function seriesList(o) {
  const sexes = o.sex === "B" ? ["F", "M"] : [o.sex];
  const list = [];
  for (const entry of [app.main, ...app.extra]) {
    for (const sex of sexes) {
      if (!entry[sex]) continue;
      const key = `${entry.n}|${sex}`;
      if (!app.colors.has(key)) {
        const used = new Set(app.colors.values());
        const free = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => !used.has(s));
        if (!free) continue;
        app.colors.set(key, free);
      }
      list.push({
        key, entry, sex,
        label: o.sex === "B" ? `${entry.n} (${SEX_WORD[sex]})` : entry.n,
        color: cssVar(`--s${app.colors.get(key)}`),
      });
    }
  }
  const names = list.slice(0, MAX_SERIES);

  // A dashed "combined" line per sex once at least two spellings are on the chart.
  const combined = [];
  for (const sex of sexes) {
    const members = names.filter((s) => s.sex === sex).map((s) => s.entry);
    if (members.length < 2) continue;
    const joined = members.length <= 3
      ? members.map((e) => e.n).join(" + ")
      : `${members[0].n} + ${members.length - 1} spellings`;
    combined.push({
      key: `combined|${sex}`, combined: true, members, sex,
      label: o.sex === "B" ? `${joined} (${SEX_WORD[sex]})` : joined,
      color: cssVar("--text-2"),
    });
  }

  // Always-on dotted line: the searched name plus every other spelling of it.
  for (const sex of sexes) {
    const members = [app.main, ...app.alts].filter((e) => e[sex]);
    if (members.length < 2 || !app.main[sex]) continue;
    const label = `${app.main.n} + all spellings`;
    combined.push({
      key: `all|${sex}`, combined: true, allSpellings: true, members, sex,
      label: o.sex === "B" ? `${label} (${SEX_WORD[sex]})` : label,
      color: cssVar("--muted"),
    });
  }
  return [...names, ...combined];
}

function freeUnusedColors(o) {
  // Release colors for names that were unchecked, so new picks can reuse them.
  const live = new Set();
  for (const e of [app.main, ...app.extra]) for (const s of ["F", "M"]) live.add(`${e.n}|${s}`);
  for (const k of [...app.colors.keys()]) if (!live.has(k)) app.colors.delete(k);
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- rendering ----------

const fmt = new Intl.NumberFormat("en-US");
function fmtValue(v, metric) {
  if (v == null) return "–";
  if (metric === "rank") return `#${fmt.format(v)}`;
  if (metric === "count") return fmt.format(v);
  return v < 0.1 ? v.toFixed(3) : v.toFixed(2);
}

let renderToken = 0;
async function render() {
  if (!app.main) return;
  const token = ++renderToken;
  const o = opts();
  freeUnusedColors(o);
  const series = seriesList(o);
  await ensureDists(o, series);
  if (token !== renderToken) return;
  $("#result-name").textContent = app.main.n;
  renderSummary(o, series);
  renderSimilar(o);
  renderCharts(o, series);
  renderTable(o, series);
  renderMap(o, series);
  writeHash(o);
}

function topStates(s, year, n = 3) {
  const rows = [];
  for (const st of app.meta.states) {
    const v = seriesAt(s, st, year);
    if (!v || v.rank == null) continue;
    const total = totalAt(st, s.sex, year);
    rows.push({ st, rank: v.rank, share: total ? v.count / total : 0 });
  }
  rows.sort((a, b) => a.rank - b.rank || b.share - a.share);
  return rows.slice(0, n);
}

function renderSummary(o, series) {
  const table = $("#summary");
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const text of ["Name", `US rank ${o.to}`, `Best US rank ${o.from}–${o.to}`,
                      `US babies ${o.from}–${o.to}`, `Top states ${o.to}`]) {
    const th = document.createElement("th");
    th.textContent = text;
    head.append(th);
  }
  const body = table.createTBody();
  for (const s of series) {
    const nat = (y) => seriesAt(s, "US", y);
    const tr = body.insertRow();
    if (s.combined) tr.className = "combined";

    const name = tr.insertCell();
    name.className = "nm";
    name.append(seriesKey(s), s.label);

    const now = nat(o.to);
    cellWithNote(tr.insertCell(), now ? `#${fmt.format(now.rank)}` : "–",
      now ? `${fmt.format(now.count)} babies` : "under 5");

    let peak = null, total = 0;
    for (let y = o.from; y <= o.to; y++) {
      const v = nat(y);
      if (!v) continue;
      total += v.count;
      if (!peak || v.rank < peak.rank) peak = { ...v, year: y };
    }
    cellWithNote(tr.insertCell(), peak ? `#${fmt.format(peak.rank)}` : "–", peak ? `in ${peak.year}` : "");
    cellWithNote(tr.insertCell(), fmt.format(total), "");

    const top = tr.insertCell();
    top.className = "top";
    const best = o.to >= 1910 ? topStates(s, o.to) : [];
    if (!best.length) top.textContent = "–";
    for (const b of best) {
      const pill = Object.assign(document.createElement("span"), { className: "pill" });
      pill.title = STATE_NAMES[b.st];
      pill.append(b.st + " ");
      const r = Object.assign(document.createElement("span"), { className: "count", textContent: `#${fmt.format(b.rank)}` });
      pill.append(r);
      top.append(pill);
    }
  }
}

function seriesKey(s) {
  // Short line in the series color; dashed for a combined series, like its chart line.
  const key = document.createElement("span");
  key.className = "key";
  key.style.borderTop = `2px ${s.allSpellings ? "dotted" : s.combined ? "dashed" : "solid"} ${s.color}`;
  return key;
}

function cellWithNote(td, main, note) {
  td.append(Object.assign(document.createElement("span"), { className: "big", textContent: main }));
  if (note) td.append(Object.assign(document.createElement("span"), { className: "count", textContent: note }));
}

let similarToken = 0;
async function renderSimilar(o) {
  const ul = $("#similar");
  const token = ++similarToken;
  const sims = (await Promise.all((app.main.sim || []).map(lookup))).filter(Boolean);
  if (token !== similarToken) return;
  const checked = new Set(app.extra.map((e) => e.n));
  const atMax = seriesList(o).filter((s) => !s.combined).length >= MAX_SERIES;
  fillNameList($("#spellings"), app.alts, "No other spellings found.", checked, atMax, o);
  fillNameList(ul, sims, "No similar names found.", checked, atMax, o);
  $("#series-cap").hidden = !atMax;
}

function fillNameList(ul, entries, emptyText, checked, atMax, o) {
  if (!entries.length) {
    ul.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: emptyText }));
    return;
  }
  // Long lists show the first few (plus anything checked) until "Show all" is clicked.
  const expanded = app.expanded.has(ul.id);
  const shown = expanded || entries.length <= LIST_PREVIEW
    ? entries
    : entries.filter((e, i) => i < LIST_PREVIEW || checked.has(e.n));
  const items = shown.map((e) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked.has(e.n);
    box.disabled = !box.checked && atMax;
    box.addEventListener("change", () => {
      if (box.checked) app.extra.push(e);
      else app.extra = app.extra.filter((x) => x.n !== e.n);
      render();
    });
    const sw = document.createElement("span");
    sw.className = "swatch";
    const slot = app.colors.get(`${e.n}|F`) || app.colors.get(`${e.n}|M`);
    if (box.checked && slot) sw.style.background = cssVar(`--s${slot}`);
    const nm = Object.assign(document.createElement("span"), { className: "nm", textContent: e.n });
    const rk = Object.assign(document.createElement("span"), { className: "rk", textContent: latestRankText(e, o) });
    label.append(box, sw, nm, rk);
    li.append(label);
    return li;
  });
  if (entries.length > LIST_PREVIEW) {
    const li = document.createElement("li");
    const more = Object.assign(document.createElement("button"), {
      type: "button", className: "link",
      textContent: expanded ? "Show fewer" : `Show all ${entries.length}`,
    });
    more.addEventListener("click", () => {
      if (expanded) app.expanded.delete(ul.id);
      else app.expanded.add(ul.id);
      fillNameList(ul, entries, emptyText, checked, atMax, o);
    });
    li.append(more);
    items.push(li);
  }
  ul.replaceChildren(...items);
}

function latestRankText(e, o) {
  const sexes = o.sex === "B" ? ["F", "M"] : [o.sex];
  const parts = [];
  for (const s of sexes) {
    const v = at(e[s]?.nat, o.to);
    if (v) parts.push(`#${fmt.format(v.rank)}${o.sex === "B" ? " " + s : ""}`);
  }
  return parts.join(" · ") || "–";
}

function renderCharts(o, series) {
  for (const c of app.charts) c.destroy();
  app.charts = [];
  const box = $("#charts");
  box.replaceChildren();
  const places = [...(o.nat ? ["US"] : []), ...o.states];
  if (!places.length) {
    box.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Pick United States or a state above to see charts." }));
    return;
  }
  for (const place of places) {
    const card = document.createElement("div");
    card.className = "chart-card";
    const h = document.createElement("h3");
    h.textContent = `${place === "US" ? "United States" : STATE_NAMES[place] || place} · ${METRIC_LABEL[o.metric]}`;
    card.append(h);
    box.append(card);

    const from = place === "US" ? o.from : Math.max(o.from, 1910);
    const years = [];
    for (let y = from; y <= o.to; y++) years.push(y);
    const datasets = series.map((s) => ({
      label: s.label,
      data: years.map((y) => seriesValue(s, place, y, o.metric)),
      borderColor: s.color,
      borderDash: s.allSpellings ? [2, 3] : s.combined ? [6, 4] : [],
      backgroundColor: s.color,
    }));
    if (!datasets.some((d) => d.data.some((v) => v != null))) {
      card.append(Object.assign(document.createElement("p"), { className: "none",
        textContent: `No records here for ${from}–${o.to}. SSA only lists a name once at least 5 babies get it in a year.` }));
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${h.textContent} for ${series.map((s) => s.label).join(", ")}`);
    wrap.append(canvas);
    card.append(wrap);
    app.charts.push(makeChart(canvas, years, datasets, o.metric));
  }
}

const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--muted");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function makeChart(canvas, years, datasets, metric) {
  const text2 = cssVar("--text-2");
  const grid = cssVar("--grid");
  return new Chart(canvas, {
    type: "line",
    data: { labels: years, datasets },
    plugins: [crosshair],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spanGaps: false,
      interaction: { mode: "index", intersect: false },
      elements: {
        line: { borderWidth: 2, tension: 0 },
        point: { radius: 0, hoverRadius: 4, hitRadius: 12 },
      },
      scales: {
        x: {
          ticks: { color: text2, maxTicksLimit: 8, maxRotation: 0 },
          grid: { display: false },
          border: { color: grid },
        },
        y: {
          // Log scale for rank so #1 vs #12 is as visible as #1,000 vs #12,000.
          type: metric === "rank" ? "logarithmic" : "linear",
          reverse: metric === "rank",
          beginAtZero: metric !== "rank",
          min: metric === "rank" ? 1 : undefined,
          ticks: {
            color: text2,
            precision: metric === "per1k" ? undefined : 0,
            callback: (v) => {
              if (metric !== "rank") return fmt.format(v);
              const lead = v / 10 ** Math.floor(Math.log10(v));
              return [1, 2, 5].some((d) => Math.abs(lead - d) < 1e-9) ? `#${fmt.format(v)}` : null;
            },
          },
          grid: { color: grid },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: "bottom",
          labels: { color: text2, usePointStyle: true, pointStyle: "line", boxWidth: 18 },
        },
        tooltip: {
          backgroundColor: cssVar("--surface"),
          titleColor: cssVar("--text"),
          bodyColor: cssVar("--text"),
          borderColor: cssVar("--border"),
          borderWidth: 1,
          padding: 10,
          usePointStyle: true,
          callbacks: {
            label: (ctx) => ` ${fmtValue(ctx.raw, metric)}  ${ctx.dataset.label}`,
            labelPointStyle: () => ({ pointStyle: "line", rotation: 0 }),
          },
        },
      },
    },
  });
}

function renderTable(o, series) {
  const sel = $("#table-year");
  const first = Math.max(o.from, 1910);
  const current = parseInt(sel.value, 10);
  sel.replaceChildren();
  for (let y = o.to; y >= first; y--) sel.append(new Option(y, y));
  sel.value = current >= first && current <= o.to ? current : o.to;
  const year = parseInt(sel.value, 10);

  const table = $("#state-table");
  table.replaceChildren();
  if (o.to < 1910) {
    table.append(Object.assign(document.createElement("caption"), { textContent: "State data starts in 1910." }));
    return;
  }
  const thead = table.createTHead().insertRow();
  const headers = ["State", ...series.map((s) => s.label)];
  headers.forEach((text, i) => {
    const th = document.createElement("th");
    if (i > 0) th.append(seriesKey(series[i - 1]));
    th.append(text + (app.sortCol === i ? (app.sortDir > 0 ? " ↑" : " ↓") : ""));
    th.addEventListener("click", () => {
      app.sortDir = app.sortCol === i ? -app.sortDir : 1;
      app.sortCol = i;
      renderTable(opts(), seriesList(opts()));
    });
    thead.append(th);
  });

  const rows = app.meta.states.map((st) => ({
    st,
    vals: series.map((s) => seriesAt(s, st, year)),
  }));
  const col = Math.min(app.sortCol, series.length);
  rows.sort((a, b) => {
    if (col === 0) return a.st.localeCompare(b.st) * app.sortDir;
    const ra = a.vals[col - 1]?.rank, rb = b.vals[col - 1]?.rank;
    if (ra == null && rb == null) return a.st.localeCompare(b.st);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return (ra - rb) * app.sortDir;
  });

  const tbody = table.createTBody();
  const picked = new Set(o.states);
  for (const r of rows) {
    const tr = tbody.insertRow();
    if (picked.has(r.st)) tr.className = "picked";
    tr.insertCell().textContent = STATE_NAMES[r.st] || r.st;
    for (const v of r.vals) {
      const td = tr.insertCell();
      if (!v) { td.textContent = "–"; continue; }
      td.append(`#${fmt.format(v.rank)}`);
      const c = document.createElement("span");
      c.className = "count";
      c.textContent = `${fmt.format(v.count)} babies`;
      td.append(c);
    }
  }
}

// ---------- map ----------

// Continuous color: rank on a log scale from #1 (darkest) to MAP_MAX_RANK and beyond (lightest).
const MAP_MAX_RANK = 1000;
const MAP_TICKS = [1, 10, 100];
const MAP_MS_PER_YEAR = 80;
const map = { paths: {}, series: null, year: null, start: 1910, end: 2025, timer: null, hover: null, token: 0, stops: [] };

const rankPos = (rank) => Math.min(1, Math.log10(Math.max(rank, 1)) / Math.log10(MAP_MAX_RANK));

function readMapStops() {
  // The ramp lives in CSS (--m1 dark ... --m7 light, flipped in dark mode).
  map.stops = [1, 2, 3, 4, 5, 6, 7].map((i) => {
    const hex = cssVar(`--m${i}`).replace("#", "");
    return [0, 2, 4].map((j) => parseInt(hex.slice(j, j + 2), 16));
  });
}

function rankColor(rank) {
  if (rank == null) return "var(--m-none)";
  const stops = map.stops;
  const pos = rankPos(rank) * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const f = pos - i;
  const [r, g, b] = stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
  return `rgb(${r}, ${g}, ${b})`;
}

async function setupMap() {
  const geo = await fetch("data/us-states.json").then((r) => r.json());
  const svg = $("#map");
  const ns = "http://www.w3.org/2000/svg";
  for (const [st, d] of Object.entries(geo.states)) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.dataset.st = st;
    p.addEventListener("pointermove", (e) => { map.hover = st; showMapTip(e); });
    p.addEventListener("pointerleave", () => { map.hover = null; $("#map-tip").hidden = true; });
    svg.append(p);
    map.paths[st] = p;
  }

  // Legend: the gradient bar with rank ticks at their log positions, plus the no-data swatch.
  const scale = document.createElement("div");
  scale.className = "map-scale";
  const bar = document.createElement("div");
  bar.className = "map-bar";
  const ticks = document.createElement("div");
  ticks.className = "map-ticks";
  for (const t of MAP_TICKS) {
    const s = document.createElement("span");
    s.style.left = `${rankPos(t) * 100}%`;
    s.textContent = `#${fmt.format(t)}`;
    ticks.append(s);
  }
  const end = Object.assign(document.createElement("span"), { textContent: `#${fmt.format(MAP_MAX_RANK)}+` });
  end.style.left = "100%";
  ticks.append(end);
  scale.append(bar, ticks);
  const none = document.createElement("span");
  none.className = "map-none";
  const sw = document.createElement("i");
  sw.style.background = "var(--m-none)";
  none.append(sw, "Under 5 babies");
  $("#map-legend").replaceChildren(scale, none);

  $("#map-play").addEventListener("click", () => (map.timer ? stopMap() : playMap()));
  $("#map-slider").addEventListener("input", (e) => {
    stopMap();
    map.year = parseInt(e.target.value, 10);
    paintMap();
  });
  $("#map-series").addEventListener("change", () => { stopMap(); render(); });
}

async function renderMap(o, series) {
  const token = ++map.token;
  const sel = $("#map-series");
  const previous = sel.value;
  sel.replaceChildren(...series.map((s) => new Option(s.label, s.key)));
  sel.value = series.some((s) => s.key === previous) ? previous : series[0]?.key || "";
  map.series = series.find((s) => s.key === sel.value) || null;
  readMapStops();

  map.start = Math.max(o.from, 1910);
  map.end = o.to;
  const slider = $("#map-slider");
  slider.min = map.start;
  slider.max = map.end;
  if (map.year == null || map.year < map.start || map.year > map.end) map.year = map.end;

  if (map.end < 1910 || !map.series) {
    stopMap();
    $("#map-year").textContent = "";
    for (const p of Object.values(map.paths)) p.style.fill = "var(--m-none)";
    return;
  }
  if (map.series.combined) {
    // Ranking a combined count needs every state's full count list for every year.
    $("#map-year").textContent = "Loading…";
    await Promise.all(app.meta.states.map((st) => loadDistFile(`place/${st}`)));
    if (token !== map.token) return;
  }
  paintMap();
}

function paintMap() {
  const s = map.series;
  if (!s) return;
  for (const [st, p] of Object.entries(map.paths)) {
    p.style.fill = rankColor(seriesAt(s, st, map.year)?.rank);
  }
  $("#map-year").textContent = map.year;
  $("#map-slider").value = map.year;
  $("#map").setAttribute("aria-label", `Map of ${s.label}'s rank in each state in ${map.year}`);
  if (map.hover) updateMapTip();
}

function playMap() {
  if (map.year >= map.end) map.year = map.start;
  $("#map-play").textContent = "Pause";
  paintMap();
  map.timer = setInterval(() => {
    if (map.year >= map.end) return stopMap();
    map.year += 1;
    paintMap();
  }, MAP_MS_PER_YEAR);
}

function stopMap() {
  clearInterval(map.timer);
  map.timer = null;
  $("#map-play").textContent = "Play";
}

function showMapTip(e) {
  const tip = $("#map-tip");
  const stage = $(".map-stage").getBoundingClientRect();
  updateMapTip();
  tip.hidden = false;
  const x = e.clientX - stage.left, y = e.clientY - stage.top;
  const flip = x > stage.width - tip.offsetWidth - 24;
  tip.style.left = `${flip ? x - tip.offsetWidth - 12 : x + 12}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
}

function updateMapTip() {
  const tip = $("#map-tip");
  const st = map.hover;
  const v = map.series ? seriesAt(map.series, st, map.year) : null;
  const name = Object.assign(document.createElement("strong"), {
    textContent: v ? `#${fmt.format(v.rank)}` : "Under 5 babies",
  });
  const place = document.createElement("span");
  place.textContent = `${STATE_NAMES[st] || st}, ${map.year}`;
  const count = Object.assign(document.createElement("span"), {
    className: "count", textContent: v ? `${fmt.format(v.count)} babies` : "",
  });
  tip.replaceChildren(name, place, count);
}

// ---------- URL ----------

function writeHash(o) {
  const p = new URLSearchParams();
  p.set("name", app.main.n);
  p.set("sex", o.sex);
  p.set("show", o.metric);
  p.set("from", o.from);
  p.set("to", o.to);
  if (!o.nat) p.set("us", "0");
  if (o.states.length) p.set("states", o.states.join(","));
  if (app.extra.length) p.set("add", app.extra.map((e) => e.n).join(","));
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const setRadio = (name, v) => {
    const el = document.querySelector(`input[name=${name}][value="${v}"]`);
    if (el) el.checked = true;
  };
  if (p.get("sex")) setRadio("sex", p.get("sex"));
  if (p.get("show")) setRadio("metric", p.get("show"));
  if (p.get("from")) $("#from").value = p.get("from");
  if (p.get("to")) $("#to").value = p.get("to");
  $("#nat").checked = p.get("us") !== "0";
  const states = new Set((p.get("states") || "").split(",").filter(Boolean));
  for (const i of document.querySelectorAll("#states input")) i.checked = states.has(i.value);
  return { name: p.get("name"), add: (p.get("add") || "").split(",").filter(Boolean) };
}

// ---------- search ----------

async function search(name, add = []) {
  name = name.trim();
  if (!name) return;
  $("#status").textContent = "Looking up…";
  const entry = await lookup(name);
  if (!entry) {
    $("#status").textContent = `No records for “${name}”. SSA only lists names given to at least 5 babies in a year, so very rare names won't show up.`;
    $("#results").hidden = true;
    return;
  }
  $("#status").textContent = "";
  $("#name").value = entry.n;
  app.main = entry;
  app.colors = new Map();
  stopMap();
  map.year = null;
  app.expanded.clear();
  $("#map-series").replaceChildren();  // new search: the map starts on the searched name
  app.alts = (await Promise.all((entry.alt || []).map(lookup))).filter(Boolean);
  const known = new Set([...(entry.alt || []), ...(entry.sim || [])]);
  app.extra = (await Promise.all(add.filter((n) => known.has(n)).map(lookup))).filter(Boolean);
  $("#results").hidden = false;
  render();
}

// ---------- setup ----------

async function init() {
  app.meta = await fetch("data/meta.json").then((r) => r.json());
  const [minY, maxY] = app.meta.years;
  for (const id of ["#from", "#to"]) Object.assign($(id), { min: minY, max: maxY });
  $("#from").value = minY;
  $("#to").value = maxY;

  $("#states").replaceChildren(...app.meta.states.map((st) => {
    const label = document.createElement("label");
    label.title = STATE_NAMES[st] || st;
    const input = Object.assign(document.createElement("input"), { type: "checkbox", value: st });
    input.setAttribute("aria-label", STATE_NAMES[st] || st);
    const span = Object.assign(document.createElement("span"), { textContent: st });
    label.append(input, span);
    return label;
  }));

  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    search($("#name").value);
  });
  $("#search").addEventListener("change", (e) => {
    if (e.target.id !== "name") render();
  });
  $("#clear-states").addEventListener("click", () => {
    for (const i of document.querySelectorAll("#states input")) i.checked = false;
    render();
  });
  $("#year-presets").addEventListener("click", (e) => {
    const span = e.target.dataset?.span;
    if (!span) return;
    $("#to").value = maxY;
    $("#from").value = span === "all" ? minY : span === "1950" ? 1950 : maxY - parseInt(span, 10) + 1;
    render();
  });
  $("#table-year").addEventListener("change", render);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  await setupMap();

  const fromHash = readHash();
  if (fromHash.name) search(fromHash.name, fromHash.add);
  else $("#name").focus();
}

init().catch((err) => {
  $("#status").textContent = "Couldn't load the name data. Try reloading the page.";
  console.error(err);
});
