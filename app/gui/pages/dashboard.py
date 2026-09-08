"""Dashboard backed exclusively by persisted audit-session data."""
from collections import Counter
from datetime import datetime

from nicegui import app, ui
from app.core.screen_registry import screen_url
from sqlalchemy import func, select

from app.db.database import SessionLocal
from app.db.models import (AuditProject, AuditSession, AuditSessionPracticeArea,
                           Comment, Customer, EvidenceFile, EvidenceSource, Finding,
                           GeneratedReport, PracticeArea, RemediationAction)
from app.gui.layout import layout
from app.services.auth.service import get_session_user
from app.services.audit_engine.correlation_map import correlation_map
from app.services.audit_engine.evidence_scan import scan_session
from app.services.audit_engine.domain_data import (CORE_PRACTICE_AREA_CODES,
                                                    domain_label_for_practice_area,
                                                    domains_for_selection)
from app.services.reports.afr_report import create_afr


def _current_user_id() -> int:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            raise RuntimeError('Your session has expired. Please sign in again.')
        return user.id


def _has_permission(required_permission: str) -> bool:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            return False
        permissions = {permission.code for role in user.roles for permission in role.permissions}
        return '*' in permissions or required_permission in permissions


def _can_write_findings() -> bool:
    return _has_permission('findings:write')


def _metric(label: str, value: int | str, icon: str, color: str = 'text-slate-900') -> None:
    with ui.card().classes('w-48 min-h-28'):
        with ui.row().classes('w-full items-center'):
            ui.icon(icon).classes('text-blue-500 text-xl')
            ui.label(label).classes('ml-2 text-slate-600')
        ui.label(str(value)).classes(f'text-3xl font-bold mt-3 {color}')


def _status(folder_status: str, evidence_status: str) -> str:
    if folder_status == 'not_scanned' or evidence_status == 'not_scanned':
        return 'Not scanned'
    if folder_status != 'available' or evidence_status == 'missing':
        return 'Missing'
    return 'Gap' if evidence_status == 'gap' else 'Available'


def _status_color(value: str) -> str:
    return {'Available': 'positive', 'Gap': 'warning', 'Missing': 'negative', 'Not scanned': 'grey'}.get(value, 'grey')


def _table(columns: list[tuple[str, str]], rows: list[dict]) -> None:
    ui.table(
        columns=[{'name': key, 'label': label, 'field': key, 'align': 'left'} for key, label in columns],
        rows=rows,
        row_key=columns[0][0],
    ).props("pagination={'rowsPerPage': 25, 'rowsPerPageOptions': [10, 25, 50, 100]}").classes('w-full')


def _session_options() -> tuple[dict[int, str], int | None]:
    with SessionLocal() as db:
        rows = db.execute(
            select(AuditSession, AuditProject, Customer).join(AuditProject, AuditSession.project_id == AuditProject.id)
            .join(Customer, AuditProject.customer_id == Customer.id).order_by(AuditSession.created_at.desc())
        ).all()
    options = {row.AuditSession.id: f'#{row.AuditSession.id} — {row.Customer.name} / {row.AuditProject.name}' for row in rows}
    return options, next(iter(options), None)


