from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session
from app.core.audit_log import log_action
from app.core.config import get_settings
from app.db.models import (AuditSession, AuditSessionPracticeArea, CmmiRule, DocumentTypeRule,
                           EvidenceFile, EvidenceSource, Finding, FindingEvidence, PracticeArea, ScanJob)
from app.services.document_processing.extractors import extract_text
from app.services.document_processing.tabular import read_tabular_sheets
from app.services.audit_engine.evidence_validation import classify_document, generate_gap_report, validate_evidence
from app.services.audit_engine.irp_validation import incident_context, validate_incident_log
from app.services.audit_engine.rca_validation import validate_lessons_learned_workbook, validate_rca_workbook
from app.services.audit_engine.risk_sla_validation import validate_risk_sla


TABULAR_SUFFIXES = ('.xlsx', '.xls', '.csv')
SPECIALIST_NAME_HINTS = {
    'incident': ('incident log', 'issue log', 'incident register', 'incident tracker',
                 'incident management log', 'irp log', 'issue register', 'issue tracker'),
    'rca': ('rca', 'root cause analysis', 'root cause', '5 why', '5-why', 'five why',
            'corrective action analysis'),
    'lesson': ('lesson learned', 'lessons learned', 'lessons learnt', 'learning register',
               'incident learning', 'iro learning'),
}


def _is_specialist_file(evidence: EvidenceFile, category: str) -> bool:
    """Match the legacy IRP file-name vocabulary without relying on one exact name."""
    path = evidence.relative_path.lower()
    return path.endswith(TABULAR_SUFFIXES) and any(hint in path for hint in SPECIALIST_NAME_HINTS[category])


def _extraction_failed(text: str) -> bool:
    """Keep unreadable evidence auditable instead of marking it processed."""
    return (text or '').startswith(('[Extraction error:', '[OCR error:', '[OCR unavailable:', '[Unsupported legacy format:'))


def _run_specialized_validator(validator, path: str, label: str) -> list[dict]:
    """Keep one malformed specialist workbook from aborting the whole scan."""
    try:
        return validator(path)
    except Exception:
        return [{'rule_id': 'IRP-VALIDATION-ERROR', 'severity': 'major',
                 'title': f'{label} validation could not read the evidence',
                 'description': 'The specialized tabular validator could not safely read this evidence file.',
                 'recommendation': 'Provide a valid, unencrypted CSV, XLS, or XLSX workbook and rerun the scan.'}]


def _document_structure(path: str) -> dict:
    if not path.lower().endswith(TABULAR_SUFFIXES):
        return {'is_spreadsheet': False}
    try:
        sheets = read_tabular_sheets(path, data_only=False)
        headers, populated_rows = [], 0
        for _, source_rows in sheets:
            rows = [row for row in source_rows if any(str(value or '').strip() for value in row)]
            if rows:
                headers.extend(str(value or '') for value in rows[0] if str(value or '').strip())
            populated_rows += max(0, len(rows) - 1)
        return {'is_spreadsheet': True, 'sheet_names': [name for name, _ in sheets],
                'headers': headers, 'populated_rows': populated_rows}
    except Exception:
        return {'is_spreadsheet': True, 'headers': [], 'populated_rows': 0}


def _load_catalog(db: Session, checklist_version_id: int) -> tuple[list[dict], list[dict]]:
    rules = [{'rule_id': item.rule_id, 'practice_area': item.practice_area_code, 'level': item.level,
              'is_gate': item.level.lower() == 'l1-gate', 'is_check': item.level.lower() == 'l3-check',
              'is_probe': item.level.lower() == 'l4-probe', 'audit_check': item.audit_check,
              'gap_text': item.gap_text}
             for item in db.scalars(select(CmmiRule).where(CmmiRule.checklist_version_id == checklist_version_id)).all()]
    documents = [{'document_type': item.document_type, 'practice_areas': item.practice_areas or [],
                  'keywords': item.keywords or [], 'expected_evidence': item.expected_evidence or ''}
                 for item in db.scalars(select(DocumentTypeRule).where(DocumentTypeRule.checklist_version_id == checklist_version_id)).all()]
    if not rules:
        raise ValueError('The selected ruleset contains no audit rules.')
    return rules, documents or None


