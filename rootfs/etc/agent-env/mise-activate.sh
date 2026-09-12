# mise, in shims mode.
#
# The shims directory is already on PATH from /etc/profile.d/10-mise.sh and
# from /etc/environment, so for most shells this is a no-op. It exists for the
# one case those two miss: an interactive non-login shell whose PATH was
# rewritten by a dotfile. `mise activate bash --shims` re-asserts the shims
# directory at the front of PATH and nothing else.
#
# Shims rather than the hook is a deliberate choice. A shim resolves the tool
# version *and* applies the enclosing mise.toml's [env] to the process it
# starts, which is what makes a project's environment reach daemons, `ssh host
# <command>`, IDEs and everything an agent shells out to -- none of which ever
# display a prompt for a chpwd hook to attach to. The hook only ever covered
# interactive bash, so half this box ran without it.
#
# What shims do not do is export those vars into the shell itself, so they are
# not visible to `echo "$FOO"`, nor to a binary that is not mise-managed (an
# apt-installed psql reading DATABASE_URL, say). Run those through `mise x --`
# or `mise run` when a project's mise.toml is what defines their environment.
#
# Sourced from two places, because bash reads different files depending on how
# it started: /etc/bash.bashrc for interactive non-login shells (desktop
# terminals, `docker exec -it`), and /etc/profile.d for login shells (ssh).

case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac
[ -n "${BASH_VERSION:-}" ] || return 0
command -v mise >/dev/null 2>&1 || return 0

eval "$(mise activate bash --shims)"
