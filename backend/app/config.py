from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    supabase_url: str = "https://dxtucfijilmytkwrzsox.supabase.co"
    supabase_secret_key: str = ""
    redis_url: str = "redis://redis:6379/0"
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    media_proxy: str = "http://egress:8080"
    max_file_size_mb: int = 500
    max_video_duration_seconds: int = 3600
    max_active_jobs_per_user: int = 2
    daily_job_quota: int = 20
    file_retention_hours: int = 1
    signed_url_ttl_seconds: int = 300
    job_timeout_seconds: int = 1800
    # Bound per-download native DASH/HLS fragment parallelism; never client-controlled.
    media_fragment_concurrency: int = Field(default=4, ge=1, le=8)
    temp_root: str = "/tmp/videoflow"
    ephemeral_job_ttl_seconds: int = Field(default=86400, ge=3600, le=604800)
    download_transfer_grace_seconds: int = Field(default=3600, ge=60, le=86400)

    guest_access_enabled: bool = True
    guest_max_file_size_mb: int = Field(default=100, ge=1)
    guest_max_video_duration_seconds: int = Field(default=900, ge=1)
    guest_max_active_jobs: int = Field(default=1, ge=1)
    guest_daily_job_quota: int = Field(default=5, ge=1)
    guest_file_retention_minutes: int = Field(default=30, ge=1)
    guest_analysis_per_minute: int = Field(default=2, ge=1)
    guest_analysis_per_day: int = Field(default=20, ge=1)
    guest_network_analysis_per_minute: int = Field(default=8, ge=1)
    guest_network_analysis_per_day: int = Field(default=100, ge=1)
    guest_network_creates_per_minute: int = Field(default=6, ge=1)
    guest_network_creates_per_day: int = Field(default=20, ge=1)
    guest_rate_limit_secret: str = ""
    trusted_proxy_cidrs: str = ""

    @field_validator("trusted_proxy_cidrs")
    @classmethod
    def proxy_networks(cls, value):
        import ipaddress

        for network in value.split(","):
            if network.strip():
                parsed = ipaddress.ip_network(network.strip())
                if parsed.prefixlen == 0:
                    raise ValueError("Do not trust every proxy address")
        return value

    @field_validator("allowed_origins")
    @classmethod
    def exact_origins(cls, value):
        from urllib.parse import urlsplit

        for origin in value.split(","):
            parsed = urlsplit(origin.strip())
            if (
                "*" in origin
                or parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.username
            ):
                raise ValueError("Use exact HTTP(S) origins without paths or wildcards")
        return value

    @property
    def configured(self):
        return self.supabase_secret_key.startswith("sb_secret_")


@lru_cache
def settings():
    return Settings()
