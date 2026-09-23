import hashlib, json
from pathlib import Path
from sqlalchemy import inspect, select, text
from app.db.database import Base, engine, SessionLocal
from app.db.models import (ChecklistVersion, CmmiDomain, CmmiDomainPracticeArea,
                           CmmiModelProfile, CmmiRule, DocumentTypeRule,
                           EvidenceFile, Finding,
                           MapRoleScreen, Permission, PracticeArea, Role,
                           SystemConfiguration)
from app.core.screen_registry import sync_screen_registry

ROLES = {
    'Admin': {'*'},
    'Super Admin': {'*'},
    'Auditor': {'customers:read', 'projects:write', 'audits:write', 'evidence:write', 'reports:write'},
    'Auditee': {'customers:read', 'projects:read', 'audits:read', 'evidence:read', 'reports:read', 'approvals:write'},
}
PRACTICE_AREAS = [('IRP','Incident Resolution Process'),('CAR','Causal Analysis and Resolution'),('RSK','Risk & Opportunity Management'),('PR','Peer Reviews'),('PQA','Process Quality Assurance'),('RDM','Requirements Development & Management'),('VV','Verification & Validation'),('EST','Estimating'),('MC','Monitor & Control'),('PLAN','Planning'),('OT','Organizational Training'),('CM','Configuration Management'),('DAR','Decision Analysis & Resolution'),('MPM','Managing Performance & Measurement'),('PAD','Process Asset Development'),('PCM','Process Management'),('GOV','Governance'),('II','Implementation Infrastructure'),('PI','Product Integration'),('TS','Technical Solution'),('CONT','Continuity'),('SDM','Service Delivery Management'),('STSM','Strategic Service Management'),('SAM','Supplier Agreement Management'),('WE','Workforce Empowerment'),('DM','Data Management'),('DQ','Data Quality'),('ESEC','Enabling Security'),('MST','Managing Security Threats & Vulnerabilities'),('ESAF','Enabling Safety'),('EVW','Enabling Virtual Work'),
                  ('SVC','Services'),('BC','Business Continuity'),('PRIV','Privacy'),('SAF','Safety'),('SUP','Supplier Management')]
CHANGE_LOG_FSD_NAME = 'Change Log / FSD'
CHANGE_LOG_FSD_ALIASES = [
    CHANGE_LOG_FSD_NAME, 'change request log/FSD', 'change request log', 'Change Request', 'FSD',
]


def _catalogue_key(value: object) -> str:
    return ''.join(char for char in str(value or '').lower() if char.isalnum())


def _rename_change_log_fsd_catalogue(db) -> None:
    """Migrate old catalogue labels without duplicating referenced document rows.

    This keeps an existing deployment consistent with the seed catalogue on
    startup. If a short-lived upgrade already created both names, references
    are moved to the canonical row before the legacy duplicate is removed.
    """
    legacy_keys = {'changerequestlogfsd', 'changelogfsd'}
    documents = list(db.scalars(select(DocumentTypeRule)).all())
    by_version: dict[int, list[DocumentTypeRule]] = {}
    for document in documents:
        if _catalogue_key(document.document_type) in legacy_keys:
            by_version.setdefault(document.checklist_version_id, []).append(document)
    for version_documents in by_version.values():
        canonical = next(
            (document for document in version_documents if document.document_type == CHANGE_LOG_FSD_NAME),
            None,
        )
        if canonical is None:
            canonical = version_documents[0]
            canonical.document_type = CHANGE_LOG_FSD_NAME
        aliases, seen = [], set()
        for candidate in [*CHANGE_LOG_FSD_ALIASES, *(canonical.aliases or [])]:
            normalized = _catalogue_key(candidate)
            if candidate and normalized not in seen:
                aliases.append(candidate)
                seen.add(normalized)
        canonical.aliases = aliases
        for legacy in version_documents:
            if legacy.id == canonical.id:
                continue
            db.query(CmmiRule).filter(CmmiRule.document_type_rule_id == legacy.id).update(
                {CmmiRule.document_type_rule_id: canonical.id}, synchronize_session='fetch'
            )
            db.query(Finding).filter(Finding.document_type_rule_id == legacy.id).update(
                {Finding.document_type_rule_id: canonical.id}, synchronize_session='fetch'
            )
            db.delete(legacy)
    for evidence in db.scalars(select(EvidenceFile)).all():
        classification = evidence.classification_json or {}
        if _catalogue_key(classification.get('detected_type')) in legacy_keys:
            evidence.classification_json = {**classification, 'detected_type': CHANGE_LOG_FSD_NAME}


