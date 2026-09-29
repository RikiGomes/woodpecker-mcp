#!/usr/bin/env bash
# secret-guard.sh: refuses commits that may hold credentials. Synced from claude-dotfiles/repo-kit;
# edit it there. It prints paths, rule names and line numbers only, never a value.
#   (no argument)              Claude Code PreToolUse hook: hook JSON on stdin, exit 2 blocks.
#   --git                      git pre-commit hook: checks the staged changes, exit 1 blocks.
#   --install-git-hook [repo]  writes the git pre-commit hook, unless another hook manager or a
#                              foreign pre-commit hook owns it (then prints one notice line).
# Checks: paths matching ../gitignore-credentials, gitleaks (when installed), and literal
# secrets in .mcp.json server entries.
set -uo pipefail

mode=hook
case "${1:-}" in
  --git) mode=git ;;
  --install-git-hook) mode=install ;;
esac

if [[ "$mode" == hook ]]; then
  # Fast path, builtins only (no fork): most Bash calls are not commits.
  input=""
  IFS= read -r -d '' input || true
  case "$input" in *commit*) ;; *) exit 0 ;; esac
fi

# cloud-setup.sh installs gitleaks into ~/.local/bin, which a hook's PATH may lack.
export PATH="${HOME:-/nonexistent}/.local/bin:$PATH"
self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patterns="$(cd "$self_dir/.." && pwd)/gitignore-credentials"
MARK='# claude-dotfiles: secret-guard pre-commit hook'
US=$'\x1f'   # separator for in-memory path sets: it can't appear in a sane path
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- git hook state and install

