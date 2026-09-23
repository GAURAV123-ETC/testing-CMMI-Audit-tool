"""Consistent, accessible search controls for data-list screens."""

from collections.abc import Callable

from nicegui import ui


def table_search_input(
    label: str,
    placeholder: str,
    on_change: Callable | None = None,
    max_width: str = 'max-w-2xl',
):
    """Create the standard outlined search field used by application lists."""
    field = ui.input(label=label, placeholder=placeholder, on_change=on_change).props(
        'outlined dense clearable debounce=250 color=primary'
    ).classes(f'w-full {max_width}')
    with field.add_slot('prepend'):
        ui.icon('search').classes('text-primary')
    return field
