"""HTTP health check endpoint on configurable port."""

from __future__ import annotations

import json
import logging
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Callable, Optional

from .config import settings

logger = logging.getLogger(__name__)

# Externally settable status function
_health_check: Optional[Callable[[], dict]] = None


def set_health_check(fn: Callable[[], dict]) -> None:
    """Register a function that returns health status dict."""
    global _health_check
    _health_check = fn


class HealthHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler for /health endpoint."""

    def do_GET(self) -> None:
        if self.path == "/health":
            status = {"status": "ok"}
            if _health_check:
                status = _health_check()

            code = 200 if status.get("status") == "ok" else 503
            body = json.dumps(status).encode()

            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args) -> None:
        # Suppress default access logs — too noisy from Docker healthchecks
        pass


def start_health_server() -> HTTPServer:
    """Start the health check HTTP server in a daemon thread."""
    server = HTTPServer(("0.0.0.0", settings.health_port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("Health server listening on port %d", settings.health_port)
    return server
