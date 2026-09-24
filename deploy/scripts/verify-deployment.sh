#!/usr/bin/env bash
set -euo pipefail

local_url="${DEVBOARD_LOCAL_URL:-http://127.0.0.1:47823}"
public_url="${DEVBOARD_PUBLIC_URL:-}"
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

check_public_http() {
  local base="$1"
  local label="$2"
  local endpoint status
  for endpoint in / /api/v1/auth/config /api/health; do
    status="$(curl --connect-timeout 5 --max-time 15 --silent --output "$tmp_file" --write-out '%{http_code}' "${base%/}${endpoint}" || true)"
    if [[ "$status" != 200 ]]; then
      printf '%s: %s returned HTTP %s\n' "$label" "$endpoint" "${status:-no response}" >&2
      return 1
    fi
  done
  printf '%s: HTTP, Web assets, auth bootstrap and health endpoint OK\n' "$label"
}

local_status="$(curl --connect-timeout 5 --max-time 15 --silent --output "$tmp_file" --write-out '%{http_code}' "${local_url%/}/api/health" || true)"
if [[ "$local_status" != 200 ]]; then
  printf 'container direct health returned HTTP %s\n' "${local_status:-no response}" >&2
  exit 1
fi
echo 'container direct: HTTP health endpoint OK'

if [[ -n "$public_url" ]]; then
  if [[ "$public_url" != https://* || "$public_url" == *'@'* || "$public_url" == *'?'* || "$public_url" == *'#'* ]]; then
    echo 'DEVBOARD_PUBLIC_URL must be an HTTPS origin or base path without credentials/query/fragment' >&2
    exit 2
  fi
  check_public_http "$public_url" "external reverse proxy"
else
  echo 'external reverse proxy/Web/auth endpoints: NOT CHECKED (set DEVBOARD_PUBLIC_URL to enable)'
fi

container_id="$(docker compose ps --status running -q devboard)"
if [[ -z "$container_id" ]]; then
  echo 'DevBoard container is not running' >&2
  exit 1
fi
health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
if [[ "$health" != healthy ]]; then
  printf 'container health is %s\n' "$health" >&2
  exit 1
fi
if docker compose port devboard 47824 >/dev/null 2>&1; then
  echo 'Admin API port 47824 is published; refusing deployment acceptance' >&2
  exit 1
fi
echo 'container healthcheck: healthy; Admin API: not published'
