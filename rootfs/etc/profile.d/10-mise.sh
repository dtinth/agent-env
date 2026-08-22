# mise, in two halves.
#
# Shims on PATH cover the cases where a shell prompt never appears: daemons,
# `ssh host <command>`, IDEs, anything the agent shells out to. They resolve the
# right tool version per directory, which is all most things need.
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-/opt/mise/state}"
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-/opt/mise/cache}"
# The image declares its own toolchain in /etc/mise/config.toml, which mise
# reads as system config regardless of this. This is where *your* `mise use -g`
# declarations go, and it is on the persisted home volume.
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-${HOME}/.config/mise}"
case ":${PATH}:" in
  *":${MISE_DATA_DIR}/shims:"*) ;;
  *) export PATH="${MISE_DATA_DIR}/shims:${PATH}" ;;
esac

# Interactive login shells additionally get the real activation. Non-login
# interactive shells pick the same file up from /etc/bash.bashrc.
[ -r /etc/agent-env/mise-activate.sh ] && . /etc/agent-env/mise-activate.sh
