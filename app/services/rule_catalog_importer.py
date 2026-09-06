"""Validate and persist an immutable rules catalogue from the CMMI workbook."""
from __future__ import annotations

from datetime import date
from hashlib import sha256
from io import BytesIO
import re

from openpyxl import load_workbook
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import ChecklistVersion, CmmiRule, DocumentTypeRule

PA_ALIASES = {'VER': 'VV', 'VAL': 'VV', 'MC': 'MPM', 'SAM': 'SUP', 'SSS': 'SUP', 'PPL': 'OT'}


def _text(value) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _norm(value) -> str:
    return re.sub(r'[^a-z0-9]+', '', _text(value).lower())


def _rows(sheet, maximum: int = 10_000) -> list[list]:
    rows = []
    for index, row in enumerate(sheet.iter_rows(values_only=True), start=1):
        if index > maximum:
            raise ValueError(f'Sheet {sheet.title} exceeds the {maximum}-row import limit.')
        rows.append(list(row))
    return rows


def _header(rows: list[list], required: str) -> tuple[int, list]:
    wanted = _norm(required)
    for index, row in enumerate(rows):
        if any(_norm(cell) == wanted for cell in row):
            return index, row
    raise ValueError(f'Missing required header "{required}".')


def _column(header: list, name: str) -> int:
    wanted = _norm(name)
    for index, value in enumerate(header):
        if _norm(value) == wanted:
            return index
    raise ValueError(f'Missing required column "{name}".')


def _split_keywords(value) -> list[str]:
    return list(dict.fromkeys(item for item in (_text(part) for part in re.split(r'[;,\n]', str(value or ''))) if len(item) > 1))


def _practice_areas(value, known: set[str]) -> list[str]:
    codes = re.findall(r'\b[A-Z]{2,5}\b', str(value or '').upper())
    return list(dict.fromkeys(PA_ALIASES.get(code, code) for code in codes if PA_ALIASES.get(code, code) in known))


def _parse_rules(workbook) -> list[dict]:
    if 'MASTER' not in workbook.sheetnames:
        raise ValueError('Workbook must contain a MASTER sheet.')
    rows = _rows(workbook['MASTER'])
    start, header = _header(rows, 'Rule ID')
    level_at = _column(header, 'Level')
    rule_at = _column(header, 'Rule ID')
    check_at = _column(header, 'Audit Check (What the auditor looks for and verifies)')
    gap_at = _column(header, 'If NO: Finding and Implication')
    rules, seen = [], set()
    for row in rows[start + 1:]:
        rule_id = _text(row[rule_at] if rule_at < len(row) else '')
        if not re.match(r'^[A-Z0-9]+-[A-Z0-9]+', rule_id, re.I):
            continue
        if rule_id in seen:
            raise ValueError(f'Duplicate Rule ID: {rule_id}.')
        seen.add(rule_id)
        audit_check = _text(row[check_at] if check_at < len(row) else '')
        gap_text = _text(row[gap_at] if gap_at < len(row) else '')
        if not audit_check or not gap_text:
            raise ValueError(f'Rule {rule_id} is missing its audit check or finding text.')
        level = _text(row[level_at] if level_at < len(row) else '')
        if level not in {'L1-Gate', 'L2-Block', 'L3-Check', 'L4-Probe'}:
            raise ValueError(f'Rule {rule_id} has an invalid level: {level or "blank"}.')
        rules.append({'rule_id': rule_id, 'practice_area': rule_id.split('-')[0].upper(), 'level': level,
                      'is_gate': level.lower() == 'l1-gate', 'is_check': level.lower() == 'l3-check',
                      'is_probe': level.lower() == 'l4-probe', 'audit_check': audit_check, 'gap_text': gap_text})
    if not rules:
        raise ValueError('MASTER contains no valid audit rules.')
    return rules


