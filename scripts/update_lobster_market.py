"""Import the official Maine DMR annual lobster boat-price series, failing closed."""

import argparse
from datetime import date, datetime, timezone
from decimal import Decimal
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import socket
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pypdf import PdfReader

SOURCE_URL = "https://www.maine.gov/dmr/sites/maine.gov.dmr/files/inline-files/lobster_table.pdf"
SOURCE_PAGE = "https://www.maine.gov/dmr/fisheries/commercial/landings-program/historical-data"
OUTPUT = Path(__file__).resolve().parents[1] / "src/data/lobster-market.json"
MAX_BYTES = 1_000_000
SOURCE_METADATA = {
    "schemaVersion": 1,
    "seriesId": "maine-dmr-american-lobster",
    "sourceName": "Maine Department of Marine Resources",
    "sourceUrl": SOURCE_URL,
    "sourcePageUrl": SOURCE_PAGE,
    "species": "American lobster",
    "region": "Maine, United States",
    "currency": "USD",
    "unit": "lb",
    "priceBasis": "ex_vessel",
    "frequency": "annual",
    "refreshCadence": "weekly",
}
# When and how the source was last checked. These change on every check, so they are not part of the series.
CHECK_RECORD_FIELDS = ("checkedAt", "checkMethod")
# checkMethod for a copy of the source PDF downloaded by hand; absent when the importer downloaded SOURCE_URL itself.
MANUAL_FILE = "manual-file"
ROW = re.compile(
    r"^\s*(\d{4})(\*)?\s+LOBSTER,\s*AMERICAN\s+"
    r"([\d,]+)\s+([\d,]+)\s+([\d.]+)\s+"
    r"\$([\d,]+)\s+([\d.]+)\s+\$([\d]+\.\d{2})(?=\s|$)",
    re.MULTILINE,
)


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected source redirect; review the official source before updating.")


SOURCE_OPENER = build_opener(RejectRedirects())