def scan_session(db: Session, audit_session_id: int, user_id: int) -> dict:
    # Lock the assessment while claiming the job. On MySQL this prevents two
    # web requests from starting the same scan concurrently. Jobs abandoned by
    # a crashed worker are released after a bounded lease.
    audit = db.scalar(select(AuditSession).where(
        AuditSession.id == audit_session_id
    ).with_for_update())
    if not audit: raise ValueError('Audit session not found')
    checklist_version_id = audit.checklist_version_id
    stale_before = datetime.now(timezone.utc) - timedelta(hours=2)
    db.execute(update(ScanJob).where(
        ScanJob.audit_session_id == audit_session_id,
        ScanJob.status == 'running',
        ScanJob.created_at < stale_before,
    ).values(status='failed', result_summary={
        'error': 'Scan worker did not finish before the two-hour lease expired.'
    }))
    running_job = db.scalar(select(ScanJob).where(
        ScanJob.audit_session_id == audit_session_id,
        ScanJob.status == 'running',
    ).order_by(ScanJob.id.desc()))
    if running_job:
        db.rollback()
        raise ValueError(f'An evidence scan is already running for this project (job {running_job.id}).')
    job = ScanJob(audit_session_id=audit_session_id, job_type='master_rule_and_irp_scan', status='running')
    db.add(job); db.flush()
    log_action(db, 'evidence_scan_started', user_id=user_id, entity_type='audit_session',
               entity_id=str(audit_session_id), detail=f'scan_job_id={job.id}')
    db.commit(); job_id = job.id
    try:
        rules, document_types = _load_catalog(db, checklist_version_id)
        files = db.scalars(select(EvidenceFile).join(EvidenceSource).where(EvidenceSource.audit_session_id == audit_session_id).order_by(EvidenceFile.id)).all()
        if not files:
            raise ValueError('No evidence files have been uploaded for this project.')
        job = db.get(ScanJob, job_id)
        job.result_summary = {'phase': 'processing', 'files_total': len(files), 'files_processed': 0, 'current_file': None}
        db.commit()
        validations: list[tuple[EvidenceFile, dict]] = []
        incident_ids, breached_ids, seen_hashes = set(), set(), set()
        for file_number, evidence in enumerate(files, start=1):
            if _is_specialist_file(evidence, 'incident'):
                workbook_path = str(get_settings().upload_dir.parent / evidence.storage_path)
                try:
                    ids, breaches = incident_context(workbook_path)
                    incident_ids.update(ids); breached_ids.update(breaches)
                except Exception:
                    pass
        for evidence in files:
            workbook_path = str(get_settings().upload_dir.parent / evidence.storage_path)
            extracted = extract_text(workbook_path)
            evidence.extracted_text = extracted
            failed = _extraction_failed(extracted)
            evidence.processing_status = 'error' if failed else 'processed'
            classification = classify_document('' if failed else extracted, evidence.relative_path, document_types, _document_structure(workbook_path))
            if evidence.sha256 in seen_hashes:
                classification['document_role'] = 'DUPLICATE'
            else:
                seen_hashes.add(evidence.sha256)
            classification['evidence_file_id'] = evidence.id
            # Store the user-facing classification once the content has been
            # extracted.  The view must never guess from an unprocessed file.
            evidence.classification_json = classification
            evidence.classified_at = datetime.now(timezone.utc)
            validations.append((evidence, validate_evidence('' if failed else extracted, classification, rules)))
            # Commit a compact checkpoint after each file. The UI can report
            # real progress even for a large spreadsheet or document set.
            job = db.get(ScanJob, job_id)
            job.result_summary = {
                'phase': 'processing',
                'files_total': len(files),
                'files_processed': file_number,
                'current_file': evidence.relative_path,
            }
            db.commit()
        report = generate_gap_report([validation for _, validation in validations], rules)
        db.execute(update(Finding).where(Finding.audit_session_id == audit_session_id, Finding.status == 'open').values(status='superseded'))
        results: list[tuple[object, list[int]]] = []
        for result in report['evidence_gap_report']:
            status = result['status']
            results.append((type('R', (), {'rule_id':result['rule_id'], 'practice_area':result['practice_area'],
                'severity':'major' if status in {'MISSING','BLOCKED'} else 'minor',
                'title':f"{status.title()} evidence for {result['rule_id']}", 'description':result['gap_text'],
                'recommendation':result['recommendation']})(), result.get('evidence_file_ids', [])))
        for evidence in files:
            if evidence.processing_status == 'error':
                results.append((type('R', (), {'rule_id':'FILE-PARSE', 'practice_area':'UNCLASSIFIED', 'severity':'major',
                    'title':f'Could not parse {evidence.relative_path}', 'description':evidence.extracted_text,
                    'recommendation':'Provide a supported, valid, unencrypted document and rerun the scan.'})(), [evidence.id]))
            workbook_path = str(get_settings().upload_dir.parent / evidence.storage_path)
            if _is_specialist_file(evidence, 'incident'):
                for finding in _run_specialized_validator(validate_incident_log, workbook_path, 'Incident log'):
                    results.append((type('R', (), {**finding, 'practice_area':'IRP'})(), [evidence.id]))
            if _is_specialist_file(evidence, 'rca'):
                for finding in _run_specialized_validator(lambda path: validate_rca_workbook(path, incident_ids, breached_ids), workbook_path, 'RCA'):
                    results.append((type('R', (), {**finding, 'practice_area':'IRP'})(), [evidence.id]))
            if _is_specialist_file(evidence, 'lesson'):
                for finding in _run_specialized_validator(validate_lessons_learned_workbook, workbook_path, 'Lessons learned'):
                    results.append((type('R', (), {**finding, 'practice_area':'IRP'})(), [evidence.id]))
            path_name = evidence.relative_path.lower()
            is_risk_or_sla = 'risk' in path_name or 'sla' in path_name
            is_governed_issue_register = any(hint in path_name for hint in (
                'issue log', 'issue register', 'issue tracker', 'incident log', 'incident register', 'incident tracker',
            ))
            if path_name.endswith(TABULAR_SUFFIXES) and (is_risk_or_sla or is_governed_issue_register):
                for finding in _run_specialized_validator(validate_risk_sla, workbook_path, 'Risk/issue SLA'):
                    results.append((type('R', (), {**finding, 'practice_area':'IRP'})(), [evidence.id]))

    # Persist the same folder/evidence availability that the dashboard shows.
    # A scan is authoritative for this audit session; before its first scan the
    # values remain ``not_scanned`` so the UI never represents guesses as facts.
        classified_codes = {
        code for _, validation in validations
        for code in validation['classification'].get('practice_areas', [])
        }
        if any(any(_is_specialist_file(evidence, category) for category in SPECIALIST_NAME_HINTS) for evidence in files):
            classified_codes.add('IRP')
        gap_codes = {result.practice_area for result, _ in results}
        pa_codes_by_id = dict(db.execute(select(PracticeArea.id, PracticeArea.code)).all())
        session_pas = db.scalars(select(AuditSessionPracticeArea).where(
        AuditSessionPracticeArea.audit_session_id == audit_session_id
        )).all()
        for session_pa in session_pas:
            code = pa_codes_by_id.get(session_pa.practice_area_id)
            if code in classified_codes:
                session_pa.folder_status = 'available'; session_pa.evidence_status = 'gap' if code in gap_codes else 'available'
            else:
                session_pa.folder_status = 'missing'; session_pa.evidence_status = 'missing'
        for result, evidence_file_ids in results:
            finding = Finding(audit_session_id=audit_session_id, rule_id=result.rule_id, practice_area_code=result.practice_area,
                          severity=result.severity, title=result.title, description=result.description,
                          recommendation=result.recommendation, created_by_id=user_id)
            db.add(finding); db.flush()
            for evidence_file_id in evidence_file_ids:
                db.add(FindingEvidence(finding_id=finding.id, evidence_file_id=evidence_file_id))
        audit.status='scanned'; job=db.get(ScanJob, job_id); job.status='completed'
        job.result_summary={'files_processed':len(files), 'findings_created':len(results), 'gap_summary':report['gap_summary']}
        log_action(db, 'evidence_scan_completed', user_id=user_id, entity_type='audit_session',
                   entity_id=str(audit_session_id), detail=(
                       f'scan_job_id={job_id}; files_processed={len(files)}; findings_created={len(results)}'
                   ))
        db.commit()
        return {'audit_session_id': audit_session_id, 'files_processed':len(files), 'findings_created':len(results),
                'scan_job_id':job_id, 'gap_summary':report['gap_summary']}
    except Exception as exc:
        db.rollback()
        failed_job=db.get(ScanJob, job_id)
        if failed_job:
            failed_job.status='failed'; failed_job.result_summary={'error':str(exc)[:1_000] or type(exc).__name__}
            log_action(db, 'evidence_scan_failed', user_id=user_id, entity_type='audit_session',
                       entity_id=str(audit_session_id), detail=f'scan_job_id={job_id}; error={type(exc).__name__}')
            db.commit()
        raise
