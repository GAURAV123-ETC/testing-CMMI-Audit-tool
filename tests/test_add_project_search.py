from app.gui.pages.add_project import _filter_saved_details


ROWS = [
    {
        'id': 21,
        'customer': 'Northwind Traders',
        'project': 'Payments Platform',
        'repository': 'https://example.test/northwind/payments',
        'audit_session': 'Q3 Readiness',
        'audit_date': '2026-09-21',
        'auditors': 'Anita Sharma',
        'auditees': 'Payments Team',
        'ruleset': 7,
        'created': '2026-09-21 10:00 UTC',
    },
    {
        'id': 22,
        'customer': 'Contoso',
        'project': 'Identity Service',
        'repository': None,
        'audit_session': 'Annual Review',
        'audit_date': None,
        'auditors': None,
        'auditees': 'Security Team',
        'ruleset': 8,
        'created': '2026-09-22 10:00 UTC',
    },
]


def test_saved_details_search_matches_each_supported_column_case_insensitively():
    for term, expected_id in (
        ('northwind', 21),
        ('PAYMENTS PLATFORM', 21),
        ('example.test/northwind', 21),
        ('q3 readiness', 21),
        ('anita sharma', 21),
        ('payments team', 21),
        ('7', 21),
        ('2026-09-22', 22),
        ('22', 22),
    ):
        assert [row['id'] for row in _filter_saved_details(ROWS, term)] == [expected_id]


def test_saved_details_search_handles_empty_missing_and_non_matching_values():
    assert _filter_saved_details(ROWS, '') == ROWS
    assert _filter_saved_details(ROWS, '   ') == ROWS
    assert _filter_saved_details(ROWS, None) == ROWS
    assert _filter_saved_details(ROWS, 'not present') == []
