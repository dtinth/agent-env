# mise, in shims mode.
#
# Shims on PATH are the whole mechanism: they resolve the right tool version per
# directory *and* apply that directory's mise.toml [env] to the process they
# start. That works everywhere, including the cases where a shell prompt never
# appears -- daemons, `ssh host <command>`, IDEs, anything the agent shells out
# to -- which is why there is no chpwd hook anywhere in this image.
# Installs go into the home volume. The image's own node and dufs are shared
# installs in /opt/mise, with their shims on PATH behind the user's.
export MISE_DATA_DIR="${MISE_DATA_DIR:-${HOME}/.local/share/mise}"
export MISE_SHARED_INSTALL_DIRS="${MISE_SHARED_INSTALL_DIRS:-/opt/mise/installs}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-/opt/mise/state}"
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-/opt/mise/cache}"
# The image declares its own toolchain in /etc/mise/config.toml, which mise
# reads as system config regardless of this. This is where *your* `mise use -g`
# declarations go, and it is on the persisted home volume.
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-${HOME}/.config/mise}"
for _mise_shims in /opt/mise/shims "${MISE_DATA_DIR}/shims"; do
  case ":${PATH}:" in
    *":${_mise_shims}:"*) ;;
    *) export PATH="${_mise_shims}:${PATH}" ;;
  esac
done
unset _mise_shims

# Interactive shells get the same shims entry from mise itself. That file is the
# one thing a non-login interactive shell reads -- it never sees profile.d -- and
# /etc/bash.bashrc sources it for exactly that reason. Both run before ~/.bashrc,
# so neither survives a dotfile that assigns PATH rather than prepending to it,
# which is the dotfile's prerogative.
[ -r /etc/agent-env/mise-activate.sh ] && . /etc/agent-env/mise-activate.sh
