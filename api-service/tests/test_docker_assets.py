from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_compose_keeps_rspamd_internal_and_persists_state() -> None:
    compose = yaml.safe_load((REPOSITORY_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    api = compose["services"]["email-analysis"]
    rspamd = compose["services"]["rspamd"]

    assert api["build"]["context"] == "./api-service"
    assert api["environment"]["RSPAMD_URL"] == "http://rspamd:11333"
    assert api["ports"] == ["${EMAIL_ANALYSIS_BIND_ADDRESS:-127.0.0.1}:${EMAIL_ANALYSIS_PORT:-3200}:3200"]
    assert api["volumes"] == ["email_analysis_data:/var/lib/email-analysis"]
    assert api["read_only"] is True
    assert rspamd["expose"] == ["11333"]
    assert "ports" not in rspamd
    assert rspamd["volumes"][0] == "rspamd_data:/var/lib/rspamd"


def test_api_image_runs_via_privilege_dropping_entrypoint() -> None:
    dockerfile = (REPOSITORY_ROOT / "api-service" / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (REPOSITORY_ROOT / "api-service" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "FROM python:3.12-slim AS wheel-builder" in dockerfile
    assert "EXPOSE 3200" in dockerfile
    assert "HEALTHCHECK" in dockerfile
    assert 'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]' in dockerfile
    assert "useradd --uid 10001" in dockerfile
    assert "exec gosu mailanalyzer" in entrypoint


def test_rspamd_worker_configuration_only_exposes_internal_scan_port() -> None:
    config_root = REPOSITORY_ROOT / "docker" / "rspamd" / "local.d"

    assert 'bind_socket = "0.0.0.0:11333";' in (config_root / "worker-normal.inc").read_text(encoding="utf-8")
    assert 'bind_socket = "127.0.0.1:11334";' in (config_root / "worker-controller.inc").read_text(encoding="utf-8")
    assert 'bind_socket = "127.0.0.1:11332";' in (config_root / "worker-proxy.inc").read_text(encoding="utf-8")
