"""Live operational dashboard backed only by current system records."""
from copy import deepcopy
from datetime import timezone

from nicegui import ui
from sqlalchemy import case, func, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.screen_registry import has_screen_permission, screen_url
from app.db.database import SessionLocal
from app.db.models import (
    AuditProject, AuditSession, Customer, EvidenceFile, EvidenceSource, Finding, PracticeArea,
    User,
)
from app.gui.layout import layout
from app.gui.search import table_search_input
from app.services.auth.service import get_session_user


# A lightweight change check keeps open browser tabs in sync. The dashboard
# redraws only after stored operational data changes, never on an idle poll.
DASHBOARD_CHANGE_CHECK_SECONDS = 2


def _session_context(screen_id: str) -> tuple[bool, str | None]:
    request = ui.context.client.request
    token = request.cookies.get('cmmi_session') if request else None
    with SessionLocal() as db:
        user = get_session_user(db, token)
        if not user:
            return False, None
        return has_screen_permission(db, user, screen_id, 'read'), (user.display_name or user.email)


def _metric(label: str, value: int, caption: str, icon: str, accent: str, tint: str) -> None:
    with ui.card().classes('flex-1 min-w-52 bg-white').style(
        f'border:1px solid #e5e9f0; border-left:3px solid {accent};'
    ):
        with ui.row().classes('w-full items-center gap-3 no-wrap'):
            with ui.element('div').classes('rounded-full flex items-center justify-center flex-none').style(
                f'width:40px; height:40px; background:{tint};'
            ):
                ui.icon(icon).style(f'color:{accent}').classes('text-xl')
            with ui.column().classes('gap-0 min-w-0'):
                ui.label(label).classes('text-sm font-semibold text-slate-600')
                ui.label(str(value)).classes('text-2xl font-bold text-slate-900 leading-tight')
                ui.label(caption).classes('text-xs text-slate-500')


def _dashboard_revision(db) -> tuple:
    """Return a compact fingerprint for data that can change this dashboard.

    Browser clients cannot be notified directly by a database commit from a
    different request or worker.  This small check detects additions and
    updates (including uploads and completed scans); only a changed revision
    triggers a page redraw.
    """
    row = db.execute(select(
        select(func.count(User.id)).scalar_subquery(), select(func.max(User.updated_at)).scalar_subquery(),
        select(func.count(Customer.id)).scalar_subquery(), select(func.max(Customer.updated_at)).scalar_subquery(),
        select(func.count(AuditProject.id)).scalar_subquery(), select(func.max(AuditProject.updated_at)).scalar_subquery(),
        select(func.count(AuditSession.id)).scalar_subquery(), select(func.max(AuditSession.updated_at)).scalar_subquery(),
        select(func.count(EvidenceFile.id)).scalar_subquery(), select(func.max(EvidenceFile.updated_at)).scalar_subquery(),
        select(func.count(Finding.id)).scalar_subquery(), select(func.max(Finding.updated_at)).scalar_subquery(),
    )).one()
    # Customer and practice-area labels are rendered on this page. Including
    # their compact display fields also avoids missing two rapid edits that
    # receive the same database timestamp resolution.
    customer_labels = tuple(db.execute(
        select(Customer.id, Customer.name, Customer.contact_email).order_by(Customer.id)
    ).all())
    practice_area_labels = tuple(db.execute(
        select(PracticeArea.id, PracticeArea.code, PracticeArea.name).order_by(PracticeArea.id)
    ).all())
    return tuple(row) + (customer_labels, practice_area_labels)


def _latest_scanned_sessions():
    """Return the most recently completed scan ID for every project.

    A session can be scanned again after a newer session was created. The
    dashboard must then show that most recently updated completed scan, not
    simply the session with the highest primary key.
    """
    ranked_scans = (
        select(
            AuditSession.project_id.label('project_id'),
            AuditSession.id.label('audit_session_id'),
            func.row_number().over(
                partition_by=AuditSession.project_id,
                order_by=(AuditSession.updated_at.desc(), AuditSession.id.desc()),
            ).label('scan_rank'),
        )
        .where(AuditSession.status == 'scanned')
        .subquery()
    )
    return (
        select(
            ranked_scans.c.project_id,
            ranked_scans.c.audit_session_id,
        )
        .where(ranked_scans.c.scan_rank == 1)
        .subquery()
    )


