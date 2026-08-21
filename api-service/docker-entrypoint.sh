#!/bin/sh
set -eu

DATA_ROOT="${MAIL_ANALYZER_DATA_ROOT:-/var/lib/email-analysis}"
JOB_DIR="${MAIL_ANALYZER_JOB_DIR:-${DATA_ROOT}/jobs}"
MODEL_PATH="${MAIL_ANALYZER_MODEL:-${DATA_ROOT}/models/baseline_model.joblib}"
MODEL_DIR="$(dirname "${MODEL_PATH}")"

if [ "$(id -u)" = "0" ]; then
  install -d -m 0750 -o mailanalyzer -g mailanalyzer \
    "${DATA_ROOT}" \
    "${JOB_DIR}" \
    "${MODEL_DIR}"
  chown -R mailanalyzer:mailanalyzer "${DATA_ROOT}"
  exec gosu mailanalyzer "$@"
fi

exec "$@"
