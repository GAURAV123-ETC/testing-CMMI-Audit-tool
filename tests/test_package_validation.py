from io import BytesIO
import zipfile

from app.services.audit_engine.package_validation import validate_package_archive


def test_package_archive_preserves_folder_coverage_and_detects_empty_and_missing_areas():
    archive = BytesIO()
    with zipfile.ZipFile(archive, 'w') as zipped:
        zipped.writestr('Audit Package/PLAN/plan.md', 'planning schedule milestone')
        zipped.writestr('Audit Package/IRP/', '')

    results = validate_package_archive('audit-package.zip', archive.getvalue(), 50 * 1024 * 1024)
    by_code = {item['code']: item for item in results}

    assert by_code['PLAN']['status'] == 'AVAILABLE'
    assert by_code['PLAN']['file_count'] == 1
    # Empty directories cannot be represented as evidence files in ZIP import,
    # but the validator still reports their governed folder as empty.
    assert by_code['IRP']['status'] == 'EMPTY'
    assert by_code['RSK']['status'] == 'MISSING'
