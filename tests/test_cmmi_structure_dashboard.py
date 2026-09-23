from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.database import Base
from app.db.init_db import _remove_retired_dashboard_reference_data
from app.db.models import (
    AuditProject, AuditSession, ChecklistVersion, Customer, EvidenceFile,
    EvidenceSource, Finding, PracticeArea, User, CmmiDomain,
    CmmiDomainPracticeArea, CmmiModelProfile,
)
from app.gui.pages.dashboard import _add_chart_toolbox, _dashboard_revision, _live_dashboard_data, _reset_chart_zoom


def test_dashboard_chart_toolbox_keeps_only_reset_and_export_actions():
    project_options = _add_chart_toolbox({}, 'yAxisIndex')
    practice_options = _add_chart_toolbox({}, 'xAxisIndex')

    assert 'dataZoom' not in project_options['toolbox']['feature']
    assert project_options['toolbox']['feature'] == practice_options['toolbox']['feature']
    assert set(project_options['toolbox']['feature']) == {'restore', 'saveAsImage'}


def test_dashboard_zoom_out_resets_all_chart_data_zoom_controls():
    class Chart:
        calls = []

        def run_chart_method(self, name, *args):
            self.calls.append((name, args))

    chart = Chart()
    _reset_chart_zoom(chart)

    assert chart.calls == [('dispatchAction', ({'type': 'dataZoom', 'start': 0, 'end': 100},))]


def test_dashboard_uses_current_operational_records_not_seeded_taxonomy():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add_all([
            User(id=1, email='active@example.com', display_name='Active', password_hash='hash', is_active=True),
            User(id=2, email='disabled@example.com', display_name='Disabled', password_hash='hash', is_active=False),
            Customer(id=1, name='Customer A', created_by_id=1),
            AuditProject(id=1, customer_id=1, name='Project A', owner_id=1),
            ChecklistVersion(id=1, version='rules-1', source='test', checksum='a' * 64),
            PracticeArea(id=1, code='RDM', name='Requirements Development & Management'),
            AuditSession(id=1, project_id=1, checklist_version_id=1, status='scanned', created_by_id=1),
            EvidenceSource(id=1, audit_session_id=1, source_type='test', created_by_id=1),
            EvidenceFile(id=1, source_id=1, relative_path='project/change-log.xlsx', storage_path='uploads/1/change-log.xlsx',
                         sha256='b' * 64, size_bytes=10),
            Finding(id=1, audit_session_id=1, rule_id='CR-01', practice_area_code='RDM', severity='major',
                    title='Duplicate ID', description='Duplicate CR ID', recommendation='Correct the ID', status='open'),
        ])
        db.commit()

        data = _live_dashboard_data(db)
        db.add(Finding(id=2, audit_session_id=1, rule_id='CR-02', practice_area_code='RDM', severity='minor',
                       title='New finding', description='Added after the first dashboard snapshot', recommendation='Review', status='open'))
        db.commit()
        refreshed_data = _live_dashboard_data(db)
    finally:
        db.close()

    assert data['total_users'] == 2
    assert data['active_users'] == 1
    assert data['projects'] == 1
    assert data['sessions'] == 1
    assert data['scanned_sessions'] == 1
    assert data['open_findings'] == 1
    assert data['evidence_files'] == 1
    assert data['project_rows'][0].name == 'Project A'
    assert data['project_rows'][0].open_findings == 1
    assert data['practice_rows'][0].practice_area_code == 'RDM'
    assert refreshed_data['open_findings'] == 2
    assert refreshed_data['project_rows'][0].open_findings == 2
    assert refreshed_data['practice_rows'][0].open == 2


