#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
target=${MENU_ORACLE_HOST:?Set MENU_ORACLE_HOST}
args=(-o BatchMode=yes -o ConnectTimeout=12)
if [[ -n ${MENU_ORACLE_IDENTITY:-} ]]; then args+=(-i "$MENU_ORACLE_IDENTITY"); fi
repo_url=${MENU_SOURCE_REPOSITORY:-https://github.com/lisenhuang/menu-lens-rails}
case "$repo_url" in
  https://github.com/lisenhuang/menu-lens-rails|https://github.com/lisenhuang/menu-lens/tree/rewrite/rails-hotwire) ;;
  *) echo "Invalid source repository" >&2; exit 1 ;;
esac
release=$(ssh "${args[@]}" "$target" 'umask 077; mkdir -p "$HOME/apps/menu-lens/releases"; mktemp -d "$HOME/apps/menu-lens/releases/rails.XXXXXX"')
[[ "$release" =~ ^/home/[a-zA-Z0-9_-]+/apps/menu-lens/releases/rails\.[a-zA-Z0-9]+$ ]]
# Only tracked application sources are sent. Private environment, database and reader material live outside Git.
git archive --format=tar.gz HEAD -- Dockerfile .dockerignore Gemfile Gemfile.lock config.ru config db bin app public |
  ssh "${args[@]}" "$target" "tar -xzf - -C '$release' && bash '$release/bin/deploy_oracle' '$release' '$repo_url'"
