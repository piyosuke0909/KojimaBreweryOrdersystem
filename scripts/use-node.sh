#!/usr/bin/env bash
# Source this file before running project commands in the cloud environment.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'Run: source scripts/use-node.sh' >&2
  exit 1
fi
kojima_node_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
kojima_node_version="$(tr -d '[:space:]' < "$kojima_node_root/.node-version")"
kojima_node_bin="$kojima_node_root/.local/tools/node-v$kojima_node_version-linux-x64/bin"
if [[ ! -x "$kojima_node_bin/node" ]]; then
  printf '%s\n' 'Install the pinned runtime first: node --use-env-proxy scripts/setup-node.mjs' >&2
  unset kojima_node_root kojima_node_version kojima_node_bin
  return 1
fi
export PATH="$kojima_node_bin:$PATH"
hash -r
unset kojima_node_root kojima_node_version kojima_node_bin
