# mise shims are on PATH for every shell (login, non-login, ssh, ttyd).
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-/etc/mise}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-/opt/mise/state}"
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-/opt/mise/cache}"
case ":${PATH}:" in
  *":${MISE_DATA_DIR}/shims:"*) ;;
  *) export PATH="${MISE_DATA_DIR}/shims:${PATH}" ;;
esac
