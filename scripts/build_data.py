"""Turn the raw SSA baby-name files into small JSON files the website loads.

Inputs (download in a browser from https://www.ssa.gov/oact/babynames/limits.html):
  raw/names.zip         national data, one yobYYYY.txt per year  ("Emma,F,20799")
  raw/namesbystate.zip  state data, one XX.TXT per state          ("CA,F,1910,Mary,295")

Outputs:
  docs/data/meta.json          year ranges, list of states, total recorded births per year
  docs/data/names/<abc>.json   every name whose lowercase form starts with <abc>

Ranks are computed per (place, year, sex) by sorting counts high to low. Tied names
share a rank (1, 2, 2, 4). SSA leaves out any name given to fewer than 5 babies in a
place and year, so those show up as a count of 0 with no rank.

Run:  .venv/bin/python scripts/build_data.py
"""

import io
import json
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import jellyfish

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "docs" / "data"
SHARD_LEN = 3
SIMILAR_LIMIT = 12

# Every name's count for each (place, sex, year). The site uses these to rank a
# combined count (e.g. Eleanor + Elinor) against all other names.
DIST = defaultdict(list)  # (place, sex, year) -> [count, ...]


def shard_key(name):
    return name.lower()[:SHARD_LEN]


def rank_counts(rows):
    """rows: list of (name, count). Returns {name: rank} with shared ranks for ties."""
    rows.sort(key=lambda r: -r[1])
    ranks = {}
    prev_count, prev_rank = None, 0
    for i, (name, count) in enumerate(rows, start=1):
        rank = prev_rank if count == prev_count else i
        ranks[name] = rank
        prev_count, prev_rank = count, rank
    return ranks


def series(year_map):
    """{year: (count, rank)} -> compact dense arrays starting at the first year."""
    years = sorted(year_map)
    y0, y1 = years[0], years[-1]
    counts, ranks = [], []
    for y in range(y0, y1 + 1):
        c, r = year_map.get(y, (0, None))
        counts.append(c)
        ranks.append(r)
    return {"y0": y0, "c": counts, "r": ranks}


def read_national(path):
    """Returns {(name, sex): {year: (count, rank)}} and {sex: {year: total}}."""
    data = defaultdict(dict)
    totals = {"F": {}, "M": {}}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            m = re.search(r"yob(\d{4})\.txt$", info.filename)
            if not m:
                continue
            year = int(m.group(1))
            by_sex = {"F": [], "M": []}
            with z.open(info) as f:
                for line in io.TextIOWrapper(f, encoding="utf-8-sig"):
                    line = line.strip()
                    if not line:
                        continue
                    name, sex, count = line.split(",")
                    by_sex[sex].append((name, int(count)))
            for sex, rows in by_sex.items():
                totals[sex][year] = sum(c for _, c in rows)
                DIST[("US", sex, year)] = [c for _, c in rows]
                counts = dict(rows)
                for name, rank in rank_counts(rows).items():
                    data[(name, sex)][year] = (counts[name], rank)
    return data, totals


def read_states(path):
    """Returns {(name, sex): {state: {year: (count, rank)}}} and {state: {sex: {year: total}}}."""
    data = defaultdict(lambda: defaultdict(dict))
    totals = {}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            m = re.search(r"([A-Z]{2})\.TXT$", info.filename, re.IGNORECASE)
            if not m:
                continue
            state = m.group(1).upper()
            groups = defaultdict(list)  # (sex, year) -> [(name, count)]
            with z.open(info) as f:
                for line in io.TextIOWrapper(f, encoding="utf-8-sig"):
                    line = line.strip()
                    if not line:
                        continue
                    _, sex, year, name, count = line.split(",")
                    groups[(sex, int(year))].append((name, int(count)))
            st_totals = {"F": {}, "M": {}}
            for (sex, year), rows in groups.items():
                st_totals[sex][year] = sum(c for _, c in rows)
                DIST[(state, sex, year)] = [c for _, c in rows]
                counts = dict(rows)
                for name, rank in rank_counts(rows).items():
                    data[(name, sex)][state][year] = (counts[name], rank)
            totals[state] = st_totals
            print(f"  {state}", end="", flush=True)
    print()
    return data, totals


