from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from app.core.audit_log import log_action
from app.core.config import get_settings
from app.db.models import (AuditSession, AuditSessionPracticeArea, CmmiRule, DocumentTypeRule,
                           EvidenceFile, EvidenceSource, Finding, FindingEvidence, PracticeArea, ScanJob)
from app.services.document_processing.extractors import extract_text
from app.services.evidence_ingestion import (
    INACTIVE_EVIDENCE_STATUSES, evidence_content_identity,
    mark_session_duplicate_evidence,
)
from app.services.document_processing.tabular import cell_text, read_tabular_sheets
from app.services.audit_engine.evidence_validation import (
    build_tabular_context, classify_document, generate_gap_report,
    tabular_context_summary, validate_evidence,
)


TABULAR_SUFFIXES = ('.xlsx', '.xls', '.csv')


def _unique_nonblank_keys(values: object) -> list[str]:
    """Normalize persisted-key candidates without splitting scalar strings."""
    if values is None:
        candidates = []
    elif isinstance(values, (str, bytes)):
        candidates = [values]
    elif isinstance(values, (list, tuple, set)):
        candidates = values
    else:
        candidates = [values]
    keys, seen = [], set()
    for value in candidates:
        key = cell_text(value).strip()
        normalized = key.casefold()
        if key and normalized not in seen:
            keys.append(key)
            seen.add(normalized)
    return keys


def _extraction_failed(text: str) -> bool:
    """Keep unreadable evidence auditable instead of marking it processed."""
    return (text or '').startswith((
        '[Extraction error:', '[OCR error:', '[OCR unavailable:',
        '[Unsupported legacy format:', '[Unsupported Office package:',
    ))


def _stored_evidence_path(storage_path: str) -> str:
    """Resolve a stored path and prove that it remains under the upload root."""
    upload_root = get_settings().upload_dir.resolve()
    candidate = (upload_root.parent / storage_path).resolve()
    try:
        candidate.relative_to(upload_root)
    except ValueError as exc:
        raise ValueError('Stored evidence path is outside the configured upload directory.') from exc
    return str(candidate)


def _document_structure(path: str) -> dict:
    if not path.lower().endswith(TABULAR_SUFFIXES):
        return {'is_spreadsheet': False}
    try:
        sheets = read_tabular_sheets(path, data_only=False)
        headers, header_rows, populated_rows = [], [], 0
        for sheet_name, source_rows in sheets:
            rows = [row for row in source_rows if any(cell_text(value).strip() for value in row)]
            # Titles, merged cells, and multi-level column headings commonly
            # occupy several initial rows. Preserve a bounded candidate set;
            # the classifier still reads the full extracted workbook body.
            for row_index, row in enumerate(rows[:100]):
                values = [cell_text(value).strip() for value in row if cell_text(value).strip()]
                if values:
                    headers.extend(values)
                    header_rows.append({'sheet': sheet_name, 'row_index': row_index, 'values': values})
            populated_rows += max(0, len(rows) - 1)
        return {'is_spreadsheet': True, 'sheet_names': [name for name, _ in sheets],
                'headers': headers, 'header_rows': header_rows, 'populated_rows': populated_rows}
    except Exception:
        return {'is_spreadsheet': True, 'headers': [], 'populated_rows': 0}