def _add_chart_toolbox(options: dict, category_axis: str) -> dict:
    """Keep only unambiguous native chart actions in the compact toolbox.

    A data-range selection is not a full-screen chart view. Showing it beside
    the chart's Zoom In action led users to click the wrong control. The
    actual full-screen action is now a labelled button in each chart header;
    ECharts retains only reset and export here.
    """
    if category_axis not in {'yAxisIndex', 'xAxisIndex'}:
        raise ValueError(f'Unsupported category axis: {category_axis}')
    options['toolbox'] = {
        'show': True,
        'right': 10,
        'feature': {
            'restore': {},
            'saveAsImage': {'pixelRatio': 2},
        },
    }
    return options


def _open_chart_zoom_dialog(title: str, chart_options: dict, on_point_click=None) -> None:
    """Open the selected chart at full size; Zoom Out closes this focused view."""
    with ui.dialog().props('maximized') as dialog, ui.card().classes('w-full h-full p-4').style(
        'border:1px solid #e2e8f0; overflow:auto;'
    ):
        with ui.row().classes('w-full items-center justify-between mb-2'):
            ui.label(title).classes('text-base font-semibold text-slate-800')
            ui.button('Zoom out', icon='zoom_out', on_click=dialog.close).props(
                'flat dense color=grey-7'
            ).tooltip('Return to the dashboard chart')
        ui.label('Use the chart toolbar to zoom, restore, or export. Click a bar to open its details.').classes(
            'text-xs text-slate-500 mb-2'
        )
        with ui.scroll_area().classes('w-full').style('height:86vh;'):
            zoom_chart = ui.echart(deepcopy(chart_options)).style('height:80vh; min-height:620px;')
            if on_point_click:
                zoom_chart.on_point_click(on_point_click)
    dialog.open()


def _reset_chart_zoom(chart) -> None:
    """Return every data-zoom control on a chart to its full-range state."""
    chart.run_chart_method('dispatchAction', {'type': 'dataZoom', 'start': 0, 'end': 100})


def _zoom_controls(chart, title: str, on_point_click=None) -> None:
    """Render visible chart actions inside the caller's header action area."""
    ui.button(
        'Zoom out', icon='zoom_out', on_click=lambda: _reset_chart_zoom(chart),
    ).props('flat dense color=grey-7').tooltip('Reset the chart to its full range')
    ui.button(
        'Zoom in', icon='zoom_in',
        on_click=lambda: _open_chart_zoom_dialog(title, chart.options, on_point_click),
    ).props('unelevated dense color=primary').tooltip('Open this chart in a full-screen view')


