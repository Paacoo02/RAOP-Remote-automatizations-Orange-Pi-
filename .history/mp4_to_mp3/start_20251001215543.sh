#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script start"

TS_STATE_FILE="${TS_STATE_FILE:-/var/lib/tailscale/tailscaled.state}"
TS_HOSTNAME="${TS_HOSTNAME:-render-$(hostname)}"
EXIT_NODE="${EXIT_NODE:-}"
TS_AUTHKEY="${TS_AUTHKEY:-}"
TS_ACCEPT_DNS="${TS_ACCEPT_DNS:-false}"            # si quieres DNS del exit-node, ponlo a true
TS_SOCKS_ADDR="${TS_SOCKS_ADDR:-127.0.0.1:1055}"   # proxy local SOLO en userspace
TS_FORCE_USERSPACE="${TS_FORCE_USERSPACE:-0}"

HEADLESS="${HEADLESS:-true}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"

mkdir -p "$(dirname "$TS_STATE_FILE")"

start_vnc_stack() {
  export DISPLAY=":99"
  echo "🖥️  Xvfb on ${DISPLAY} (${XVFB_RESOLUTION})"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
  sleep 0.5
  echo "🪟 fluxbox started"
  fluxbox >/tmp/fluxbox.log 2>&1 &
  if [[ -n "${VNC_PASSWORD}" ]]; then
    echo "${VNC_PASSWORD}" > /tmp/vncpass
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -passwdfile /tmp/vncpass ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  else
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -nopw ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  fi
  websockify --web=/usr/share/novnc 0.0.0.0:${NOVNC_PORT} localhost:5901 >/tmp/novnc.log 2>&1 &
  echo "✅ Servicios listos. API en :10000, noVNC en :${NOVNC_PORT}"
}

wait_tailscaled_or_dump() {
  for i in {1..40}; do
    if /usr/local/bin/tailscale version >/dev/null 2>&1; then return 0; fi
    if ! pgrep -x tailscaled >/dev/null; then
      echo "❌ tailscaled se ha caído. Log:"
      sed -n '1,200p' /tmp/tailscaled.log || true
      return 1
    fi
    sleep 0.5
  done
  echo "❌ tailscaled no está listo. Log:"
  sed -n '1,200p' /tmp/tailscaled.log || true
  return 1
}

start_tailscale_kernel() {
  echo "🔐 Iniciando tailscaled (kernel TUN)…"
  if [[ ! -e /dev/net/tun ]]; then
    echo "⚠️  /dev/net/tun no existe (falta --device /dev/net/tun o --privileged)."
    return 1
  fi

  /usr/local/bin/tailscaled --state="${TS_STATE_FILE}" --verbose=1 >/tmp/tailscaled.log 2>&1 &
  if ! wait_tailscaled_or_dump; then return 1; fi

  /usr/local/bin/tailscale up \
    --reset \
    ${TS_AUTHKEY:+--auth-key="${TS_AUTHKEY}"} \
    --hostname="${TS_HOSTNAME}" \
    --accept-routes=true \
    --accept-dns="${TS_ACCEPT_DNS}" \
    ${EXIT_NODE:+--exit-node="${EXIT_NODE}"} \
    --exit-node-allow-lan-access=false

  /usr/local/bin/tailscale status || true
  return 0
}

