#!/usr/bin/env bash
# fleet-agent-update.sh
# Checks this Mac and every host in ~/.ssh/config for:
#   Claude Code (claude), Codex (codex), Pi (pi), Grok Build (grok)
# Works out how each was installed, runs the matching update, prints a table.
#
# Usage:
#   ./fleet-agent-update.sh              # check and update everything
#   ./fleet-agent-update.sh --dry-run    # check only, change nothing
#   ./fleet-agent-update.sh --no-local   # skip this Mac
#   ./fleet-agent-update.sh host1 host2  # only these ssh hosts
#   SKIP_HOSTS="stormbreaker github.com" ./fleet-agent-update.sh
#
# A full sweep skips ssh-config hosts ending in -lan; name one to include it.
#
# Written for macOS bash 3.2, so no bash 4 features.

set -u

DRY_RUN=0
DO_LOCAL=1
MACHINE_OUTPUT=0
ONLY_HOSTS=""
SSH_CONFIG="${SSH_CONFIG:-$HOME/.ssh/config}"
SKIP_HOSTS="${SKIP_HOSTS:-github.com gitlab.com bitbucket.org}"

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --no-local) DO_LOCAL=0 ;;
    --machine-output) MACHINE_OUTPUT=1 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    -*)         echo "Unknown option: $arg" >&2; exit 2 ;;
    *)          ONLY_HOSTS="$ONLY_HOSTS $arg" ;;
  esac
done

LOG_DIR="$HOME/Library/Logs/fleet-agent-update/$(date +%Y%m%d-%H%M%S)"
[ -d "$HOME/Library" ] || LOG_DIR="$HOME/.cache/fleet-agent-update/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# PAYLOAD: runs on each machine (locally or over ssh). Prints one line per tool:
#   ROW|tool|installed|method|before|update|after
# All update command output goes to stderr, which is saved to the log.
# ---------------------------------------------------------------------------
PAYLOAD=$(cat <<'EOF'
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.pi/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
# Keep updaters non-interactive: no TTY tricks, no prompts, no colour codes.
export TERM=dumb CI=1 NO_COLOR=1 npm_config_yes=true npm_config_fund=false
UPDATE_TIMEOUT="${UPDATE_TIMEOUT:-600}"
TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || echo "")