def _load_catalog(db: Session, checklist_version_id: int) -> tuple[list[dict], list[dict]]:
    rules = [{'rule_id': item.rule_id, 'practice_area': item.practice_area_code, 'level': item.level,
              'is_gate': item.level.lower() == 'l1-gate', 'is_check': item.level.lower() == 'l3-check',
              'is_probe': item.level.lower() == 'l4-probe', 'audit_check': item.audit_check,
              'gap_text': item.gap_text, 'document_type_rule_id': item.document_type_rule_id,
              'condition': item.applicability_condition, 'detection': item.detection,
              'recommendation': item.recommendation,
              'is_mandatory': item.is_mandatory}
             for item in db.scalars(select(CmmiRule).where(CmmiRule.checklist_version_id == checklist_version_id)).all()]
    documents = [{'document_type_rule_id': item.id,
                  'document_type': item.document_type, 'practice_areas': item.practice_areas or [],
                  'keywords': item.keywords or [], 'aliases': item.aliases or [],
                  'expected_evidence': item.expected_evidence or '',
                  'include_in_afr': bool(item.include_in_afr)}
                 for item in db.scalars(select(DocumentTypeRule).where(
                     DocumentTypeRule.checklist_version_id == checklist_version_id,
                     DocumentTypeRule.include_in_afr.is_(True),
                 )).all()]
    if not rules:
        raise ValueError('The selected ruleset contains no audit rules.')
    if not documents:
        raise ValueError('The selected ruleset contains no active document-type rules.')
    return rules, documents


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
        # The SAP master already contains the governed field controls. The
        # generic document-key completeness rows are only classification
        # diagnostics and can contradict valid aliases such as UT ID/Test ID
        # or an all-Pass test set with no Fail column. Do not turn them into
        # AFR findings for a SAP evidence ruleset.
        has_document_specific_sap_controls = any(
            rule.get('document_type_rule_id') is not None for rule in rules
        )
        existing_duplicate_files = db.scalar(select(func.count(EvidenceFile.id)).join(EvidenceSource).where(
            EvidenceSource.audit_session_id == audit_session_id,
            EvidenceFile.processing_status == 'duplicate',
        )) or 0
        duplicate_files_skipped = existing_duplicate_files + mark_session_duplicate_evidence(db, audit_session_id)
        files = db.scalars(select(EvidenceFile).join(EvidenceSource).where(
            EvidenceSource.audit_session_id == audit_session_id,
            EvidenceFile.processing_status.notin_(INACTIVE_EVIDENCE_STATUSES),
        ).order_by(EvidenceFile.id)).all()
        if not files:
            raise ValueError('No evidence files have been uploaded for this project.')
        source_uri_by_id = dict(db.execute(select(EvidenceSource.id, EvidenceSource.source_uri).where(
            EvidenceSource.audit_session_id == audit_session_id,
        )).all())
        job = db.get(ScanJob, job_id)
        job.result_summary = {'phase': 'processing', 'files_total': len(files), 'files_processed': 0, 'current_file': None}
        db.commit()
        validations: list[tuple[EvidenceFile, dict]] = []
        seen_evidence_identities = set()
        for file_number, evidence in enumerate(files, start=1):
            # Office automation requires an absolute path; relative paths are
            # resolved against Word's process directory rather than the app.
            workbook_path = _stored_evidence_path(evidence.storage_path)
            extracted = extract_text(workbook_path)
            evidence.extracted_text = extracted
            failed = _extraction_failed(extracted)
            evidence.processing_status = 'error' if failed else 'processed'
            classification = classify_document('' if failed else extracted, evidence.relative_path, document_types, _document_structure(workbook_path))
            evidence_identity = evidence_content_identity(
                evidence.relative_path, evidence.sha256, source_uri_by_id.get(evidence.source_id),
            )
            if evidence_identity in seen_evidence_identities:
                classification['document_role'] = 'DUPLICATE'
            else:
                seen_evidence_identities.add(evidence_identity)
            classification['evidence_file_id'] = evidence.id
            tabular_context = build_tabular_context(workbook_path, classification) if not failed else None
            if tabular_context:
                classification['tabular_assessment'] = tabular_context_summary(tabular_context)
            # Store the user-facing classification once the content has been
            # extracted.  The view must never guess from an unprocessed file.
            evidence.classification_json = classification
            evidence.classified_at = datetime.now(timezone.utc)
            validations.append((evidence, validate_evidence(
                '' if failed else extracted, classification, rules, tabular_context
            )))
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
        # The approved document catalogue is the scan scope. Once a document
        # maps to TS/RDM/etc., assess only that mapped practice area's CMMI
        # questions. Do not generate project-wide gaps for unrelated areas.
        scoped_practice_areas = {
            code
            for _, validation in validations
            if (validation['classification'].get('document_type_rule_id')
                and validation['classification'].get('afr_eligible')
                and validation['classification'].get('document_role') == 'PROJECT_IMPLEMENTATION_EVIDENCE')
            for code in validation['classification'].get('practice_areas', [])
        }
        scoped_document_type_ids = {
            validation['classification'].get('document_type_rule_id')
            for _, validation in validations
            if (validation['classification'].get('document_type_rule_id')
                and validation['classification'].get('afr_eligible')
                and validation['classification'].get('document_role') == 'PROJECT_IMPLEMENTATION_EVIDENCE')
        }
        # SAP controls are tied to one evidence type.  Legacy CMMI rules
        # remain area-scoped, but must not leak into a document-specific scan.
        scoped_rules = [rule for rule in rules if (
            rule.get('document_type_rule_id') in scoped_document_type_ids
            if rule.get('document_type_rule_id') is not None
            else rule['practice_area'] in scoped_practice_areas
        )]
        report = generate_gap_report([validation for _, validation in validations], scoped_rules)
        db.execute(update(Finding).where(Finding.audit_session_id == audit_session_id, Finding.status == 'open').values(status='superseded'))
        results: list[tuple[object, list[int]]] = []

        def append_result(result: dict, evidence_file_ids: list[int],
                          finding_kind: str = 'rule_assessment',
                          document_type_rule_id: int | None = None) -> None:
            status = result['status']
            available_keys = _unique_nonblank_keys(result.get('found_evidence'))
            missing_required_keys = _unique_nonblank_keys(result.get('missing_evidence'))
            required_keys = _unique_nonblank_keys(result.get('required_evidence'))
            if not required_keys:
                required_keys = _unique_nonblank_keys([result.get('detection'), result.get('audit_check')])
            results.append((type('R', (), {'rule_id':result['rule_id'], 'practice_area':result['practice_area'],
                'finding_kind': finding_kind, 'document_type_rule_id': document_type_rule_id,
                'severity':'major' if status in {'MISSING','BLOCKED'} else 'minor',
                'title':result.get('title') or f"{status.title()} evidence for {result['rule_id']}",
                'description':result['gap_text'],
                'recommendation':result['recommendation'], 'required_keys':required_keys,
                'available_keys':available_keys, 'missing_required_keys':missing_required_keys})(), evidence_file_ids))

        # Persist direct assessments per evidence file. Aggregating different
        # document types into one row lets a non-AFR file strengthen a result
        # later reported against an AFR-eligible file and obscures provenance.
        for evidence, validation in validations:
            for result in generate_gap_report([validation])['evidence_gap_report']:
                append_result(
                    result, [evidence.id],
                    document_type_rule_id=validation['classification'].get('document_type_rule_id'),
                )

            classification = validation['classification']
            if (not has_document_specific_sap_controls and classification.get('afr_eligible') and
                    classification.get('document_type_rule_id') and
                    classification.get('document_role') == 'PROJECT_IMPLEMENTATION_EVIDENCE'):
                required = classification.get('required_keywords') or []
                available = classification.get('matched_keywords') or []
                missing = classification.get('missed_keywords') or []
                if missing:
                    document_type = classification['detected_type']
                    for practice_area in classification.get('practice_areas') or ['UNCLASSIFIED']:
                        ratio = len(missing) / max(1, len(required))
                        append_result({
                            'rule_id': f"DOC-{classification['document_type_rule_id']}",
                            'practice_area': practice_area,
                            'status': 'MISSING' if ratio >= .5 else 'PARTIAL',
                            'title': f'Incomplete {document_type}',
                            'required_evidence': required,
                            'found_evidence': available,
                            'missing_evidence': missing,
                            'gap_text': (
                                f'{document_type} matched from the document body, but only '
                                f'{len(available)} of {len(required)} configured evidence keys were found.'
                            ),
                            'recommendation': (
                                f'Update {document_type} with the missing governed evidence keys: '
                                f'{", ".join(missing)}.'
                            ),
                        }, [evidence.id], finding_kind='document_catalogue',
                           document_type_rule_id=classification['document_type_rule_id'])

        # Catalogue coverage remains project-level and deliberately carries no
        # file link. It remains in the AFR as an absence-based finding.
        for result in report['evidence_gap_report']:
            if not result.get('evidence_file_ids'):
                append_result(result, [], finding_kind='coverage_gap')
        # A rule-level report cannot represent a document type that has no
        # mapped file at all when its rules were not in the per-file scope.
        # Persist one explicit, catalogue-backed coverage finding per absent
        # governed artefact. This avoids both the historic blindspot (zero
        # finding for a deleted file) and a noisy row for every control that
        # would have been evaluated inside that absent document.
        for document_type in document_types:
            document_type_id = document_type['document_type_rule_id']
            if document_type_id in scoped_document_type_ids:
                continue
            practice_areas = document_type.get('practice_areas') or []
            document_name = document_type['document_type']
            expected_evidence = document_type.get('expected_evidence') or document_name
            append_result({
                'rule_id': f'DOC-COVERAGE-{document_type_id}',
                'practice_area': practice_areas[0] if practice_areas else 'UNCLASSIFIED',
                'status': 'MISSING',
                'title': f'Missing required document: {document_name}',
                'required_evidence': [document_name],
                'found_evidence': [],
                'missing_evidence': [
                    f'No uploaded file was classified as {document_name}.'
                ],
                'gap_text': (
                    f'The governed document type {document_name} was not matched in the '
                    'uploaded audit evidence.'
                ),
                'recommendation': (
                    f'Upload the required {document_name} evidence: {expected_evidence}.'
                ),
            }, [], finding_kind='coverage_gap', document_type_rule_id=document_type_id)
        for evidence in files:
            if evidence.processing_status == 'error':
                results.append((type('R', (), {'rule_id':'FILE-PARSE', 'practice_area':'UNCLASSIFIED', 'severity':'major',
                    'finding_kind':'file_parse', 'document_type_rule_id':None,
                    'title':f'Could not parse {evidence.relative_path}', 'description':evidence.extracted_text,
                    'recommendation':'Provide a supported, valid, unencrypted document and rerun the scan.',
                    'required_keys':['Readable supported document content'], 'available_keys':[],
                    'missing_required_keys':['Document content could not be extracted']})(), [evidence.id]))
            # Document-type mapping above is the only route into checklist
            # validation.  Filename-triggered IRP/RCA/SLA validators made an
            # unrelated workbook produce findings outside its catalogue scope.

    # Persist the same folder/evidence availability that the dashboard shows.
    # A scan is authoritative for this audit session; before its first scan the
    # values remain ``not_scanned`` so the UI never represents guesses as facts.
        classified_codes = scoped_practice_areas
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
                # This scan did not assess an unrelated practice area. Mark it
                # as not-scanned rather than presenting an artificial gap.
                session_pa.folder_status = 'not_scanned'; session_pa.evidence_status = 'not_scanned'
        for result, evidence_file_ids in results:
            finding = Finding(audit_session_id=audit_session_id, rule_id=result.rule_id,
                          finding_kind=getattr(result, 'finding_kind', 'rule_assessment'),
                          document_type_rule_id=getattr(result, 'document_type_rule_id', None),
                          practice_area_code=result.practice_area,
                          severity=result.severity, title=result.title, description=result.description,
                          recommendation=result.recommendation, required_keys=getattr(result, 'required_keys', []),
                          available_keys=getattr(result, 'available_keys', []),
                          missing_required_keys=getattr(result, 'missing_required_keys', []), created_by_id=user_id)
            db.add(finding); db.flush()
            for evidence_file_id in evidence_file_ids:
                db.add(FindingEvidence(finding_id=finding.id, evidence_file_id=evidence_file_id))
        evidence_findings_created = sum(1 for _, evidence_file_ids in results if evidence_file_ids)
        coverage_gaps_created = len(results) - evidence_findings_created
        audit.status='scanned'; job=db.get(ScanJob, job_id); job.status='completed'
        job.result_summary={'files_processed':len(files), 'findings_created':len(results),
                            'evidence_findings_created': evidence_findings_created,
                            'coverage_gaps_created': coverage_gaps_created,
                            'duplicate_files_skipped': duplicate_files_skipped,
                            'gap_summary':report['gap_summary']}
        log_action(db, 'evidence_scan_completed', user_id=user_id, entity_type='audit_session',
                   entity_id=str(audit_session_id), detail=(
                       f'scan_job_id={job_id}; files_processed={len(files)}; findings_created={len(results)}; '
                       f'evidence_findings_created={evidence_findings_created}; coverage_gaps_created={coverage_gaps_created}; '
                       f'duplicate_files_skipped={duplicate_files_skipped}'
                   ))
        db.commit()
        return {'audit_session_id': audit_session_id, 'files_processed':len(files), 'findings_created':len(results),
                'evidence_findings_created': evidence_findings_created,
                'coverage_gaps_created': coverage_gaps_created,
                'duplicate_files_skipped': duplicate_files_skipped,
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