def _add_document(output: dict[str, dict], name, pa, keywords, expected, source, known, purpose='') -> None:
    display = _text(name).rstrip('/')
    key = _norm(display)
    if not key:
        return
    item = output.setdefault(key, {'document_type': display, 'practice_areas': [], 'keywords': [],
                                   'aliases': [], 'expected_evidence': '', 'primary_purpose': ''})
    item['practice_areas'] = list(dict.fromkeys(item['practice_areas'] + _practice_areas(pa, known)))
    item['keywords'] = list(dict.fromkeys(item['keywords'] + _split_keywords(keywords)))
    item['aliases'] = list(dict.fromkeys(item['aliases'] + [display] + [_text(part) for part in display.split('/') if _text(part)]))
    item['expected_evidence'] = item['expected_evidence'] or _text(expected)
    item['primary_purpose'] = item['primary_purpose'] or _text(purpose)


def _parse_documents(workbook, known: set[str]) -> list[dict]:
    documents: dict[str, dict] = {}
    if 'Sheet2' in workbook.sheetnames:
        rows = _rows(workbook['Sheet2']); start, header = _header(rows, 'Related Document Name')
        indexes = [_column(header, name) for name in ('Related Document Name', 'Practice Area Name', 'Main Keywords', 'Example Evidence / Example Document')]
        for row in rows[start + 1:]:
            values = [(row[i] if i < len(row) else '') for i in indexes]
            _add_document(documents, *values, 'Sheet2', known)
    if 'Sheet5' in workbook.sheetnames:
        rows = _rows(workbook['Sheet5']); start, header = _header(rows, 'Document / Evidence')
        indexes = [_column(header, name) for name in ('Document / Evidence', 'Related Practice Area', 'What to Check / Key Points', 'Expected Evidence')]
        for row in rows[start + 1:]:
            values = [(row[i] if i < len(row) else '') for i in indexes]
            _add_document(documents, *values, 'Sheet5', known)
    if 'Sheet6' in workbook.sheetnames:
        rows = _rows(workbook['Sheet6']); start, header = _header(rows, 'Document / Evidence')
        doc_at, purpose_at = _column(header, 'Document / Evidence'), _column(header, 'Primary Purpose')
        for row in rows[start + 1:]:
            _add_document(documents, row[doc_at] if doc_at < len(row) else '', '', '', '', 'Sheet6', known,
                          row[purpose_at] if purpose_at < len(row) else '')
    result = [item for item in documents.values() if item['keywords'] and item['practice_areas']]
    if not result:
        raise ValueError('No usable document catalogue was found in Sheet2/Sheet5/Sheet6.')
    return result


def _rule_signature(rule: dict) -> tuple:
    return (rule['practice_area'], rule['level'], rule['audit_check'], rule['gap_text'])


def _document_signature(document: dict) -> tuple:
    return (
        tuple(document.get('practice_areas') or []),
        tuple(document.get('keywords') or []),
        tuple(document.get('aliases') or []),
        document.get('expected_evidence') or '',
        document.get('primary_purpose') or '',
    )


def _stored_catalog(db: Session, version_id: int) -> tuple[dict, dict]:
    rules = {
        item.rule_id: {
            'practice_area': item.practice_area_code,
            'level': item.level,
            'audit_check': item.audit_check,
            'gap_text': item.gap_text,
        }
        for item in db.scalars(select(CmmiRule).where(CmmiRule.checklist_version_id == version_id)).all()
    }
    documents = {
        item.document_type: {
            'practice_areas': item.practice_areas or [],
            'keywords': item.keywords or [],
            'aliases': item.aliases or [],
            'expected_evidence': item.expected_evidence or '',
            'primary_purpose': item.primary_purpose or '',
        }
        for item in db.scalars(select(DocumentTypeRule).where(DocumentTypeRule.checklist_version_id == version_id)).all()
    }
    return rules, documents


