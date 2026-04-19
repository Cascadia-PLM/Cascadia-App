"""Configuration via environment variables using pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/cascadia"

    # RabbitMQ
    rabbitmq_url: str = "amqp://localhost:5672"

    # Worker
    worker_concurrency: int = 2
    job_timeout: int = 60_000  # 1 minute in ms

    # Health check
    health_port: int = 3004

    # Vault
    vault_root: str = "/vault"

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