def _open_project_details(project_id: int) -> None:
    """Show current, project-scoped information without exposing other projects."""
    with SessionLocal() as db:
        project_row = db.execute(
            select(AuditProject, Customer).join(Customer, Customer.id == AuditProject.customer_id)
            .where(AuditProject.id == project_id)
        ).first()
        session = db.scalar(select(AuditSession).where(
            AuditSession.project_id == project_id, AuditSession.status == 'scanned',
        ).order_by(AuditSession.updated_at.desc(), AuditSession.id.desc()).limit(1))
        sessions = db.scalar(select(func.count(AuditSession.id)).where(AuditSession.project_id == project_id)) or 0
        evidence_files = finding_count = 0
        findings: list[Finding] = []
        if session:
            evidence_files = db.scalar(select(func.count(EvidenceFile.id)).join(
                EvidenceSource, EvidenceSource.id == EvidenceFile.source_id,
            ).where(EvidenceSource.audit_session_id == session.id)) or 0
            finding_count = db.scalar(select(func.count(Finding.id)).where(
                Finding.audit_session_id == session.id, Finding.status != 'superseded',
            )) or 0
            findings = db.scalars(select(Finding).where(
                Finding.audit_session_id == session.id, Finding.status != 'superseded',
            ).order_by(Finding.severity, Finding.created_at.desc())).all()
    if not project_row:
        ui.notify('This project no longer exists.', type='warning')
        return
    project, customer = project_row
    with ui.dialog() as dialog:
        with ui.card().classes('w-[min(92vw,960px)] max-w-full p-0').style('height:min(86vh,820px); overflow:hidden;'):
            with ui.row().classes('w-full items-start justify-between p-4 pb-2 no-wrap'):
                with ui.column().classes('gap-0 min-w-0'):
                    ui.label(f'Project details - {project.name}').classes('text-xl font-bold')
                    ui.label(f'Customer: {customer.name}').classes('text-sm text-slate-600')
                ui.button(icon='close', on_click=dialog.close).props(
                    'flat round dense color=grey-7 aria-label="Close project details"'
                ).tooltip('Close')
            with ui.scroll_area().classes('w-full').style('height:calc(min(86vh,820px) - 84px);'):
                with ui.column().classes('w-full p-4 pt-2 gap-3'):
                    with ui.row().classes('w-full gap-3 flex-wrap'):
                        _metric('Audit sessions', sessions, 'Stored for this project', 'assignment', '#2563eb', '#dbeafe')
                        _metric('Evidence files', evidence_files, 'In the latest scanned session', 'description', '#7c3aed', '#ede9fe')
                        _metric('Current findings', finding_count, 'Excludes superseded scan results', 'fact_check', '#c2410c', '#ffedd5')
                    if session:
                        ui.label(
                            f'Latest scan: {session.audit_name or f"Audit session #{session.id}"} - '
                            f'{_display_datetime(session.updated_at)} - {session.status.title()}'
                        ).classes('text-sm text-slate-600')
                    else:
                        ui.label('This project has no completed scan yet.').classes('text-sm text-warning')
                    if findings:
                        ui.table(columns=[
                            {'name': 'rule', 'label': 'Rule', 'field': 'rule', 'align': 'left'},
                            {'name': 'area', 'label': 'Practice area', 'field': 'area', 'align': 'left'},
                            {'name': 'severity', 'label': 'Severity', 'field': 'severity', 'align': 'left'},
                            {'name': 'status', 'label': 'Status', 'field': 'status', 'align': 'left'},
                            {'name': 'finding', 'label': 'Finding', 'field': 'finding', 'align': 'left'},
                        ], rows=[
                            {'id': finding.id, 'rule': finding.rule_id or '-', 'area': finding.practice_area_code,
                             'severity': finding.severity.title(), 'status': finding.status.replace('_', ' ').title(),
                             'finding': finding.title}
                            for finding in findings
                        ], row_key='id').classes('w-full').props(
                            "flat dense pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50]}"
                        )
    dialog.open()


def _open_practice_area_details(practice_area_code: str) -> None:
    """Open the current findings behind a practice-area chart bar."""
    latest_session_ids = select(_latest_scanned_sessions().c.audit_session_id)
    with SessionLocal() as db:
        findings = db.execute(
            select(Finding, AuditProject.name.label('project'))
            .join(AuditSession, AuditSession.id == Finding.audit_session_id)
            .join(AuditProject, AuditProject.id == AuditSession.project_id)
            .where(
                Finding.audit_session_id.in_(latest_session_ids),
                Finding.practice_area_code == practice_area_code,
                Finding.status != 'superseded',
            )
            .order_by(AuditProject.name, Finding.severity, Finding.created_at.desc())
        ).all()
    with ui.dialog() as dialog:
        with ui.card().classes('w-[min(92vw,960px)] max-w-full p-0').style('height:min(86vh,820px); overflow:hidden;'):
            with ui.row().classes('w-full items-center justify-between p-4 pb-2'):
                ui.label(f'Practice-area details - {practice_area_code}').classes('text-xl font-bold')
                ui.button(icon='close', on_click=dialog.close).props(
                    'flat round dense color=grey-7 aria-label="Close practice-area details"'
                ).tooltip('Close')
            with ui.scroll_area().classes('w-full').style('height:calc(min(86vh,820px) - 76px);'):
                with ui.column().classes('w-full p-4 pt-2'):
                    if findings:
                        ui.table(columns=[
                            {'name': 'project', 'label': 'Project', 'field': 'project', 'align': 'left'},
                            {'name': 'rule', 'label': 'Rule', 'field': 'rule', 'align': 'left'},
                            {'name': 'severity', 'label': 'Severity', 'field': 'severity', 'align': 'left'},
                            {'name': 'status', 'label': 'Status', 'field': 'status', 'align': 'left'},
                            {'name': 'finding', 'label': 'Finding', 'field': 'finding', 'align': 'left'},
                        ], rows=[
                            {'id': finding.id, 'project': project, 'rule': finding.rule_id or '-',
                             'severity': finding.severity.title(), 'status': finding.status.replace('_', ' ').title(),
                             'finding': finding.title}
                            for finding, project in findings
                        ], row_key='id').classes('w-full').props(
                            "flat dense pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [10, 25, 50]}"
                        )
                    else:
                        ui.label('No current findings exist for this practice area.').classes('text-slate-600')
    dialog.open()


