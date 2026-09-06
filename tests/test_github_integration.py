import pytest

from app.services.integrations.github import parse_repository


@pytest.mark.parametrize(('value', 'expected'), [
    ('octocat/Hello-World', ('octocat', 'Hello-World')),
    ('https://github.com/octocat/Hello-World.git', ('octocat', 'Hello-World')),
])
def test_parse_github_repository(value, expected):
    assert parse_repository(value) == expected


def test_parse_github_repository_rejects_ambiguous_input():
    with pytest.raises(ValueError):
        parse_repository('not-a-repository')


def test_parse_github_repository_rejects_path_injection():
    with pytest.raises(ValueError):
        parse_repository('owner/repo?branch=unsafe')
