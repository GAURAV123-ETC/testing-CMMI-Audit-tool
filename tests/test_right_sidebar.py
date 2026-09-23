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
    assert '.sidebar-collapsed .account-profile-icon {width:26px!important' in source
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
    assert 'button.tooltip(item.label)' not in source
    assert 'mobile_toggle.tooltip' not in source
    assert 'aria-label="{item.label}"' in source
    assert 'self.drawer.hide()' in source
    assert 'aria-label="Open account actions"' in source
    assert 'account-profile-display' in source
    assert 'account-profile-button' not in source
    assert 'account-collapsed-menu-trigger' in source
    assert '.sidebar-collapsed .account-profile-display {display:none!important}' in source
    assert '.sidebar-collapsed .account-collapsed-menu-trigger {display:inline-flex!important' in source
    assert '.account-profile-display:hover {background:rgba(37,99,235,.08)!important}' in source
    assert 'on_click=account_menu.open' in source
    assert 'def _create_account_menu' in source
    assert "ui.icon('account_circle', size='26px')" in source
    assert 'Professional Credentials' not in source
    assert "ui.menu_item('Change Password'" in source
    assert 'def _build_change_password_dialog' in source
    assert 'def _open_change_password_dialog' in source
    assert 'ui.menu_item(\'Change Password\', self._open_change_password_dialog)' in source
    assert "classes('text-xs text-slate-500 uppercase')" not in source
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
    for route in ('/', '/rule-catalog', '/add-project', '/evidence-scan', '/reports', '/users', '/roles'):
        assert repr(route) in registry
    for label in ('Dashboard', 'Rules Catalogue', 'Add Project', 'Evidence Scan', 'AFR Reports', 'Manage Users', 'Manage Roles'):
        assert repr(label) in registry
    assert "ScreenDefinition('findings'" not in registry
    assert "'findings'" in registry
    assert "ScreenDefinition('repository_scan'" not in registry
    assert "ScreenDefinition('integrations'" not in registry
    assert "ScreenDefinition('rule_library'" not in registry
    assert "ScreenDefinition('pa_validation'" not in registry
    assert "ScreenDefinition('package_checker'" not in registry
    assert "ScreenDefinition('gap_analysis'" not in registry


def test_authenticated_pages_use_the_shared_layout():
    sources = [
        Path('app/gui/pages/dashboard.py').read_text(encoding='utf-8'),
        Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8'),
        Path('app/gui/pages/user_administration.py').read_text(encoding='utf-8'),
        Path('app/gui/pages/role_administration.py').read_text(encoding='utf-8'),
    ]
    assert all('layout(' in source for source in sources)


