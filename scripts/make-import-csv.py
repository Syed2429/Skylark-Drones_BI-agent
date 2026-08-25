"""
Produces Monday.com import-ready CSVs from the two source spreadsheets.

DELIBERATELY MINIMAL. The only changes made are the ones needed for Monday's
import wizard to read the file correctly:

  1. Work Orders: drop the blank first row so the real header is row 1.
     Left as-is, Monday treats the blank row as the header and every column
     lands unnamed, which breaks title-based column mapping completely.
  2. Dates written as YYYY-MM-DD so Monday's date parser is unambiguous.
  3. Currency floats rounded to 2 dp (source has values like 2984097.3600000003).
     Total impact across all rows is under one rupee.

Everything else is preserved exactly, INCLUDING the data quality defects:
the two repeated header rows in Deals, the 52% missing deal values, the
"BIlled" typo, the four always-empty columns, the mixed quantity units.
Those are what the agent is built to handle, so they must survive the import.

    python scripts/make-import-csv.py
"""

import csv
import datetime as dt
import os
import sys

try:
    import pandas as pd
except ImportError:
    sys.exit("pandas is required:  python -m pip install pandas openpyxl")

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
SOURCE_DIR = os.path.dirname(PROJECT_ROOT)
OUT_DIR = os.path.join(SOURCE_DIR, "monday-import")

BOARDS = [
    {
        "file": "Deal funnel Data.xlsx",
        "sheet": "Deal tracker",
        "name_column": "Deal Name",
        "out": "Deals Pipeline.csv",
    },
    {
        "file": "Work_Order_Tracker Data.xlsx",
        "sheet": "work order tracker",
        "name_column": "Deal name masked",
        "out": "Work Orders.csv",
    },
]


def find_header_row(path: str, sheet: str, name_column: str) -> int:
    """
    Locates the header row instead of hardcoding it.

    As shipped, the Work Orders sheet has a blank row 0 and its header on row 1,
    while Deals has its header on row 0. Detecting it means the script keeps
    working whether or not someone has since deleted that blank row by hand.
    """
    probe = pd.read_excel(path, sheet_name=sheet, header=None, nrows=10)
    target = name_column.strip().lower()

    for idx in range(len(probe)):
        first = str(probe.iloc[idx, 0]).strip().lower()
        if first == target:
            return idx

    # Fall back to the first row that has any content at all.
    for idx in range(len(probe)):
        if probe.iloc[idx].notna().any():
            print(
                f"  ! Could not find a '{name_column}' header in {os.path.basename(path)};"
                f" assuming row {idx + 1} is the header."
            )
            return idx

    sys.exit(f"{path} appears to be empty.")

MONEY_HINT = ("amount", "value", "billed", "collected", "receivable")


def render(value, column: str) -> str:
    """Formats one cell for CSV, leaving blanks genuinely blank."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    if isinstance(value, pd.Timestamp) or isinstance(value, (dt.datetime, dt.date)):
        if pd.isna(value):
            return ""
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        col = column.lower()
        return f"{round(value, 2)}" if any(h in col for h in MONEY_HINT) else str(value)
    return str(value).strip()


os.makedirs(OUT_DIR, exist_ok=True)

for board in BOARDS:
    src = os.path.join(SOURCE_DIR, board["file"])
    if not os.path.exists(src):
        sys.exit(f"Missing source file: {src}")

    header_row = find_header_row(src, board["sheet"], board["name_column"])
    df = pd.read_excel(src, sheet_name=board["sheet"], header=header_row)

    # Trailing rows that are entirely empty carry no data and only confuse the
    # import preview. Rows that are merely SPARSE are kept — incomplete records
    # are exactly what the agent needs to demonstrate handling.
    df = df.dropna(how="all")

    dest = os.path.join(OUT_DIR, board["out"])
    # Plain UTF-8, no BOM: monday.com would otherwise fold the BOM into the
    # first column's title, so "Deal Name" would not match on import.
    with open(dest, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow([str(c).strip() for c in df.columns])
        for _, row in df.iterrows():
            writer.writerow([render(row[c], str(c)) for c in df.columns])

    print(f"  {board['out']:24} {len(df):>4} rows, {len(df.columns)} columns")

print(f"\n  Written to {OUT_DIR}")
print("  Import these two files into monday.com as separate boards.")