start_tailscale_userspace() {
  echo "🕶️  Userspace + SOCKS ${TS_SOCKS_ADDR}…"
  /usr/local/bin/tailscaled \
    --state="${TS_STATE_FILE}" \
    --tun=userspace-networking \
    --socks5-server="${TS_SOCKS_ADDR}" \
    >/tmp/tailscaled.log 2>&1 &
  if ! wait_tailscaled_or_dump; then return 1; fi

  echo "⏳ Configurando tailscale con exit-node=${EXIT_NODE}..."
  READY=0
  for i in {1..10}; do
    if /usr/local/bin/tailscale up \
        --reset \
        ${TS_AUTHKEY:+--auth-key="${TS_AUTHKEY}"} \
        --hostname="${TS_HOSTNAME}" \
        --accept-routes=true \
        --accept-dns=false \
        ${EXIT_NODE:+--exit-node="${EXIT_NODE}"} \
        --exit-node-allow-lan-access=false; then
      READY=1
      break
    fi
    echo "   (intento $i falló, reintentando en 2s)"
    sleep 2
  done

  if [[ $READY -eq 0 ]]; then
    echo "⚠️  No se pudo aplicar exit-node tras varios intentos"
  fi

  /usr/local/bin/tailscale status || true

  # 🔎 Comprobación TSMP no bloqueante
  if [[ -n "${EXIT_NODE}" ]]; then
    echo "🔎 Comprobando exit-node (${EXIT_NODE}) por TSMP (no bloqueante)…"
    /usr/local/bin/tailscale ping --tsmp --timeout=3s --c=1 "${EXIT_NODE}" >/tmp/ts_ping.log 2>&1 \
      && echo "✔ Exit-node reachable por TSMP." \
      || { echo "⚠️  TSMP al exit-node no respondió (continúo)"; sed -n '1,40p' /tmp/ts_ping.log || true; }
  fi

  echo "🌍 Esperando SOCKS…"
  for i in {1..60}; do
    if curl -sS --max-time 5 --socks5-hostname "${TS_SOCKS_ADDR}" https://ifconfig.me >/dev/null; then
      echo "✅ SOCKS OK (salida a Internet confirmada)"
      break
    fi
    sleep 1
  done || true

  return 0
}

diagnose_connectivity_kernel() {
  echo "🔎 Diagnóstico (kernel/TUN) con exit-node ${EXIT_NODE}"
  set +e
  /usr/local/bin/tailscale ping --tsmp --timeout=8s --c=3 "${EXIT_NODE}" ; P1=$?
  curl -sS --max-time 6 http://1.1.1.1/cdn-cgi/trace | head -n1 >/dev/null ; P2=$?
  EXT_IP="$(curl -sS --max-time 8 https://ifconfig.me)"; P3=$?
  set -e
  [[ $P1 -eq 0 ]] && echo "✔ TSMP ping OK" || echo "✖ TSMP ping FALLÓ"
  [[ $P2 -eq 0 ]] && echo "✔ HTTP a 1.1.1.1 OK" || echo "✖ HTTP a 1.1.1.1 FALLÓ"
  [[ $P3 -eq 0 && -n "${EXT_IP}" ]] && echo "✔ ifconfig.me → ${EXT_IP}" || echo "✖ ifconfig.me FALLÓ"
}

# === Arranque ===
BOOT_MODE="kernel"
if [[ -z "${TS_AUTHKEY}" ]]; then
  echo "ℹ️  TS_AUTHKEY no definido → no se inicia Tailscale."
  export USE_PROXY="0"
else
  unset ALL_PROXY HTTP_PROXY HTTPS_PROXY

  if [[ "${TS_FORCE_USERSPACE}" == "1" ]]; then
    echo "⏩ Forzando userspace por TS_FORCE_USERSPACE=1"
    BOOT_MODE="userspace"
    start_tailscale_userspace || true
    export USE_PROXY="1"
  else
    if start_tailscale_kernel; then
      export USE_PROXY="0"
    else
      echo "↩️  Kernel/TUN falló → userspace"
      BOOT_MODE="userspace"
      start_tailscale_userspace || true
      export USE_PROXY="1"
    fi
  fi
fi

if [[ "${HEADLESS}" == "false" ]]; then
  start_vnc_stack
else
  unset DISPLAY || true
fi

if [[ "${BOOT_MODE}" == "kernel" && -n "${EXIT_NODE}" ]]; then
  diagnose_connectivity_kernel
fi

echo "🚀 Lanzando app Node…"
exec node /app/app.js
