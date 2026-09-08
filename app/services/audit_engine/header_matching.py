"""Semantic, exclusive header matching shared by migrated audit validators."""
import re


def normalize_header(value) -> str:
    return ' '.join(re.sub(r'[^a-zA-Z0-9&/ ]', ' ', re.sub(r'\(.*?\)', ' ', str(value or ''))).lower().split())


def _singular(value: str) -> str:
    return value[:-1] if len(value) > 3 and value.endswith('s') and not value.endswith('ss') else value


def _levenshtein(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for index, left_char in enumerate(left, 1):
        current = [index]
        for right_index, right_char in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[right_index] + 1, previous[right_index - 1] + (left_char != right_char)))
        previous = current
    return previous[-1]


def equivalent(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if left == right or _singular(left) == _singular(right):
        return True
    maximum = max(len(left), len(right))
    return maximum >= 4 and _levenshtein(left, right) <= (1 if maximum <= 6 else 2)


def match_fields_exclusive(headers: list, fields: list[dict]) -> dict[str, int | None]:
    """Assign each source column at most once (exact names before fuzzy ones)."""
    normalized = [normalize_header(header) for header in headers]
    claimed: set[int] = set()
    matches: dict[str, int | None] = {}

    def assign(field: dict, predicate) -> None:
        if field['key'] in matches:
            return
        for index, header in enumerate(normalized):
            if index not in claimed and header and predicate(header):
                matches[field['key']] = index
                claimed.add(index)
                return

    for field in fields:
        canonical = normalize_header(field['canonical'])
        assign(field, lambda header, canonical=canonical: header == canonical or _singular(header) == _singular(canonical))
    for field in fields:
        synonyms = [normalize_header(value) for value in field.get('synonyms', [])]
        assign(field, lambda header, synonyms=synonyms: any(header == value or _singular(header) == _singular(value) for value in synonyms))
    for field in fields:
        candidates = [normalize_header(field['canonical']), *(normalize_header(value) for value in field.get('synonyms', []))]
        assign(field, lambda header, candidates=candidates: any(equivalent(header, value) for value in candidates))
    return {field['key']: matches.get(field['key']) for field in fields}
