from app.gui.components.folder_upload import _matches_session_token


def test_folder_upload_requires_the_session_that_created_the_control():
    assert _matches_session_token('signed-in-session', 'signed-in-session')
    assert not _matches_session_token('signed-in-session', 'other-session')
    assert not _matches_session_token('signed-in-session', None)
    assert not _matches_session_token(None, 'signed-in-session')
