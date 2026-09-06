"""Exports the current audit session's persisted findings for Evidence Scan."""
import csv
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import EvidenceFile, Finding, FindingEvidence, GeneratedReport


HEADERS = ('Finding ID', 'Rule ID', 'Practice Area', 'Severity', 'Status', 'Finding',
           'Description', 'Recommendation', 'Linked Evidence', 'Created At')
EXCEL_CELL_LIMIT = 32_767


def _safe_export_value(value: object) -> str | int:
    """Prevent spreadsheet formula execution and oversized/corrupt cells."""
    if isinstance(value, int):
        return value
    text = str(value or '').replace('\x00', '')
    # Excel/CSV interprets these leading characters as a formula when opened.
    if text.startswith(('=', '+', '-', '@')):
        text = "'" + text
    if len(text) > EXCEL_CELL_LIMIT:
        text = text[:EXCEL_CELL_LIMIT - 15] + ' [truncated]'
    return text


def _rows(db: Session, audit_session_id: int) -> list[list[str | int]]:
    findings = db.scalars(select(Finding).where(
        Finding.audit_session_id == audit_session_id,
        Finding.status == 'open',
    ).order_by(Finding.severity, Finding.practice_area_code, Finding.id)).all()
    evidence_by_finding: dict[int, list[str]] = {finding.id: [] for finding in findings}
    links = db.execute(select(FindingEvidence.finding_id, EvidenceFile.relative_path).join(
        EvidenceFile, EvidenceFile.id == FindingEvidence.evidence_file_id
    ).where(FindingEvidence.finding_id.in_(evidence_by_finding) if evidence_by_finding else False)).all()
    for finding_id, path in links:
        evidence_by_finding[finding_id].append(path)
    return [[_safe_export_value(value) for value in (
        finding.id, finding.rule_id or '', finding.practice_area_code, finding.severity,
        finding.status, finding.title, finding.description, finding.recommendation,
        '\n'.join(evidence_by_finding[finding.id]), finding.created_at.isoformat(),
    )] for finding in findings]


def create_current_findings_export(db: Session, audit_session_id: int, user_id: int, fmt: str) -> GeneratedReport:
    """Create a CSV or XLSX for only the open findings from one audit session."""
    if fmt not in {'csv', 'xlsx'}:
        raise ValueError('Supported export formats are csv and xlsx')
    rows = _rows(db, audit_session_id)
    created = datetime.now(timezone.utc)
    output = get_settings().output_dir / f'Evidence_Findings_session-{audit_session_id}_{created:%Y%m%dT%H%M%SZ}_{uuid4().hex[:8]}.{fmt}'
    if fmt == 'csv':
        content = StringIO(newline='')
        writer = csv.writer(content)
        writer.writerow(HEADERS)
        writer.writerows(rows)
        output.write_text(content.getvalue(), encoding='utf-8-sig', newline='')
    else:
        from openpyxl import Workbook
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = 'Open Findings'
        sheet.append(HEADERS)
        for row in rows:
            sheet.append(row)
        sheet.freeze_panes = 'A2'
        for column in sheet.columns:
            letter = column[0].column_letter
            sheet.column_dimensions[letter].width = min(60, max(14, max(len(str(cell.value or '')) for cell in column) + 2))
        workbook.save(output)
    report = GeneratedReport(audit_session_id=audit_session_id, report_type=f'evidence_findings_{fmt}',
                             storage_path=str(output), created_by_id=user_id)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
