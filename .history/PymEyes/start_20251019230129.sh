#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script start"

# ====== Configuración ======
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"

# Playwright (ruta de navegadores)
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

# ====== SSH ======
start_ssh() {
  echo "🧩 Iniciando servidor SSH..."
  service ssh start >/tmp/ssh.log 2>&1 || /usr/sbin/sshd || true
  sleep 1
  if pgrep -x sshd >/dev/null; then
    echo "✅ SSH activo en puerto 22 (usuarios: root / devuser)"
  else
    echo "⚠️ SSH no pudo iniciarse (revisar /tmp/ssh.log)"
  fi
}

# ====== VNC + noVNC ======
start_vnc_stack() {
  export DISPLAY=":99"
  echo "🖥️  Iniciando servidor gráfico Xvfb en ${DISPLAY} (${XVFB_RESOLUTION})"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
  sleep 1
  echo "🟟 Iniciando gestor de ventanas fluxbox"
  fluxbox >/tmp/fluxbox.log 2>&1 &
  if [[ -n "${VNC_PASSWORD}" ]]; then
    echo "${VNC_PASSWORD}" > /tmp/vncpass
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -passwdfile /tmp/vncpass ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  else
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -nopw ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  fi
  websockify --web=/usr/share/novnc 0.0.0.0:${NOVNC_PORT} localhost:5901 >/tmp/novnc.log 2>&1 &
  
  # --- MODIFICACIÓN AQUÍ ---
  # Se añade un bucle para esperar a que el puerto de noVNC esté realmente listo.
  echo "⏳ Esperando a que noVNC esté disponible en el puerto ${NOVNC_PORT}..."
  # (Se usa 'ss' que es más moderno que 'netstat'. El '-tln' lista puertos TCP que están escuchando)
  for i in {1..10}; do
    if ss -tln | grep -q ":${NOVNC_PORT}"; then
      echo "✅ Servicios listos — noVNC en :${NOVNC_PORT}, VNC en :5901"
      return # Sale de la función porque ya está listo
    fi
    sleep 0.5
  done
  
  echo "⚠️  noVNC no pudo iniciarse en el puerto ${NOVNC_PORT}. Revisa /tmp/novnc.log"
  # --- FIN DE LA MODIFICACIÓN ---
}

# ====== Lanzamiento ======
start_ssh
start_vnc_stack

# Lanzar app Node opcional (si existe)
if [[ -f /app/app.js ]]; then
  echo "🚀 Lanzando app Node con entorno gráfico..."
  export DISPLAY=":99"
  sleep 1
  echo "🎬 Ejecutando gpu_enabler.js en DISPLAY=${DISPLAY}"
  node /app/app.js || true
else
  echo "ℹ️  No se encontró /app/app.js — omitiendo ejecución Node."
fi

# ====== Mantener contenedor activo ======
echo "🌀 Contenedor activo — SSH (22), noVNC (${NOVNC_PORT}) y VNC (5901) disponibles."
tail -f /dev/null