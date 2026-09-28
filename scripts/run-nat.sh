#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3.11}"
VENV_DIR="${NAT_VENV_DIR:-${ROOT_DIR}/.venv}"

cd "${ROOT_DIR}"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install -e "${ROOT_DIR}/nemo_agent"

export DDP_APP_URL="${DDP_APP_URL:-http://localhost:3000}"
export NAT_HOST="${NAT_HOST:-127.0.0.1}"
export NAT_PORT="${NAT_PORT:-8000}"

exec "${VENV_DIR}/bin/nat" serve \
  --config_file "${ROOT_DIR}/nemo_agent/configs/config.yml" \
  --host "${NAT_HOST}" \
  --port "${NAT_PORT}"