def test_dashboard_uses_live_operational_records_without_seeded_catalogue_metrics():
    source = Path('app/gui/pages/dashboard.py').read_text(encoding='utf-8')
    assert 'CmmiModelProfile' not in source
    assert 'CmmiDomainPracticeArea' not in source
    assert 'CMMI v3.0 structure' not in source
    # Chart drill-down must use the typed point-click event, not a bare
    # 'click' listener — NiceGUI's echart component never emits a plain
    # 'click' event, so `.on('click', ...)` silently never fires.
    assert "chart.on_point_click(" in source
    # The dashboard shows only the stored CMMI reference catalogue — no
    # live-computed audit/finding activity belongs on this page.
    assert 'AuditSession' in source
    assert 'Finding' in source
    assert 'User' in source
    assert 'has_linked_evidence' not in source
    assert 'Findings by project' in source
    assert 'Findings by practice area' in source
    assert 'Project-wise details' in source
    assert 'View Details' in source
    assert 'table_search_input(' in source
    assert "'flat dense hide-bottom'" in source
    assert 'ui.pagination(' in source
    assert 'Showing {first_row + 1}' in source
    search_component = Path('app/gui/search.py').read_text(encoding='utf-8')
    assert "'outlined dense clearable debounce=250 color=primary'" in search_component
    assert "ui.icon('search')" in search_component
    assert 'Recent findings' not in source
    assert 'Recent audit sessions' not in source
    assert "ui.expansion('Show Charts', icon='insights', value=False).classes('w-full mb-3')" in source
    assert "project_chart = ui.echart(" in source
    assert "project_chart.on_point_click(" in source
    assert "practice_chart.on_point_click(" in source
    assert "_zoom_controls(project_chart, 'Findings by project', open_project_from_chart)" in source
    assert "_zoom_controls(practice_chart, 'Findings by practice area', open_practice_from_chart)" in source
    assert "'dataZoom'" in source
    assert "'saveAsImage'" in source
    assert "'Zoom in', icon='zoom_in'" in source
    assert "'Zoom out', icon='zoom_out'" in source
    assert "project_chart_actions = ui.row().classes('items-center gap-1 flex-none')" in source
    assert "practice_chart_actions = ui.row().classes('items-center gap-1 flex-none')" in source
    assert "props('maximized')" in source
    assert '@ui.refreshable' in source
    assert 'DASHBOARD_CHANGE_CHECK_SECONDS = 2' in source
    assert 'def _render_dashboard_content()' in source
    assert 'def dashboard_content()' in source
    assert 'ui.timer(DASHBOARD_CHANGE_CHECK_SECONDS, refresh_if_data_changed)' in source
    assert "ui.button('Refresh now'" not in source
    assert 'ui.timer(DASHBOARD_REFRESH_SECONDS, _dashboard_content.refresh)' not in source
    assert "ui.button('Add project'" not in source
    assert "ui.button('Open evidence scan'" not in source
    assert 'Loading saved audit session' not in source
    assert 'Change audit session' not in source
    assert 'No sample React scores are used.' not in source
    assert 'Run 302-rule audit scan' not in source
    assert 'manage_finding' not in source
    assert "app.storage.user.get('selected_audit_session_id')" not in source


def test_dashboard_completion_api_has_protected_comment_remediation_and_filtered_afr_support():
    audits = Path('app/api/endpoints/audits.py').read_text(encoding='utf-8')
    reports = Path('app/api/endpoints/reports.py').read_text(encoding='utf-8')
    for route in ('/findings/{finding_id}/comments', '/findings/{finding_id}/remediation-actions', '/remediation-actions/{action_id}'):
        assert route in audits
    assert "Depends(require_screen('evidence_scan', 'write'))" in audits
    assert 'class AfrFilterIn' in reports
    assert 'filters.model_dump()' in reports


def test_duplicate_package_and_gap_analysis_surfaces_are_retired():
    registry = Path('app/core/screen_registry.py').read_text(encoding='utf-8')
    workspace = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    reports = Path('app/api/endpoints/reports.py').read_text(encoding='utf-8')
    main = Path('main.py').read_text(encoding='utf-8')
    assert "'package_checker'" in registry
    assert "'gap_analysis'" in registry
    assert not Path('app/gui/pages/package_checker.py').exists()
    assert not Path('app/services/audit_engine/package_validation.py').exists()
    assert not Path('app/services/audit_engine/gap_analysis.py').exists()
    assert 'package_checker.register()' not in main
    assert "@ui.page(screen_url('gap_analysis'))" not in workspace
    assert 'create_gap_report' not in reports
    assert '/audit-sessions/{audit_session_id}/gap/{format}' not in reports


