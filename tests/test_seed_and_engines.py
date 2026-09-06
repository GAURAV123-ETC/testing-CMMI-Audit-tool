import json
from pathlib import Path
from app.services.audit_engine.irp_validation import ISSUE_LOG_FIELDS
def test_rule_seed_has_all_master_rules():
    rules=json.loads((Path('app/db/seed_data/cmmi_rules.json')).read_text())
    assert len(rules) == 302
    assert len({r['rule_id'] for r in rules}) == len(rules)
def test_irp_has_24_required_fields(): assert len(ISSUE_LOG_FIELDS) == 24
