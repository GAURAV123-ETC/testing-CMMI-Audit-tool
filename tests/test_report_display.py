from datetime import datetime, timezone

from app.gui.pages.audit_workspace import _format_ist


def test_generated_report_timestamp_is_rendered_in_ist():
    assert _format_ist(datetime(2026, 9, 21, 4, 39, tzinfo=timezone.utc)) == '2026-09-21 10:09'
    # MySQL commonly returns a naive timestamp even for a timezone-aware model
    # column. Treat persisted naive values as UTC, matching the application's
    # UTC write convention.
    assert _format_ist(datetime(2026, 9, 21, 4, 39)) == '2026-09-21 10:09'
