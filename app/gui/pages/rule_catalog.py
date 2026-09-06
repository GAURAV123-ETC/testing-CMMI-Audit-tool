"""Administrator UI for governed CMMI master-workbook versions."""
import json

from nicegui import ui
from app.core.screen_registry import screen_url
from sqlalchemy import select

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
        layout('Rules Catalogue', 'The governed CMMI master workbook is stored in the database. Validate changes here before explicitly activating them for future scans.')
        if not _allowed('*'):
            ui.label('Only administrators can view and manage the rules catalogue.').classes('text-negative')
            return

        def validated_options() -> dict[int, str]:
            with SessionLocal() as db:
                versions = db.scalars(select(ChecklistVersion).where(
                    ChecklistVersion.status == 'VALIDATED'
                ).order_by(ChecklistVersion.created_at.desc())).all()
            return {item.id: f'{item.version} — {item.source}' for item in versions}

        @ui.refreshable
        def overview() -> None:
            with SessionLocal() as db:
                active = db.scalar(select(ChecklistVersion).where(
                    ChecklistVersion.is_active.is_(True)
                ).order_by(ChecklistVersion.id.desc()))
                versions = db.scalars(select(ChecklistVersion).order_by(
                    ChecklistVersion.created_at.desc()
                ).limit(20)).all()
                counts = {
                    item.id: (
                        db.query(CmmiRule).filter_by(checklist_version_id=item.id).count(),
                        db.query(DocumentTypeRule).filter_by(checklist_version_id=item.id).count(),
                    )
                    for item in versions
                }
            with ui.card().classes('w-full max-w-6xl mt-4'):
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
                'version': item.version,
                'status': 'ACTIVE' if item.is_active else item.status,
                'source': item.source,
                'rules': counts[item.id][0],
                'documents': counts[item.id][1],
                'checksum': item.checksum[:16],
                'created': item.created_at.strftime('%Y-%m-%d %H:%M UTC'),
            } for item in versions], row_key='version').classes('w-full max-w-6xl')

        overview()
        with ui.card().classes('w-full max-w-6xl mt-5'):
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
                    overview.refresh(); refresh_candidates()
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
                    overview.refresh(); refresh_candidates()
                    ui.notify(f'{version.version} is now active for future evidence scans.', type='positive')
                except Exception as exc:
                    ui.notify(f'Ruleset activation failed: {exc}', type='negative')

            ui.upload(on_upload=upload_master, auto_upload=True,
                      max_file_size=get_settings().max_upload_mb * 1024 * 1024,
                      label='Upload CMMI master workbook for validation').props('accept=.xlsx').classes('w-full max-w-3xl mt-3')
            ui.button('Activate selected validated version', icon='published_with_changes', on_click=activate_selected).props('color=primary').classes('mt-3')
            refresh_candidates()
