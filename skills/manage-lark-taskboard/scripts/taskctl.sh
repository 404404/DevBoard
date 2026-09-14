#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Lark-Codex: $1" >&2
  exit 2
}

has_cli() {
  [ -x "$1/Contents/Resources/runtime/bin/node" ] &&
    [ -f "$1/Contents/Resources/runtime/packages/taskctl/dist/cli.js" ]
}

if [ "${LARK_CODEX_APP_PATH+x}" = x ]; then
  [ -n "$LARK_CODEX_APP_PATH" ] || fail "LARK_CODEX_APP_PATH 不能为空。"
  lark_app=$LARK_CODEX_APP_PATH
  has_cli "$lark_app" || fail "指定位置缺少完整应用及内置 taskctl，请核对 LARK_CODEX_APP_PATH。"
else
  lark_app=
  lark_system_app=/Applications/Lark-Codex.app
  if has_cli "$lark_system_app"; then
    lark_app=$lark_system_app
  elif [ -n "${HOME:-}" ] && has_cli "$HOME/Applications/Lark-Codex.app"; then
    lark_app=$HOME/Applications/Lark-Codex.app
  fi
  [ -n "$lark_app" ] || fail "未找到完整的 Lark-Codex.app；请安装到 /Applications 或 ~/Applications，或设置 LARK_CODEX_APP_PATH。"
fi

if [ "${LARK_TASKBOARD_DATA_DIR+x}" = x ]; then
  [ -n "$LARK_TASKBOARD_DATA_DIR" ] || fail "LARK_TASKBOARD_DATA_DIR 不能为空。"
else
  [ -n "${HOME:-}" ] || fail "无法确定用户目录，请设置 HOME 或显式指定 LARK_TASKBOARD_DATA_DIR。"
  LARK_TASKBOARD_DATA_DIR="$HOME/Library/Application Support/Lark Codex Taskboard/data"
fi
export LARK_TASKBOARD_DATA_DIR

# Preserve the caller's cwd so taskctl context resolves the intended project.
exec "$lark_app/Contents/Resources/runtime/bin/node" \
  "$lark_app/Contents/Resources/runtime/packages/taskctl/dist/cli.js" "$@"