def _live_dashboard_data(db) -> dict:
    """Fetch current operational aggregates without historical scan inflation.

    A scan supersedes prior findings only within its audit session.  Projects
    can have several sessions, so counting every session makes legacy/open
    records dominate the chart and hides newly scanned projects.  Dashboard
    finding metrics intentionally use only each project's latest completed
    scan; all stored sessions remain available in the audit workspace.
    """
    total_users = db.scalar(select(func.count(User.id))) or 0
    active_users = db.scalar(select(func.count(User.id)).where(User.is_active.is_(True))) or 0
    project_count = db.scalar(select(func.count(AuditProject.id))) or 0
    session_count = db.scalar(select(func.count(AuditSession.id))) or 0
    scanned_sessions = db.scalar(select(func.count(AuditSession.id)).where(AuditSession.status == 'scanned')) or 0
    evidence_files = db.scalar(select(func.count(EvidenceFile.id))) or 0

    latest_scanned_sessions = _latest_scanned_sessions()
    current_session_ids = select(latest_scanned_sessions.c.audit_session_id)
    current_project_session_id = (
        select(latest_scanned_sessions.c.audit_session_id)
        .where(latest_scanned_sessions.c.project_id == AuditProject.id)
        .correlate(AuditProject)
        .scalar_subquery()
    )
    open_findings = db.scalar(select(func.count(Finding.id)).where(
        Finding.audit_session_id.in_(current_session_ids),
        Finding.status == 'open',
    )) or 0

    project_sessions = (
        select(func.count(AuditSession.id)).where(AuditSession.project_id == AuditProject.id)
        .correlate(AuditProject).scalar_subquery()
    )
    project_findings = (
        select(func.count(Finding.id)).select_from(Finding)
        .where(
            Finding.audit_session_id == current_project_session_id,
            Finding.status != 'superseded',
        ).correlate(AuditProject).scalar_subquery()
    )
    project_open_findings = (
        select(func.count(Finding.id)).select_from(Finding)
        .where(
            Finding.audit_session_id == current_project_session_id,
            Finding.status == 'open',
        )
        .correlate(AuditProject).scalar_subquery()
    )
    project_last_scan = (
        select(AuditSession.updated_at).where(
            AuditSession.id == current_project_session_id,
        ).correlate(AuditProject).scalar_subquery()
    )
    project_audit_name = (
        select(AuditSession.audit_name).where(AuditSession.id == current_project_session_id)
        .correlate(AuditProject).scalar_subquery()
    )
    project_evidence_files = (
        select(func.count(EvidenceFile.id)).select_from(EvidenceFile)
        .join(EvidenceSource, EvidenceSource.id == EvidenceFile.source_id)
        .where(EvidenceSource.audit_session_id == current_project_session_id)
        .correlate(AuditProject).scalar_subquery()
    )
    projects = db.execute(
        select(AuditProject.id, AuditProject.name, Customer.name.label('customer'),
               project_sessions.label('sessions'), project_findings.label('findings'),
               project_open_findings.label('open_findings'), project_last_scan.label('last_scan'),
               project_audit_name.label('audit_name'), project_evidence_files.label('evidence_files'))
        .join(Customer, Customer.id == AuditProject.customer_id)
        .order_by(project_last_scan.desc(), AuditProject.updated_at.desc(), AuditProject.name)
    ).all()

    practice_findings = db.execute(
        select(
            Finding.practice_area_code,
            func.coalesce(PracticeArea.name, Finding.practice_area_code).label('practice_area_name'),
            func.count(Finding.id).label('total'),
            func.sum(case((Finding.status == 'open', 1), else_=0)).label('open'),
        )
        .outerjoin(PracticeArea, PracticeArea.code == Finding.practice_area_code)
        .where(Finding.audit_session_id.in_(current_session_ids), Finding.status != 'superseded')
        .group_by(Finding.practice_area_code, PracticeArea.name)
        .order_by(func.sum(case((Finding.status == 'open', 1), else_=0)).desc(), func.count(Finding.id).desc())
        .limit(12)
    ).all()
    return {
        'total_users': total_users, 'active_users': active_users, 'projects': project_count,
        'sessions': session_count, 'scanned_sessions': scanned_sessions,
        'open_findings': open_findings, 'evidence_files': evidence_files,
        'project_rows': projects, 'practice_rows': practice_findings,
    }


