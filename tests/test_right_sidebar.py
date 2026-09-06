from pathlib import Path


def test_left_sidebar_uses_native_responsive_nicegui_drawer():
    source = Path('app/gui/layout.py').read_text(encoding='utf-8')
    assert 'class LeftSidebar' in source
    assert 'ui.left_drawer(value=None, fixed=True, bordered=True)' in source
    assert "with ui.element('nav')" in source
    assert "with ui.column().classes('nav-list" in source
    assert 'ui.right_drawer' not in source
    assert 'EXPANDED_WIDTH = 300' in source
    assert 'COLLAPSED_WIDTH = 72' in source
    assert 'async def toggle' in source
    assert "localStorage.setItem('cmmi_sidebar_expanded'" in source
    assert "localStorage.getItem('cmmi_sidebar_expanded')" in source
    assert "initial_toggle_label = 'Collapse sidebar' if self.expanded else 'Expand sidebar'" in source
    assert 'sidebar-toggle-icon' in source
    assert 'min-width:44px!important' in source
    assert 'prefers-reduced-motion' in source
    assert '.sidebar-collapsed .sidebar-header {justify-content:center!important' in source
    assert '.sidebar-collapsed .nav-scroll::-webkit-scrollbar' in source
    assert '.sidebar-collapsed .account-avatar {width:40px!important' in source
    assert '.sidebar-collapsed .account-row .q-space {display:none!important' in source
    assert '@media (max-width:1023px)' in source
    assert 'mobile-sidebar-toggle' in source
    assert 'aria-label="Open navigation sidebar"' in source
    assert 'async def open_mobile' in source
    assert "self.drawer.props(f'width={EXPANDED_WIDTH}')" in source
    assert "self.drawer.classes(remove='sidebar-collapsed')" in source
    assert 'on_click=sidebar.open_mobile' in source
    assert 'min-height:44px!important; color:#13294b' in source
    assert '.nav-entry:focus-visible' in source
    assert 'aria-label="Primary navigation"' in source
    assert 'aria-current=' in source
    assert 'self.drawer.hide()' in source
    assert 'aria-label="Open account menu"' in source
    assert 'account-avatar-button' in source
    assert "classes('text-xs text-slate-500 uppercase')" in source
    assert "ui.label('CMMI Audit Platform')" in source
    assert "ui.label('NAVIGATION')" not in source
    assert 'AuditGovern' not in source
    assert '.audit-sidebar .nav-label {color:#13294b!important' in source
    assert '.sidebar-collapsed .nav-entry .nav-icon {position:static!important; display:inline-flex!important' in source
    assert '.sidebar-collapsed .nav-list {width:100%!important; min-width:0!important; max-width:none!important' in source
    assert '.sidebar-collapsed .nav-entry {display:flex!important; width:100%!important; min-width:0!important' in source
    assert 'overflow:hidden; min-width:0; visibility:visible; opacity:1' in source
    assert 'visibility:hidden!important; opacity:0' in source
    assert 'align-items:center!important; justify-content:center!important; overflow:visible!important' in source
    assert "nav.scrollLeft = 0" in source
    assert 'ui.timer(0.05, self._reset_nav_horizontal_scroll, once=True)' in source
    assert 'box-sizing:border-box!important; width:100%!important; min-width:0!important' in source
    assert "classList.contains('sidebar-collapsed')" in source
    assert 'await self._set_expanded(bool(visually_collapsed))' in source
    assert "isinstance(saved_preference, bool)" in source
    assert "ui.icon(item.icon).classes('nav-icon')" in source
    assert "ui.label('CMMI Audit Platform').classes('sidebar-label text-base" in source


def test_left_sidebar_contains_all_authenticated_routes_and_rbac_visibility():
    source = Path('app/gui/layout.py').read_text(encoding='utf-8')
    registry = Path('app/core/screen_registry.py').read_text(encoding='utf-8')
    assert 'visible_screens' in source
    assert 'for item in self.identity[\'screens\']' in source
    assert 'MENU_ITEMS' not in source
    for route in ('/', '/repository-scan', '/pa-validation', '/rule-catalog', '/add-project', '/evidence-scan', '/package-checker', '/findings', '/gap-analysis', '/correlation-map', '/ai-guide', '/reports', '/rule-library', '/integrations', '/users'):
        assert repr(route) in registry
    for label in ('Dashboard', 'Repository Scan', 'PA Validation', 'Rules Catalogue', 'Add Project', 'Evidence Scan', 'Package Checker', 'Findings', 'Gap Analysis', 'Correlation Map', 'AI Guide', 'AFR Reports', 'CMMI Rule Library', 'Integrations', 'User Administration'):
        assert repr(label) in registry


def test_authenticated_pages_use_the_shared_layout():
    sources = [
        Path('app/gui/pages/dashboard.py').read_text(encoding='utf-8'),
        Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8'),
    ]
    assert all('layout(' in source for source in sources)


def test_dashboard_uses_persisted_session_coverage_not_legacy_mock_scores():
    source = Path('app/gui/pages/dashboard.py').read_text(encoding='utf-8')
    assert 'AuditSessionPracticeArea' in source
    assert 'Practice-area coverage' in source
    assert 'Domains (all when empty)' in source
    assert 'No sample React scores are used.' in source
    assert 'Audit readiness' not in source
    assert 'Generate filtered AFR' in source
    assert 'Run 302-rule audit scan' in source
    assert 'manage_finding' in source
    assert 'Finding correlation map' in source


