from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / '.env', extra='ignore')
    app_title: str = 'CMMI V3.0 Audit Platform'
    environment: str = 'development'
    # Development values are intentionally unusable in production. Production
    # validation below runs before the application serves requests.
    secret_key: str = 'development-only-change-me'
    db_user: str = 'cmmi_dev'
    db_password: str = 'cmmi_dev_password'
    db_host: str = 'localhost'
    db_port: int = 3306
    db_name: str = 'cmmi_audit'
    # Optional only for tests/special deployments; normal configuration uses DB_*.
    database_url: str | None = None
    session_timeout_minutes: int = 480
    max_login_attempts: int = 5
    login_lockout_minutes: int = 15
    max_upload_mb: int = 50
    max_document_pages: int = 500
    max_image_pixels: int = 40_000_000
    ocr_timeout_seconds: int = 30
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
    smtp_tls_mode: str = 'starttls'
    # Local development runs on 8090; Docker overrides this to its published
    # port in docker-compose so externally generated links remain correct.
    public_base_url: str = 'http://localhost:8090'
    app_host: str = '127.0.0.1'
    app_port: int = 8090
    app_reload: bool = False
    auto_migrate_on_startup: bool = True
    cors_origins: str = ''

    def trusted_origins(self) -> set[str]:
        origins = {item.strip().rstrip('/') for item in self.cors_origins.split(',') if item.strip()}
        if self.public_base_url:
            origins.add(self.public_base_url.rstrip('/'))
        return origins

    def validate_security_configuration(self) -> None:
        """Fail closed for settings which would make a production deployment unsafe."""
        if self.environment.lower() != 'production':
            return
        insecure = {
            '', 'development-only-change-me', 'change-this-before-production',
            'change-this-to-a-very-long-random-secret-key-in-production',
        }
        if self.secret_key in insecure or len(self.secret_key) < 32:
            raise RuntimeError('Production SECRET_KEY must be a unique value of at least 32 characters.')
        if self.db_user.strip().lower() in {'', 'root', 'cmmi_dev'}:
            raise RuntimeError('Production DB_USER must be a dedicated non-root runtime account.')
        if self.db_password in {'', 'root', 'cmmi_dev_password', 'change-me', 'change-root-password'} or len(self.db_password) < 16:
            raise RuntimeError('Production DB_PASSWORD is missing or insecure.')
        parsed = urlparse(self.public_base_url)
        if parsed.scheme != 'https' or not parsed.netloc:
            raise RuntimeError('Production PUBLIC_BASE_URL must be an HTTPS URL.')
        if self.app_reload:
            raise RuntimeError('APP_RELOAD must be disabled in production.')
        if self.auto_migrate_on_startup:
            raise RuntimeError('AUTO_MIGRATE_ON_STARTUP must be false in production.')
        if self.smtp_tls_mode not in {'starttls', 'implicit'}:
            raise RuntimeError('SMTP_TLS_MODE must be starttls or implicit.')

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