def _add_missing_columns(table: str, definitions: dict[str, str]) -> None:
    columns = {column['name'] for column in inspect(engine).get_columns(table)}
    with engine.begin() as connection:
        for name, definition in definitions.items():
            if name not in columns:
                connection.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {definition} NULL'))

def _upgrade_schema() -> None:
    """Apply additive pre-Alembic upgrades safely to existing installations."""
    _add_missing_columns('audit_sessions', {
        'audit_name': 'VARCHAR(255)',
        'audit_date': 'DATE',
        'auditors': 'TEXT',
        'auditees': 'TEXT',
    })
    _add_missing_columns('checklist_versions', {
        'framework': 'VARCHAR(64)',
        'status': 'VARCHAR(32)',
        'effective_from': 'DATE',
    })
    _add_missing_columns('evidence_files', {
        'classification_json': 'JSON',
        'classified_at': 'DATETIME',
    })
    _add_missing_columns('findings', {
        'finding_kind': 'VARCHAR(32)',
        'document_type_rule_id': 'INTEGER',
        'required_keys': 'JSON',
        'available_keys': 'JSON',
        'missing_required_keys': 'JSON',
    })
    _add_missing_columns('cmmi_rules', {
        'document_type_rule_id': 'INTEGER',
        'applicability_condition': 'VARCHAR(500)',
        'detection': 'TEXT',
        'recommendation': 'TEXT',
        'is_mandatory': 'BOOLEAN',
    })
    with engine.begin() as connection:
        connection.execute(text('UPDATE cmmi_rules SET is_mandatory = 1 WHERE is_mandatory IS NULL'))
    cmmi_rule_indexes = {index['name'] for index in inspect(engine).get_indexes('cmmi_rules')}
    with engine.begin() as connection:
        if 'ix_cmmi_rules_document_type_rule_id' not in cmmi_rule_indexes:
            connection.execute(text(
                'CREATE INDEX ix_cmmi_rules_document_type_rule_id ON cmmi_rules (document_type_rule_id)'
            ))
    # Existing rows predate explicit scope. Preserve their UI behavior while
    # ensuring they cannot enter the document-catalogue AFR accidentally.
    with engine.begin() as connection:
        connection.execute(text(
            "UPDATE findings SET finding_kind = 'rule_assessment' WHERE finding_kind IS NULL"
        ))
    finding_indexes = {index['name'] for index in inspect(engine).get_indexes('findings')}
    with engine.begin() as connection:
        if 'ix_findings_finding_kind' not in finding_indexes:
            connection.execute(text('CREATE INDEX ix_findings_finding_kind ON findings (finding_kind)'))
        if 'ix_findings_document_type_rule_id' not in finding_indexes:
            connection.execute(text(
                'CREATE INDEX ix_findings_document_type_rule_id ON findings (document_type_rule_id)'
            ))
    if engine.dialect.name == 'mysql':
        finding_foreign_keys = inspect(engine).get_foreign_keys('findings')
        has_document_type_fk = any(
            foreign_key.get('constrained_columns') == ['document_type_rule_id']
            for foreign_key in finding_foreign_keys
        )
        with engine.begin() as connection:
            # SQLAlchemy's default integer primary key is MySQL INT. Match it
            # exactly before adding the reference (older pre-release builds
            # briefly created this nullable column as BIGINT).
            if not has_document_type_fk:
                connection.execute(text(
                    'ALTER TABLE findings MODIFY COLUMN document_type_rule_id INTEGER NULL'
                ))
            connection.execute(text(
                "ALTER TABLE findings MODIFY COLUMN finding_kind "
                "VARCHAR(32) NOT NULL DEFAULT 'rule_assessment'"
            ))
            if not has_document_type_fk:
                connection.execute(text(
                    'ALTER TABLE findings ADD CONSTRAINT fk_findings_document_type_rule_id '
                    'FOREIGN KEY (document_type_rule_id) REFERENCES document_type_rules (id)'
                ))
    _add_missing_columns('document_type_rules', {
        'include_in_afr': 'BOOLEAN',
    })
    _add_missing_columns('practice_areas', {
        'category': 'VARCHAR(64)',
        'capability_area': 'VARCHAR(255)',
        'max_practice_group_level': 'INTEGER',
        'total_practices': 'INTEGER',
        'is_core': 'BOOLEAN',
    })
    with engine.begin() as connection:
        connection.execute(text('UPDATE practice_areas SET is_core = 0 WHERE is_core IS NULL'))
    _add_missing_columns('roles', {
        'default_screen_id': 'VARCHAR(64)',
        'is_active': 'BOOLEAN',
    })
    with engine.begin() as connection:
        connection.execute(text('UPDATE roles SET is_active = 1 WHERE is_active IS NULL'))
    # ``create_all`` does not widen an existing column.  Preserve every
    # existing evidence record while allowing large XLSX/PDF extraction text.
    extracted_column = next((column for column in inspect(engine).get_columns('evidence_files') if column['name'] == 'extracted_text'), None)
    if engine.dialect.name == 'mysql' and extracted_column and 'LONGTEXT' not in str(extracted_column['type']).upper():
        with engine.begin() as connection:
            connection.execute(text('ALTER TABLE evidence_files MODIFY COLUMN extracted_text LONGTEXT NULL'))


