# syntax=docker/dockerfile:1

FROM python:3.12-slim AS wheel-builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

# scikit-learn normally installs a prebuilt wheel. The compiler keeps the build
# reproducible on architectures where a matching wheel is not published.
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip wheel --wheel-dir /wheels --requirement requirements.txt


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    MAIL_ANALYZER_DATABASE=/var/lib/email-analysis/mail_analyzer.db \
    MAIL_ANALYZER_JOB_DIR=/var/lib/email-analysis/jobs \
    MAIL_ANALYZER_MODEL=/var/lib/email-analysis/models/baseline_model.joblib

# gosu lets the entrypoint prepare an initially root-owned named volume and
# then run Uvicorn as an unprivileged service account.
RUN apt-get update \
    && apt-get install --no-install-recommends -y gosu \
    && groupadd --gid 10001 mailanalyzer \
    && useradd --uid 10001 --gid mailanalyzer --create-home --shell /usr/sbin/nologin mailanalyzer \
    && mkdir -p /var/lib/email-analysis/jobs /var/lib/email-analysis/models \
    && chown -R mailanalyzer:mailanalyzer /var/lib/email-analysis \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=wheel-builder /wheels /wheels
COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-index --find-links=/wheels --requirement requirements.txt \
    && rm -rf /wheels

COPY --chown=mailanalyzer:mailanalyzer app ./app
COPY --chown=mailanalyzer:mailanalyzer config ./config
COPY --chown=mailanalyzer:mailanalyzer static ./static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "from urllib.request import urlopen; response = urlopen('http://127.0.0.1:3200/healthz', timeout=3); assert response.status == 200"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3200", "--proxy-headers"]
