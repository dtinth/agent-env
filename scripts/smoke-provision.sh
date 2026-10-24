#!/bin/bash
# A startup script for the smoke test (see the "default components" run in
# .github/workflows/docker.yml): makes a component in a folder of its own and
# installs it, the way a real one would clone a repository first. Safe to run
# again, as every startup script has to be.
set -euo pipefail

d="${HOME}/smoke-provisioned"
mkdir -p "${d}"
cat > "${d}/agent-env-component.toml" <<'TOML'
name = "smoke-provisioned"
title = "Provisioned by the smoke test"
TOML
cat > "${d}/pitchfork.toml" <<'TOML'
namespace = "agent-env-smoke-provisioned"

[daemons.web]
run = "exec python3 -m http.server 18766 --bind 127.0.0.1"
ready_port = 18766
retry = true
TOML

cd "${d}"
agent-env component install .