def register():
    @ui.page(screen_url('dashboard'))
    def dashboard():
        layout('Dashboard', 'Automatic audit status, coverage, and findings from the current persisted audit session.')
        session_options, default_session_id = _session_options()
        if not session_options:
            ui.label('Create a customer, project, and audit session in Add Project to begin.').classes('text-slate-600 mt-2')
            ui.button('Open Add Project', icon='add_task', on_click=lambda: ui.navigate.to('/add-project')).props('color=primary').classes('mt-4')
            return

        remembered_session = app.storage.user.get('selected_audit_session_id')
        default_session_id = remembered_session if remembered_session in session_options else default_session_id
        ui.label('Coverage and findings are calculated automatically from the current audit session. No sample React scores are used.').classes('text-slate-600 mt-1')
        with ui.card().classes('w-full max-w-5xl mt-4'):
            ui.label('Current audit workspace').classes('text-sm font-bold text-slate-600')
            session_context = ui.label('Loading saved audit session...').classes('text-lg font-bold')
            ui.label('Use Change audit session only when reviewing a different project or historical audit.').classes('text-sm text-slate-600')
            with ui.row().classes('gap-2 mt-2'):
                change_session_button = ui.button('Change audit session', icon='swap_horiz').props('outline')

        with ui.dialog() as session_dialog, ui.card().classes('w-full max-w-xl'):
            ui.label('Choose an audit session').classes('text-xl font-bold')
            ui.label('Dashboard calculations and history will update for the selected customer, project, and audit session.').classes('text-sm text-slate-600')
            session_select = ui.select(session_options, value=default_session_id, label='Audit session').classes('w-full mt-3')
            with ui.row().classes('w-full justify-end gap-2 mt-4'):
                ui.button('Cancel', on_click=session_dialog.close).props('flat')
                use_session_button = ui.button('Use this audit session', icon='check').props('color=primary')

        def manage_finding(finding_id: int) -> None:
            if not _can_write_findings():
                ui.notify('You do not have permission to change findings.', type='negative')
                return
            with SessionLocal() as db:
                finding = db.get(Finding, finding_id)
                comments = db.scalars(select(Comment).where(Comment.finding_id == finding_id).order_by(Comment.created_at)).all()
                actions = db.scalars(select(RemediationAction).where(RemediationAction.finding_id == finding_id).order_by(RemediationAction.created_at)).all()
            if not finding:
                ui.notify('Finding no longer exists.', type='negative')
                return
            with ui.dialog() as dialog, ui.card().classes('w-full max-w-3xl'):
                ui.label(f'Finding #{finding.id} — {finding.title}').classes('text-xl font-bold')
                ui.label(f'{finding.practice_area_code} · {finding.severity} · {finding.status}').classes('text-slate-600')
                ui.label('Comments').classes('font-bold mt-3')
                if comments:
                    for comment in comments:
                        ui.label(comment.body).classes('w-full bg-slate-50 p-2 rounded text-sm')
                else:
                    ui.label('No comments yet.').classes('text-sm text-slate-600')
                comment_body = ui.textarea('Add comment').classes('w-full')
                def add_comment() -> None:
                    if not comment_body.value or not comment_body.value.strip():
                        ui.notify('Enter a comment.', type='warning'); return
                    with SessionLocal() as db:
                        db.add(Comment(finding_id=finding_id, author_id=_current_user_id(), body=comment_body.value.strip()))
                        db.commit()
                    dialog.close(); results.refresh(); ui.notify('Comment added.', type='positive')
                ui.button('Add comment', icon='comment', on_click=add_comment).props('outline')
                ui.separator().classes('my-3')
                ui.label('Remediation actions').classes('font-bold')
                if actions:
                    for action in actions:
                        with ui.row().classes('w-full items-center justify-between bg-slate-50 p-2 rounded'):
                            ui.label(action.action).classes('text-sm')
                            ui.badge(action.status, color={'completed': 'positive', 'cancelled': 'grey'}.get(action.status, 'warning'))
                else:
                    ui.label('No remediation actions yet.').classes('text-sm text-slate-600')
                action_text = ui.textarea('New remediation action').classes('w-full')
                due_date = ui.input('Due date (optional)').props('type=date').classes('w-52')
                def add_action() -> None:
                    if not action_text.value or not action_text.value.strip():
                        ui.notify('Enter a remediation action.', type='warning'); return
                    try:
                        due_at = datetime.fromisoformat(due_date.value).replace(tzinfo=None) if due_date.value else None
                    except ValueError:
                        ui.notify('Choose a valid due date from the calendar.', type='warning'); return
                    with SessionLocal() as db:
                        db.add(RemediationAction(finding_id=finding_id, action=action_text.value.strip(), due_at=due_at))
                        db.commit()
                    dialog.close(); results.refresh(); ui.notify('Remediation action added.', type='positive')
                ui.button('Add remediation action', icon='assignment_turned_in', on_click=add_action).props('color=primary')
                ui.button('Close', on_click=dialog.close).props('flat').classes('mt-2')
            dialog.open()

        @ui.refreshable
        def results() -> None:
            selected_domains: list[str] = []
            selected_codes: set[str] = set()
            selected_session_id = int(session_select.value) if session_select.value else None
            with SessionLocal() as db:
                session = db.get(AuditSession, selected_session_id)
                if not session:
                    ui.label('The selected audit session no longer exists.').classes('text-red-700 mt-4')
                    return
                project = db.get(AuditProject, session.project_id)
                customer = db.get(Customer, project.customer_id) if project else None
                pa_rows = db.execute(
                    select(AuditSessionPracticeArea, PracticeArea).join(PracticeArea, AuditSessionPracticeArea.practice_area_id == PracticeArea.id)
                    .where(AuditSessionPracticeArea.audit_session_id == selected_session_id)
                ).all()
                all_pa_names = {practice_area.code: practice_area.name for _, practice_area in pa_rows}
                pa_statuses = {practice_area.code: _status(row.folder_status, row.evidence_status) for row, practice_area in pa_rows}
                selected_codes = set(all_pa_names)
                findings_query = select(Finding).where(Finding.audit_session_id == selected_session_id)
                findings = db.scalars(findings_query.order_by(Finding.created_at.desc())).all()
                project_count = db.scalar(select(func.count(AuditProject.id))) or 0
                evidence_files = db.scalar(select(func.count(EvidenceFile.id).join(EvidenceSource).where(EvidenceSource.audit_session_id == selected_session_id))) or 0
                report_count = db.scalar(select(func.count(GeneratedReport.id).where(GeneratedReport.audit_session_id == selected_session_id))) or 0

            session_context.text = (
                f'{customer.name if customer else "Unknown customer"} / '
                f'{project.name if project else "Unknown project"} / '
                f'{session.audit_name or f"Audit session #{session.id}"}'
                + (f' — {session.audit_date}' if session.audit_date else '')
            )
            session_context.update()
            coverage = Counter(pa_statuses.get(code, 'Not scanned') for code in selected_codes)
            total = len(selected_codes)
            score = round((coverage['Available'] / total) * 100) if total else 0
            open_findings = [finding for finding in findings if finding.status == 'open']
            with ui.row().classes('gap-4 flex-wrap mt-5'):
                _metric('Audit Projects', project_count, 'folder')
                _metric('Selected Session', f'#{selected_session_id}', 'event_note')
                _metric('Evidence Files', evidence_files, 'attach_file')
                _metric('Open Findings', len(open_findings), 'fact_check', 'text-amber-700')
                _metric('Generated AFRs', report_count, 'summarize')
            with ui.row().classes('gap-3 flex-wrap my-4'):
                ui.button('Open Add Project', icon='add_task', on_click=lambda: ui.navigate.to('/add-project')).props('color=primary')
                ui.button('Review findings', icon='fact_check', on_click=lambda: ui.navigate.to('/findings')).props('outline')
                def run_selected_audit() -> None:
                    if not _has_permission('audits:write'):
                        ui.notify('You do not have permission to run an audit scan.', type='negative'); return
                    try:
                        with SessionLocal() as scan_db:
                            result = scan_session(scan_db, selected_session_id, _current_user_id())
                        results.refresh()
                        ui.notify(f"Audit scan complete: {result['findings_created']} finding(s) from {result['files_processed']} file(s).", type='positive')
                    except Exception as exc:
                        ui.notify(f'Audit scan failed: {exc}', type='negative')
                ui.button('Run 302-rule audit scan', icon='play_circle', on_click=run_selected_audit).props('outline')
                def generate_current_afr() -> None:
                    if not _has_permission('reports:write'):
                        ui.notify('You do not have permission to generate AFR reports.', type='negative')
                        return
                    try:
                        with SessionLocal() as report_db:
                            created_report = create_afr(
                                db=report_db, audit_session_id=selected_session_id, user_id=_current_user_id(), fmt='xlsx',
                                practice_area_codes=sorted(selected_codes), severities=[], statuses=[],
                            )
                        ui.notify(f'AFR #{created_report.id} generated. Open AFR Reports to download it.', type='positive')
                    except Exception as exc:
                        ui.notify(f'Could not generate AFR: {exc}', type='negative')
                ui.button('Generate AFR (Excel)', icon='summarize', on_click=generate_current_afr).props('outline')
            with ui.row().classes('w-full gap-5 items-stretch flex-wrap'):
                with ui.card().classes('min-w-72 flex-grow'):
                    ui.label('Practice-area coverage').classes('text-lg font-bold')
                    with ui.row().classes('items-center gap-5 mt-3'):
                        ui.circular_progress(value=score, show_value=True, size='112px').props('color=primary thickness=0.16')
                        with ui.column().classes('gap-1'):
                            ui.label(f'{coverage["Available"]} of {total} available').classes('font-semibold')
                            for label in ('Gap', 'Missing', 'Not scanned'):
                                ui.label(f'{label}: {coverage[label]}').classes('text-sm text-slate-600')
                with ui.card().classes('min-w-72 flex-grow'):
                    ui.label('Audit findings').classes('text-lg font-bold')
                    by_severity = Counter(finding.severity for finding in findings)
                    if findings:
                        for severity in ('critical', 'major', 'minor'):
                            with ui.row().classes('w-full items-center justify-between py-1'):
                                ui.label(severity.title()).classes('text-slate-700')
                                ui.badge(str(by_severity[severity]), color={'critical': 'negative', 'major': 'warning', 'minor': 'primary'}[severity])
                    else:
                        ui.label('No findings have been recorded for this audit session.').classes('text-sm text-slate-600 mt-4')
            ui.label('Domain-wise coverage').classes('text-xl font-bold mt-6')
            domain_rows = []
            for domain in domains_for_selection(selected_domains):
                codes = set(CORE_PRACTICE_AREA_CODES) | set(domain.practice_area_codes)
                codes.intersection_update(all_pa_names)
                states = Counter(pa_statuses.get(code, 'Not scanned') for code in codes)
                domain_rows.append({'domain': f'{domain.code} — {domain.label}', 'total': len(codes), 'available': states['Available'],
                                    'gap': states['Gap'], 'missing': states['Missing'], 'not_scanned': states['Not scanned'],
                                    'score': f"{round(states['Available'] * 100 / len(codes)) if codes else 0}%"})
            _table([('domain', 'Domain'), ('total', 'Total PA'), ('available', 'Available'), ('gap', 'Gap'),
                    ('missing', 'Missing'), ('not_scanned', 'Not scanned'), ('score', 'Score')], domain_rows)
            ui.label('Finding correlation map').classes('text-xl font-bold mt-6')
            correlations = correlation_map(findings)
            if correlations:
                for practice_area, correlated in sorted(correlations.items()):
                    with ui.expansion(f'{practice_area} — {len(correlated)} related finding(s)').classes('w-full border border-slate-200 rounded'):
                        for item in correlated:
                            ui.label(f"#{item['id']} · {item['rule_id'] or 'No rule'} · {item['title']}").classes('block p-2 text-sm')
            else:
                ui.label('No findings are available for correlation under the current filters.').classes('text-sm text-slate-600')
            ui.label('Practice-area detail').classes('text-xl font-bold mt-6')
            detail_codes = ['IRP', *CORE_PRACTICE_AREA_CODES, *[code for domain in domains_for_selection(selected_domains) for code in domain.practice_area_codes]]
            for code in detail_codes:
                if code not in all_pa_names:
                    continue
                state = pa_statuses.get(code, 'Not scanned')
                code_findings = [finding for finding in findings if finding.practice_area_code == code]
                with ui.expansion(f'{code} — {all_pa_names[code]}').classes('w-full border border-slate-200 rounded'):
                    with ui.row().classes('items-center gap-3 p-2'):
                        ui.badge(state, color=_status_color(state))
                        ui.label(domain_label_for_practice_area(code)).classes('text-sm text-slate-600')
                        ui.label(f'{len(code_findings)} finding(s)').classes('text-sm text-slate-600')
                    if code_findings:
                        _table([('id', 'ID'), ('severity', 'Severity'), ('status', 'Status'), ('title', 'Finding')],
                               [{'id': finding.id, 'severity': finding.severity, 'status': finding.status, 'title': finding.title} for finding in code_findings])
                        if _can_write_findings():
                            with ui.row().classes('gap-2 p-2 flex-wrap'):
                                for finding in code_findings:
                                    ui.button(f'Manage #{finding.id}', icon='edit_note',
                                              on_click=lambda finding_id=finding.id: manage_finding(finding_id)).props('flat dense')
                    else:
                        ui.label('No findings for this practice area.').classes('p-2 text-sm text-slate-600')

        def refresh_results() -> None:
            results.refresh()

        def use_selected_session() -> None:
            selected_session_id = int(session_select.value) if session_select.value else None
            with SessionLocal() as db:
                session = db.get(AuditSession, selected_session_id) if selected_session_id else None
                project = db.get(AuditProject, session.project_id) if session else None
                customer = db.get(Customer, project.customer_id) if project else None
            if not session or not project or not customer:
                ui.notify('Choose a valid saved audit session.', type='warning')
                return
            app.storage.user['selected_evidence_customer_id'] = customer.id
            app.storage.user['selected_evidence_project_id'] = project.id
            app.storage.user['selected_audit_session_id'] = session.id
            session_dialog.close()
            refresh_results()

        change_session_button.on('click', lambda: session_dialog.open())
        use_session_button.on('click', use_selected_session)
        refresh_results()
