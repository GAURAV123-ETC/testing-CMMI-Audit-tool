"""Compatibility adapter for the canonical evidence classifier.

The scan pipeline uses :mod:`evidence_validation` directly. Keep this older
list-shaped entry point aligned with it so a future caller cannot accidentally
reintroduce a separate filename/keyword scoring algorithm.
"""
from app.services.audit_engine.evidence_validation import classify_document as _classify_evidence


def classify_document(name: str, text: str) -> list[dict]:
    """Return ranked candidates using the same content-first rules as scans."""
    return _classify_evidence(text, name).get('candidates', [])
