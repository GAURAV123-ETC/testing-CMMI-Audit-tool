import json
from pathlib import Path
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from app.db.database import Base
from app.db.init_db import _rename_change_log_fsd_catalogue
from app.db.models import ChecklistVersion, CmmiRule, DocumentTypeRule, Finding
from app.services.audit_engine.irp_validation import ISSUE_LOG_FIELDS
def test_rule_seed_has_all_master_rules():
    rules=json.loads((Path('app/db/seed_data/cmmi_rules.json')).read_text())
    assert len(rules) == 302
    assert len({r['rule_id'] for r in rules}) == len(rules)
def test_irp_has_24_required_fields(): assert len(ISSUE_LOG_FIELDS) == 24


def test_incident_log_two_months_document_type_is_seeded_for_afr():
    documents = json.loads((Path('app/db/seed_data/document_types.json')).read_text(encoding='utf-8'))
    incident = next(item for item in documents if item['document_type'] == 'Incident Log – 2 Months')

    assert incident['practice_areas'] == ['IRP']
    assert incident['keywords'] == [
        'Incident ID', 'Date', 'Priority', 'Impact', 'Urgency', 'Category',
        'SLA', 'Resolution', 'Status', 'Issue Description', 'Issue status', 'Closer date',
    ]
    assert incident['aliases'] == ['Incident Log – 2 Months']
    assert incident['expected_evidence'] == '2-month Incident Log'
    assert incident['primary_purpose'] is None
    assert incident['include_in_afr'] is True


def test_seed_catalogue_contains_the_active_afr_document_types():
    documents = json.loads((Path('app/db/seed_data/document_types.json')).read_text(encoding='utf-8'))
    by_name = {item['document_type']: item for item in documents}

    assert len(documents) == 14
    assert all(item['include_in_afr'] is True for item in documents)
    technical_design = by_name['Impact Analysis and TSD']
    assert technical_design['practice_areas'] == ['TS']
    assert 'Technical Solution Design' in technical_design['aliases']
    assert technical_design['include_in_afr'] is True


def test_change_log_fsd_rename_merges_legacy_duplicate_and_preserves_references():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        version = ChecklistVersion(version='test', source='test', checksum='x')
        db.add(version); db.flush()
        legacy = DocumentTypeRule(
            checklist_version_id=version.id, document_type='change request log/FSD',
            practice_areas=['RDM'], keywords=['Change ID'], aliases=['FSD'], include_in_afr=True,
        )
        canonical = DocumentTypeRule(
            checklist_version_id=version.id, document_type='Change Log / FSD',
            practice_areas=['RDM'], keywords=['Change ID'], aliases=['Change Request'], include_in_afr=True,
        )
        db.add_all([legacy, canonical]); db.flush()
        rule = CmmiRule(
            checklist_version_id=version.id, rule_id='CR-01', practice_area_code='RDM',
            level='L3-Check', audit_check='Change is logged.', gap_text='Change missing.',
            document_type_rule_id=legacy.id,
        )
        finding = Finding(
            audit_session_id=1, finding_kind='rule_assessment', document_type_rule_id=legacy.id,
            practice_area_code='RDM', severity='major', title='Legacy', description='Legacy',
            recommendation='Update', status='open',
        )
        db.add_all([rule, finding]); db.flush()

        _rename_change_log_fsd_catalogue(db)
        db.flush()

        documents = db.scalars(select(DocumentTypeRule)).all()
        assert len(documents) == 1
        assert documents[0].document_type == 'Change Log / FSD'
        assert {'Change Log / FSD', 'change request log/FSD', 'FSD'} <= set(documents[0].aliases)
        assert db.get(CmmiRule, rule.id).document_type_rule_id == documents[0].id
        assert db.get(Finding, finding.id).document_type_rule_id == documents[0].id
