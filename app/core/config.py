from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / '.env', extra='ignore')
    app_title: str = 'CMMI V3.0 Audit Platform'
    environment: str = 'development'
    secret_key: str = 'change-this-before-production'
    db_user: str = 'root'
    db_password: str = 'root'
    db_host: str = 'localhost'
    db_port: int = 3306
    db_name: str = 'cmmi_audit'
    # Optional only for tests/special deployments; normal configuration uses DB_*.
    database_url: str | None = None
    session_timeout_minutes: int = 480
    max_login_attempts: int = 5
    login_lockout_minutes: int = 15
    max_upload_mb: int = 50
    # Office automation is opt-in because it must run only in a controlled
    # interactive Windows service account with Word installed and hardened.
    legacy_doc_conversion_enabled: bool = False
    upload_dir: Path = ROOT / 'uploads'
    output_dir: Path = ROOT / 'output_file'
    template_dir: Path = ROOT / 'template_file'
    turnstile_enabled: bool = False
    turnstile_secret_key: str = ''
    turnstile_site_key: str = ''
    microsoft_oauth_enabled: bool = False
    azure_tenant_id: str = ''
    azure_client_id: str = ''
    azure_client_secret: str = ''
    sender_email: str = ''
    microsoft_redirect_uri: str = ''
    smtp_host: str = ''
    smtp_port: int = 587
    smtp_username: str = ''
    smtp_password: str = ''
    smtp_from_email: str = ''
    # Local development runs on 8010; Docker overrides this to its published
    # port in docker-compose so externally generated links remain correct.
    public_base_url: str = 'http://localhost:8010'
    bootstrap_admin_email: str = ''
    bootstrap_admin_password: str = ''
    cors_origins: str = ''

    @property
    def sqlalchemy_url(self) -> str:
        """Connection URL derived from the shared DMS-style DB_* configuration."""
        if self.database_url:
            return self.database_url
        from urllib.parse import quote_plus
        return f'mysql+pymysql://{quote_plus(self.db_user)}:{quote_plus(self.db_password)}@{self.db_host}:{self.db_port}/{self.db_name}'

    @property
    def session_hours(self) -> int:
        """Legacy compatibility helper; new code must use session_seconds."""
        return max(1, self.session_timeout_minutes // 60)

    @property
    def session_seconds(self) -> int:
        """Preserve the configured timeout exactly, including sub-hour values."""
        return max(1, self.session_timeout_minutes) * 60

    @property
    def lockout_attempts(self) -> int:
        return self.max_login_attempts

    @property
    def lockout_minutes(self) -> int:
        return self.login_lockout_minutes

    def prepare_directories(self) -> None:
        for directory in (self.upload_dir, self.output_dir, self.template_dir):
            directory.mkdir(parents=True, exist_ok=True)

@lru_cache
def get_settings() -> Settings:
    return Settings()