def test_dashboard_uses_only_the_latest_scanned_session_for_project_findings():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add_all([
            User(id=1, email='auditor@example.com', display_name='Auditor', password_hash='hash'),
            Customer(id=1, name='Customer A', created_by_id=1),
            AuditProject(id=1, customer_id=1, name='Gamma', owner_id=1),
            ChecklistVersion(id=1, version='rules-1', source='test', checksum='a' * 64),
            AuditSession(id=1, project_id=1, checklist_version_id=1, status='scanned', created_by_id=1,
                         updated_at=datetime(2026, 9, 17, tzinfo=timezone.utc)),
            AuditSession(id=2, project_id=1, checklist_version_id=1, status='scanned', created_by_id=1,
                         updated_at=datetime(2026, 9, 16, tzinfo=timezone.utc)),
            Finding(id=1, audit_session_id=1, rule_id='CR-01', practice_area_code='RDM', severity='major',
                    title='Current rescan finding', description='Chart the most recently completed scan.', recommendation='Correct', status='open'),
            Finding(id=2, audit_session_id=2, rule_id='OLD-01', practice_area_code='RDM', severity='major',
                    title='Historical finding', description='Do not chart this older completed scan.', recommendation='Ignore', status='open'),
        ])
        db.commit()
        data = _live_dashboard_data(db)
    finally:
        db.close()

    assert data['open_findings'] == 1
    assert data['project_rows'][0].name == 'Gamma'
    assert data['project_rows'][0].findings == 1
    assert data['project_rows'][0].open_findings == 1


def test_dashboard_revision_changes_when_new_evidence_or_findings_are_stored():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add_all([
            User(id=1, email='auditor@example.com', display_name='Auditor', password_hash='hash'),
            Customer(id=1, name='Customer A', created_by_id=1),
            AuditProject(id=1, customer_id=1, name='Gamma', owner_id=1),
            ChecklistVersion(id=1, version='rules-1', source='test', checksum='a' * 64),
            AuditSession(id=1, project_id=1, checklist_version_id=1, status='scanned', created_by_id=1),
        ])
        db.commit()
        before = _dashboard_revision(db)
        db.add(Finding(id=1, audit_session_id=1, rule_id='CR-01', practice_area_code='RDM', severity='major',
                       title='New finding', description='Stored after page load.', recommendation='Correct', status='open'))
        db.commit()
        after = _dashboard_revision(db)
    finally:
        db.close()

    assert after != before


def test_dashboard_revision_changes_when_rendered_customer_data_changes():
    """A renamed customer must refresh the project chart/table labels."""
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add_all([
            User(id=1, email='auditor@example.com', display_name='Auditor', password_hash='hash'),
            Customer(id=1, name='Customer A', created_by_id=1),
            AuditProject(id=1, customer_id=1, name='Gamma', owner_id=1),
            ChecklistVersion(id=1, version='rules-1', source='test', checksum='a' * 64),
            AuditSession(id=1, project_id=1, checklist_version_id=1, status='scanned', created_by_id=1),
        ])
        db.commit()
        before = _dashboard_revision(db)
        customer = db.get(Customer, 1)
        customer.name = 'Customer Renamed'
        db.commit()
        after = _dashboard_revision(db)
    finally:
        db.close()

    assert after != before


def test_retired_dashboard_cleanup_preserves_operational_data():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        db.add_all([
            User(id=1, email='auditor@example.com', display_name='Auditor', password_hash='hash'),
            Customer(id=1, name='Customer A', created_by_id=1),
            AuditProject(id=1, customer_id=1, name='Project A', owner_id=1),
            ChecklistVersion(id=1, version='rules-1', source='test', checksum='a' * 64),
            AuditSession(id=1, project_id=1, checklist_version_id=1, created_by_id=1),
            PracticeArea(id=1, code='RDM', name='Requirements', category='Doing',
                         capability_area='Static taxonomy', total_practices=9, is_core=True),
            CmmiModelProfile(id=1, model_version='CMMI-3', source='static', total_domains=1,
                             total_practice_areas=1, core_practice_area_count=1,
                             domain_specific_practice_area_count=0, practice_group_levels='1', maturity_levels='1'),
            CmmiDomain(id=1, code='DEV', name='Development', capability_description='Static taxonomy'),
            Finding(id=1, audit_session_id=1, practice_area_code='RDM', severity='major',
                    title='Stored finding', description='Stored finding', recommendation='Fix it'),
        ])
        db.flush()
        db.add(CmmiDomainPracticeArea(domain_id=1, practice_area_id=1))
        db.commit()

        _remove_retired_dashboard_reference_data(db)
        db.commit()

        assert db.query(CmmiModelProfile).count() == 0
        assert db.query(CmmiDomain).count() == 0
        assert db.query(CmmiDomainPracticeArea).count() == 0
        area = db.get(PracticeArea, 1)
        assert area.code == 'RDM'
        assert area.total_practices is None
        assert area.is_core is False
        assert db.get(AuditProject, 1).name == 'Project A'
        assert db.get(AuditSession, 1).id == 1
        assert db.get(Finding, 1).title == 'Stored finding'
    finally:
        db.close()