def sound_key(name):
    """Metaphone, with any leading vowel treated the same (Ava ~ Eva, Emily ~ Amelie)."""
    key = jellyfish.metaphone(name)
    if key and key[0] in "AEIOU":
        key = "A" + key[1:]
    return key


def similar_names(totals_by_name):
    """For each name, other names that sound alike, closest spelling first."""
    groups = defaultdict(list)
    for name in totals_by_name:
        groups[sound_key(name)].append(name)
    result = {}
    for members in groups.values():
        for name in members:
            others = [o for o in members if o != name]
            others.sort(key=lambda o: (jellyfish.levenshtein_distance(name.lower(), o.lower()),
                                       -totals_by_name[o]))
            result[name] = others[:SIMILAR_LIMIT]
    return result


def encode_dist(counts):
    """Counts -> [distinct counts high to low, delta-encoded], [how many names have each]."""
    how_many = defaultdict(int)
    for c in counts:
        how_many[c] += 1
    values = sorted(how_many, reverse=True)
    deltas = [values[0]] + [values[i - 1] - values[i] for i in range(1, len(values))]
    return [deltas, [how_many[v] for v in values]]


def write_distributions():
    """Two layouts of the same data, so the site loads only what it needs:
    dist/place/<US|XX>.json  keyed "<sex><year>"   (charts over time for one place)
    dist/year/<year>.json    keyed "<place><sex>"  (every state in one year)"""
    by_place, by_year = defaultdict(dict), defaultdict(dict)
    for (place, sex, year), counts in DIST.items():
        enc = encode_dist(counts)
        by_place[place][f"{sex}{year}"] = enc
        by_year[year][f"{place}{sex}"] = enc
    for sub, groups in (("place", by_place), ("year", by_year)):
        (OUT / "dist" / sub).mkdir(parents=True)
        for key, content in groups.items():
            with open(OUT / "dist" / sub / f"{key}.json", "w") as f:
                json.dump(content, f, separators=(",", ":"))


def totals_series(year_totals):
    years = sorted(year_totals)
    return {"y0": years[0], "t": [year_totals.get(y, 0) for y in range(years[0], years[-1] + 1)]}


def main():
    nat_zip, st_zip = RAW / "names.zip", RAW / "namesbystate.zip"
    for p in (nat_zip, st_zip):
        if not p.exists():
            sys.exit(f"Missing {p}. Download it from https://www.ssa.gov/oact/babynames/limits.html")

    print("Reading national data...")
    national, nat_totals = read_national(nat_zip)
    print("Reading state data...")
    states, st_totals = read_states(st_zip)

    # Every name gets one entry, keyed case-insensitively. SSA spells each name one way.
    entries = {}
    total_births = defaultdict(int)
    for (name, sex), year_map in national.items():
        e = entries.setdefault(name, {"n": name})
        e[sex] = {"nat": series(year_map)}
        total_births[name] += sum(c for c, _ in year_map.values())
    for (name, sex), by_state in states.items():
        e = entries.setdefault(name, {"n": name})
        e.setdefault(sex, {})["st"] = {st: series(ym) for st, ym in sorted(by_state.items())}
        total_births.setdefault(name, 0)

    print("Finding sound-alike names...")
    sims = similar_names(total_births)
    for name, e in entries.items():
        e["sim"] = sims.get(name, [])

    print("Writing files...")
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "names").mkdir(parents=True)

    shards = defaultdict(dict)
    for name, e in entries.items():
        shards[shard_key(name)][name.lower()] = e
    for key, content in shards.items():
        with open(OUT / "names" / f"{key}.json", "w") as f:
            json.dump(content, f, separators=(",", ":"))

    all_years = sorted({y for t in nat_totals.values() for y in t})
    meta = {
        "years": [all_years[0], all_years[-1]],
        "states": sorted(st_totals),
        "shardLen": SHARD_LEN,
        "totals": {
            "nat": {sex: totals_series(t) for sex, t in nat_totals.items()},
            "st": {st: {sex: totals_series(t) for sex, t in by_sex.items() if t}
                   for st, by_sex in st_totals.items()},
        },
    }
    write_distributions()

    with open(OUT / "meta.json", "w") as f:
        json.dump(meta, f, separators=(",", ":"))

    size = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"Done: {len(entries):,} names in {len(shards):,} files, {size / 1e6:.1f} MB total.")


if __name__ == "__main__":
    main()