[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if command -v npm >/dev/null 2>&1; then
  NPM_PREFIX=$(npm prefix -g 2>/dev/null) && export PATH="$NPM_PREFIX/bin:$PATH"
fi

resolve() {  # follow symlinks to the real file (portable, no readlink -f)
  p="$1"; n=0
  while [ -L "$p" ] && [ $n -lt 20 ]; do
    d=$(cd "$(dirname "$p")" && pwd)
    t=$(readlink "$p")
    if [ "${t#/}" != "$t" ]; then
      p="$t"
    else
      p="$d/$t"
    fi
    n=$((n+1))
  done
  echo "$p"
}

run_limited() {  # run an update with stdin closed and a hard time limit
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$UPDATE_TIMEOUT" sh -c "$1" </dev/null >&2 2>&1
    return $?
  fi
  # No timeout binary (e.g. a Mac without coreutils): watchdog in plain shell.
  sh -c "$1" </dev/null >&2 2>&1 &
  cmd_pid=$!
  ( sleep "$UPDATE_TIMEOUT"; kill -9 "$cmd_pid" 2>/dev/null ) >/dev/null 2>&1 &
  watch_pid=$!
  wait "$cmd_pid"; rc=$?
  kill "$watch_pid" 2>/dev/null
  return $rc
}

ver() {  # first x.y.z style number from --version
  "$1" --version 2>/dev/null | head -n 3 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*' | head -n 1
}

check_tool() {
  label="$1"; bin="$2"
  path=$(command -v "$bin" 2>/dev/null)
  if [ -z "$path" ]; then
    echo "ROW|$label|no|-|-|-|-"; return
  fi
  real=$(resolve "$path")
  echo "[$label] found at $path -> $real" >&2
  before=$(ver "$bin"); [ -z "$before" ] && before="unknown"

  method="unknown"; cmd=""
  if [[ "$real" == */Caskroom/* ]]; then
    name=$(echo "$real" | sed -E 's#.*/Caskroom/([^/]+)/.*#\1#')
    method="brew-cask"; cmd="brew upgrade --cask $name"
  elif [[ "$real" == */Cellar/* ]]; then
    name=$(echo "$real" | sed -E 's#.*/Cellar/([^/]+)/.*#\1#')
    method="brew"; cmd="brew upgrade $name"
  elif [[ "$real" == */node_modules/* ]]; then
    pkg=$(echo "$real" | sed -E 's#.*/node_modules/((@[^/]+/)?[^/]+).*#\1#')
    # Install back into the prefix this binary actually lives under, rather
    # than wherever `npm config get prefix` happens to point. On a host where
    # the prefix was never configured, a bare `-g` silently aims at
    # /usr/local and dies with EACCES (mediaserver, 2026-09-17).
    npm_root=${real%%/lib/node_modules/*}
    method="npm"
    if [ "$npm_root" != "$real" ] && [ -n "$npm_root" ]; then
      cmd="npm --prefix '$npm_root' install -g $pkg@latest"
    else
      cmd="npm install -g $pkg@latest"
    fi
  fi
  # Tool-specific self-updaters
  if [ "$method" = "unknown" ]; then
    target="$label:$real"
    if [[ "$target" == claude*:*/.local/share/claude/* ]]; then
      method="native"; cmd="claude update"
    elif [[ "$target" == codex*:*/.codex/* ]]; then
      method="standalone"; cmd="codex update"
    elif [[ "$target" == grok*:*/.grok/* ]]; then
      method="script"; cmd="grok update"
    elif [[ "$target" == pi:* ]]; then
      method="self"; cmd="pi update --self --no-approve"
    fi
  fi
  # Pi documents its own updater for npm installs too
  [ "$label" = "pi" ] && [ "$method" = "npm" ] && cmd="pi update --self --no-approve"

  if [ -z "$cmd" ]; then
    echo "ROW|$label|yes|$method|$before|SKIPPED unknown install|$before"; return
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "ROW|$label|yes|$method|$before|would run: ${cmd%% *}|-"; return
  fi

  echo "[$label] running: $cmd" >&2
  run_limited "$cmd"
  rc=$?
  hash -r 2>/dev/null
  after=$(ver "$bin"); [ -z "$after" ] && after="unknown"
  if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
    status="TIMED OUT (${UPDATE_TIMEOUT}s)"
  elif [ $rc -ne 0 ]; then
    status="FAILED (exit $rc)"
  elif [ "$after" = "$before" ]; then
    status="OK, already latest"
  else
    status="OK, updated"
  fi
  echo "ROW|$label|yes|$method|$before|$status|$after"
}

check_tool "claude" claude
check_tool "codex"  codex
check_tool "pi"     pi
check_tool "grok"   grok
exit 0
EOF
)

run_payload() {  # $1 = label, $2 = "local" or ssh host
  label="$1"; target="$2"
  out="$LOG_DIR/$label.out"; err="$LOG_DIR/$label.log"
  if [ "$target" = "local" ]; then
    printf 'DRY_RUN=%s\n%s\n' "$DRY_RUN" "$PAYLOAD" | bash -s >"$out" 2>"$err"
    echo $? >"$LOG_DIR/$label.rc"
  else
    printf 'DRY_RUN=%s\n%s\n' "$DRY_RUN" "$PAYLOAD" | \
      ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=8 \
          "$target" 'bash -s' >"$out" 2>"$err"
    echo $? >"$LOG_DIR/$label.rc"
  fi
}

# ---- Build host list ------------------------------------------------------
HOSTS=""
if [ -n "$ONLY_HOSTS" ]; then
  HOSTS="$ONLY_HOSTS"
elif [ -f "$SSH_CONFIG" ]; then
  HOSTS=$(awk 'tolower($1)=="host" { for (i=2;i<=NF;i++) if ($i !~ /[*?!]/) print $i }' "$SSH_CONFIG" | sort -u)
fi
FILTERED=""
for h in $HOSTS; do
  skip=0
  for s in $SKIP_HOSTS; do [ "$h" = "$s" ] && skip=1; done
  # A -lan alias is a second route to a machine we already reach another way,
  # and it only resolves when we are on that network. Drop it when the plain
  # name is also in the list (stormbreaker-lan vs stormbreaker); keep it when it
  # is the only entry for that machine (proxmox-lan). Naming one on the command
  # line always runs it.
  if [ -z "$ONLY_HOSTS" ]; then
    case "$h" in
      *-lan)
        base=${h%-lan}
        for o in $HOSTS; do [ "$o" = "$base" ] && skip=1; done ;;
    esac
  fi
  [ $skip -eq 0 ] && FILTERED="$FILTERED $h"
done

[ "$DRY_RUN" = "1" ] && echo "DRY RUN: nothing will be updated."
[ "$DO_LOCAL" = "1" ] && LP="local" || LP=""
echo "Hosts: $LP$FILTERED"
echo "Logs:  $LOG_DIR"
echo "Working (runs in parallel, updates can take a few minutes)..."

# ---- Run everything in parallel ------------------------------------------
LABELS=""
if [ "$DO_LOCAL" = "1" ]; then
  LOCAL_LABEL="local-$(hostname -s)"
  LABELS="$LOCAL_LABEL"
  run_payload "$LOCAL_LABEL" local &
fi
for h in $FILTERED; do
  LABELS="$LABELS $h"
  run_payload "$h" "$h" &
done
wait

# ---- Print table ----------------------------------------------------------
# Colour only when writing to a real terminal, and never when NO_COLOR is set,
# so redirecting the output to a file keeps it plain.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then USE_COLOR=1; else USE_COLOR=0; fi
[ -n "${FORCE_COLOR:-}" ] && USE_COLOR=1   # keep colour when piping into a pager
if [ "$DRY_RUN" = "1" ]; then MODE="dry run"; else MODE="live run"; fi

{
  for l in $LABELS; do
    rc=$(cat "$LOG_DIR/$l.rc" 2>/dev/null || echo 255)
    case "$l" in local-*) disp=${l#local-} ;; *) disp="$l" ;; esac
    if [ "$rc" = "255" ] || ! grep -q "^ROW|" "$LOG_DIR/$l.out" 2>/dev/null; then
      reason=$(tail -n 1 "$LOG_DIR/$l.log" 2>/dev/null | tr "|" " " | cut -c1-48)
      printf "HOST|%s||bad|%s\n" "$disp" "${reason:-no output}"
      continue
    fi
    printf "HOST|%s||ok|\n" "$disp"
    grep "^ROW|" "$LOG_DIR/$l.out" | while IFS="|" read -r _ tool inst method before status after; do
      printf "TOOL|%s|%s|%s|%s|%s|%s|%s\n" "$disp" "$tool" "$inst" "$method" "$before" "$status" "$after"
    done
  done
} | awk -v color="$USE_COLOR" -v dry="$DRY_RUN" -v mode="$MODE" -v machine="$MACHINE_OUTPUT" \
        -v title="FLEET AGENT UPDATE" \
        -v g_bar="$(printf '\342\224\200')" -v g_behind="$(printf '\342\226\276')" \
        -v g_ok="$(printf '\342\234\223')" -v g_fail="$(printf '\342\234\227')" \
        -v g_skip="?" -v g_none="$(printf '\342\200\223')" \
'# Renders the fleet results as a host x tool version matrix.
# Input records: HOST|name|tag|state|reason   and   TOOL|host|tool|inst|method|before|status|after
function vlen(s,   t) { t = s; gsub(/[\200-\277]/, "", t); return length(t) }
function pad(s, w,   r) { r = s; while (vlen(r) < w) r = r " "; return r }
function rep(c, n,   r, i) { r = ""; for (i = 0; i < n; i++) r = r c; return r }
function vcmp(a, b,   x, y, i, n, m, k) {   # numeric version compare: 1, 0 or -1
  n = split(a, x, /[^0-9]+/); m = split(b, y, /[^0-9]+/); k = (n > m ? n : m)
  for (i = 1; i <= k; i++) {
    if ((x[i] + 0) > (y[i] + 0)) return 1
    if ((x[i] + 0) < (y[i] + 0)) return -1
  }
  return 0
}
BEGIN {
  FS = "|"
  if (color) { R="\033[0m"; B="\033[1m"; D="\033[2m"; GRN="\033[32m"; YEL="\033[33m"; RED="\033[31m"; CYN="\033[36m" }
}
$1 == "HOST" {
  h = $2
  if (!(h in seen)) { hosts[++nh] = h; seen[h] = 1 }
  tag[h] = $3; state[h] = $4; reason[h] = $5
  next
}
$1 == "TOOL" {
  h = $2; t = $3
  if (!(tseen[t])) { tools[++nt] = t; tseen[t] = 1 }
  inst[h, t] = $4; before[h, t] = $6; status[h, t] = $7; after[h, t] = $8
  next
}
END {
  # newest version seen across the fleet, per tool
  for (i = 1; i <= nh; i++) for (j = 1; j <= nt; j++) {
    h = hosts[i]; t = tools[j]
    if (inst[h, t] != "yes") continue
    v = (after[h, t] != "-" && after[h, t] != "" && after[h, t] != "unknown") ? after[h, t] : before[h, t]
    if (v == "-" || v == "" || v == "unknown") continue
    ver[h, t] = v
    if (!(t in newest) || vcmp(v, newest[t]) > 0) newest[t] = v
  }
  # build each cell, then size the columns to fit
  hw = vlen("HOST")
  for (i = 1; i <= nh; i++) { h = hosts[i]; if (vlen(h) > hw) hw = vlen(h) }
  for (j = 1; j <= nt; j++) { t = tools[j]; cw[t] = vlen(t) }
  for (i = 1; i <= nh; i++) for (j = 1; j <= nt; j++) {
    h = hosts[i]; t = tools[j]
    if (state[h] != "ok") { cell[h, t] = ""; continue }
    s = status[h, t]; v = ver[h, t]
    if (inst[h, t] != "yes")            { cell[h, t] = g_none;    cls[h, t] = "none" }
    else if (s ~ /^SKIPPED/)            { cell[h, t] = v " " g_skip; cls[h, t] = "skip"; prob[++np] = h "|" t "|" s }
    else if (s ~ /^FAILED|^TIMED OUT/)  { cell[h, t] = v " " g_fail; cls[h, t] = "fail"; prob[++np] = h "|" t "|" s }
    else if (s ~ /^OK, updated/)        { cell[h, t] = v " " g_ok;   cls[h, t] = "ok";   nupd++ }
    else if (t in newest && vcmp(v, newest[t]) < 0)
                                        { cell[h, t] = v " " g_behind; cls[h, t] = "behind"; nbehind++ }
    else                                { cell[h, t] = v;         cls[h, t] = "plain" }
    if (inst[h, t] == "yes") ninst++
    if (vlen(cell[h, t]) > cw[t]) cw[t] = vlen(cell[h, t])
  }
  total = hw
  for (j = 1; j <= nt; j++) total += cw[tools[j]] + 2

  # ---- header ----
  printf "\n  %s%s%s  %s%s · %d hosts%s\n\n", B, title, R, D, mode, nh, R
  line = pad("HOST", hw)
  for (j = 1; j <= nt; j++) line = line "  " pad(tools[j], cw[tools[j]])
  printf "  %s%s%s\n", D, line, R
  printf "  %s%s%s\n", D, rep(g_bar, total), R

  # ---- rows ----
  for (i = 1; i <= nh; i++) {
    h = hosts[i]
    if (state[h] != "ok") {
      printf "  %s  %s%s%s\n", pad(h, hw), RED, reason[h], R
      nbad++
      continue
    }
    nok++
    printf "  %s", pad(h, hw)
    for (j = 1; j <= nt; j++) {
      t = tools[j]; c = cls[h, t]
      col = ""
      if (c == "none") col = D
      else if (c == "behind" || c == "skip") col = YEL
      else if (c == "fail") col = RED
      else if (c == "ok") col = GRN
      printf "  %s%s%s", col, pad(cell[h, t], cw[t]), (col == "" ? "" : R)
    }
    printf "\n"
  }

  # ---- legend and summary ----
  printf "\n"
  leg = sprintf("%s%s behind%s   %s%s not installed%s", YEL, g_behind, R, D, g_none, R)
  if (nupd) leg = sprintf("%s%s updated%s   ", GRN, g_ok, R) leg
  if (np)   leg = leg sprintf("   %s%s failed%s   %s%s no update path%s", RED, g_fail, R, YEL, g_skip, R)
  printf "  %s\n", leg
  if (dry)
    printf "  %s%d reachable · %d installed · %d behind newest%s\n", D, nok, ninst, nbehind, R
  else
    printf "  %s%d reachable · %d installed · %d updated · %d problems%s\n", D, nok, ninst, nupd, np, R

  # ---- problems, in full ----
  if (np || nbad) {
    printf "\n  %sNeeds attention%s\n", B, R
    for (i = 1; i <= nh; i++) if (state[hosts[i]] != "ok")
      printf "    %s%s%s  %s\n", RED, pad(hosts[i], hw), R, reason[hosts[i]]
    for (k = 1; k <= np; k++) {
      split(prob[k], p, "|")
      pc = (p[3] ~ /^SKIPPED/) ? YEL : RED
      printf "    %s  %s%s%s  %s\n", pad(p[1], hw), pc, pad(p[2], 7), R, p[3]
    }
  }
  printf "\n"
  if (machine) {
    printf "@@AGENT_DATA_BEGIN@@\n"
    for (i = 1; i <= nh; i++) {
      h = hosts[i]
      if (state[h] != "ok") {
        printf "AGENT_HOST|%s|bad|%s\n", h, reason[h]
        continue
      }
      printf "AGENT_HOST|%s|ok|\n", h
      for (j = 1; j <= nt; j++) {
        t = tools[j]
        printf "AGENT_TOOL|%s|%s|%s|%s|%s|%s|%s|%s|%s\n", h, t, inst[h,t], method[h,t], before[h,t], status[h,t], after[h,t], ver[h,t], cls[h,t]
      }
    }
  }
}'

echo "  Full per-host output: $LOG_DIR/<host>.log"
echo
