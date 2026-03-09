#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# claude-mem plugin uninstall script
# Removes plugin code, registrations, and processes.
# Does NOT delete user data (~/.claude-mem/ or project mem.db).
# ============================================================

# --- Constants (update these when renaming the plugin) ---
PLUGIN_ID="claude-mem@thedotmack"
MARKETPLACE="thedotmack"
PLUGIN_NAME="claude-mem"
WORKER_PORT=37777

CLAUDE_DIR="$HOME/.claude"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
DATA_DIR="$HOME/.claude-mem"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; }

# --- Pre-flight checks ---
preflight() {
  if [[ ! -d "$CLAUDE_DIR" ]]; then
    error "未检测到 Claude Code 环境 (~/.claude/ 不存在)"
    exit 1
  fi

  local installed="$PLUGINS_DIR/installed_plugins.json"
  if [[ ! -f "$installed" ]]; then
    error "未找到插件注册文件: $installed"
    exit 1
  fi

  # Check if our plugin is registered
  local found
  found=$(python3 -c "
import json, sys
d = json.load(open('$installed'))
plugins = d.get('plugins', d)  # v2 has 'plugins' key, v1 is flat
print('yes' if '$PLUGIN_ID' in plugins else 'no')
")
  if [[ "$found" != "yes" ]]; then
    error "插件 $PLUGIN_ID 未安装或已卸载"
    exit 0
  fi
}

# --- Collect actions (dry-run) ---
collect_actions() {
  echo ""
  echo "即将执行以下卸载操作："
  echo "─────────────────────────────────"
  echo ""

  # Processes
  echo "停止进程："
  local worker_pid=""
  if [[ -f "$DATA_DIR/worker.pid" ]]; then
    worker_pid=$(cat "$DATA_DIR/worker.pid" 2>/dev/null || true)
    if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
      echo "  - Worker 进程 (PID: $worker_pid)"
    fi
  fi
  # Check port
  local port_pids
  port_pids=$(lsof -ti :"$WORKER_PORT" 2>/dev/null || true)
  if [[ -n "$port_pids" ]]; then
    echo "  - 端口 $WORKER_PORT 上的进程"
  fi
  # MCP server
  local mcp_pids
  mcp_pids=$(pgrep -f "mcp-server.cjs" 2>/dev/null || true)
  if [[ -n "$mcp_pids" ]]; then
    echo "  - MCP server 进程 (PID: $(echo $mcp_pids | tr '\n' ' '))"
  fi
  local has_procs="false"
  [[ -n "$worker_pid" || -n "$port_pids" || -n "$mcp_pids" ]] && has_procs="true"
  if [[ "$has_procs" == "false" ]]; then
    echo "  (无运行中的进程)"
  fi
  echo ""

  # Directories
  echo "删除目录："
  local marketplace_dir="$PLUGINS_DIR/marketplaces/$MARKETPLACE"
  local cache_dir="$PLUGINS_DIR/cache/$MARKETPLACE"
  [[ -d "$marketplace_dir" ]] && echo "  - $marketplace_dir"
  [[ -d "$cache_dir" ]] && echo "  - $cache_dir"
  echo ""

  # JSON entries
  echo "清理注册条目（仅删除本插件条目）："
  echo "  - installed_plugins.json: 删除 \"$PLUGIN_ID\""
  echo "  - known_marketplaces.json: 删除 \"$MARKETPLACE\""
  echo "  - settings.json: 从 enabledPlugins 删除 \"$PLUGIN_ID\""
  echo "  - settings.json: 从 extraKnownMarketplaces 删除 \"$MARKETPLACE\""
  echo ""

  # Shell alias
  local has_alias="false"
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [[ -f "$rc" ]] && grep -q "alias claude-mem=" "$rc" 2>/dev/null; then
      echo "清理 shell 配置："
      echo "  - $rc: 删除 alias claude-mem=..."
      has_alias="true"
    fi
  done
  [[ "$has_alias" == "true" ]] && echo ""

  # Data dir
  if [[ -d "$DATA_DIR" ]]; then
    echo -e "删除全局数据目录："
    echo "  - $DATA_DIR/ (数据库、配置、日志、向量索引等)"
    echo ""
  fi

  # Data NOT touched
  echo -e "以下数据 ${YELLOW}不会${NC} 被删除："
  echo "  - 各项目的 .claude/mem.db* 文件"
  echo "  - 各项目 .gitignore 中的 mem.db* 条目"
  echo "  - shell 配置中的 CLAUDE_MEM_* 环境变量"
  echo ""
}

# --- Confirm ---
confirm() {
  echo "─────────────────────────────────"
  read -rp "确认卸载？(y/N) " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "已取消。"
    exit 0
  fi
  echo ""
}

# --- Step 1: Kill processes ---
kill_processes() {
  # Worker via PID file
  if [[ -f "$DATA_DIR/worker.pid" ]]; then
    local pid
    pid=$(cat "$DATA_DIR/worker.pid" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  fi

  # Worker via pkill
  pkill -f "worker-service.cjs" 2>/dev/null || true

  # Worker via port (fallback)
  local port_pids
  port_pids=$(lsof -ti :"$WORKER_PORT" 2>/dev/null || true)
  if [[ -n "$port_pids" ]]; then
    echo "$port_pids" | xargs kill 2>/dev/null || true
  fi

  # MCP server
  pkill -f "mcp-server.cjs" 2>/dev/null || true

  info "已停止相关进程"
}

# --- Step 2: Remove directories ---
remove_directories() {
  local marketplace_dir="$PLUGINS_DIR/marketplaces/$MARKETPLACE"
  local cache_dir="$PLUGINS_DIR/cache/$MARKETPLACE"

  if [[ -d "$marketplace_dir" ]]; then
    rm -rf "$marketplace_dir"
  fi

  if [[ -d "$cache_dir" ]]; then
    rm -rf "$cache_dir"
  fi

  info "已删除插件目录"
}

# --- Step 3: Clean JSON registrations ---
clean_json_registrations() {
  # 3a. installed_plugins.json — delete plugins["$PLUGIN_ID"]
  local installed="$PLUGINS_DIR/installed_plugins.json"
  if [[ -f "$installed" ]]; then
    python3 -c "
import json
path = '$installed'
with open(path) as f:
    d = json.load(f)
# v2 format has 'plugins' key
target = d.get('plugins', d)
target.pop('$PLUGIN_ID', None)
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
"
    info "已清理 installed_plugins.json"
  fi

  # 3b. known_marketplaces.json — delete ["$MARKETPLACE"]
  local marketplaces="$PLUGINS_DIR/known_marketplaces.json"
  if [[ -f "$marketplaces" ]]; then
    python3 -c "
import json
path = '$marketplaces'
with open(path) as f:
    d = json.load(f)
d.pop('$MARKETPLACE', None)
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
"
    info "已清理 known_marketplaces.json"
  fi

  # 3c. settings.json — delete enabledPlugins["$PLUGIN_ID"] and extraKnownMarketplaces["$MARKETPLACE"]
  local settings="$CLAUDE_DIR/settings.json"
  if [[ -f "$settings" ]]; then
    python3 -c "
import json
path = '$settings'
with open(path) as f:
    d = json.load(f)
d.get('enabledPlugins', {}).pop('$PLUGIN_ID', None)
d.get('extraKnownMarketplaces', {}).pop('$MARKETPLACE', None)
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
"
    info "已清理 settings.json"
  fi
}

# --- Step 4: Clean shell aliases ---
clean_shell_aliases() {
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [[ -f "$rc" ]] && grep -q "alias claude-mem=" "$rc" 2>/dev/null; then
      # Remove lines containing 'alias claude-mem='
      python3 -c "
import re
path = '$rc'
with open(path) as f:
    lines = f.readlines()
with open(path, 'w') as f:
    for line in lines:
        if 'alias claude-mem=' not in line:
            f.write(line)
"
      info "已清理 $rc 中的 claude-mem alias"
    fi
  done
}

# --- Step 5: Remove global data directory ---
clean_data_dir() {
  if [[ -d "$DATA_DIR" ]]; then
    rm -rf "$DATA_DIR"
    info "已删除全局数据目录 $DATA_DIR/"
  fi
}

# --- Step 6: Final summary ---
print_summary() {
  echo ""
  echo "─────────────────────────────────"
  echo -e "${GREEN}卸载完成。${NC}"
  echo ""
  echo "以下数据未被删除，如需清理请手动处理："
  echo "  - 各项目数据库：<项目>/.claude/mem.db*"
  echo "  - 各项目 .gitignore 中的 mem.db* 条目"
  echo "  - 环境变量（检查 shell 配置中的 CLAUDE_MEM_* 变量）"
}

# --- Main ---
main() {
  echo "claude-mem 插件卸载工具"
  echo ""

  preflight
  collect_actions
  confirm
  kill_processes
  remove_directories
  clean_json_registrations
  clean_shell_aliases
  clean_data_dir
  print_summary
}

main "$@"
