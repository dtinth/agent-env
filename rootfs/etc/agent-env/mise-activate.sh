# Full mise activation, for interactive bash only.
#
# Shims (see /etc/profile.d/10-mise.sh) resolve tool versions everywhere, but
# they cannot supply a project's mise.toml [env] vars or run the cd/enter hooks.
# Those matter when a person — or an agent — is working in a repo, so activate
# properly where there is a prompt to hook.
#
# Sourced from two places, because bash reads different files depending on how
# it started: /etc/bash.bashrc for interactive non-login shells (desktop
# terminals, `docker exec -it`), and /etc/profile.d for login shells (ssh).
# The MISE_SHELL guard makes the second one a no-op.

case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac
[ -n "${BASH_VERSION:-}" ] || return 0
[ -z "${MISE_SHELL:-}" ] || return 0
command -v mise >/dev/null 2>&1 || return 0

eval "$(mise activate bash)"
