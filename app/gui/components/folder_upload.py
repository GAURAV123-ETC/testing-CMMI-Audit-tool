"""Browser folder picker which retains relative paths during evidence upload."""
import hmac
from typing import Dict, List, Optional, cast

from fastapi import HTTPException, Request, status
from starlette.datastructures import UploadFile

from nicegui import app
from nicegui.elements.mixins.disableable_element import DisableableElement
from nicegui.elements.mixins.label_element import LabelElement
from nicegui.events import Handler, MultiUploadEventArguments, UiEventArguments, handle_event


def _matches_session_token(expected_token: str | None, request_token: str | None) -> bool:
    """Require the browser request to use the credential that built the control."""
    return bool(expected_token and request_token and hmac.compare_digest(request_token, expected_token))


class FolderUpload(LabelElement, DisableableElement, component='folder_upload.js'):
    """One evidence-upload control for files, ZIPs, and local folders."""

    def __init__(
        self,
        *,
        on_multi_upload: Optional[Handler[MultiUploadEventArguments]] = None,
        label: str = 'Upload evidence',
        accept: str = '',
        max_file_size: Optional[int] = None,
        max_total_size: Optional[int] = None,
        max_files: Optional[int] = None,
    ) -> None:
        super().__init__(label=label)
        self._props['url'] = f'/_nicegui/client/{self.client.id}/folder-upload/{self.id}'
        # ``/_nicegui/`` routes are intentionally public so NiceGUI can
        # hydrate its login page.  This custom POST route must nevertheless
        # remain bound to the authenticated page that created it; a random
        # client URL alone is not an authorization boundary.
        self._session_token = (
            self.client.request.cookies.get('cmmi_session')
            if self.client.request is not None else None
        )
        self._props['accept'] = accept
        self._max_files = max_files or 1_000
        self._max_total_size = max_total_size
        if max_file_size is not None:
            self._props['max_file_size'] = max_file_size
        if max_total_size is not None:
            self._props['max_total_size'] = max_total_size
        if max_files is not None:
            self._props['max_files'] = max_files
        self._multi_upload_handlers = [on_multi_upload] if on_multi_upload else []

        @app.post(self._props['url'])
        async def folder_upload_route(request: Request) -> Dict[str, str]:
            if self.client._deleted:
                raise HTTPException(status.HTTP_410_GONE, 'This upload control is no longer available.')
            if not _matches_session_token(self._session_token, request.cookies.get('cmmi_session')):
                raise HTTPException(status.HTTP_403_FORBIDDEN, 'Sign in again before uploading evidence.')
            # Reject an oversized request before multipart parsing spools files
            # to disk. The service applies the exact content-size limit again
            # after parsing, because multipart framing adds a small overhead.
            content_length = request.headers.get('content-length')
            if content_length and self._max_total_size is not None:
                try:
                    request_size = int(content_length)
                except ValueError as exc:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, 'Invalid upload size.') from exc
                if request_size > self._max_total_size + 4 * 1024 * 1024:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, 'Evidence upload exceeds the total size limit.')
            form = await request.form(max_files=self._max_files, max_fields=10)
            uploads = [
                (relative_path, cast(UploadFile, upload))
                for relative_path, upload in form.multi_items()
                if isinstance(upload, UploadFile)
            ]
            self.handle_uploads(uploads)
            return {'upload': 'success'}

    def handle_uploads(self, uploads: List[tuple[str, UploadFile]]) -> None:
        """Dispatch one batch after validating the folder request reached this client."""
        event = MultiUploadEventArguments(
            sender=self,
            client=self.client,
            contents=[upload.file for _, upload in uploads],
            names=[relative_path for relative_path, _ in uploads],
            types=[upload.content_type or '' for _, upload in uploads],
        )
        for handler in self._multi_upload_handlers:
            handle_event(handler, event)

    def _handle_delete(self) -> None:
        app.remove_route(self._props['url'])
        super()._handle_delete()
