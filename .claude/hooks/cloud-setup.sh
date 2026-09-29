#!/usr/bin/env bash
# SessionStart hook: installs tools a Claude Code on the web session lacks, from .claude/cloud-tools.
# No-op on local machines. Never fails the session when run directly. Synced from claude-dotfiles/repo-kit.
#
# Sourceable: install.sh (Ubuntu) sources this file to reuse install_tool for the tools below that
# need neither brew nor sudo. Sourcing only defines functions: it runs nothing, sets no shell
# option, and never exits the caller's shell. The guard at the bottom is bash-3.2 safe.

have() { command -v "$1" >/dev/null 2>&1; }

sha256_of() { # sha256_of <file>: portable across coreutils (sha256sum) and BSD/macOS (shasum)
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# gitleaks from its official GitHub release tarball into ~/.local/bin (no sudo), via a fresh
# temp dir, checksum-verified against the release's own checksums file. GITLEAKS_VERSION
# overrides the pinned version.
install_gitleaks() {
  local v="${GITLEAKS_VERSION:-8.30.1}" os arch tmp base name expected actual rc
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "gitleaks: unsupported OS" >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "gitleaks: unsupported CPU" >&2; return 1 ;; esac
  base="https://github.com/gitleaks/gitleaks/releases/download/v$v"
  name="gitleaks_${v}_${os}_${arch}.tar.gz"
  tmp="$(mktemp -d)" || return 1
  curl -fsSL "$base/$name" -o "$tmp/$name" || { rm -rf "$tmp"; return 1; }
  curl -fsSL "$base/gitleaks_${v}_checksums.txt" -o "$tmp/checksums.txt" || { rm -rf "$tmp"; return 1; }
  expected="$(awk -v f="$name" '$2==f{print $1; exit}' "$tmp/checksums.txt")"
  actual="$(sha256_of "$tmp/$name")"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "gitleaks: checksum mismatch for $name" >&2; rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/$name" -C "$tmp" --no-same-owner gitleaks \
    && mkdir -p "$HOME/.local/bin" && install -m 755 "$tmp/gitleaks" "$HOME/.local/bin/gitleaks"
  rc=$?; rm -rf "$tmp"; return $rc
}

# The Bitwarden Secrets Manager CLI from its official GitHub release zip into ~/.local/bin (no
# sudo), checksum-verified against the release's own checksums file. Never the official
# bws.bitwarden.com/install script: it uses sudo whenever one exists, silently, and does no
# integrity check. BWS_VERSION overrides the pinned version.
install_bws() {
  local v="${BWS_VERSION:-2.1.0}" os arch tmp base name expected actual rc
  case "$(uname -s)" in Linux) os=unknown-linux-gnu ;; Darwin) os=apple-darwin ;; *) echo "bws: unsupported OS" >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) echo "bws: unsupported CPU" >&2; return 1 ;; esac
  have unzip || { echo "bws: unzip is required" >&2; return 1; }
  base="https://github.com/bitwarden/sdk-sm/releases/download/bws-v$v"
  name="bws-${arch}-${os}-${v}.zip"
  tmp="$(mktemp -d)" || return 1
  curl -fsSL "$base/$name" -o "$tmp/$name" || { rm -rf "$tmp"; return 1; }
  curl -fsSL "$base/bws-sha256-checksums-${v}.txt" -o "$tmp/checksums.txt" || { rm -rf "$tmp"; return 1; }
  expected="$(awk -v f="$name" '$2==f{print $1; exit}' "$tmp/checksums.txt")"
  actual="$(sha256_of "$tmp/$name")"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "bws: checksum mismatch for $name" >&2; rm -rf "$tmp"; return 1; }
  unzip -oq "$tmp/$name" -d "$tmp" bws \
    && mkdir -p "$HOME/.local/bin" && install -m 755 "$tmp/bws" "$HOME/.local/bin/bws"
  rc=$?; rm -rf "$tmp"; return $rc
}

# Node.js from the official nodejs.org tarball into ~/.local/node (no sudo), checksum-verified
# against nodejs.org's own SHASUMS256.txt. NODE_MAJOR overrides the pinned LTS line (default: 24).
install_node() {
  local major="${NODE_MAJOR:-24}" os arch base tmp dist expected actual rc
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "node: unsupported OS" >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "node: unsupported CPU" >&2; return 1 ;; esac
  base="https://nodejs.org/dist/latest-v${major}.x"
  tmp="$(mktemp -d)" || return 1
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || { rm -rf "$tmp"; return 1; }
  dist="$(grep -oE "node-v[0-9.]+-${os}-${arch}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [[ -n "$dist" ]] || { echo "node: no $os/$arch build listed for the v$major line" >&2; rm -rf "$tmp"; return 1; }
  curl -fsSL "$base/$dist" -o "$tmp/$dist" || { rm -rf "$tmp"; return 1; }
  expected="$(awk -v f="$dist" '$2==f{print $1; exit}' "$tmp/SHASUMS256.txt")"
  actual="$(sha256_of "$tmp/$dist")"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "node: checksum mismatch for $dist" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$HOME/.local/node"; mkdir -p "$HOME/.local/node"
  tar -xzf "$tmp/$dist" -C "$HOME/.local/node" --no-same-owner --strip-components=1
  rc=$?; rm -rf "$tmp"; return $rc
}

