"""Administrator UI for governed CMMI master-workbook versions and stored rules."""
import json

from nicegui import ui
from app.core.screen_registry import screen_url
from sqlalchemy import or_, select

from app.core.audit_log import log_action
from app.core.config import get_settings
from app.db.database import SessionLocal
from app.db.models import ChecklistVersion, CmmiRule, DocumentTypeRule
from app.gui.layout import layout
from app.gui.pages.audit_workspace import _allowed, _current_user_id
from app.services.rule_catalog_importer import activate_rule_catalog, import_rule_catalog


def _summary_text(summary: dict) -> str:
    return ', '.join((
        f"{summary.get('rules_added', 0)} rule(s) added",
        f"{summary.get('rules_removed', 0)} rule(s) removed",
        f"{summary.get('rules_changed', 0)} rule(s) changed",
        f"{summary.get('documents_added', 0)} document type(s) added",
        f"{summary.get('documents_removed', 0)} document type(s) removed",
        f"{summary.get('documents_changed', 0)} document type(s) changed",
    ))


def register():
    @ui.page(screen_url('rule_catalog'))
    def rule_catalog_page():
        layout('Rules Catalogue', 'Manage the governed CMMI master workbook and browse the database-stored rules used by audit sessions.')
        if not _allowed('*'):
            ui.label('Only administrators can view and manage the rules catalogue.').classes('text-negative')
            return

        def validated_options() -> dict[int, str]:
            with SessionLocal() as db:
                versions = db.scalars(select(ChecklistVersion).where(
                    ChecklistVersion.status == 'VALIDATED'
                ).order_by(ChecklistVersion.created_at.desc())).all()
            return {item.id: f'{item.version} — {item.source}' for item in versions}

        def all_version_options() -> tuple[dict[int, str], int | None]:
            with SessionLocal() as db:
                versions = db.scalars(select(ChecklistVersion).order_by(
                    ChecklistVersion.created_at.desc()
                )).all()
                active = next((item for item in versions if item.is_active), None)
            options = {
                item.id: f'{item.version} — {item.status}' + (' (active)' if item.is_active else '')
                for item in versions
            }
            return options, active.id if active else next(iter(options), None)

        with ui.tabs().classes('w-full max-w-6xl') as tabs:
            manage_tab = ui.tab('Manage versions', icon='published_with_changes')
            browse_tab = ui.tab('Browse stored rules', icon='menu_book')

        with ui.tab_panels(tabs, value=manage_tab).classes('w-full max-w-6xl'):
            with ui.tab_panel(manage_tab):
                @ui.refreshable
                def overview() -> None:
                    with SessionLocal() as db:
                        active = db.scalar(select(ChecklistVersion).where(
                            ChecklistVersion.is_active.is_(True)
                        ).order_by(ChecklistVersion.id.desc()))
                        versions = db.scalars(select(ChecklistVersion).order_by(
                            ChecklistVersion.created_at.desc()
                        )).all()
                        counts = {
                            item.id: (
                                db.query(CmmiRule).filter_by(checklist_version_id=item.id).count(),
                                db.query(DocumentTypeRule).filter_by(checklist_version_id=item.id).count(),
                            )
                            for item in versions
                        }
                    with ui.card().classes('w-full mt-4'):
                        ui.label('Active workbook used by Evidence Scan').classes('text-lg font-bold')
                        if not active:
                            ui.label('No active rulebook is available. Validate and activate the master workbook below.').classes('text-negative')
                        else:
                            rule_count, document_count = counts.get(active.id, (0, 0))
                            ui.label(f'{active.version} • {active.source}').classes('font-medium mt-1')
                            ui.label(f'{rule_count} rules • {document_count} document types • effective {active.effective_from or "not recorded"}').classes('text-sm text-slate-600')
                            ui.label(f'Workbook checksum: {active.checksum}').classes('text-xs text-slate-500 break-all mt-1')
                            ui.label('Evidence Scan automatically applies this active version. Project users do not upload a rulebook.').classes('text-sm text-slate-600 mt-2')
                    ui.label('Workbook version history').classes('text-lg font-bold mt-5')
                    ui.table(columns=[
                        {'name': 'version', 'label': 'Version', 'field': 'version', 'align': 'left'},
                        {'name': 'status', 'label': 'Status', 'field': 'status', 'align': 'left'},
                        {'name': 'source', 'label': 'Uploaded workbook', 'field': 'source', 'align': 'left'},
                        {'name': 'rules', 'label': 'Rules', 'field': 'rules', 'align': 'right'},
                        {'name': 'documents', 'label': 'Document types', 'field': 'documents', 'align': 'right'},
                        {'name': 'checksum', 'label': 'Checksum', 'field': 'checksum', 'align': 'left'},
                        {'name': 'created', 'label': 'Uploaded', 'field': 'created', 'align': 'left'},
                    ], rows=[{
                        'id': item.id,
                        'version': item.version,
                        'status': 'ACTIVE' if item.is_active else item.status,
                        'source': item.source,
                        'rules': counts[item.id][0],
                        'documents': counts[item.id][1],
                        'checksum': item.checksum[:16],
                        'created': item.created_at.strftime('%Y-%m-%d %H:%M UTC'),
                    } for item in versions], row_key='id').props("pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50]}").classes('w-full')

                overview()
                with ui.card().classes('w-full mt-5'):
                    ui.label('Validate a replacement master workbook').classes('text-lg font-bold')
                    ui.label('Uploading does not replace the live rules. The workbook is checked, compared with the active database version, and stored as VALIDATED. Activate it only after reviewing the reported changes.').classes('text-sm text-slate-600')
                    activation_select = ui.select(validated_options(), label='Validated version to activate').classes('w-full max-w-3xl mt-3')

                    def refresh_candidates() -> None:
                        options = validated_options()
                        activation_select.set_options(options)
                        if options and activation_select.value not in options:
                            activation_select.value = next(iter(options))
                            activation_select.update()

                    def upload_master(event) -> None:
                        try:
                            limit = get_settings().max_upload_mb * 1024 * 1024
                            content = event.content.read(limit + 1)
                            if len(content) > limit:
                                raise ValueError('Master workbook exceeds the configured upload limit.')
                            with SessionLocal() as db:
                                imported = import_rule_catalog(db, event.name, content, activate=False)
                                log_action(db, 'rule_catalog_validated', user_id=_current_user_id(),
                                           entity_type='checklist_version', entity_id=str(imported['checklist_version_id']),
                                           detail=json.dumps({
                                               'filename': event.name, 'version': imported['version'],
                                               'already_imported': imported['already_imported'],
                                               'content_unchanged': imported['content_unchanged'],
                                               'change_summary': imported['change_summary'],
                                           }, sort_keys=True))
                                db.commit()
                            overview.refresh(); refresh_candidates(); refresh_browse_versions()
                            if imported['content_unchanged']:
                                ui.notify('No substantive rule or document-catalogue change was found. The active version remains unchanged.', type='info')
                            else:
                                ui.notify(f"Validated {imported['version']} but did not activate it. Changes: {_summary_text(imported['change_summary'])}", type='positive')
                        except Exception as exc:
                            ui.notify(f'Rules upload rejected: {exc}', type='negative')

                    def activate_selected() -> None:
                        if not activation_select.value:
                            ui.notify('Select a validated version first.', type='warning')
                            return
                        try:
                            with SessionLocal() as db:
                                version = activate_rule_catalog(db, int(activation_select.value))
                                log_action(db, 'rule_catalog_activated', user_id=_current_user_id(),
                                           entity_type='checklist_version', entity_id=str(version.id),
                                           detail=f'version={version.version}')
                                db.commit()
                            overview.refresh(); refresh_candidates(); refresh_browse_versions(preferred_version=version.id)
                            ui.notify(f'{version.version} is now active for future evidence scans.', type='positive')
                        except Exception as exc:
                            ui.notify(f'Ruleset activation failed: {exc}', type='negative')

                    ui.upload(on_upload=upload_master, auto_upload=True,
                              max_file_size=get_settings().max_upload_mb * 1024 * 1024,
                              label='Upload CMMI master workbook for validation').props('accept=.xlsx').classes('w-full max-w-3xl mt-3')
                    ui.button('Activate selected validated version', icon='published_with_changes', on_click=activate_selected).props('color=primary').classes('mt-3')
                    refresh_candidates()

            with ui.tab_panel(browse_tab):
                ui.label('Browse stored CMMI rules').classes('text-xl font-bold mt-4')
                ui.label('These are the database records imported through Manage versions. The active version is selected by default; select a historical version to review its rules without changing any audit session.').classes('text-sm text-slate-600')
                versions, default_version = all_version_options()
                version_select = ui.select(versions, value=default_version, label='Ruleset version').classes('w-full max-w-3xl mt-3')
                query = ui.input('Search rule ID, practice area, audit check, or gap guidance').classes('w-full mt-3')
                results = ui.column().classes('w-full mt-3')

                def search_rules() -> None:
                    results.clear()
                    version_id = int(version_select.value) if version_select.value else None
                    term = (query.value or '').strip().casefold()
                    with SessionLocal() as db:
                        version = db.get(ChecklistVersion, version_id) if version_id else None
                        rules_query = select(CmmiRule).where(
                            CmmiRule.checklist_version_id == version_id
                        ) if version else None
                        if rules_query is not None and term:
                            pattern = f'%{term}%'
                            rules_query = rules_query.where(or_(
                                CmmiRule.rule_id.ilike(pattern),
                                CmmiRule.practice_area_code.ilike(pattern),
                                CmmiRule.audit_check.ilike(pattern),
                                CmmiRule.gap_text.ilike(pattern),
                            ))
                        rules = db.scalars(rules_query.order_by(
                            CmmiRule.practice_area_code, CmmiRule.rule_id
                        )).all() if rules_query is not None else []
                    with results:
                        if not version:
                            ui.label('No stored ruleset version is available.').classes('text-slate-600')
                            return
                        ui.label(f'{len(rules)} matching rule(s) in {version.version}').classes('text-slate-600')
                        ui.table(columns=[
                            {'name': 'id', 'label': 'Record ID', 'field': 'id', 'align': 'right'},
                            {'name': 'rule_id', 'label': 'Rule ID', 'field': 'rule_id', 'align': 'left'},
                            {'name': 'practice_area', 'label': 'Practice area', 'field': 'practice_area', 'align': 'left'},
                            {'name': 'level', 'label': 'Level', 'field': 'level', 'align': 'left'},
                            {'name': 'audit_check', 'label': 'Audit check', 'field': 'audit_check', 'align': 'left'},
                            {'name': 'gap_guidance', 'label': 'Gap guidance', 'field': 'gap_guidance', 'align': 'left'},
                        ], rows=[{
                            'id': rule.id,
                            'rule_id': rule.rule_id,
                            'practice_area': rule.practice_area_code,
                            'level': rule.level,
                            'audit_check': rule.audit_check,
                            'gap_guidance': rule.gap_text,
                        } for rule in rules], row_key='id').props(
                            "pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}"
                        ).classes('w-full')

                def refresh_browse_versions(preferred_version: int | None = None) -> None:
                    options, active_version = all_version_options()
                    version_select.set_options(options)
                    selected = preferred_version if preferred_version in options else active_version
                    if version_select.value not in options or preferred_version is not None:
                        version_select.value = selected
                    version_select.update()
                    search_rules()

                version_select.on('update:model-value', search_rules)
                ui.button('Search stored rules', icon='search', on_click=search_rules).props('color=primary').classes('mt-3')
                search_rules()