def _rename_reviewer_role(db) -> None:
    """Rename the legacy Reviewer role without dropping its access grants.

    Most installations will have only the old role, where changing the name
    preserves its primary key, memberships, permissions, and screen mappings.
    The merge branch also handles a partially upgraded database that already
    contains an Auditee role.
    """
    reviewer = db.scalar(select(Role).where(Role.name == 'Reviewer'))
    if reviewer is None:
        return

    auditee = db.scalar(select(Role).where(Role.name == 'Auditee'))
    if auditee is None:
        reviewer.name = 'Auditee'
        reviewer.description = 'Auditee role'
        return

    for user in list(reviewer.users):
        if auditee not in user.roles:
            user.roles.append(auditee)
        user.roles.remove(reviewer)
    for permission in list(reviewer.permissions):
        if permission not in auditee.permissions:
            auditee.permissions.append(permission)
        reviewer.permissions.remove(permission)
    for mapping in db.scalars(
        select(MapRoleScreen).where(MapRoleScreen.role_id == reviewer.id)
    ).all():
        current_mapping = db.get(
            MapRoleScreen,
            {'role_id': auditee.id, 'screen_id': mapping.screen_id},
        )
        if current_mapping is None:
            db.add(MapRoleScreen(
                role_id=auditee.id,
                screen_id=mapping.screen_id,
                can_read=mapping.can_read,
                can_write=mapping.can_write,
            ))
        else:
            current_mapping.can_read = current_mapping.can_read or mapping.can_read
            current_mapping.can_write = current_mapping.can_write or mapping.can_write
        db.delete(mapping)
    db.delete(reviewer)


def _restore_rules_catalogue_default_access(db) -> None:
    """One-time repair for the temporary Admin-only catalogue restriction.

    New and custom roles remain disabled until an administrator explicitly
    grants a page mapping. The marker ensures a later administrator change is
    never overwritten at startup.
    """
    marker_key = 'rbac.rules_catalogue_admin_super_admin_default_v1'
    if db.scalar(select(SystemConfiguration).where(SystemConfiguration.key == marker_key)):
        return
    for name in ('Admin', 'Super Admin'):
        role = db.scalar(select(Role).where(Role.name == name))
        if role is None:
            continue
        mapping = db.get(MapRoleScreen, (role.id, 'rule_catalog'))
        if mapping is None:
            db.add(MapRoleScreen(
                role_id=role.id, screen_id='rule_catalog', can_read=True, can_write=True,
            ))
        else:
            mapping.can_read = True
            mapping.can_write = True
    db.add(SystemConfiguration(key=marker_key, value='applied'))


def _backfill_split_administration_access(db) -> None:
    """Preserve existing combined administration access after the page split.

    Before Manage Users and Manage Roles became separate pages, a role that
    could manage users could also edit roles from the same screen. Copy that
    effective grant once; future changes remain independently configurable.
    """
    marker_key = 'rbac.split_administration_access_v1'
    if db.scalar(select(SystemConfiguration).where(SystemConfiguration.key == marker_key)):
        return
    for role in db.scalars(select(Role)).all():
        users_mapping = db.get(MapRoleScreen, (role.id, 'user_administration'))
        roles_mapping = db.get(MapRoleScreen, (role.id, 'role_administration'))
        if users_mapping and roles_mapping:
            roles_mapping.can_read = users_mapping.can_read
            roles_mapping.can_write = users_mapping.can_write
    db.add(SystemConfiguration(key=marker_key, value='applied'))