def _display_datetime(value) -> str:
    if not value:
        return '-'
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc)
    return value.strftime('%d %b %Y %H:%M UTC')


def _render_dashboard_content() -> None:
    """Render one fresh snapshot; the caller owns the page-local refresh action."""
    allowed, _ = _session_context('dashboard')
    if not allowed:
        ui.label('Your Dashboard access has expired or been removed.').classes('text-negative')
        return
    with SessionLocal() as db:
        data = _live_dashboard_data(db)

    with ui.row().classes('w-full items-center justify-between gap-3 flex-wrap mt-4'):
        ui.label('System activity').classes('text-xl font-bold text-slate-800')

    with ui.row().classes('w-full gap-4 flex-wrap mt-3'):
        _metric('Total users', data['total_users'], f"{data['active_users']} enabled account(s)", 'group', '#2563eb', '#dbeafe')
        _metric('Projects', data['projects'], f"{data['sessions']} audit sessions", 'folder_open', '#0f766e', '#ccfbf1')
        _metric('Open findings', data['open_findings'], 'Across all projects', 'fact_check', '#c2410c', '#ffedd5')
        _metric('Evidence files', data['evidence_files'], f"{data['scanned_sessions']} sessions scanned", 'description', '#7c3aed', '#ede9fe')

    with ui.expansion('Show Charts', icon='insights', value=False).classes('w-full mb-3'):
        with ui.row().classes('w-full gap-5 items-start flex-wrap mt-7'):
            with ui.card().classes('min-w-[32rem] flex-1 bg-white').style('border:1px solid #e5e9f0; border-top:3px solid #0f766e;'):
                with ui.row().classes('w-full items-start justify-between gap-2 no-wrap'):
                    with ui.column().classes('gap-0 min-w-0'):
                        ui.label('Findings by project').classes('text-lg font-bold')
                        ui.label('Latest scanned session per project; updates automatically after a scan.').classes('text-xs text-slate-500 mb-3')
                    project_chart_actions = ui.row().classes('items-center gap-1 flex-none')
                if not data['project_rows']:
                    ui.label('No projects have been created yet.').classes('text-sm text-slate-500 py-5')
                else:
                    project_rows = list(data['project_rows'])

                    def open_project_from_chart(event) -> None:
                        if 0 <= event.data_index < len(project_rows):
                            _open_project_details(int(project_rows[event.data_index].id))

                    project_chart = ui.echart(_add_chart_toolbox({
                        'tooltip': {'trigger': 'axis'},
                        'grid': {'left': 150, 'right': 40, 'top': 18, 'bottom': 28},
                        'xAxis': {
                            'type': 'value', 'minInterval': 1,
                        },
                        'yAxis': {
                            'type': 'category', 'data': [row.name for row in data['project_rows']],
                            'axisLabel': {'width': 135, 'overflow': 'truncate'},
                        },
                        'series': [
                            {'name': 'Open', 'type': 'bar', 'barMaxWidth': 18,
                             'data': [int(row.open_findings or 0) for row in project_rows],
                             'itemStyle': {'color': '#dc2626'}},
                            {'name': 'Current findings', 'type': 'bar', 'barMaxWidth': 18,
                             'data': [int(row.findings or 0) for row in project_rows],
                             'itemStyle': {'color': '#2563eb'}},
                        ], 'legend': {'bottom': 0},
                        'dataZoom': [{'type': 'inside', 'yAxisIndex': 0}, {'type': 'slider', 'yAxisIndex': 0, 'right': 4}],
                    }, 'yAxisIndex')).classes('w-full h-96')
                    project_chart.on_point_click(open_project_from_chart)
                    with project_chart_actions:
                        _zoom_controls(project_chart, 'Findings by project', open_project_from_chart)

            with ui.card().classes('min-w-[28rem] flex-1 bg-white').style('border:1px solid #e5e9f0; border-top:3px solid #c2410c;'):
                with ui.row().classes('w-full items-start justify-between gap-2 no-wrap'):
                    with ui.column().classes('gap-0 min-w-0'):
                        ui.label('Findings by practice area').classes('text-lg font-bold')
                        ui.label('Open and total findings are calculated from live records.').classes('text-xs text-slate-500 mb-3')
                    practice_chart_actions = ui.row().classes('items-center gap-1 flex-none')
                if not data['practice_rows']:
                    ui.label('No findings have been created yet.').classes('text-sm text-slate-500 py-5')
                else:
                    practice_rows = list(data['practice_rows'])

                    def open_practice_from_chart(event) -> None:
                        _open_practice_area_details(str(event.name))

                    practice_chart = ui.echart(_add_chart_toolbox({
                        'tooltip': {'trigger': 'axis'},
                        'grid': {'left': 42, 'right': 12, 'top': 18, 'bottom': 62},
                        'xAxis': {'type': 'category', 'data': [row.practice_area_code for row in data['practice_rows']],
                                  'axisLabel': {'interval': 0, 'rotate': 35}},
                        'yAxis': {'type': 'value', 'minInterval': 1},
                        'series': [
                            {'name': 'Open', 'type': 'bar', 'data': [int(row.open or 0) for row in practice_rows],
                             'itemStyle': {'color': '#dc2626'}},
                            {'name': 'All findings', 'type': 'bar', 'data': [int(row.total or 0) for row in practice_rows],
                             'itemStyle': {'color': '#2563eb'}},
                        ], 'legend': {'bottom': 0},
                        'dataZoom': [{'type': 'inside', 'xAxisIndex': 0}, {'type': 'slider', 'xAxisIndex': 0, 'bottom': 0}],
                    }, 'xAxisIndex')).classes('w-full h-72')
                    practice_chart.on_point_click(open_practice_from_chart)
                    with practice_chart_actions:
                        _zoom_controls(practice_chart, 'Findings by practice area', open_practice_from_chart)

    with ui.card().classes('w-full mt-7 bg-white').style('border:1px solid #e5e9f0; border-top:3px solid #2563eb;'):
        ui.label('Project-wise details').classes('text-lg font-bold')
        ui.label('Search by project, customer, or latest audit session. Select View Details for the project current evidence and findings.').classes('text-xs text-slate-500 mb-3')
        paging = {'page': 1, 'page_size': 10}

        def refresh_project_details(reset_page: bool = False) -> None:
            if reset_page:
                paging['page'] = 1
            project_details.refresh()

        search = table_search_input(
            'Search project details', 'Project, customer, or latest audit session',
            on_change=lambda _: refresh_project_details(reset_page=True),
        )

        def change_page(event) -> None:
            paging['page'] = int(event.value)
            project_details.refresh()

        def change_page_size(event) -> None:
            paging['page_size'] = int(event.value)
            paging['page'] = 1
            project_details.refresh()

        @ui.refreshable
        def project_details() -> None:
            query = (search.value or '').strip().casefold()
            rows = []
            for row in data['project_rows']:
                searchable = ' '.join((str(row.name or ''), str(row.customer or ''), str(row.audit_name or ''))).casefold()
                if query and query not in searchable:
                    continue
                rows.append({
                    'id': row.id, 'project': row.name, 'customer': row.customer,
                    'audit_session': row.audit_name or 'Not scanned',
                    'last_scan': _display_datetime(row.last_scan), 'sessions': int(row.sessions or 0),
                    'evidence_files': int(row.evidence_files or 0), 'open': int(row.open_findings or 0),
                    'total': int(row.findings or 0),
                })
            total_rows = len(rows)
            page_count = max(1, (total_rows + paging['page_size'] - 1) // paging['page_size'])
            paging['page'] = min(paging['page'], page_count)
            first_row = (paging['page'] - 1) * paging['page_size']
            visible_rows = rows[first_row:first_row + paging['page_size']]
            table = ui.table(columns=[
                {'name': 'project', 'label': 'Project', 'field': 'project', 'align': 'left'},
                {'name': 'customer', 'label': 'Customer', 'field': 'customer', 'align': 'left'},
                {'name': 'audit_session', 'label': 'Latest audit session', 'field': 'audit_session', 'align': 'left'},
                {'name': 'last_scan', 'label': 'Last scan', 'field': 'last_scan', 'align': 'left'},
                {'name': 'sessions', 'label': 'Sessions', 'field': 'sessions', 'align': 'right'},
                {'name': 'evidence_files', 'label': 'Evidence files', 'field': 'evidence_files', 'align': 'right'},
                {'name': 'open', 'label': 'Open', 'field': 'open', 'align': 'right'},
                {'name': 'total', 'label': 'Current findings', 'field': 'total', 'align': 'right'},
                {'name': 'actions', 'label': 'Actions', 'field': 'actions', 'align': 'right'},
            ], rows=visible_rows, row_key='id').classes('w-full mt-3').props(
                'flat dense hide-bottom'
            )
            table.add_slot('body-cell-actions', '''
                <q-td :props="props">
                    <q-btn flat dense color="primary" icon="visibility" label="View Details"
                           @click="$parent.$emit('view_project_details', props.row.id)" />
                </q-td>
            ''')
            table.on('view_project_details', lambda event: _open_project_details(int(event.args)))
            with ui.row().classes('w-full items-center justify-between gap-3 flex-wrap mt-4'):
                if total_rows:
                    ui.label(
                        f'Showing {first_row + 1}-{min(first_row + paging["page_size"], total_rows)} of {total_rows} project(s)'
                    ).classes('text-sm text-slate-600')
                else:
                    ui.label('No projects match this search.').classes('text-sm text-slate-600')
                with ui.row().classes('items-center gap-3'):
                    ui.select(
                        {10: '10 per page', 25: '25 per page', 50: '50 per page'},
                        value=paging['page_size'], on_change=change_page_size,
                    ).props('outlined dense').classes('w-36')
                    if total_rows > paging['page_size']:
                        ui.pagination(
                            1, page_count, value=paging['page'], direction_links=True, on_change=change_page,
                        ).props('boundary-links color=primary')

        project_details()


def register():
    @ui.page(screen_url('dashboard'))
    def dashboard():
        allowed, display_name = _session_context('dashboard')
        layout(f'Welcome back, {display_name}!' if display_name else 'Dashboard',
               'Live view of the projects, audit sessions, evidence, and findings stored in this system.')
        if not allowed:
            ui.label('You do not have permission to view the Dashboard.').classes('text-negative')
            return
        # This function must be page-local. A module-level ``ui.refreshable``
        # stores targets from every browser tab, causing one user's timer to
        # redraw every other open dashboard. The local wrapper owns exactly
        # this page's target and refresh action.
        revision_state = {'value': None}

        @ui.refreshable
        def dashboard_content() -> None:
            _render_dashboard_content()
            with SessionLocal() as db:
                revision_state['value'] = _dashboard_revision(db)

        dashboard_content()

        def refresh_if_data_changed() -> None:
            try:
                with SessionLocal() as db:
                    current_revision = _dashboard_revision(db)
            except SQLAlchemyError:
                # Retain the established UI during a transient database issue;
                # the next lightweight check retries without surfacing a timer error.
                return
            if current_revision != revision_state['value']:
                dashboard_content.refresh()

        # Refreshable replaces existing content in-place, so changed uploads,
        # scans, projects, users, and findings are visible without a button.
        ui.timer(DASHBOARD_CHANGE_CHECK_SECONDS, refresh_if_data_changed)
