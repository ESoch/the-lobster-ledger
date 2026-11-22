# Lobster market data

The **Lobster prices** page (`/#lobster-prices`) charts the Maine Department of Marine Resources annual American lobster boat-price series from 1950 onward. Prices are nominal U.S. dollars per live-weight pound paid to harvesters. The page includes a year table and CSV export. The **Roll prices** tab in **Places** shows reports for restaurant lobster rolls.

## Source and freshness

Every build bundles the committed `src/data/lobster-market.json`. Authenticated clients can read it through `GET /api/lobster-market` or the MCP tool `get_lobster_prices`. The JSON records the source URL, publication date, check time, check method, and SHA-256 of the PDF used to validate the snapshot.

The page shows the latest published year and whether it is preliminary. It shows when the next annual release is due based on that latest year and the publication schedule, and shows a late notice 90 days after the expected release. The check time is displayed separately so rechecking a PDF cannot make an old series look current.

## Scheduled refreshes

Set the repository variable `ENABLE_MARKET_REFRESH` to `true` to enable the workflow in your repository. The demo and fresh forks can use the committed snapshot without refresh setup.

The **Refresh lobster market data** workflow (`.github/workflows/market-refresh.yml`) runs weekly and on demand. It runs the importer tests and validates the upstream PDF before proposing a data update. The pull request contains the validated numeric JSON snapshot and its provenance. A change to the check time or check method alone does not create a data update. The workflow reports failures through the **Lobster market refresh is failing** issue. See [GitHub and deployment automation](github.md#lobster-market-refresh).

## Refreshing a snapshot locally

From the repository root, run the importer with its Python dependencies and run the importer tests.

```sh
uv run --with-requirements scripts/requirements-market.txt python scripts/update_lobster_market.py
uv run --with-requirements scripts/requirements-market.txt python -m unittest discover -s scripts -p 'test_lobster_market_*.py'
```

If the source refuses an automated request, open [Maine DMR’s historical landings page](https://www1.maine.gov/dmr/fisheries/commercial/landings-program/historical-data) in your browser, download the **Lobster PDF**, and import it from disk.

```sh
uv run --with-requirements scripts/requirements-market.txt python scripts/update_lobster_market.py --source-file ~/Downloads/lobster_table.pdf
```

The same checks apply to browser downloads. The importer verifies document type and size, source dates, continuous years, and price against landed value and pounds. It rejects updates that drop years from the current snapshot. A local file import records `checkMethod: "manual-file"`; the check time reflects validation of that file. Open a pull request with only the resulting JSON snapshot.

`--allow-existing-snapshot` lets a local run keep a validated snapshot with its existing check time after a defined source availability failure. Parse and validation errors still fail the run. The scheduled workflow reports source failures directly.