def test_dashboard_completion_api_has_protected_comment_remediation_and_filtered_afr_support():
    audits = Path('app/api/endpoints/audits.py').read_text(encoding='utf-8')
    reports = Path('app/api/endpoints/reports.py').read_text(encoding='utf-8')
    for route in ('/findings/{finding_id}/comments', '/findings/{finding_id}/remediation-actions', '/remediation-actions/{action_id}'):
        assert route in audits
    assert "Depends(require_screen('findings', 'write'))" in audits
    assert 'class AfrFilterIn' in reports
    assert 'filters.model_dump()' in reports


def test_gap_analysis_filters_persisted_findings_and_exports_the_selected_session():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('gap_analysis'))" in source
    assert "ui.button('Apply filters'" in source
    assert "Finding.audit_session_id == selected_id" in source
    assert "Finding.practice_area_code.in_(pa_code.value)" in source
    assert "Finding.severity.in_(severity.value)" in source
    assert "Finding.status.in_(status.value)" in source
    assert "Generate filtered AFR (.xlsx)" in source
    assert "Select one audit session before generating a filtered AFR." in source


def test_correlation_map_is_a_protected_persisted_evidence_route_not_sample_data():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('correlation_map'))" in source
    assert 'FindingEvidence.finding_id == Finding.id' in source
    assert 'EvidenceFile.id == FindingEvidence.evidence_file_id' in source
    assert 'No sample traceability rows are shown.' in source
    assert 'Evidence link missing' in source


def test_ai_guide_uses_persisted_rules_and_live_findings_not_legacy_mock_chat():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('ai_guide'))" in source
    assert 'select(CmmiRule)' in source
    assert "Finding.status.in_(['open', 'in_progress'])" in source
    assert 'no invented AI response is used' in source
    assert 'def ask_guidance' in source
    assert "ui.button('Ask guidance'" in source
    assert 'CMMI guidance (stored rules and live findings)' in source


def test_github_import_is_server_side_bounded_and_permission_protected():
    integrations = Path('app/api/endpoints/integrations.py').read_text(encoding='utf-8')
    github = Path('app/services/integrations/github.py').read_text(encoding='utf-8')
    assert "@router.post('/github/import')" in integrations
    assert "Depends(require_screen('integrations', 'write'))" in integrations
    assert 'persist_remote_evidence' in integrations
    assert 'max_files: int = 500' in github
    assert 'GitHub returned a truncated repository tree' in github
    repository_page = Path('app/gui/pages/repository_scan.py').read_text(encoding='utf-8')
    assert 'Import supported evidence from GitHub' in repository_page
    assert 'Personal access token (optional)' in repository_page
    assert 'token.value = \'\'' in repository_page
    assert 'Import supported evidence from SharePoint' in repository_page
    assert 'Import supported evidence from Google Drive' in repository_page
    assert "@router.post('/sharepoint/import')" in integrations
    assert "@router.post('/google-drive/import')" in integrations
    assert "repository-folder-uploader" in repository_page
    assert "input.setAttribute('webkitdirectory', '')" in repository_page
    pa_validation_page = Path('app/gui/pages/pa_validation.py').read_text(encoding='utf-8')
    assert "pa-folder-uploader" in pa_validation_page
    assert "input.setAttribute('webkitdirectory', '')" in pa_validation_page


def test_evidence_scan_exposes_project_scoped_upload_and_persisted_results():
    source = Path('app/gui/pages/evidence_scan.py').read_text(encoding='utf-8')
    assert 'Select audit workspace' in source
    assert "ui.button('Refresh'" in source
    assert "label='Customer'" in source
    assert "label='Project'" in source
    assert "label='Audit session'" in source
    assert "ui.label('Upload evidence')" in source
    assert "ui.label('1." not in source
    assert "ui.label('2." not in source
    assert "ui.label('3." not in source
    assert "ui.label('4." not in source
    assert 'Upload one evidence file or one project ZIP' in source
    assert 'Files are stored only in the selected audit workspace shown above.' in source
    assert 'Run CMMI evidence scan' in source
    assert 'import_parent_folder_archive' not in source
    assert 'classification_json' in source
    assert 'Scan is running.' in source
    assert 'View saved scan details' in source
    assert 'Findings from this scan' in source
    assert "download_current_findings('csv')" in source
    assert "download_current_findings('xlsx')" in source
    assert 'on_upload=upload_project_document' in source
    assert 'source_type=\'evidence_scan_folder\'' in source


def test_add_project_uses_one_dynamic_form_with_duplicate_protection_and_pagination():
    source = Path('app/gui/pages/add_project.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('add_project'))" in source
    assert 'Add customer, project, and audit session' in source
    assert "ui.dialog() as add_project_dialog" in source
    assert 'Customer name' in source and 'Project name' in source and 'Audit session name' in source
    assert 'func.lower(AuditSession.audit_name) == audit_value.casefold()' in source
    assert "pagination={'rowsPerPage': 10}" in source


def test_audit_workspace_has_one_setup_path_and_hands_off_to_evidence_scan():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "with ui.tabs().classes('hidden')" in source
    assert "ui.navigate.to('/evidence-scan')" in source
    assert "Create audit session and continue" in source
    assert "project_customer.set_options(customer_options)" in source
    assert "session_project.set_options(project_options)" in source
