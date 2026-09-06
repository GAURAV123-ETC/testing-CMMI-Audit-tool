from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.db.models import CmmiRule

@dataclass
class RuleResult:
    rule_id: str; practice_area: str; severity: str; title: str; description: str; recommendation: str

def evaluate_rules(db: Session, checklist_version_id: int, extracted_documents: list[tuple[str, str]]) -> list[RuleResult]:
    """Conservative evidence matcher: each rule becomes a finding only when its distinctive terms are absent.
    It does not claim semantic compliance based solely on file names; reviewers retain final disposition."""
    corpus = '\n'.join(f'{name}\n{text}' for name, text in extracted_documents).lower()
    results = []
    for rule in db.scalars(select(CmmiRule).where(CmmiRule.checklist_version_id == checklist_version_id)).all():
        words = [w.lower().strip('.,:;()') for w in rule.audit_check.split() if len(w.strip('.,:;()')) >= 6]
        distinctive = list(dict.fromkeys(words))[:4]
        if distinctive and not any(word in corpus for word in distinctive):
            results.append(RuleResult(rule.rule_id, rule.practice_area_code, 'major', f'Evidence not located for {rule.rule_id}', rule.gap_text, f'Review and provide evidence for: {rule.audit_check}'))
    return results