# hooks_state <repo>: prints "<state><TAB><path>" for the repo's effective pre-commit hook.
# States: ours, none, foreign-hook (path = the hook file), foreign-path (path = core.hooksPath).
hooks_state() {
  local repo="$1" common own configured hp
  common="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$common" in /*) ;; *) common="$repo/$common" ;; esac
  own="$common/hooks"
  configured="$(git -C "$repo" config --get core.hooksPath 2>/dev/null || true)"
  if [[ -n "$configured" ]]; then
    case "$configured" in
      \~/*) hp="${HOME:-}/${configured#\~/}" ;;
      /*) hp="$configured" ;;
      *) hp="$(git -C "$repo" rev-parse --show-toplevel)/$configured" ;;   # relative to the work tree root
    esac
    if [[ ! -d "$own" || "$(cd "$hp" 2>/dev/null && pwd -P)" != "$(cd "$own" && pwd -P)" ]]; then
      printf 'foreign-path\t%s\n' "$configured"; return 0
    fi
  fi
  if [[ -e "$own/pre-commit" || -L "$own/pre-commit" ]]; then
    if ! grep -qsF "$MARK" "$own/pre-commit"; then printf 'foreign-hook\t%s\n' "$own/pre-commit"
    # Ours but not executable: git skips it, so it counts as missing (the installer rewrites it).
    elif [[ -x "$own/pre-commit" ]]; then printf 'ours\t%s\n' "$own/pre-commit"
    else printf 'none\t%s\n' "$own/pre-commit"; fi
  else
    printf 'none\t%s\n' "$own/pre-commit"
  fi
}

install_git_hook() { # install_git_hook <repo>
  local repo="$1" common state kind path target
  common="$(git -C "$repo" rev-parse --git-common-dir)" || return 1
  case "$common" in /*) ;; *) common="$repo/$common" ;; esac
  mkdir -p "$common/hooks" || return 1
  state="$(hooks_state "$repo")" || return 1
  kind="${state%%$'\t'*}"; path="${state#*$'\t'}"
  case "$kind" in
    foreign-path)
      target="${path%/}"
      # husky's core.hooksPath is its generated .husky/_ dir; people edit .husky/pre-commit.
      [[ "${target##*/}" == _ ]] && target="${target%/*}"
      echo "notice: $repo uses core.hooksPath=$path; add \`.claude/hooks/secret-guard.sh --git\` to $target/pre-commit"
      return 0 ;;
    foreign-hook)
      echo "notice: $repo already has a pre-commit hook; add \`.claude/hooks/secret-guard.sh --git\` to $path"
      return 0 ;;
  esac
  # shellcheck disable=SC2016  # $(...) and $guard must stay literal: they run inside the hook
  printf '%s\n' '#!/bin/sh' \
    "$MARK (written by claude-dotfiles secret-guard.sh --install-git-hook)" \
    '# Blocks commits whose staged changes may hold credentials.' \
    'guard="$(git rev-parse --show-toplevel)/.claude/hooks/secret-guard.sh"' \
    '[ -x "$guard" ] || exit 0' \
    'exec "$guard" --git' > "$path" || return 1
  chmod 755 "$path"
}

if [[ "$mode" == install ]]; then
  repo="${2:-}"
  [[ -n "$repo" ]] || repo="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "secret-guard: not in a git repo" >&2; exit 1; }
  install_git_hook "$repo"
  exit $?
fi

# ---------------------------------------------------------------- checks

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/secret-guard.XXXXXX")" || exit 1
trap 'rm -rf "$TMPD"' EXIT
GL_TIMEOUT="${SECRET_GUARD_TIMEOUT:-30}"   # per gitleaks scan
GL_BUDGET="${SECRET_GUARD_BUDGET:-45}"     # all gitleaks scans of this run (hook timeout is 120 s)
GL_DEADLINE=$((SECONDS + GL_BUDGET))
problems=""
add() { case "$problems" in *"  $1"$'\n'*) ;; *) problems="$problems  $1"$'\n' ;; esac; }

# read0 <array-name> <command...>: reads the command's NUL-separated output into the array.
read0() {
  local __name="$1" __f; shift
  eval "$__name=()"
  while IFS= read -r -d '' __f; do eval "${__name}[\${#${__name}[@]}]=\"\$__f\""; done < <("$@" 2>/dev/null)
}

# run_timeout <secs> <cmd...>: runs cmd, killing it after <secs> (macOS has no timeout(1)).
run_timeout() {
  local secs="$1"; shift
  if have timeout; then timeout "$secs" "$@"; return; fi
  if have gtimeout; then gtimeout "$secs" "$@"; return; fi
  "$@" &
  local pid=$!
  ( i=0; while [ "$i" -lt "$secs" ]; do sleep 1; kill -0 "$pid" 2>/dev/null || exit 0; i=$((i+1)); done
    kill -TERM "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  wait "$pid"
}

# path_check <paths...> (relative to the cwd repo root): a path counts when the kit patterns
# alone ignore it (so a force-added .env is caught and unrelated rules like dist/ are not) and
# the repo's own ignore rules, with the kit patterns as fallback, still ignore it (so a `!path`
# negation after the synced block allows a fixture).
path_check() {
  [[ -f "$patterns" ]] || { echo "secret-guard: $patterns is missing; credential path check skipped" >&2; return 0; }
  local -a chunk=() kit=() eff=()
  local p effset
  while [[ $# -gt 0 ]]; do
    chunk=()
    while [[ $# -gt 0 && ${#chunk[@]} -lt 200 ]]; do chunk[${#chunk[@]}]="$1"; shift; done
    read0 kit git --literal-pathspecs ls-files -z -c -o -i --exclude-from="$patterns" -- "${chunk[@]}"
    [[ ${#kit[@]} -gt 0 ]] || continue
    read0 eff git --literal-pathspecs ls-files -z -c -o -i --exclude-standard --exclude-from="$patterns" -- "${chunk[@]}"
    effset="$US"; for p in ${eff[@]+"${eff[@]}"}; do effset="$effset$p$US"; done
    for p in "${kit[@]}"; do
      case "$effset" in *"$US$p$US"*) add "$p: credential-file (matches the credential patterns)" ;; esac
    done
  done
}

# mcp_check <label> <content>: literal secrets anywhere in an .mcp.json server entry.
read -r -d '' MCP_JQ <<'JQ'
def unref: gsub("\\$\\{[A-Za-z_][A-Za-z0-9_]*(:-(?<d>[^}]*))?\\}"; .d // "") | gsub("\\$[A-Za-z_][A-Za-z0-9_]*"; "");
def longtok: test("^[A-Za-z0-9_-]{20,}$") and test("[A-Za-z]") and test("[0-9]")
  and (test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") | not)
  and ([splits("[-_]")] | map(length) | max) >= 16;
def rule($field):
  if longtok then "mcp-long-token"
  elif test("Bearer\\s+\\S") then "mcp-bearer-literal"
  elif test("(^|[^A-Za-z0-9])(ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|sk-|xox)") then "mcp-token-prefix"
  elif ($field == "args" or $field == "url") and test("(token|key|secret|password|passwd|auth)[=:][\"']?[^\"'\\s&]"; "i") then "mcp-keyword-secret"
  elif $field == "url" and test("://[^/@:\\s]+:[^/@\\s]+@") then "mcp-url-credentials"
  else empty end;
(.mcpServers // {}) | to_entries[] | select(.value | type == "object") | .key as $srv | .value as $cfg
| ( ($cfg | paths(strings)) as $p
    | ($cfg | getpath($p) | unref | rule($p[0] | tostring)) as $r
    | [(["mcpServers", $srv] + $p | map(tostring) | join(".")),
       (if ($p | last | type) == "string" then ($p | last) else ($p[0] | tostring) end), $r] | @tsv ),
  ( ($cfg.args | if type == "array" then . else [] end) as $a
    | range(0; ($a | length) - 1) as $i
    | select(($a[$i] | type) == "string" and ($a[$i + 1] | type) == "string")
    | select($a[$i] | test("^--?[A-Za-z0-9_-]*(token|key|secret|password|passwd|auth)$"; "i"))
    | ($a[$i + 1] | unref) as $v
    | select(($v | length) > 0 and ($v | startswith("-") | not))
    | [("mcpServers." + $srv + ".args." + (($i + 1) | tostring)), "args", "mcp-arg-secret"] | @tsv )
JQ
mcp_check() {
  local label="$1" content="$2" found keypath leaf rule line
  if ! have jq; then echo "secret-guard: jq not installed; $label check skipped" >&2; return 0; fi
  if ! found="$(printf '%s\n' "$content" | jq -r "$MCP_JQ" 2>/dev/null)"; then
    add "$label: mcp-invalid-json (cannot check its servers)"; return 0
  fi
  while IFS=$'\t' read -r keypath leaf rule; do
    [[ -n "$keypath" ]] || continue
    line="$(printf '%s\n' "$content" | grep -nF "\"$leaf\"" | head -n 1 | cut -d: -f1)"
    add "$label:${line:-?}: $rule at $keypath"
  done <<< "$found"
}

# gl_run <workdir> <subcommand> <flag> [more flags...]: one gitleaks scan of <workdir> with a
# timeout. Findings come from the redacted JSON report (its own output is discarded). Fails
# closed on any non-zero exit.
gl_run() {
  local wd="$1" rep rc found t; shift
  t=$((GL_DEADLINE - SECONDS))
  if [[ $t -le 0 ]]; then
    add "gitleaks time budget of ${GL_BUDGET}s used up before gitleaks $1 $2 (blocking to be safe)"; return 0
  fi
  [[ $t -gt $GL_TIMEOUT ]] && t=$GL_TIMEOUT
  rep="$(mktemp "$TMPD/report.XXXXXX")" || return 1
  ( cd "$wd" && run_timeout "$t" gitleaks "$1" "$2" --redact --no-banner --exit-code 1 --log-level error \
      --report-format json --report-path "$rep" "${@:3}" . ) </dev/null >/dev/null 2>&1
  rc=$?
  [[ $rc -eq 0 ]] && return 0
  case $rc in
    124|137|143) add "gitleaks timed out after ${t}s (per-scan limit ${GL_TIMEOUT}s, total budget ${GL_BUDGET}s; blocking to be safe): gitleaks $1 $2"; return 0 ;;
  esac
  found=""
  have jq && found="$(jq -r --arg pre "$wd/" '.[]? | "\(.File | ltrimstr($pre) | ltrimstr("./")):\(.StartLine): \(.RuleID) (gitleaks)"' "$rep" 2>/dev/null)"
  if [[ -n "$found" ]]; then
    while IFS= read -r l; do add "$l"; done <<< "$found"
  else
    add "gitleaks exited $rc (a leak, or an error); details: gitleaks $1 $2 --redact -v"
  fi
}

# check_repo <scope> [force-add dirs/paths...]: runs every check in the cwd repo (its root).
#   staged: the index (git mode).
#   wide:   what a commit in this call might include: tracked changes vs HEAD (staged or not),
#           untracked files that are not ignored, and `git add -f` targets (dir<US>path pairs).
check_repo() {
  local scope="$1" f d p top; shift
  local -a cands=() untracked=() part=()
  top="$PWD"
  if [[ "$scope" == staged ]]; then
    read0 cands git diff --cached --name-only -z --diff-filter=ACMRT
  else
    if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
      read0 cands git diff HEAD --name-only -z --diff-filter=ACMRT
    else
      read0 cands git ls-files -z
    fi
    read0 untracked git ls-files -z -o --exclude-standard
    for f in "$@"; do
      d="${f%%"$US"*}"; p="${f#*"$US"}"
      read0 part git -C "$d" --literal-pathspecs ls-files -z --full-name -o -- "$p"
      untracked+=(${part[@]+"${part[@]}"})
      read0 part git -C "$d" --literal-pathspecs ls-files -z --full-name -c -- "$p"
      cands+=(${part[@]+"${part[@]}"})
    done
    cands+=(${untracked[@]+"${untracked[@]}"})
  fi
  [[ ${#cands[@]} -gt 0 ]] || return 0

  path_check "${cands[@]}"

  for f in "${cands[@]}"; do
    case "$f" in .mcp.json|*/.mcp.json) ;; *) continue ;; esac
    if git cat-file -e ":$f" 2>/dev/null; then mcp_check "$f" "$(git show ":$f")"; fi
    if [[ "$scope" == wide && -f "$f" ]]; then mcp_check "$f" "$(cat "$f")"; fi
  done

  if have gitleaks; then
    gl_run "$top" git --staged
    if [[ "$scope" == wide ]]; then
      gl_run "$top" git --pre-commit
      if [[ ${#untracked[@]} -gt 0 ]]; then
        d="$(mktemp -d "$TMPD/untracked.XXXXXX")"
        printf '%s\0' "${untracked[@]}" | tar -C "$top" -c -f - --null -T - 2>/dev/null | tar -C "$d" -x -f - 2>/dev/null
        local -a cfg=()
        [[ -f "$top/.gitleaks.toml" ]] && cfg=(--config="$top/.gitleaks.toml")
        gl_run "$d" dir --gitleaks-ignore-path="$top" ${cfg[@]+"${cfg[@]}"}
      fi
    fi
  else
    echo "secret-guard: gitleaks not installed; path check only" >&2
  fi
}

report_and_exit() { # report_and_exit <exit code>
  [[ -n "$problems" ]] || exit 0
  {
    echo "secret-guard: commit blocked; it may include credentials (values not shown):"
    printf '%s' "$problems"
    echo "Unstage with: git restore --staged <path> (a file already committed: git rm --cached <path>)."
    echo "Keep the value in Bitwarden: .claude/bin/with-secrets injects it at run time; .mcp.json takes \${VAR} references."
    echo "A gitleaks false positive: add its Fingerprint (gitleaks git --staged --redact -v) to .gitleaksignore."
  } >&2
  exit "$1"
}

if [[ "$mode" == git ]]; then
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  cd "$top" || exit 0
  check_repo staged
  report_and_exit 1
fi

# ---------------------------------------------------------------- hook mode: parse the command

json_str() { # json_str <key>: the unescaped string value of "key" in $input (jq-less fallback)
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\"" s out="" i=0 c
  [[ "$input" =~ $re ]] || return 0
  s="${BASH_REMATCH[1]}"
  while [[ $i -lt ${#s} ]]; do
    c="${s:i:1}"
    if [[ "$c" == "\\" ]]; then
      case "${s:i+1:1}" in n) out+=$'\n' ;; t) out+=$'\t' ;; r) ;; *) out+="${s:i+1:1}" ;; esac
      i=$((i+2))
    else out+="$c"; i=$((i+1)); fi
  done
  printf '%s' "$out"
}

if have jq; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
  base="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
else
  cmd="$(json_str command)"; base="$(json_str cwd)"
fi
[[ -n "$base" && -d "$base" ]] || base="$PWD"


NL=$'\n'

# strip_heredocs <text>: drops heredoc bodies, so a commit message never parses as commands.
# Quote-aware: `<<WORD` inside quotes is text, but inside a "$( ... )" it is a real heredoc.
strip_heredocs() {
  local LC_ALL=C
  local s="$1" n=${#1} i=0 c q="" stack="" delim="" out="" rest line t j
  while [[ $i -lt $n ]]; do
    c="${s:i:1}"
    if [[ "$c" == "$NL" && -n "$delim" ]]; then
      out+="$c"; i=$((i+1))
      while [[ $i -lt $n ]]; do
        rest="${s:i}"; line="${rest%%"$NL"*}"; i=$((i+${#line}+1))
        t="${line#"${line%%[![:space:]]*}"}"
        [[ "$t" == "$delim" ]] && break
      done
      delim=""; continue
    fi
    case "$q" in
      "'") [[ "$c" == "'" ]] && q="" ;;
      '"')
        if [[ "$c" == "\\" ]]; then out+="${s:i:2}"; i=$((i+2)); continue
        elif [[ "$c" == '"' ]]; then q=""
        elif [[ "$c" == '$' && "${s:i+1:1}" == "(" ]]; then stack+='"'; q=""; out+="\$("; i=$((i+2)); continue
        fi ;;
      *)
        case "$c" in
          "\\") out+="${s:i:2}"; i=$((i+2)); continue ;;
          "'"|'"') q="$c" ;;
          '$') if [[ "${s:i+1:1}" == "(" ]]; then stack+="-"; out+="\$("; i=$((i+2)); continue; fi ;;
          "(") [[ -n "$stack" ]] && stack+="(" ;;
          ")")
            if [[ -n "$stack" ]]; then
              t="${stack:${#stack}-1}"; stack="${stack%?}"
              [[ "$t" == '"' ]] && q='"'
            fi ;;
          "<")
            if [[ "${s:i:2}" == "<<" && "${s:i+2:1}" != "<" && "${s:i-1:1}" != "<" ]]; then
              j=$((i+2)); [[ "${s:j:1}" == "-" ]] && j=$((j+1))
              while [[ "${s:j:1}" == " " || "${s:j:1}" == $'\t' ]]; do j=$((j+1)); done
              t="${s:j:1}"
              if [[ "$t" == "'" || "$t" == '"' ]]; then
                rest="${s:j+1}"; delim="${rest%%"$t"*}"; j=$((j+2+${#delim}))
              else
                [[ "$t" == "\\" ]] && j=$((j+1))
                rest="${s:j}"; delim="${rest%%[!A-Za-z0-9_]*}"; j=$((j+${#delim}))
              fi
              out+="${s:i:j-i}"; i=$j; continue
            fi ;;
        esac ;;
    esac
    out+="$c"; i=$((i+1))
  done
  printf '%s' "$out"
}

# subst_end <text> <index of "(">: sets SUB_END to the index after the matching ")".
subst_end() {
  local s="$1" k=$(( $2 + 1 )) d=1 ch rest part
  while [[ $k -lt ${#s} && $d -gt 0 ]]; do
    ch="${s:k:1}"
    case "$ch" in
      "(") d=$((d+1)) ;;
      ")") d=$((d-1)) ;;
      "'") rest="${s:k+1}"; if [[ "$rest" == *"'"* ]]; then part="${rest%%"'"*}"; k=$((k+1+${#part})); fi ;;
      "\\") k=$((k+1)) ;;
    esac
    k=$((k+1))
  done
  SUB_END=$k
}

# tokenize <text>: shell-like words into TOK; operators (; & | ( ) newline) become "$US<op>".
# The bodies of $(...) and `...` go to SUBS, to be walked like sh -c scripts.
tokenize() {
  local LC_ALL=C
  local s="$1" i=0 n=${#1} c w="" inw=0 rest part
  TOK=(); SUBS=()
  while [[ $i -lt $n ]]; do
    c="${s:i:1}"
    case "$c" in
      "'")
        rest="${s:i+1}"
        if [[ "$rest" == *"'"* ]]; then part="${rest%%"'"*}"; else part="$rest"; fi
        w+="$part"; i=$((i+2+${#part})); inw=1 ;;
      '"')
        i=$((i+1)); inw=1
        while [[ $i -lt $n ]]; do
          c="${s:i:1}"
          if [[ "$c" == '"' ]]; then i=$((i+1)); break
          elif [[ "$c" == "\\" ]]; then w+="${s:i+1:1}"; i=$((i+2))
          elif [[ "$c" == '$' && "${s:i+1:1}" == "(" ]]; then
            subst_end "$s" $((i+1)); SUBS[${#SUBS[@]}]="${s:i+2:SUB_END-i-3}"; w+="${s:i:SUB_END-i}"; i=$SUB_END
          elif [[ "$c" == '`' ]]; then
            rest="${s:i+1}"; part="${rest%%\`*}"; SUBS[${#SUBS[@]}]="$part"; w+="\`$part\`"; i=$((i+2+${#part}))
          else w+="$c"; i=$((i+1)); fi
        done ;;
      "\\") w+="${s:i+1:1}"; i=$((i+2)); inw=1 ;;
      '$')
        if [[ "${s:i+1:1}" == "(" ]]; then
          subst_end "$s" $((i+1)); SUBS[${#SUBS[@]}]="${s:i+2:SUB_END-i-3}"; w+="${s:i:SUB_END-i}"; i=$SUB_END
        else w+="$c"; i=$((i+1)); fi
        inw=1 ;;
      '`')
        rest="${s:i+1}"; part="${rest%%\`*}"; SUBS[${#SUBS[@]}]="$part"; w+="\`$part\`"; i=$((i+2+${#part})); inw=1 ;;
      " "|$'\t')
        if [[ $inw == 1 ]]; then TOK[${#TOK[@]}]="$w"; fi
        w=""; inw=0; i=$((i+1)) ;;
      ";"|"&"|"|"|"("|")"|"$NL")
        if [[ $inw == 1 ]]; then TOK[${#TOK[@]}]="$w"; fi
        w=""; inw=0
        TOK[${#TOK[@]}]="$US$c"; i=$((i+1)) ;;
      *) w+="$c"; inw=1; i=$((i+1)) ;;
    esac
  done
  if [[ $inw == 1 ]]; then TOK[${#TOK[@]}]="$w"; fi
}

# hp_check <word>: a word that sets core.hooksPath (git -c, --config-env, GIT_CONFIG_*
# variables) would let the commit skip our git hook.
hp_check() {
  shopt -s nocasematch
  [[ "$1" == *core.hookspath* ]] && skip_reason="a core.hooksPath override"
  shopt -u nocasematch
  return 0
}

join_dir() { # join_dir <base> <path>: expands a leading ~ and resolves a relative path
  local p="$2"
  case "$p" in \~) p="${HOME:-}" ;; \~/*) p="${HOME:-}/${p#\~/}" ;; esac
  case "$p" in /*) printf '%s' "$p" ;; *) printf '%s/%s' "$1" "$p" ;; esac
}

commit_seen=0; commit_word=0; skip_reason=""
C_DIR=(); C_GITDIR=(); C_WT=(); F_ENTRY=()
Q_CMD=(); Q_DIR=()
add_cand() { C_DIR[${#C_DIR[@]}]="$1"; C_GITDIR[${#C_GITDIR[@]}]="${2:-}"; C_WT[${#C_WT[@]}]="${3:-}"; }

# analyze_git <cwd> <GIT_DIR or ""> <GIT_WORK_TREE or ""> <words after git...>
analyze_git() {
  local ctx="$1" gitdir="$2" wt="$3" sub="" w ch j rest; shift 3
  while [[ $# -gt 0 ]]; do
    w="$1"
    case "$w" in
      -C) [[ $# -ge 2 ]] && ctx="$(join_dir "$ctx" "$2")"; shift 2 || shift ;;
      -C?*) ctx="$(join_dir "$ctx" "${w#-C}")"; shift ;;
      -c|--config-env) hp_check "${2:-}"; shift 2 || shift ;;
      --config-env=*) hp_check "$w"; shift ;;
      --namespace|--super-prefix) shift 2 || shift ;;
      --git-dir=*) gitdir="${w#--git-dir=}"; shift ;;
      --git-dir) gitdir="${2:-}"; shift 2 || shift ;;
      --work-tree=*) wt="${w#--work-tree=}"; shift ;;
      --work-tree) wt="${2:-}"; shift 2 || shift ;;
      -*) shift ;;
      *) sub="$w"; shift; break ;;
    esac
  done
  [[ -n "$gitdir" ]] && gitdir="$(join_dir "$ctx" "$gitdir")"
  [[ -n "$wt" ]] && wt="$(join_dir "$ctx" "$wt")"
  case "$sub" in
    commit)
      commit_seen=1
      add_cand "$ctx" "$gitdir" "$wt"
      while [[ $# -gt 0 ]]; do
        w="$1"; shift
        case "$w" in
          --) break ;;
          --no-veri*) skip_reason="--no-verify" ;;
          --message|--file|--author|--date|--reuse-message|--reedit-message|--fixup|--squash|--template|--cleanup|--trailer|--pathspec-from-file)
            shift || true ;;
          --*) ;;
          -?*)
            rest="${w#-}"; j=0
            while [[ $j -lt ${#rest} ]]; do
              ch="${rest:j:1}"
              case "$ch" in
                n) skip_reason="-n (--no-verify)" ;;
                m|F|C|c|t) [[ $((j+1)) -ge ${#rest} ]] && { shift || true; }; break ;;
                S|u) break ;;
              esac
              j=$((j+1))
            done ;;
        esac
      done ;;
    config)
      # Only a write counts: `git config [scope] core.hooksPath <value>` or `git config set ...`.
      local -a pos=(); local readonly=0
      for w in "$@"; do
        case "$w" in
          --get*|-l|--list|--unset*|--remove-section|--rename-section|-e|--edit) readonly=1 ;;
          -*) ;;
          *) pos[${#pos[@]}]="$w" ;;
        esac
      done
      case "${pos[0]:-}" in get|list|unset|remove-section|rename-section|edit) readonly=1 ;; set) pos=("${pos[@]:1}") ;; esac
      if [[ $readonly == 0 && ${#pos[@]} -ge 2 ]]; then hp_check "${pos[0]}"; fi ;;
    add|stage)
      local force=0 endopts=0
      local -a paths=()
      while [[ $# -gt 0 ]]; do
        w="$1"; shift
        if [[ $endopts == 0 ]]; then
          case "$w" in
            --) endopts=1; continue ;;
            --force) force=1; continue ;;
            --*) continue ;;
            -?*) [[ "$w" == *f* ]] && force=1; continue ;;
          esac
        fi
        paths[${#paths[@]}]="$w"
      done
      if [[ $force == 1 ]]; then
        for w in ${paths[@]+"${paths[@]}"}; do F_ENTRY[${#F_ENTRY[@]}]="$ctx$US$w"; done
      fi ;;
  esac
}

# wrapper_args <name>: " opt opt " list of the options that take a separate argument.
wrapper_args() {
  case "$1" in
    env) WARGS=" -u -C -S --unset --chdir --split-string " ;;
    sudo|doas) WARGS=" -u -g -C -h -p -D -r -t -U --user --group --host --prompt --chdir " ;;
    nice) WARGS=" -n --adjustment " ;;
    ionice) WARGS=" -c -n -p --class --classdata " ;;
    xargs) WARGS=" -I -n -P -L -s -d -E -a --max-args --max-procs --delimiter --arg-file " ;;
    timeout|gtimeout) WARGS=" -s -k --signal --kill-after " ;;
    stdbuf) WARGS=" -i -o -e " ;;
    *) WARGS=" " ;;
  esac
}

# analyze <text> <cwd>: walks each simple command. cd/pushd move the context (each target is a
# candidate), `)` and popd restore it, GIT_DIR/GIT_WORK_TREE assignments add a candidate, and
# sh/bash -c, eval, $(...) and `...` bodies are queued for the same walk.
analyze() {
  local cur="$2" k nw w b x j wn seg_gd seg_wt pstack="" dstack=""
  local -a words=() toks=()
  tokenize "$(strip_heredocs "${1//\\$NL/}")"
  toks=(${TOK[@]+"${TOK[@]}"})
  for x in ${SUBS[@]+"${SUBS[@]}"}; do Q_CMD[${#Q_CMD[@]}]="$x"; Q_DIR[${#Q_DIR[@]}]="$cur"; done
  toks[${#toks[@]}]="$US;"
  for w in "${toks[@]}"; do
    if [[ "$w" != "$US"* ]]; then
      words[${#words[@]}]="$w"
      [[ "$w" == commit ]] && commit_word=1
      continue
    fi
    nw=${#words[@]}; k=0; seg_gd=""; seg_wt=""
    # Skip assignments and wrappers (env, sudo, timeout, nice, ...) and their options.
    while [[ $k -lt $nw ]]; do
      x="${words[k]}"
      case "$x" in
        GIT_DIR=*) seg_gd="${x#GIT_DIR=}"; k=$((k+1)); continue ;;
        GIT_WORK_TREE=*) seg_wt="${x#GIT_WORK_TREE=}"; k=$((k+1)); continue ;;
        [A-Za-z_]*=*) hp_check "$x"; k=$((k+1)); continue ;;
      esac
      wn="${x##*/}"
      case "$wn" in
        env|command|builtin|exec|nohup|time|sudo|doas|nice|ionice|xargs|timeout|gtimeout|stdbuf|caffeinate|then|do|else|elif|if|while|until|"{"|"}"|"!") ;;
        *) break ;;
      esac
      wrapper_args "$wn"; k=$((k+1))
      while [[ $k -lt $nw && "${words[k]}" == -?* ]]; do
        [[ "${words[k]}" == -- ]] && { k=$((k+1)); break; }
        case "$WARGS" in *" ${words[k]} "*) k=$((k+2)) ;; *) k=$((k+1)) ;; esac
      done
      if [[ "$wn" == timeout || "$wn" == gtimeout ]]; then k=$((k+1)); fi   # the duration
    done
    if [[ -n "$seg_gd$seg_wt" ]]; then
      [[ -n "$seg_gd" ]] && seg_gd="$(join_dir "$cur" "$seg_gd")"
      [[ -n "$seg_wt" ]] && seg_wt="$(join_dir "$cur" "$seg_wt")"
      add_cand "$cur" "$seg_gd" "$seg_wt"
    fi
    if [[ $k -lt $nw ]]; then
      b="${words[k]##*/}"
      case "$b" in
        git) analyze_git "$cur" "$seg_gd" "$seg_wt" "${words[@]:k+1}" ;;
        cd|pushd)
          x=""
          for ((j = k + 1; j < nw; j++)); do case "${words[j]}" in -*) ;; *) x="${words[j]}"; break ;; esac; done
          [[ "$b" == pushd ]] && dstack="$cur$US$dstack"
          if [[ -z "$x" ]]; then cur="${HOME:-$cur}"; else cur="$(join_dir "$cur" "$x")"; fi
          add_cand "$cur" ;;
        popd) if [[ -n "$dstack" ]]; then cur="${dstack%%"$US"*}"; dstack="${dstack#*"$US"}"; fi ;;
        sh|bash|zsh|dash|ksh)
          for ((j = k + 1; j < nw - 1; j++)); do
            case "${words[j]}" in -*c*) Q_CMD[${#Q_CMD[@]}]="${words[j+1]}"; Q_DIR[${#Q_DIR[@]}]="$cur"; break ;; esac
          done ;;
        export)
          for x in "${words[@]:k+1}"; do
            case "$x" in
              GIT_DIR=*) add_cand "$cur" "$(join_dir "$cur" "${x#GIT_DIR=}")" ;;
              GIT_WORK_TREE=*) add_cand "$(join_dir "$cur" "${x#GIT_WORK_TREE=}")" ;;
              *) hp_check "$x" ;;
            esac
          done ;;
        eval) Q_CMD[${#Q_CMD[@]}]="${words[*]:k+1}"; Q_DIR[${#Q_DIR[@]}]="$cur" ;;
      esac
    fi
    words=()
    # A subshell's cd does not outlive it.
    case "$w" in
      "$US(") pstack="$cur$US$pstack" ;;
      "$US)") if [[ -n "$pstack" ]]; then cur="${pstack%%"$US"*}"; pstack="${pstack#*"$US"}"; fi ;;
    esac
  done
}

add_cand "$base"   # the session's cwd is always a candidate
Q_CMD[0]="$cmd"; Q_DIR[0]="$base"; qi=0
while [[ $qi -lt ${#Q_CMD[@]} && $qi -lt 32 ]]; do
  analyze "${Q_CMD[qi]}" "${Q_DIR[qi]}"
  qi=$((qi+1))
done

# Backstop that does not depend on the parser: the raw text holds the word commit and a
# hook-skipping flag or a core.hooksPath setting. It can over-block a command that only
# mentions them; that is the accepted cost.
shopt -s nocasematch
bs_commit='(^|[^[:alnum:]_.-])commit([^[:alnum:]_-]|$)'
bs_skip='--no-veri|core\.hookspath=|-c[[:space:]]+core\.hookspath|--config-env[=[:space:]]+core\.hookspath|GIT_CONFIG_(KEY|VALUE)_[0-9]+=[^[:space:]]*core\.hookspath|GIT_CONFIG_PARAMETERS=[^[:space:]]*core\.hookspath'
if [[ "$cmd" =~ $bs_commit && "$cmd" =~ $bs_skip ]]; then
  skip_reason="${skip_reason:-the command text holds --no-verify or a core.hooksPath setting}"
  commit_word=1
fi
shopt -u nocasematch

# No commit found and the word commit never appears: not a commit. When the word appears but
# the parser found no commit invocation, fall through and scan anyway (fail safe).
[[ $commit_seen == 1 || $commit_word == 1 ]] || exit 0

if [[ -n "$skip_reason" ]]; then
  echo "secret-guard: commit blocked: git hooks may not be skipped ($skip_reason). Commit without it; if a hook then blocks the commit, fix what it reports." >&2
  exit 2
fi

# Check each candidate repo once. A repo whose effective pre-commit hook is ours is left to
# that hook: it sees the exact commit, including `git add` and `-a` in this call.
seen="$US"
for ((ci = 0; ci < ${#C_DIR[@]}; ci++)); do
  dir="${C_DIR[ci]}"; gd="${C_GITDIR[ci]}"; wt="${C_WT[ci]}"
  [[ -n "$wt" ]] && dir="$wt"
  [[ -d "$dir" ]] || continue
  (
    [[ -n "$gd" ]] && export GIT_DIR="$gd"
    [[ -n "$wt" ]] && export GIT_WORK_TREE="$wt"
    cd "$dir" || exit 0
    top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
    case "$seen" in *"$US$top$US"*) exit 0 ;; esac
    printf '%s\n' "$top" >> "$TMPD/seen"
    state="$(hooks_state "$top")"
    if [[ "${state%%$'\t'*}" == ours && -x "$top/.claude/hooks/secret-guard.sh" ]]; then exit 0; fi
    cd "$top" || exit 0
    forced=()
    for e in ${F_ENTRY[@]+"${F_ENTRY[@]}"}; do
      t="$(git -C "${e%%"$US"*}" rev-parse --show-toplevel 2>/dev/null)" || continue
      [[ "$t" == "$top" ]] && forced[${#forced[@]}]="$e"
    done
    check_repo wide ${forced[@]+"${forced[@]}"}
    if [[ -n "$problems" ]]; then
      printf '  %s: no secret-guard git pre-commit hook here (%s), so this checked staged and unstaged changes, untracked files and git add -f targets\n%s' \
        "$top" "${state%%$'\t'*}" "$problems" >> "$TMPD/problems"
    fi
  )
  [[ -f "$TMPD/seen" ]] && while IFS= read -r l; do seen="$seen$l$US"; done < "$TMPD/seen"
done
if [[ -s "$TMPD/problems" ]]; then
  problems="$(cat "$TMPD/problems")"$'\n'
  report_and_exit 2
fi
exit 0
