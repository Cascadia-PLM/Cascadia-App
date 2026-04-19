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
    job_timeout: int = 600_000  # 10 minutes in ms

    # Health check
    health_port: int = 3003

    # Vault
    vault_root: str = "/vault"

    # Mesh defaults (overridable per-job via payload)
    mesh_linear_deflection: float = 0.1
    mesh_angular_deflection: float = 0.5
    stl_format: str = "binary"  # "binary" or "ascii"

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
