# mise, in shims mode.
#
# Shims on PATH are the whole mechanism: they resolve the right tool version per
# directory *and* apply that directory's mise.toml [env] to the process they
# start. That works everywhere, including the cases where a shell prompt never
# appears -- daemons, `ssh host <command>`, IDEs, anything the agent shells out
# to -- which is why there is no chpwd hook anywhere in this image.
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

# Interactive shells get the same shims entry from mise itself. That file is the
# one thing a non-login interactive shell reads -- it never sees profile.d -- and
# /etc/bash.bashrc sources it for exactly that reason. Both run before ~/.bashrc,
# so neither survives a dotfile that assigns PATH rather than prepending to it,
# which is the dotfile's prerogative.
[ -r /etc/agent-env/mise-activate.sh ] && . /etc/agent-env/mise-activate.sh