# Go from the official go.dev tarball into ~/.local/go (no sudo), checksum-verified against
# go.dev's own JSON release listing. GO_VERSION pins an exact release (e.g. go1.25.0); default is
# the latest stable release. Needs jq, which install.sh's apt step guarantees on Ubuntu; a cloud
# sandbox without jq fails this one tool cleanly rather than mis-parsing the listing.
install_go() {
  local os arch tmp filename sha actual rc
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "go: unsupported OS" >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "go: unsupported CPU" >&2; return 1 ;; esac
  have jq || { echo "go: jq is required to resolve the release list from go.dev" >&2; return 1; }
  tmp="$(mktemp -d)" || return 1
  curl -fsSL "https://go.dev/dl/?mode=json" -o "$tmp/dl.json" || { rm -rf "$tmp"; return 1; }
  if [[ -n "${GO_VERSION:-}" ]]; then
    filename="$(jq -r --arg v "$GO_VERSION" --arg os "$os" --arg arch "$arch" \
      '[.[] | select(.version==$v) | .files[] | select(.os==$os and .arch==$arch and .kind=="archive")][0].filename // empty' "$tmp/dl.json")"
  else
    filename="$(jq -r --arg os "$os" --arg arch "$arch" \
      '[.[] | select(.stable==true) | .files[] | select(.os==$os and .arch==$arch and .kind=="archive")][0].filename // empty' "$tmp/dl.json")"
  fi
  [[ -n "$filename" ]] || { echo "go: no $os/$arch release found" >&2; rm -rf "$tmp"; return 1; }
  sha="$(jq -r --arg f "$filename" '[.[].files[] | select(.filename==$f)][0].sha256 // empty' "$tmp/dl.json")"
  curl -fsSL "https://go.dev/dl/$filename" -o "$tmp/$filename" || { rm -rf "$tmp"; return 1; }
  actual="$(sha256_of "$tmp/$filename")"
  [[ -n "$sha" && "$sha" == "$actual" ]] || { echo "go: checksum mismatch for $filename" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$HOME/.local/go"; mkdir -p "$HOME/.local"
  tar -xzf "$tmp/$filename" -C "$HOME/.local" --no-same-owner
  rc=$?; rm -rf "$tmp"; return $rc
}

# When the system npm's global prefix isn't writable (a root-owned system node, non-root user),
# point npm/corepack at ~/.local instead, so `npm install -g`/`corepack enable` don't fail with
# EACCES rather than silently trying and failing.
ensure_npm_prefix() {
  local prefix
  have npm || return 0
  prefix="$(npm prefix -g 2>/dev/null)" || return 0
  [[ -n "$prefix" && -w "$prefix" ]] && return 0
  mkdir -p "$HOME/.local/bin"
  export npm_config_prefix="$HOME/.local"
}

install_tool() {
  local f rc
  case "$1" in
    bws) have bws || install_bws ;;
    pnpm) have pnpm || { ensure_npm_prefix; corepack enable --install-directory "$HOME/.local/bin" pnpm || npm install -g pnpm; } ;;
    uv) have uvx || curl -LsSf https://astral.sh/uv/install.sh | sh ;;
    node) have node || install_node ;;
    go) have go || install_go ;;
    typescript-language-server) have typescript-language-server || { ensure_npm_prefix; npm install -g typescript-language-server typescript; } ;;
    dotnet) have dotnet || { f="$(mktemp)" && curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$f" && bash "$f" --channel 10.0; rc=$?; rm -f "$f"; return $rc; } ;;
    csharp-ls) have csharp-ls || dotnet tool install --global csharp-ls ;;
    gopls) have gopls || go install golang.org/x/tools/gopls@latest ;;
    gitleaks) have gitleaks || install_gitleaks ;;
    *) echo "cloud-setup: unknown tool '$1'" >&2; return 1 ;;
  esac
}

# Everything below runs only when this file is executed directly, never when install.sh (Ubuntu)
# sources it to reuse install_tool. [[ "${BASH_SOURCE[0]}" == "$0" ]] is true only when this file
# is the script bash was invoked on, and works on bash 3.2 too.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  [[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]] || exit 0

  claude_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  tools_file="$claude_dir/cloud-tools"

  # A cloud clone never ran install.sh, so let the repo's secret guard write its git pre-commit hook.
  repo_dir="${CLAUDE_PROJECT_DIR:-$(cd "$claude_dir/.." && pwd)}"
  if [[ -x "$repo_dir/.claude/hooks/secret-guard.sh" ]]; then
    "$repo_dir/.claude/hooks/secret-guard.sh" --install-git-hook "$repo_dir" </dev/null >&2 || echo "cloud-setup: could not install the git pre-commit hook" >&2
  fi

  [[ -f "$tools_file" ]] || exit 0

  export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.local/go/bin:$HOME/.bws/bin:$HOME/.dotnet:$HOME/.dotnet/tools:$HOME/go/bin:$PATH"

  failed=""
  while IFS= read -r tool || [[ -n "$tool" ]]; do
    tool="${tool%%#*}"; tool="$(echo "$tool" | tr -d '[:space:]')"
    [[ -z "$tool" ]] && continue
    # stdin from /dev/null: an installer that reads stdin would otherwise eat the rest of the list.
    install_tool "$tool" </dev/null >&2 || failed="$failed $tool"
  done < "$tools_file"

  if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
    echo "export PATH=\"$PATH\"" >> "$CLAUDE_ENV_FILE"
    # dotnet-install.sh puts the SDK in ~/.dotnet; tools like csharp-ls need DOTNET_ROOT to find it.
    [[ -x "$HOME/.dotnet/dotnet" ]] && echo "export DOTNET_ROOT=\"$HOME/.dotnet\"" >> "$CLAUDE_ENV_FILE"
  fi
  [[ -n "$failed" ]] && echo "cloud-setup: failed to install:$failed" >&2
  exit 0
fi
