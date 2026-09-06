from io import BytesIO
from openpyxl import Workbook
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.models import ChecklistVersion, CmmiRule, DocumentTypeRule
from app.services.rule_catalog_importer import activate_rule_catalog, import_rule_catalog


def workbook_bytes(duplicate=False, audit_check='Locate Risk Register.'):
    book=Workbook(); master=book.active; master.title='MASTER'
    master.append(['#','Level','Rule ID','Gate / Artefact','Audit Check (What the auditor looks for and verifies)','Conformance','If NO: Finding and Implication'])
    master.append([1,'L1-Gate','RSK-G1','Artefact',audit_check,'', 'Risk Register missing.'])
    if duplicate: master.append([2,'L3-Check','RSK-G1','', 'Check risks.','', 'Risks incomplete.'])
    s2=book.create_sheet('Sheet2'); s2.append(['S. No.','Domain Name','Practice Area Name','Related Document Name','Main Keywords','Example Evidence / Example Document']); s2.append([1,'Development','Risk Management (RSK)','Risk Register','Risk ID, Probability, Impact, Owner, Mitigation','Current risk register'])
    s5=book.create_sheet('Sheet5'); s5.append(['Sr. No.','Document / Evidence','Related Practice Area','What to Check / Key Points','Expected Evidence']); s5.append([1,'Risk Register','RSK','Risk ID, Probability, Impact, Owner','Updated risk register'])
    s6=book.create_sheet('Sheet6'); s6.append(['Document / Evidence','Primary Purpose']); s6.append(['Risk Register','Manage risks'])
    output=BytesIO(); book.save(output); return output.getvalue()


def test_import_validates_then_explicitly_activates_immutable_catalog():
    engine=create_engine('sqlite://'); Base.metadata.create_all(engine); factory=sessionmaker(bind=engine)
    with factory() as db:
        result=import_rule_catalog(db,'master.xlsx',workbook_bytes()); db.commit()
        version=db.get(ChecklistVersion,result['checklist_version_id'])
        document=db.scalar(select(DocumentTypeRule))
        assert version.status == 'VALIDATED' and not version.is_active
        assert db.scalar(select(CmmiRule.rule_id)) == 'RSK-G1'
        assert document.practice_areas == ['RSK'] and 'Mitigation' in document.keywords
        activate_rule_catalog(db, version.id); db.commit()
        assert db.get(ChecklistVersion, version.id).status == 'ACTIVE'


def test_small_text_change_creates_a_validated_version_without_replacing_active_rules():
    engine=create_engine('sqlite://'); Base.metadata.create_all(engine); factory=sessionmaker(bind=engine)
    with factory() as db:
        active = import_rule_catalog(db, 'master.xlsx', workbook_bytes(), activate=True)
        db.commit()
        candidate = import_rule_catalog(db, 'master-updated.xlsx', workbook_bytes(
            audit_check='Locate the approved Risk Register.'
        ))
        db.commit()
        active_version = db.get(ChecklistVersion, active['checklist_version_id'])
        candidate_version = db.get(ChecklistVersion, candidate['checklist_version_id'])
        assert active_version.is_active and active_version.status == 'ACTIVE'
        assert not candidate_version.is_active and candidate_version.status == 'VALIDATED'
        assert candidate['change_summary']['rules_changed'] == 1


def test_invalid_catalog_does_not_create_or_activate_version():
    engine=create_engine('sqlite://'); Base.metadata.create_all(engine); factory=sessionmaker(bind=engine)
    with factory() as db:
        try: import_rule_catalog(db,'master.xlsx',workbook_bytes(duplicate=True))
        except ValueError as exc: assert 'Duplicate Rule ID' in str(exc)
        else: raise AssertionError('invalid workbook was accepted')
        assert db.scalar(select(ChecklistVersion.id)) is None
