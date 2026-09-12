# mise, in shims mode.
#
# The shims directory is already on PATH from /etc/profile.d/10-mise.sh and
# from /etc/environment, so for most shells this is a no-op. It exists for the
# interactive non-login shell -- a desktop terminal, `docker exec -it` -- which
# reads /etc/bash.bashrc and never reads profile.d at all.
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

# Bash reads this file *before* ~/.bashrc, so the line above cannot outlast a
# dotfile that assigns PATH outright rather than prepending to it -- and in
# shims mode nothing else would ever put the shims back. `node` then silently
# resolves to Debian's, not the version the lockfile pins. The old chpwd hook
# happened to cover this, because it recomputed the environment on the next
# `cd`; losing that quietly is worse than the small cost of a guard.
#
# This is not mise's hook by another name: it re-asserts one PATH entry if it
# has gone missing and touches nothing else, so MISE_SHELL stays unset and
# tool resolution still happens entirely in the shim. It rides PROMPT_COMMAND,
# so it covers the prompt-driven session a person actually types into, not
# `bash -ic` -- which never displays a prompt, and which the old hook did not
# cover either.
_mise_shims_guard() {
  case ":${PATH}:" in
    *":${MISE_DATA_DIR:-/opt/mise}/shims:"*) ;;
    *) PATH="${MISE_DATA_DIR:-/opt/mise}/shims:${PATH}" ;;
  esac
}
case ";${PROMPT_COMMAND:-};" in
  *";_mise_shims_guard;"*) ;;
  *) PROMPT_COMMAND="_mise_shims_guard${PROMPT_COMMAND:+;${PROMPT_COMMAND}}" ;;
esac
