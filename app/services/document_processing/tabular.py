"""Safe tabular evidence readers shared by extraction and audit validators."""
import csv
from pathlib import Path

from openpyxl import load_workbook


def read_tabular_rows(path: str) -> list[list]:
    """Read CSV, modern Excel, and legacy XLS cells without modifying evidence."""
    source = Path(path)
    suffix = source.suffix.lower()
    if suffix == '.csv':
        with source.open('r', encoding='utf-8-sig', errors='replace', newline='') as stream:
            return [row for row in csv.reader(stream)]
    if suffix == '.xls':
        # xlrd 2.x deliberately supports only legacy .xls files.  Modern
        # workbooks remain on openpyxl below.
        import xlrd
        workbook = xlrd.open_workbook(source)
        sheet = workbook.sheet_by_index(0)
        return [sheet.row_values(index) for index in range(sheet.nrows)]
    workbook = load_workbook(source, read_only=True, data_only=True)
    return [list(row) for row in workbook[workbook.sheetnames[0]].iter_rows(values_only=True)]