def _change_summary(db: Session, active: ChecklistVersion | None, rules: list[dict], documents: list[dict]) -> dict:
    """Describe substantive rulebook changes without exposing workbook bytes."""
    incoming_rules = {item['rule_id']: item for item in rules}
    incoming_documents = {item['document_type']: item for item in documents}
    if not active:
        return {
            'rules_added': len(incoming_rules), 'rules_removed': 0, 'rules_changed': 0,
            'documents_added': len(incoming_documents), 'documents_removed': 0, 'documents_changed': 0,
            'changed_rule_ids': sorted(incoming_rules)[:25], 'changed_document_types': sorted(incoming_documents)[:25],
        }
    stored_rules, stored_documents = _stored_catalog(db, active.id)
    changed_rules = sorted(rule_id for rule_id in incoming_rules.keys() & stored_rules.keys()
                           if _rule_signature(incoming_rules[rule_id]) != _rule_signature(stored_rules[rule_id]))
    changed_documents = sorted(name for name in incoming_documents.keys() & stored_documents.keys()
                               if _document_signature(incoming_documents[name]) != _document_signature(stored_documents[name]))
    return {
        'rules_added': len(incoming_rules.keys() - stored_rules.keys()),
        'rules_removed': len(stored_rules.keys() - incoming_rules.keys()),
        'rules_changed': len(changed_rules),
        'documents_added': len(incoming_documents.keys() - stored_documents.keys()),
        'documents_removed': len(stored_documents.keys() - incoming_documents.keys()),
        'documents_changed': len(changed_documents),
        'changed_rule_ids': changed_rules[:25],
        'changed_document_types': changed_documents[:25],
    }


def _has_substantive_change(summary: dict) -> bool:
    return any(summary[key] for key in (
        'rules_added', 'rules_removed', 'rules_changed',
        'documents_added', 'documents_removed', 'documents_changed',
    ))


def activate_rule_catalog(db: Session, checklist_version_id: int) -> ChecklistVersion:
    """Promote a validated immutable ruleset only through an explicit action."""
    version = db.get(ChecklistVersion, checklist_version_id)
    if not version:
        raise ValueError('Ruleset version not found.')
    if version.status not in {'VALIDATED', 'ACTIVE', 'RETIRED'}:
        raise ValueError('Only a validated or previously governed ruleset can be activated.')
    if version.is_active:
        return version
    db.execute(update(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)).values(
        is_active=False, status='RETIRED'
    ))
    version.is_active = True
    version.status = 'ACTIVE'
    return version


def import_rule_catalog(db: Session, filename: str, content: bytes, activate: bool = False) -> dict:
    """Validate and version a catalogue; activation is explicit by default."""
    if not filename.lower().endswith(('.xlsx', '.xlsm')):
        raise ValueError('Master rules must be supplied as an XLSX workbook.')
    digest = sha256(content).hexdigest()
    existing = db.scalar(select(ChecklistVersion).where(ChecklistVersion.checksum == digest))
    if existing:
        if activate and not existing.is_active:
            activate_rule_catalog(db, existing.id)
        return {'checklist_version_id': existing.id, 'version': existing.version, 'rules': db.query(CmmiRule).filter_by(checklist_version_id=existing.id).count(),
                'document_types': db.query(DocumentTypeRule).filter_by(checklist_version_id=existing.id).count(),
                'already_imported': True, 'content_unchanged': True, 'change_summary': {}}
    try:
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=False, keep_links=False)
    except Exception as exc:
        raise ValueError('The master workbook is corrupt or unreadable.') from exc
    rules = _parse_rules(workbook)
    documents = _parse_documents(workbook, {rule['practice_area'] for rule in rules})
    active = db.scalar(select(ChecklistVersion).where(ChecklistVersion.is_active.is_(True)).order_by(ChecklistVersion.id.desc()))
    summary = _change_summary(db, active, rules, documents)
    if active and not _has_substantive_change(summary):
        return {
            'checklist_version_id': active.id, 'version': active.version,
            'rules': len(rules), 'document_types': len(documents), 'already_imported': True,
            'content_unchanged': True, 'change_summary': summary,
        }
    version_name = f'CMMI-V3-{date.today().isoformat()}-{digest[:8]}'
    version = ChecklistVersion(version=version_name, source=filename[:255], checksum=digest, framework='CMMI v3.0',
                               status='VALIDATED', effective_from=date.today(), is_active=False)
    db.add(version); db.flush()
    db.add_all([CmmiRule(checklist_version_id=version.id, rule_id=item['rule_id'], practice_area_code=item['practice_area'],
                         level=item['level'], audit_check=item['audit_check'], gap_text=item['gap_text']) for item in rules])
    db.add_all([DocumentTypeRule(checklist_version_id=version.id, **item) for item in documents])
    if activate:
        activate_rule_catalog(db, version.id)
    return {'checklist_version_id': version.id, 'version': version.version, 'rules': len(rules),
            'document_types': len(documents), 'already_imported': False,
            'content_unchanged': False, 'change_summary': summary}
