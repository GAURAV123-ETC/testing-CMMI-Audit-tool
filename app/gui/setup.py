from nicegui import ui
from app.core.config import get_settings
ui.add_head_html('<style>body{background:#f6f8fb}.cmmi-card{min-width:260px}</style>')
def notify_error(error: Exception): ui.notify(str(error), type='negative')
