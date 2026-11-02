# Browser-terminal (ttyd) and mosh sessions are remote, but unlike SSH they
# leave SSH_CONNECTION unset. Tools that tell remote from local key off it --
# notably Claude Code's TUI, which copies selected text with the OSC 52 escape
# (that a browser terminal or mosh relays to your real clipboard) only when it
# sees a remote session; otherwise, because this image sets DISPLAY so GUI tools
# work, it copies to the container's own X clipboard, which you never see. Mark
# these sessions remote so that path is taken, while DISPLAY stays set. Real SSH
# already exports SSH_CONNECTION (left alone), and a local desktop terminal has
# neither ttyd nor mosh-server for an ancestor, so only ttyd/mosh get it.
if [ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ]; then
  __ae_pid=$$
  __ae_hop=0
  while [ "${__ae_pid:-0}" -gt 1 ] && [ "${__ae_hop}" -lt 12 ]; do
    __ae_comm=$(cat "/proc/${__ae_pid}/comm" 2>/dev/null) || break
    if [ "${__ae_comm}" = ttyd ] || [ "${__ae_comm}" = mosh-server ]; then
      SSH_CONNECTION="127.0.0.1 0 127.0.0.1 0"
      export SSH_CONNECTION
      break
    fi
    __ae_pid=$(awk '/^PPid:/{print $2}' "/proc/${__ae_pid}/status" 2>/dev/null)
    __ae_hop=$((__ae_hop + 1))
  done
  unset __ae_pid __ae_hop __ae_comm
fi
