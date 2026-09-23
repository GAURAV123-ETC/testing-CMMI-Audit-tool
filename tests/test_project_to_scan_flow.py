from pathlib import Path


def test_project_setup_uses_a_native_calendar_input():
    source = Path('app/gui/pages/add_project.py').read_text(encoding='utf-8')

    assert "ui.input('Audit date (optional)').props('type=date')" in source


def test_legacy_audit_workspace_uses_a_native_calendar_input():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')

    assert "ui.input('Audit date (optional)').props('type=date')" in source


def test_remediation_due_dates_are_managed_through_the_findings_api():
    source = Path('app/api/endpoints/audits.py').read_text(encoding='utf-8')

    assert 'due_at: datetime | None' in source
    assert "@router.patch('/remediation-actions/{action_id}')" in source
