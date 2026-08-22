# mise shims are on PATH for every shell (login, non-login, ssh, ttyd).
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
# The image declares its own toolchain in /etc/mise/config.toml, which mise
# reads as system config regardless of this. This is where *your* `mise use -g`
# declarations go, and it is on the persisted home volume.
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-${HOME}/.config/mise}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-/opt/mise/state}"
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-/opt/mise/cache}"
case ":${PATH}:" in
  *":${MISE_DATA_DIR}/shims:"*) ;;
  *) export PATH="${MISE_DATA_DIR}/shims:${PATH}" ;;
esac
