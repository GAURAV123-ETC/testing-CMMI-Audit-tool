"""CMMI domain taxonomy used by the persisted-data dashboard.

This deliberately contains only the legacy application's taxonomy.  Scores and
sample statuses from the retired React dashboard are not carried over: those
must always be calculated from the audit session stored in MySQL.
"""

from dataclasses import dataclass


CORE_PRACTICE_AREA_CODES = (
    'CAR', 'PR', 'PQA', 'RDM', 'VV', 'EST', 'MC', 'PLAN', 'RSK', 'OT',
    'CM', 'DAR', 'MPM', 'PAD', 'PCM', 'GOV', 'II',
)


@dataclass(frozen=True)
class Domain:
    id: str
    code: str
    label: str
    practice_area_codes: tuple[str, ...]


DOMAINS = (
    Domain('dev', 'DEV', 'Development', ('PI', 'TS')),
    Domain('svc', 'SVC', 'Services', ('CONT', 'SDM', 'STSM')),
    Domain('spm', 'SPM', 'Suppliers', ('SAM',)),
    Domain('ppl', 'PPL', 'People', ('WE',)),
    Domain('data', 'DATA', 'Data', ('DM', 'DQ')),
    Domain('sec', 'SEC', 'Security', ('ESEC', 'MST')),
    Domain('saf', 'SAF', 'Safety', ('ESAF',)),
    Domain('vrt', 'VRT', 'Virtual', ('EVW',)),
)


def domains_for_selection(selected_ids: list[str] | None) -> tuple[Domain, ...]:
    """An empty selection means all domains, matching the legacy dashboard."""
    if not selected_ids:
        return DOMAINS
    selected = set(selected_ids)
    return tuple(domain for domain in DOMAINS if domain.id in selected)


def practice_area_codes_for_selection(selected_ids: list[str] | None) -> set[str]:
    """Core PAs and IRP apply across every selected CMMI domain."""
    codes = set(CORE_PRACTICE_AREA_CODES)
    codes.add('IRP')
    for domain in domains_for_selection(selected_ids):
        codes.update(domain.practice_area_codes)
    return codes


def domain_label_for_practice_area(code: str) -> str:
    if code in CORE_PRACTICE_AREA_CODES or code == 'IRP':
        return 'Core (All Domains)'
    for domain in DOMAINS:
        if code in domain.practice_area_codes:
            return domain.code
    return 'Unmapped'
