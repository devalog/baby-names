# Baby Name Explorer

Look up any name in the Social Security Administration's baby name data and see:

- Rank, births, or births per 1,000 by year, nationally and for any states you pick
- The name's rank in **every** state for a given year, including names outside the top 100
- Names that sound alike. Check one to add it to the charts.

Everything is static. GitHub Pages serves the `docs/` folder.

## Updating the data

SSA publishes new numbers each spring.

1. Download both files from <https://www.ssa.gov/oact/babynames/limits.html> into `raw/`:
   - **National data** → `raw/names.zip`
   - **State-specific data** → `raw/namesbystate.zip`
2. Build:

   ```sh
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   .venv/bin/python scripts/build_data.py
   ```

3. Commit the changes in `docs/data/` and push.

## How ranks work

SSA only publishes counts, not ranks for every name. The build script sorts each place, year and sex by count and numbers them. Tied names share a rank. A name given to fewer than 5 babies in a state that year isn't in SSA's data, so it shows as a dash.

## Preview locally

```sh
cd docs && python3 -m http.server 8000
```