def parse_table(text: str, checked_at: datetime) -> dict:
    if "HISTORICAL MAINE LOBSTER LANDINGS" not in text or "PRICE/LB" not in text:
        raise ValueError("The source no longer has the expected lobster price table.")
    updated = re.search(r"Last Updated\s+(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if not updated:
        raise ValueError("Missing source publication date.")
    month, day, year = map(int, updated.groups())
    source_date = date(year, month, day)
    if source_date > checked_at.date():
        raise ValueError("Source publication date is in the future.")
    observations = {}
    for match in ROW.finditer(text):
        year, preliminary, _, pounds, _, value, _, price = match.groups()
        year, pounds, value = int(year), int(pounds.replace(",", "")), int(value.replace(",", ""))
        if year < 1950:
            continue
        cents = int(Decimal(price) * 100)
        if year in observations or year >= checked_at.year:
            raise ValueError("Expected unique, completed calendar years.")
        if pounds <= 0 or value <= 0 or not 1 <= cents <= 100_000:
            raise ValueError("Invalid landings or price.")
        # Catch shifted PDF columns, including the separate adjusted-price series.
        if abs(Decimal(value) / Decimal(pounds) - Decimal(price)) > Decimal("0.0051"):
            raise ValueError(f"Published price does not match value/pounds for {year}.")
        observations[year] = {
            "year": year,
            "priceCentsPerLb": cents,
            "pounds": pounds,
            "landedValueUsd": value,
            "preliminary": bool(preliminary),
        }
    years = sorted(observations)
    if not years or years != list(range(1950, years[-1] + 1)):
        raise ValueError("Expected an uninterrupted annual series from 1950.")
    if years[-1] < checked_at.year - 3:
        raise ValueError("The latest source year is unexpectedly old.")
    return {
        **SOURCE_METADATA,
        "sourceUpdatedOn": source_date.isoformat(),
        "checkedAt": checked_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "notes": [
            "Annual average price paid to harvesters for whole American lobster landed in Maine.",
            "Nominal US dollars per live-weight pound; not adjusted for inflation.",
            "Reporting changes in 2002–2004 affect comparisons across those years.",
            "Preliminary years may be revised by Maine DMR.",
        ],
        "observations": [observations[year] for year in years],
    }


def parse_pdf(content: bytes, checked_at: datetime) -> dict:
    if len(content) > MAX_BYTES or not content.startswith(b"%PDF-"):
        raise ValueError("Expected a small official PDF document.")
    reader = PdfReader(BytesIO(content))
    if not 1 <= len(reader.pages) <= 10:
        raise ValueError("Unexpected source page count.")
    snapshot = parse_table("\n".join(page.extract_text() or "" for page in reader.pages), checked_at)
    snapshot["sourceSha256"] = hashlib.sha256(content).hexdigest()
    return snapshot


def write_snapshot(snapshot: dict, output: Path) -> None:
    if output.exists():
        previous = json.loads(output.read_text())
        prior_years = {row["year"] for row in previous["observations"]}
        if not prior_years.issubset({row["year"] for row in snapshot["observations"]}):
            raise ValueError("Refusing to remove previously published years.")
        if snapshot["sourceUpdatedOn"] < previous["sourceUpdatedOn"]:
            raise ValueError("Refusing an older source publication.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as handle:
        json.dump(snapshot, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(output)


def read_source_file(path: Path) -> bytes:
    with path.open("rb") as handle:
        return handle.read(MAX_BYTES + 1)


def save_source(content: bytes, directory: Path, source_updated_on: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(directory / f"lobster_table_{source_updated_on}.pdf")


def import_snapshot(content: bytes, now: datetime, args: argparse.Namespace, check_method: str | None = None) -> None:
    snapshot = parse_pdf(content, now)
    if check_method:
        snapshot["checkMethod"] = check_method
    write_snapshot(snapshot, args.output)
    if args.save_source_dir:
        save_source(content, args.save_source_dir, snapshot["sourceUpdatedOn"])
    origin = " from a manually downloaded file" if check_method == MANUAL_FILE else ""
    print(f"Validated {len(snapshot['observations'])} annual prices through {snapshot['observations'][-1]['year']}{origin}; source updated {snapshot['sourceUpdatedOn']}; sha256 {snapshot['sourceSha256']}.")


def validate_existing_snapshot(output: Path, now: datetime) -> dict:
    content = output.read_bytes()
    if len(content) > MAX_BYTES:
        raise ValueError("Existing market snapshot is unexpectedly large.")
    snapshot = json.loads(content)
    if not isinstance(snapshot, dict) or any(
        type(snapshot.get(key)) is not type(value) or snapshot.get(key) != value
        for key, value in SOURCE_METADATA.items()
    ):
        raise ValueError("Existing market snapshot has invalid source metadata.")
    try:
        checked_at = datetime.fromisoformat(snapshot["checkedAt"])
        source_date = date.fromisoformat(snapshot["sourceUpdatedOn"])
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", snapshot["checkedAt"]) or source_date.isoformat() != snapshot["sourceUpdatedOn"] or not source_date <= checked_at.date() <= now.date() or checked_at > now:
            raise ValueError("Existing market snapshot has invalid source/check dates.")
        if not re.fullmatch(r"[a-f0-9]{64}", snapshot["sourceSha256"]):
            raise ValueError("Existing market snapshot has no valid source checksum.")
        if "checkMethod" in snapshot and snapshot["checkMethod"] != MANUAL_FILE:
            raise ValueError("Existing market snapshot has an unknown check method.")
        if not isinstance(snapshot["notes"], list) or not snapshot["notes"] or any(not isinstance(note, str) or not note.strip() for note in snapshot["notes"]):
            raise ValueError("Existing market snapshot has invalid source notes.")
        observations = snapshot["observations"]
        if not isinstance(observations, list) or not observations:
            raise ValueError("Existing market snapshot has no annual observations.")
        for year, row in enumerate(observations, start=1950):
            if not isinstance(row, dict) or any(type(row[key]) is not int for key in ("year", "priceCentsPerLb", "pounds", "landedValueUsd")) or type(row["preliminary"]) is not bool:
                raise ValueError("Existing market snapshot has invalid observation types.")
            if row["year"] != year or year >= checked_at.year:
                raise ValueError("Existing market snapshot must contain continuous completed years from 1950.")
            cents, pounds, value = row["priceCentsPerLb"], row["pounds"], row["landedValueUsd"]
            if pounds <= 0 or value <= 0 or not 1 <= cents <= 100_000 or abs(Decimal(value) / Decimal(pounds) - Decimal(cents) / 100) > Decimal("0.0051"):
                raise ValueError("Existing market snapshot has invalid landings or prices.")
        if observations[-1]["year"] < now.year - 3:
            raise ValueError("Existing market snapshot's latest year is unexpectedly old.")
    except (KeyError, TypeError) as error:
        raise ValueError("Existing market snapshot is malformed.") from error
    return snapshot


def source_unavailable(error: Exception) -> bool:
    if isinstance(error, HTTPError):
        return error.geturl() == SOURCE_URL and error.code in (403, 408, 429, 500, 502, 503, 504)
    reason = error.reason if isinstance(error, URLError) else error
    return isinstance(reason, (TimeoutError, ConnectionError, socket.gaierror))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--allow-existing-snapshot", action="store_true", help="On defined source-availability failures, retain a validated existing snapshot without changing its successful-check time.")
    source.add_argument("--source-file", type=Path, metavar="PATH", help=f"Validate a copy of the official PDF that you downloaded yourself from {SOURCE_URL} (for example in a browser while the source refuses automated requests) instead of downloading it. checkedAt records when the file was validated, and checkMethod records {MANUAL_FILE!r}.")
    parser.add_argument("--save-source-dir", type=Path, metavar="DIR", help="After a successful update, also save the validated PDF as DIR/lobster_table_<source date>.pdf.")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    if args.source_file:
        import_snapshot(read_source_file(args.source_file), now, args, MANUAL_FILE)
        return
    request = Request(SOURCE_URL, headers={"User-Agent": "LobsterLedger/1.0 (public fisheries data)"})
    try:
        with SOURCE_OPENER.open(request, timeout=30) as response:
            if response.geturl() != SOURCE_URL:
                raise ValueError("Unexpected source redirect; review the official source before updating.")
            content = response.read(MAX_BYTES + 1)
    except (HTTPError, URLError, TimeoutError, ConnectionError) as error:
        if not args.allow_existing_snapshot or not source_unavailable(error):
            raise
        if isinstance(error, HTTPError):
            error.close()
        snapshot = validate_existing_snapshot(args.output, now)
        reason = f"HTTP {error.code}" if isinstance(error, HTTPError) else type(error).__name__
        print(f"WARNING: Official source unavailable ({reason}); retained validated existing snapshot unchanged. Last successful source check {snapshot['checkedAt']}; source updated {snapshot['sourceUpdatedOn']}.", file=sys.stderr)
        return
    import_snapshot(content, now, args)


if __name__ == "__main__":
    main()
