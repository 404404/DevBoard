#!/bin/sh
set -eu

fail() {
  printf '%s\n' "CodexBoard: $1" >&2
  exit 2
}

has_cli() {
  [ -x "$1/Contents/Resources/runtime/bin/node" ] &&
    [ -f "$1/Contents/Resources/runtime/packages/taskctl/dist/cli.js" ]
}

if [ "${CODEXBOARD_APP_PATH+x}" = x ]; then
  [ -n "$CODEXBOARD_APP_PATH" ] || fail "CODEXBOARD_APP_PATH 不能为空。"
  board_app=$CODEXBOARD_APP_PATH
  has_cli "$board_app" || fail "指定位置缺少完整应用及内置 taskctl，请核对 CODEXBOARD_APP_PATH。"
else
  board_app=
  board_system_app=/Applications/CodexBoard.app
  if has_cli "$board_system_app"; then
    board_app=$board_system_app
  elif [ -n "${HOME:-}" ] && has_cli "$HOME/Applications/CodexBoard.app"; then
    board_app=$HOME/Applications/CodexBoard.app
  fi
  [ -n "$board_app" ] || fail "未找到完整的 CodexBoard.app；请安装到 /Applications 或 ~/Applications，或设置 CODEXBOARD_APP_PATH。"
fi

if [ "${CODEXBOARD_DATA_DIR+x}" = x ]; then
  [ -n "$CODEXBOARD_DATA_DIR" ] || fail "CODEXBOARD_DATA_DIR 不能为空。"
  export CODEXBOARD_DATA_DIR
elif [ "${LARK_CODEX_DATA_DIR+x}" = x ]; then
  [ -n "$LARK_CODEX_DATA_DIR" ] || fail "旧版数据目录覆盖变量不能为空。"
  export LARK_CODEX_DATA_DIR
elif [ "${LARK_TASKBOARD_DATA_DIR+x}" = x ]; then
  # Preserve the legacy source so taskctl can recognize migrated default paths.
  [ -n "$LARK_TASKBOARD_DATA_DIR" ] || fail "旧版数据目录覆盖变量不能为空。"
  export LARK_TASKBOARD_DATA_DIR
else
  [ -n "${HOME:-}" ] || fail "无法确定用户目录，请设置 HOME 或显式指定 CODEXBOARD_DATA_DIR。"
  CODEXBOARD_DATA_DIR="$HOME/Library/Application Support/CodexBoard/data"
  export CODEXBOARD_DATA_DIR
fi

# Preserve the caller's cwd so taskctl context resolves the intended project.
exec "$board_app/Contents/Resources/runtime/bin/node" \
  "$board_app/Contents/Resources/runtime/packages/taskctl/dist/cli.js" "$@"
