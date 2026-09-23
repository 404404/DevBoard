#!/usr/bin/env bash
set -euo pipefail

host="${DEVBOARD_SSH_HOST:-}"
port="${DEVBOARD_SSH_PORT:-22}"
username="${DEVBOARD_SSH_USERNAME:-}"
auth_mode="${DEVBOARD_SSH_AUTH_MODE:-identity_file}"
known_hosts="${DEVBOARD_SSH_KNOWN_HOSTS:-}"
identity_directory="${DEVBOARD_SSH_IDENTITY_DIR:-/run/devboard/ssh/identities}"
identity_ref="${DEVBOARD_SSH_IDENTITY_REF:-}"
timeout_seconds="${DEVBOARD_SSH_CONNECT_TIMEOUT:-8}"
error_file="$(mktemp)"
output_file="$(mktemp)"
trap 'rm -f "$error_file" "$output_file"' EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -n "$host" && "$host" != -* && "$host" != *$'\n'* && "$host" != *$'\r'* ]] || fail 'SSH Host is missing or invalid'
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || fail 'SSH Host must be a DNS name or IP address'
[[ -n "$username" && "$username" != -* && "$username" != *$'\n'* && "$username" != *$'\r'* ]] || fail 'SSH username is missing or invalid'
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( port >= 1 && port <= 65535 )) || fail 'SSH port is invalid'
[[ "$timeout_seconds" =~ ^[0-9]{1,2}$ ]] && (( timeout_seconds >= 1 && timeout_seconds <= 30 )) || fail 'SSH timeout must be from 1 to 30 seconds'
[[ -n "$known_hosts" && -f "$known_hosts" && ! -L "$known_hosts" ]] || fail 'Managed known_hosts must be an existing regular file; trust the host key in DevBoard first'

if ! getent ahosts "$host" >/dev/null 2>&1; then
  fail 'DNS resolution failed'
fi
if ! timeout "$timeout_seconds" bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$host" "$port" 2>/dev/null; then
  fail 'DNS OK; SSH TCP connection failed'
fi
echo 'DNS/TCP: OK'

ssh_args=(
  -o BatchMode=yes
  -o ConnectTimeout="$timeout_seconds"
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o UserKnownHostsFile="$known_hosts"
  -o GlobalKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -p "$port"
)

case "$auth_mode" in
  identity_file)
    [[ "$identity_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$identity_ref" != *..* ]] || fail 'Select a catalog Identity reference; arbitrary paths are not accepted'
    identity_path="$identity_directory/$identity_ref"
    [[ -f "$identity_path" && ! -L "$identity_path" ]] || fail 'Selected SSH identity is missing or is not a regular file'
    file_mode="$(stat -c '%a' "$identity_path" 2>/dev/null || stat -f '%Lp' "$identity_path" 2>/dev/null || true)"
    [[ -n "$file_mode" ]] || fail 'Could not inspect SSH identity permissions'
    permission_bits=$((8#$file_mode))
    (( (permission_bits & 077) == 0 )) || fail 'SSH identity permissions are too broad; use mode 0600'
    ssh_args+=(-o IdentitiesOnly=yes -i "$identity_path")
    ;;
  agent)
    [[ -n "${SSH_AUTH_SOCK:-}" && -S "$SSH_AUTH_SOCK" ]] || fail 'SSH Agent is unavailable; check the mounted SSH_AUTH_SOCK (no fallback was attempted)'
    ssh-add -l >/dev/null 2>&1 || fail 'SSH Agent is reachable but has no usable identities'
    ssh_args+=(-o IdentitiesOnly=no)
    ;;
  *)
    fail 'SSH auth mode must be identity_file or agent'
    ;;
esac

remote="${username}@${host}"
if ! ssh "${ssh_args[@]}" "$remote" 'printf "%s\n" "$(id -un)" "$(uname -s)" "$(uname -m)" "$(git --version 2>/dev/null || echo git-missing)" "$(codex --version 2>/dev/null | head -n 1 || echo codex-missing)" "$(codex login status >/dev/null 2>&1 && echo codex-auth-ready || echo codex-auth-unverified)" "$(command -v cursor-agent >/dev/null 2>&1 && echo cursor-ready || echo cursor-missing)" "$(command -v opencode >/dev/null 2>&1 && echo opencode-ready || echo opencode-missing)" "$(command -v grok >/dev/null 2>&1 && echo grok-ready || echo grok-missing)"' >"$output_file" 2>"$error_file"; then
  if grep -qi 'REMOTE HOST IDENTIFICATION HAS CHANGED\|offending key' "$error_file"; then
    fail 'HOST_KEY_CHANGED: SSH refused the changed host key'
  elif grep -qi 'host key verification failed\|no .* host key is known' "$error_file"; then
    fail 'HOST_KEY_UNTRUSTED: trust the displayed fingerprint in DevBoard before retrying'
  elif grep -qi 'passphrase' "$error_file"; then
    fail 'SSH_KEY_PASSPHRASE_REQUIRED: load the encrypted key into an SSH Agent; the check will not prompt'
  elif grep -qi 'permission denied\|authentication failed' "$error_file"; then
    fail 'SSH authentication failed; check the selected identity reference or agent'
  else
    fail 'SSH command failed; diagnostic text was suppressed to avoid leaking host configuration'
  fi
fi

result=()
while IFS= read -r line; do result+=("$line"); done <"$output_file"
(( ${#result[@]} >= 9 )) || fail 'Remote host returned incomplete diagnostics'
echo 'Host key: trusted'
echo 'SSH auth: OK'
printf 'User: %s\nOS: %s\nArchitecture: %s\n' "${result[0]}" "${result[1]}" "${result[2]}"
printf 'Git: %s\n' "${result[3]}"
if [[ "${result[4]}" == *codex-missing* ]]; then
  echo 'Codex: NOT INSTALLED'
else
  printf 'Codex: %s\n' "${result[4]}"
fi
printf 'Codex authentication: %s\n' "${result[5]#codex-auth-}"
printf 'Cursor: %s\nGrok Build: %s\nOpenCode: %s\n' "${result[6]}" "${result[8]}" "${result[7]}"