def _retire_unsupported_roles(db) -> None:
    """Consolidate retired seeded roles into the supported Auditee role.

    The application now operates with Admin, Super Admin, Auditor, and
    Auditee. Existing Account Manager and Viewer accounts remain usable, but
    are moved to Auditee before the legacy role rows are removed.
    """
    marker_key = 'rbac.retire_account_manager_viewer_v1'
    if db.scalar(select(SystemConfiguration).where(SystemConfiguration.key == marker_key)):
        return
    auditee = db.scalar(select(Role).where(Role.name == 'Auditee'))
    if auditee is None:
        return
    for role_name in ('Account Manager', 'Viewer'):
        legacy = db.scalar(select(Role).where(Role.name == role_name))
        if legacy is None:
            continue
        for account in list(legacy.users):
            account.roles.remove(legacy)
            if not account.roles:
                account.roles.append(auditee)
        for permission in list(legacy.permissions):
            legacy.permissions.remove(permission)
        for mapping in db.scalars(select(MapRoleScreen).where(MapRoleScreen.role_id == legacy.id)).all():
            db.delete(mapping)
        db.delete(legacy)
    db.add(SystemConfiguration(key=marker_key, value='applied'))


def _remove_retired_dashboard_reference_data(db) -> None:
    """Remove the retired seeded taxonomy without touching audit evidence.

    These tables fed the former CMMI reference dashboard. The operational
    dashboard reads only users, projects, sessions, evidence, and findings.
    Practice-area codes remain because they are referenced by the active
    checklist and historical finding records.
    """
    db.query(CmmiDomainPracticeArea).delete(synchronize_session=False)
    db.query(CmmiDomain).delete(synchronize_session=False)
    db.query(CmmiModelProfile).delete(synchronize_session=False)
    db.query(PracticeArea).update({
        PracticeArea.category: None,
        PracticeArea.capability_area: None,
        PracticeArea.max_practice_group_level: None,
        PracticeArea.total_practices: None,
        PracticeArea.is_core: False,
    }, synchronize_session=False)
    db.query(SystemConfiguration).filter(
        SystemConfiguration.key == 'cmmi_v3_structure_source_checksum'
    ).delete(synchronize_session=False)

def initialise_database():
    Base.metadata.create_all(engine)
    _upgrade_schema()
    seed = Path(__file__).parent / 'seed_data' / 'cmmi_rules.json'
    raw = seed.read_bytes(); rules = json.loads(raw)
    with SessionLocal() as db:
        _rename_reviewer_role(db)
        permissions = {code: Permission(code=code, description=code) for codes in ROLES.values() for code in codes}
        for value in permissions.values():
            if not db.scalar(select(Permission).where(Permission.code == value.code)): db.add(value)
        db.flush()
        permission_rows = {p.code:p for p in db.scalars(select(Permission)).all()}
        for name, codes in ROLES.items():
            role = db.scalar(select(Role).where(Role.name == name))
            if not role:
                role = Role(name=name, description=f'{name} role'); db.add(role); db.flush()
                # Seed only newly created roles.  Reassigning this relationship
                # on every boot used to silently undo production role changes.
                role.permissions = list(permission_rows.values()) if '*' in codes else [permission_rows[c] for c in codes]
        _remove_retired_dashboard_reference_data(db)
        for code, name in PRACTICE_AREAS:
            if not db.scalar(select(PracticeArea).where(PracticeArea.code == code)):
                db.add(PracticeArea(code=code, name=name))
        checksum = hashlib.sha256(raw).hexdigest()
        version = db.scalar(select(ChecklistVersion).where(ChecklistVersion.checksum == checksum))
        if not version:
            version = ChecklistVersion(version='CMMI-V3-2026.09.01', source='CMMI_v3_Rule_Based_Audit_Checklist_v2.xlsx / MASTER', checksum=checksum,
                                       framework='CMMI v3.0', status='ACTIVE')
            db.add(version); db.flush()
            db.add_all([CmmiRule(checklist_version_id=version.id, rule_id=r['rule_id'], practice_area_code=r['practice_area'], level=r['level'], audit_check=r['audit_check'], gap_text=r['gap_text']) for r in rules])
        if not db.scalar(select(DocumentTypeRule.id).where(DocumentTypeRule.checklist_version_id == version.id)):
            documents = json.loads((Path(__file__).parent / 'seed_data' / 'document_types.json').read_text(encoding='utf-8'))
            db.add_all([DocumentTypeRule(checklist_version_id=version.id, document_type=item['document_type'],
                                         practice_areas=item.get('practice_areas', []), keywords=item.get('keywords', []),
                                         aliases=item.get('aliases', []), expected_evidence=item.get('expected_evidence'),
                                         primary_purpose=item.get('primary_purpose'),
                                         include_in_afr=bool(item.get('include_in_afr', False))) for item in documents])
        _rename_change_log_fsd_catalogue(db)
        sync_screen_registry(db)
        # Screen-registry mappings are needed by the one-time access
        # migrations below. Flush first so their existence checks cannot add
        # duplicate composite keys on a newly initialized database.
        db.flush()
        _backfill_split_administration_access(db)
        _restore_rules_catalogue_default_access(db)
        _retire_unsupported_roles(db)
        db.commit()
