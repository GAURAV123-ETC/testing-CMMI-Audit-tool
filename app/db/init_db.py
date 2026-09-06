import hashlib, json
from pathlib import Path
from sqlalchemy import inspect, select, text
from app.core.security import hash_password
from app.db.database import Base, engine, SessionLocal
from app.db.models import ChecklistVersion, CmmiRule, DocumentTypeRule, Permission, PracticeArea, Role, User
from app.core.screen_registry import sync_screen_registry

ROLES = {
    'Admin': {'*'},
    'Super Admin': {'*'},
    'Auditor': {'customers:read', 'projects:write', 'audits:write', 'evidence:write', 'findings:write', 'reports:write'},
    'Reviewer': {'customers:read', 'projects:read', 'audits:read', 'evidence:read', 'findings:write', 'reports:read', 'approvals:write'},
    'Account Manager': {'customers:write', 'projects:write', 'audits:read', 'reports:read'},
    'Viewer': {'customers:read', 'projects:read', 'audits:read', 'evidence:read', 'findings:read', 'reports:read'},
}
PRACTICE_AREAS = [('IRP','Incident Resolution Process'),('CAR','Causal Analysis and Resolution'),('RSK','Risk & Opportunity Management'),('PR','Peer Reviews'),('PQA','Process Quality Assurance'),('RDM','Requirements Development & Management'),('VV','Verification & Validation'),('EST','Estimating'),('MC','Monitor & Control'),('PLAN','Planning'),('OT','Organizational Training'),('CM','Configuration Management'),('DAR','Decision Analysis & Resolution'),('MPM','Managing Performance & Measurement'),('PAD','Process Asset Development'),('PCM','Process Management'),('GOV','Governance'),('II','Implementation Infrastructure'),('PI','Product Integration'),('TS','Technical Solution'),('CONT','Continuity'),('SDM','Service Delivery Management'),('STSM','Strategic Service Management'),('SAM','Supplier Agreement Management'),('WE','Workforce Empowerment'),('DM','Data Management'),('DQ','Data Quality'),('ESEC','Enabling Security'),('MST','Managing Security Threats & Vulnerabilities'),('ESAF','Enabling Safety'),('EVW','Enabling Virtual Work'),
                  ('SVC','Services'),('BC','Business Continuity'),('PRIV','Privacy'),('SAF','Safety'),('SUP','Supplier Management')]


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
    # ``create_all`` does not widen an existing column.  Preserve every
    # existing evidence record while allowing large XLSX/PDF extraction text.
    extracted_column = next((column for column in inspect(engine).get_columns('evidence_files') if column['name'] == 'extracted_text'), None)
    if engine.dialect.name == 'mysql' and extracted_column and 'LONGTEXT' not in str(extracted_column['type']).upper():
        with engine.begin() as connection:
            connection.execute(text('ALTER TABLE evidence_files MODIFY COLUMN extracted_text LONGTEXT NULL'))

def initialise_database(bootstrap_email: str | None = None, bootstrap_password: str | None = None):
    Base.metadata.create_all(engine)
    _upgrade_schema()
    seed = Path(__file__).parent / 'seed_data' / 'cmmi_rules.json'
    raw = seed.read_bytes(); rules = json.loads(raw)
    with SessionLocal() as db:
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
        for code, name in PRACTICE_AREAS:
            if not db.scalar(select(PracticeArea).where(PracticeArea.code == code)): db.add(PracticeArea(code=code, name=name))
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
                                         expected_evidence=item.get('expected_evidence')) for item in documents])
        if bootstrap_email and bootstrap_password and not db.scalar(select(User).where(User.email == bootstrap_email.lower())):
            admin = User(email=bootstrap_email.lower(), display_name='Bootstrap Administrator', password_hash=hash_password(bootstrap_password))
            admin.roles = [db.scalar(select(Role).where(Role.name == 'Admin'))]; db.add(admin)
        sync_screen_registry(db)
        db.commit()
