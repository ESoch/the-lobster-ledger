from datetime import date, datetime, timedelta, timezone
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from update_lobster_market import CHECK_RECORD_FIELDS, MAX_BYTES, SOURCE_URL, RejectRedirects, main, parse_pdf, parse_table, write_snapshot

CHECKED_AT = datetime(2026, 10, 15, tzinfo=timezone.utc)


def series(snapshot):
    """The snapshot without its check record (when and how the source was last checked)."""
    return {key: value for key, value in snapshot.items() if key not in CHECK_RECORD_FIELDS}


def table_text():
    lines = ["HISTORICAL MAINE LOBSTER LANDINGS", "YEAR SPECIES POUNDS VALUE PRICE/LB ADJUSTED PRICE/LB"]
    for year in range(1950, 2026):
        cents = 585 if year == 2025 else 615 if year == 2024 else 200
        marker = "*" if year == 2025 else ""
        lines.append(f"{year}{marker} LOBSTER, AMERICAN 100 1,000,000 1.0000 ${cents * 10000:,} 2.0000 ${cents / 100:.2f} $9.99")
    return "\n".join(lines) + "\nLast Updated 2/6/2026\n2025* data are preliminary"


def sample_pdf():
    """A multi-page PDF made from the synthetic price series used by the table tests."""
    writer = PdfWriter()
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    lines = table_text().splitlines()
    for start in range(0, len(lines), 36):
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
        })
        stream = DecodedStreamObject()
        rows = [f"({line}) Tj T*" for line in lines[start:start + 36]]
        stream.set_data(("\n".join(["BT /F1 8 Tf 12 TL 12 770 Td", *rows, "ET"])).encode("ascii"))
        page[NameObject("/Contents")] = stream
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def blank_pdf():
    writer, output = PdfWriter(), BytesIO()
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


class MarketFeedTests(unittest.TestCase):
    def test_nominal_column_preliminary_flag_and_source_dates(self):
        result = parse_table(table_text(), CHECKED_AT)
        self.assertEqual(len(result["observations"]), 76)
        self.assertEqual(result["observations"][-2]["priceCentsPerLb"], 615)
        self.assertEqual(result["observations"][-1]["priceCentsPerLb"], 585)
        self.assertTrue(result["observations"][-1]["preliminary"])
        self.assertFalse(result["observations"][-2]["preliminary"])
        self.assertEqual(result["sourceUpdatedOn"], "2026-02-06")
        self.assertEqual(result["priceBasis"], "ex_vessel")

    def test_rejects_missing_and_duplicate_years(self):
        text = table_text()
        row = next(line for line in text.splitlines() if line.startswith("2000 "))
        for changed in [text.replace(row + "\n", ""), text + "\n" + row]:
            with self.assertRaises(ValueError):
                parse_table(changed, CHECKED_AT)

    def test_rejects_shifted_columns_bad_headers_and_dates(self):
        text = table_text()
        for changed in [text.replace("$6.15", "$9.99"), text.replace("PRICE/LB", "COST/KG"), text.replace("Last Updated 2/6/2026", "Last Updated 2/6/2028")]:
            with self.assertRaises(ValueError):
                parse_table(changed, CHECKED_AT)

    def test_rejects_old_series_and_non_pdf_responses(self):
        with self.assertRaises(ValueError):
            parse_table(table_text(), datetime(2030, 1, 1, tzinfo=timezone.utc))
        for payload in [b"<html>Service unavailable</html>", b"%PDF-" + b" " * 1_000_000]:
            with self.assertRaises(ValueError):
                parse_pdf(payload, CHECKED_AT)

    def test_failed_update_preserves_last_good_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "market.json"
            good = parse_table(table_text(), CHECKED_AT)
            write_snapshot(good, target)
            original = target.read_bytes()
            for changed in [{**good, "observations": good["observations"][:-1]}, {**good, "sourceUpdatedOn": "2025-01-01"}]:
                with self.assertRaises(ValueError):
                    write_snapshot(changed, target)
                self.assertEqual(target.read_bytes(), original)
            self.assertEqual(json.loads(original)["observations"][-1]["year"], 2025)


class PdfParserTests(unittest.TestCase):
    def test_extracts_the_synthetic_table_across_pdf_pages(self):
        data = parse_pdf(sample_pdf(), CHECKED_AT)
        self.assertEqual(data["observations"], parse_table(table_text(), CHECKED_AT)["observations"])
        self.assertEqual(data["sourceUpdatedOn"], "2026-02-06")


class MarketRefreshTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "market.json"
        self.good = {**parse_table(table_text(), CHECKED_AT), "sourceSha256": "a" * 64}
        write_snapshot(self.good, self.target)
        self.original = self.target.read_bytes()

    def run_import(self, error=None, *, allow_existing=False, content=b"%PDF-test", redirect=SOURCE_URL, extra=(), now=CHECKED_AT):
        if isinstance(error, HTTPError):
            self.addCleanup(error.close)
        argv = ["update_lobster_market.py", "--output", str(self.target), *extra]
        if allow_existing:
            argv.append("--allow-existing-snapshot")
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = redirect
        response.read.return_value = content
        stdout, stderr = StringIO(), StringIO()
        with patch("sys.argv", argv), patch("update_lobster_market.SOURCE_OPENER.open", return_value=response, side_effect=error) as opener, patch("update_lobster_market.datetime", wraps=datetime) as clock, redirect_stdout(stdout), redirect_stderr(stderr):
            self.opener = opener
            clock.now.return_value = now
            main()
        return stdout.getvalue(), stderr.getvalue()

    def test_release_retains_valid_snapshot_on_public_source_403(self):
        error = HTTPError(SOURCE_URL, 403, "Forbidden", {}, None)
        try:
            stdout, stderr = self.run_import(error, allow_existing=True)
        except SystemExit as error:
            self.fail(f"Release retention option is unavailable: {error}")
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertNotIn("Validated", stdout)
        self.assertIn("WARNING", stderr)
        self.assertIn("HTTP 403", stderr)
        self.assertIn(self.good["checkedAt"], stderr)
        self.assertIn("unchanged", stderr)

    def test_scheduled_default_still_fails_on_fetch_error(self):
        with self.assertRaises(HTTPError):
            self.run_import(HTTPError(SOURCE_URL, 403, "Forbidden", {}, None))
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_release_retains_only_for_defined_availability_failures(self):
        errors = [HTTPError(SOURCE_URL, code, "Unavailable", {}, None) for code in (408, 429, 500, 502, 503, 504)]
        errors += [TimeoutError(), ConnectionResetError(), URLError(socket.gaierror()), URLError(TimeoutError())]
        for error in errors:
            with self.subTest(error=repr(error)):
                self.run_import(error, allow_existing=True)
                self.assertEqual(self.target.read_bytes(), self.original)

    def test_release_fails_on_other_http_tls_and_unexpected_errors(self):
        errors = [HTTPError(SOURCE_URL, code, "Unavailable", {}, None) for code in (401, 404, 410)]
        errors += [HTTPError("https://example.com/other.pdf", 403, "Forbidden", {}, None), URLError(ssl.SSLCertVerificationError()), URLError("unknown cause"), RuntimeError("bug")]
        for error in errors:
            with self.subTest(error=repr(error)), self.assertRaises(type(error)):
                self.run_import(error, allow_existing=True)
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_release_fails_on_invalid_pdf_and_redirect(self):
        for args in [{"content": b"<html>Unavailable</html>"}, {"redirect": "https://example.com/other.pdf"}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.run_import(allow_existing=True, **args)
            self.assertEqual(self.target.read_bytes(), self.original)

    def test_redirect_is_rejected_before_following_another_source(self):
        with self.assertRaises(ValueError):
            RejectRedirects().redirect_request(None, None, 302, "Found", {}, "https://example.com/other.pdf")

    def test_retention_preserves_an_overdue_successful_check(self):
        self.target.write_text(json.dumps({**self.good, "checkedAt": "2026-09-01T00:00:00Z"}))
        original = self.target.read_bytes()
        _, stderr = self.run_import(TimeoutError(), allow_existing=True)
        self.assertEqual(self.target.read_bytes(), original)
        self.assertIn("2026-09-01T00:00:00Z", stderr)

    def test_release_rejects_missing_or_invalid_retained_snapshot(self):
        invalid = [
            {**self.good, "schemaVersion": 2},
            {**self.good, "sourceUrl": "https://example.com/other.pdf"},
            {**self.good, "sourceSha256": "missing"},
            {**self.good, "checkedAt": "2027-01-01T00:00:00Z"},
            {**self.good, "checkedAt": "2026-10-15T00:00:00"},
            {**self.good, "checkedAt": "20261015T00:00:00Z"},
            {**self.good, "sourceUpdatedOn": "2026-10-16"},
            {**self.good, "sourceUpdatedOn": "20260206"},
            {**self.good, "notes": []},
            {**self.good, "checkMethod": "browser"},
            {**self.good, "observations": self.good["observations"][:-3]},
            {**self.good, "observations": self.good["observations"][1:]},
            {**self.good, "observations": self.good["observations"] + [self.good["observations"][-1]]},
        ]
        for changes in [{"year": True}, {"priceCentsPerLb": 0}, {"priceCentsPerLb": 999}, {"pounds": 0}, {"landedValueUsd": -1}, {"preliminary": "false"}]:
            invalid.append({**self.good, "observations": [{**self.good["observations"][0], **changes}, *self.good["observations"][1:]]})
        for snapshot in invalid:
            original = json.dumps(snapshot).encode()
            self.target.write_bytes(original)
            with self.subTest(snapshot=snapshot), self.assertRaises(ValueError):
                self.run_import(HTTPError(SOURCE_URL, 403, "Forbidden", {}, None), allow_existing=True)
            self.assertEqual(self.target.read_bytes(), original)
        self.target.write_text("{")
        with self.assertRaises(ValueError):
            self.run_import(HTTPError(SOURCE_URL, 403, "Forbidden", {}, None), allow_existing=True)
        self.target.unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_import(HTTPError(SOURCE_URL, 403, "Forbidden", {}, None), allow_existing=True)

    def test_successful_fetch_updates_snapshot_and_check_time(self):
        updated = {**self.good, "checkedAt": "2026-10-15T01:00:00Z"}
        with patch("update_lobster_market.parse_pdf", return_value=updated):
            stdout, stderr = self.run_import(allow_existing=True)
        self.assertEqual(json.loads(self.target.read_text()), updated)
        self.assertIn("Validated 76 annual prices", stdout)
        self.assertEqual(stderr, "")

    def test_retention_accepts_a_snapshot_checked_from_a_manual_file(self):
        self.target.write_text(json.dumps({**self.good, "checkMethod": "manual-file"}))
        original = self.target.read_bytes()
        self.run_import(HTTPError(SOURCE_URL, 403, "Forbidden", {}, None), allow_existing=True)
        self.assertEqual(self.target.read_bytes(), original)


    def write_source(self, content):
        source = Path(self.directory.name) / "downloaded.pdf"
        source.write_bytes(content)
        return source

    def test_source_file_is_validated_like_a_download_and_recorded_as_manual(self):
        content = sample_pdf()
        stdout, stderr = self.run_import(extra=["--source-file", str(self.write_source(content))], now=CHECKED_AT)
        self.opener.assert_not_called()
        written = json.loads(self.target.read_text())
        self.assertEqual(series(written), series(parse_pdf(content, CHECKED_AT)))
        self.assertEqual(written["sourceSha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(written["checkMethod"], "manual-file")
        self.assertEqual(written["checkedAt"], CHECKED_AT.isoformat().replace("+00:00", "Z"))
        observations = self.good["observations"]
        self.assertIn(f"Validated {len(observations)} annual prices through {observations[-1]['year']} from a manually downloaded file", stdout)
        self.assertIn(written["sourceSha256"], stdout)
        self.assertEqual(stderr, "")

    def test_source_file_is_refused_when_a_download_would_be(self):
        newer = (date.fromisoformat(self.good["sourceUpdatedOn"]) + timedelta(days=1)).isoformat()
        older_than_existing = {**self.good, "sourceUpdatedOn": newer, "checkedAt": CHECKED_AT.isoformat().replace("+00:00", "Z")}
        cases = [
            ("not a PDF", b"<html>Access denied</html>", None),
            ("too large", b"%PDF-" + b" " * MAX_BYTES, None),
            ("no price table", blank_pdf(), None),
            ("older publication", sample_pdf(), older_than_existing),
        ]
        for label, content, existing in cases:
            with self.subTest(label):
                if existing:
                    self.target.write_text(json.dumps(existing))
                original = self.target.read_bytes()
                with self.assertRaises(ValueError):
                    self.run_import(extra=["--source-file", str(self.write_source(content))], now=CHECKED_AT)
                self.assertEqual(self.target.read_bytes(), original)
                self.opener.assert_not_called()

    def test_source_file_cannot_be_combined_with_retention(self):
        with self.assertRaises(SystemExit):
            self.run_import(allow_existing=True, extra=["--source-file", str(self.write_source(sample_pdf()))])
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_save_source_dir_keeps_the_exact_validated_pdf(self):
        content = sample_pdf()
        saved = Path(self.directory.name) / "fixtures"
        stdout, _ = self.run_import(content=content, extra=["--save-source-dir", str(saved)], now=CHECKED_AT)
        self.assertEqual((saved / "lobster_table_2026-02-06.pdf").read_bytes(), content)
        self.assertNotIn("checkMethod", json.loads(self.target.read_text()))
        self.assertNotIn("manually", stdout)
        for source in (["--source-file", str(self.write_source(content))], []):
            with self.subTest(source=source):
                (saved / "lobster_table_2026-02-06.pdf").unlink()
                self.run_import(content=content, extra=[*source, "--save-source-dir", str(saved)], now=CHECKED_AT)
                self.assertEqual((saved / "lobster_table_2026-02-06.pdf").read_bytes(), content)

    def test_save_source_dir_saves_nothing_when_validation_fails(self):
        saved = Path(self.directory.name) / "fixtures"
        with self.assertRaises(ValueError):
            self.run_import(content=b"<html>Access denied</html>", extra=["--save-source-dir", str(saved)])
        self.assertFalse(saved.exists())
        self.assertEqual(self.target.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