def test_correlation_map_is_retired_from_the_application():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    registry = Path('app/core/screen_registry.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('correlation_map'))" not in source
    assert "ScreenDefinition('correlation_map'" not in registry
    assert "'correlation_map'" in registry


def test_ai_guide_is_retired_without_removing_shared_rule_or_finding_workflows():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    registry = Path('app/core/screen_registry.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('ai_guide'))" not in source
    assert "ScreenDefinition('ai_guide'" not in registry
    assert "'ai_guide'" in registry


def test_repository_and_cloud_import_surfaces_are_retired():
    registry = Path('app/core/screen_registry.py').read_text(encoding='utf-8')
    router = Path('app/api/router.py').read_text(encoding='utf-8')
    main = Path('main.py').read_text(encoding='utf-8')
    evidence_scan = Path('app/gui/pages/evidence_scan.py').read_text(encoding='utf-8')
    assert "'ai_guide'" in registry
    assert 'integrations.router' not in router
    assert 'repository_scan.register()' not in main
    assert not Path('app/gui/pages/repository_scan.py').exists()
    assert not Path('app/api/endpoints/integrations.py').exists()
    assert not Path('app/services/integrations/github.py').exists()
    assert not Path('app/services/integrations/google_drive.py').exists()
    assert not Path('app/services/integrations/microsoft_graph.py').exists()
    assert 'Upload evidence' in evidence_scan
    assert 'repository-folder-uploader' not in evidence_scan
    assert not Path('app/gui/pages/pa_validation.py').exists()


def test_rule_catalog_combines_version_management_and_database_rule_browsing():
    catalog = Path('app/gui/pages/rule_catalog.py').read_text(encoding='utf-8')
    workspace = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "ui.tab('Manage versions'" in catalog
    assert "ui.tab('Browse stored rules'" in catalog
    assert "CmmiRule.checklist_version_id == version_id" in catalog
    assert "label='Ruleset version'" in catalog
    assert 'Update keys for an approved document/evidence type' in catalog
    assert 'import_document_catalogue_additions' in catalog
    assert catalog.count("_screen_allowed('rule_catalog'") >= 4
    assert 'Roles and page access' in workspace
    assert 'create_disabled_screen_mappings' in workspace
    assert 'set_role_screen_permission' in workspace
    assert 'CMMI Rule Library' not in workspace


def test_rules_catalogue_and_evidence_scan_use_the_colored_workflow_tabs():
    layout = Path('app/gui/layout.py').read_text(encoding='utf-8')
    catalog = Path('app/gui/pages/rule_catalog.py').read_text(encoding='utf-8')
    evidence_scan = Path('app/gui/pages/evidence_scan.py').read_text(encoding='utf-8')
    assert '.workflow-tabs .workflow-tab .q-tab__indicator' in layout
    assert '.workflow-tabs .workflow-tab.q-tab--disabled' in layout
    assert '.workflow-tabs .workflow-tab-teal .q-tab__indicator {background:#16803c!important}' in layout
    assert '.workflow-tabs .workflow-tab-violet .q-tab__indicator {background:#d35400!important}' in layout
    assert '.workflow-tabs .workflow-tab-amber .q-tab__indicator {background:#5046a8!important}' in layout
    assert "classes('workflow-tab workflow-tab-teal')" in catalog
    assert "classes('workflow-tab workflow-tab-violet')" in evidence_scan
    assert "classes('workflow-tab workflow-tab-amber')" in evidence_scan
    assert "classes('workflow-tabs w-full max-w-6xl')" in catalog
    assert "classes('workflow-tabs w-full max-w-6xl mt-4')" in evidence_scan


def test_evidence_scan_exposes_project_scoped_upload_and_persisted_results():
    source = Path('app/gui/pages/evidence_scan.py').read_text(encoding='utf-8')
    assert 'Select audit workspace' in source
    assert "ui.button('Refresh workspace list'" in source
    assert "label='Customer'" in source
    assert "label='Project'" in source
    assert "label='Audit session'" in source
    assert '1. Select audit workspace' in source
    assert '2. Upload evidence' in source
    assert '3. Run scan and review results' in source
    assert "label='Upload evidence'" in source
    assert 'FolderUpload(' in source
    assert 'persist_uploaded_folder_evidence' in source
    folder_upload = Path('app/gui/components/folder_upload.js').read_text(encoding='utf-8')
    assert 'Choose files or ZIP' in folder_upload
    assert 'Choose project folder' in folder_upload
    folder_upload_backend = Path('app/gui/components/folder_upload.py').read_text(encoding='utf-8')
    assert 'request.form(max_files=self._max_files, max_fields=10)' in folder_upload_backend
    assert 'Evidence upload exceeds the total size limit.' in folder_upload_backend
    assert "ui.tab('1. Workspace'" in source
    assert "ui.tab('2. Upload evidence'" in source
    assert "ui.tab('3. Scan and results'" in source
    assert 'upload_tab.disable()' in source
    assert 'review_tab.disable()' in source
    assert 'evidence_details_session_id' not in source
    assert 'Run Scoped CMMI Evidence Scan' in source
    assert 'import_parent_folder_archive' not in source
    assert 'classification_json' in source
    assert 'Scan is running for audit session ID' in source
    assert 'Saved results' in source
    assert 'View saved results for selected session' not in source
    assert 'Evidence findings from uploaded files' in source
    assert 'Checklist coverage gaps' in source
    assert 'not included in AFR' in source
    assert 'Scan job ID' in source
    assert 'Workspace selection is locked until it finishes' in source
    assert 'running_scan_session_id' in source
    assert 'restore_workspace_selection' in source
    assert "download_current_findings('csv')" in source
    assert "download_current_findings('xlsx')" in source
    assert 'on_multi_upload=upload_project_evidence' in source
    assert 'persist_uploaded_folder_evidence(' in source


def test_add_project_uses_one_dynamic_form_with_duplicate_protection_and_pagination():
    source = Path('app/gui/pages/add_project.py').read_text(encoding='utf-8')
    assert "@ui.page(screen_url('add_project'))" in source
    assert 'Add customer, project, and audit session' in source
    assert "ui.dialog() as add_project_dialog" in source
    assert 'Customer name' in source and 'Project name' in source and 'Audit session name' in source
    assert 'func.lower(AuditSession.audit_name) == audit_value.casefold()' in source
    assert 'table_search_input(' in source
    assert 'Search saved project details' in source
    assert '_filter_saved_details(rows, search_text)' in source
    assert 'SAVED_DETAILS_SEARCHABLE_COLUMNS' in source
    assert "pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50, 100]}" in source


def test_persisted_data_tables_are_paginated_and_use_stable_database_ids():
    sources = {
        'app/gui/pages/add_project.py': ('row_key=\'id\'', 'select(AuditSession, AuditProject, Customer)'),
        'app/gui/pages/audit_workspace.py': ("row_key='id'", "'download_url': f'/api/v1/reports/{report.id}/download'"),
        'app/gui/pages/evidence_scan.py': ("row_key='id'",),
        'app/gui/pages/rule_catalog.py': ("row_key='id'",),
    }
    for path, expected in sources.items():
        source = Path(path).read_text(encoding='utf-8')
        assert 'pagination=' in source
        for value in expected:
            assert value in source
    workspace = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50, 100]" in workspace


def test_afr_collects_comments_and_actions_in_bulk_queries():
    source = Path('app/services/reports/afr_report.py').read_text(encoding='utf-8')
    assert 'finding_ids = [finding.id for finding in findings]' in source
    assert 'Comment.finding_id.in_(finding_ids)' in source
    assert 'RemediationAction.finding_id.in_(finding_ids)' in source


def test_saved_project_details_support_safe_edit_and_delete_actions():
    source = Path('app/gui/pages/add_project.py').read_text(encoding='utf-8')
    assert "'actions', 'label': 'Actions'" in source
    assert "edit_saved_details" in source
    assert "confirm_delete_saved_details" in source
    assert "props('type=date')" in source
    assert 'Historical audit data is protected.' in source
    assert 'db.execute(delete(AuditSessionPracticeArea)' in source


def test_audit_workspace_has_one_setup_path_and_hands_off_to_evidence_scan():
    source = Path('app/gui/pages/audit_workspace.py').read_text(encoding='utf-8')
    assert "with ui.tabs().classes('hidden')" in source
    assert "ui.navigate.to('/evidence-scan')" in source
    assert "Create audit session and continue" in source
    assert "project_customer.set_options(customer_options)" in source
    assert "session_project.set_options(project_options)" in source
