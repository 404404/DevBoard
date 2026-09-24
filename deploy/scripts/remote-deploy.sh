#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
deploy_directory="${2:-}"
if [[ ! "$image" =~ ^ghcr\.io/404404/devboard(:((main|preview|sha-[a-f0-9]{7,40}|[0-9]+\.[0-9]+\.[0-9]+)))?@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Refusing a DevBoard image reference without an approved immutable SHA-256 digest' >&2
  exit 2
fi
if [[ ! "$deploy_directory" =~ ^/[A-Za-z0-9_./-]+$ || "$deploy_directory" == *..* ]]; then
  echo 'Refusing an unsafe deployment directory' >&2
  exit 2
fi
if [[ ! -f "$deploy_directory/compose.yaml" || ! -f "$deploy_directory/.env" ]]; then
  echo 'Deployment directory must contain compose.yaml and .env; no files were changed' >&2
  exit 2
fi

cd "$deploy_directory"
previous_image=''
previous_digest=''
previous_container="$(docker compose ps --all -q devboard 2>/dev/null | sed -n '1p' || true)"
if [[ -n "$previous_container" ]]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_container" 2>/dev/null || true)"
  image_id="$(docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null || true)"
  if [[ -n "$image_id" ]]; then
    previous_digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null | sed -n '1p' || true)"
  fi
fi

print_recovery_hint() {
  local status=$?
  trap - ERR
  echo "Deployment failed (exit $status). Previous image tag: ${previous_image:-unknown}; previous digest: ${previous_digest:-unknown}."
  if [[ -n "$previous_digest" ]]; then
    printf "Manual rollback candidate (not executed): cd '%s' && DEVBOARD_IMAGE='%s' docker compose up -d --no-deps devboard\n" "$deploy_directory" "$previous_digest"
  elif [[ -n "$previous_image" ]]; then
    printf "Manual rollback candidate (not executed): cd '%s' && DEVBOARD_IMAGE='%s' docker compose up -d --no-deps devboard\n" "$deploy_directory" "$previous_image"
  else
    echo 'No previous image reference is available for a rollback candidate.'
  fi
  echo 'WARNING: a previous application image is not guaranteed to support a database schema already migrated by the new image. Verify/restore a tested backup before any downgrade.'
  exit "$status"
}
trap print_recovery_hint ERR

DEVBOARD_IMAGE="$image" docker compose config --quiet
if [[ -n "$previous_container" ]]; then
  previous_status="$(docker inspect --format '{{.State.Status}}' "$previous_container")"
  previous_health="$(docker inspect --format '{{.State.Health.Status}}' "$previous_container" 2>/dev/null || true)"
  if [[ "$previous_status" != running || "$previous_health" != healthy ]]; then
    echo 'Existing DevBoard must be running and healthy before an upgrade; no files or image were changed' >&2
    false
  fi
  backup_output="$(docker exec "$previous_container" node apps/server/dist/ops.js backup)"
  backup_directory="$(printf '%s\n' "$backup_output" | sed -n 's/.*"directory":"\([^"]*\)".*/\1/p')"
  if [[ ! "$backup_directory" =~ ^/var/lib/devboard/backups/[A-Za-z0-9._-]+$ ]]; then
    echo 'Pre-deployment backup did not return a managed backup directory; refusing upgrade' >&2
    false
  fi
  docker exec "$previous_container" node apps/server/dist/ops.js verify "$backup_directory"
  echo "Pre-deployment backup verified: ${backup_directory##*/}"
fi
DEVBOARD_IMAGE="$image" docker compose pull devboard
DEVBOARD_IMAGE="$image" docker compose up -d --no-deps devboard

container="$(DEVBOARD_IMAGE="$image" docker compose ps -q devboard)"
if [[ -z "$container" ]]; then
  echo 'DevBoard container was not created' >&2
  false
fi
if docker port "$container" 47824/tcp 2>/dev/null | grep -q .; then
  echo 'Admin API port 47824 is published; refusing deployment acceptance' >&2
  false
fi
healthy=false
for attempt in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
  if [[ "$status" == healthy ]] && docker exec "$container" node -e 'fetch("http://127.0.0.1:47823/api/health").then(async r=>{if(!r.ok)process.exit(1);const h=await r.json();if(h.status!=="ok"||h.checks.sqlite!=="ok"||h.checks.migrations!=="ok"||h.checks.events!=="ok")process.exit(1)}).catch(()=>process.exit(1))'; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo 'New container did not pass its healthcheck; deployment state was preserved for inspection' >&2
  docker inspect --format 'container state={{.State.Status}} health={{.State.Health.Status}} image={{.Config.Image}}' "$container" >&2 || true
  false
fi

deployed_digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$(docker inspect --format '{{.Image}}' "$container")" 2>/dev/null | sed -n '1p' || true)"
echo "Deployment healthy. Image tag: $image; digest: ${deployed_digest:-not available from local image metadata}."
