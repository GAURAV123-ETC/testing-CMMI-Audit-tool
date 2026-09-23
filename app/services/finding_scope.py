"""Queries that keep file-backed findings distinct from checklist coverage gaps.

The scan persists both kinds of result for audit traceability.  A direct finding has
at least one ``FindingEvidence`` link; a coverage gap does not.  Keeping that
distinction in one place prevents exports and dashboards from implying that a
missing checklist item was detected in a particular uploaded file.
"""
from sqlalchemy import and_, exists, or_, select, true

from app.db.models import EvidenceFile, EvidenceSource, Finding, FindingEvidence


def has_linked_evidence():
    """True only for an evidence link that belongs to the finding's session."""
    return exists(select(FindingEvidence.finding_id).join(
        EvidenceFile, EvidenceFile.id == FindingEvidence.evidence_file_id
    ).join(
        EvidenceSource, EvidenceSource.id == EvidenceFile.source_id
    ).where(
        FindingEvidence.finding_id == Finding.id,
        EvidenceSource.audit_session_id == Finding.audit_session_id,
    ))


def has_afr_eligible_evidence():
    """True only for a same-session link approved by the AFR document catalogue."""
    return exists(select(FindingEvidence.finding_id).join(
        EvidenceFile, EvidenceFile.id == FindingEvidence.evidence_file_id
    ).join(
        EvidenceSource, EvidenceSource.id == EvidenceFile.source_id
    ).where(
        FindingEvidence.finding_id == Finding.id,
        EvidenceSource.audit_session_id == Finding.audit_session_id,
        EvidenceFile.classification_json['afr_eligible'].as_boolean() == true(),
    ))


def evidence_findings_query(audit_session_id: int, *, open_only: bool = True):
    """Findings directly assessed against one or more uploaded files."""
    query = select(Finding).where(
        Finding.audit_session_id == audit_session_id,
        has_linked_evidence(),
    )
    return query.where(Finding.status == 'open') if open_only else query


def afr_findings_query(audit_session_id: int, *, open_only: bool = True):
    """Confirmed AFR findings, including absence confirmed at project scope.

    SAP field controls are persisted as ``rule_assessment`` findings rather
    than the retired generic ``document_catalogue`` checks.  The AFR summary
    must include those confirmed missing/partial/blocked outcomes, while
    review-required rows remain in the detailed control sheet for an auditor
    to decide instead of being presented as a confirmed finding. A
    ``coverage_gap`` has no evidence link by definition: it records that no
    matching project artefact existed after the complete uploaded scope was
    assessed, so it must remain visible in the AFR source of truth.
    """
    query = select(Finding).where(
        Finding.audit_session_id == audit_session_id,
        or_(
            and_(
                Finding.finding_kind.in_(('document_catalogue', 'rule_assessment')),
                Finding.title.notlike('Review_Required evidence for %'),
                has_afr_eligible_evidence(),
            ),
            Finding.finding_kind == 'coverage_gap',
        ),
    )
    return query.where(Finding.status == 'open') if open_only else query


def coverage_gaps_query(audit_session_id: int, *, open_only: bool = True):
    """Checklist coverage gaps with no directly matched uploaded artifact."""
    query = select(Finding).where(
        Finding.audit_session_id == audit_session_id,
        ~has_linked_evidence(),
    )
    return query.where(Finding.status == 'open') if open_only else query
