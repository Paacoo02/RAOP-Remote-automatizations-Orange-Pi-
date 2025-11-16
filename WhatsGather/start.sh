#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script start (MODO PLAYWRIGHT TOTAL)"

# ====== Config por defecto ======
HEADLESS="${HEADLESS:-false}"
DISPLAY="${DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6081}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"
ENABLE_SSH="${ENABLE_SSH:-true}"
# ¡ESENCIAL! Playwright es nuestro motor
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

# ====== Helpers ======
wait_for_port() {
  local port="$1" tries="${2:-20}" sleep_s="${3:-0.5}"
  echo "⏳ Esperando a que el puerto ${port} quede disponible..."
  for _ in $(seq 1 "${tries}"); do
    if ss -tln | grep -q ":${port}"; then
      echo "✅ Puerto ${port} disponible"
      return 0
    fi
    sleep "${sleep_s}"
  done
  echo "⚠️  El puerto ${port} no abrió a tiempo"
  return 1
}

# ======================================================
# Playwright: asegurar navegador instalado
# ======================================================
playwright_ensure() {
  echo "🔎 Verificando e instalando navegadores Playwright (Chromium y Firefox)..."
  
  if ! npm list playwright-core >/dev/null 2>&1; then
    echo "Instalando playwright-core para gestionar navegadores..."
    npm install playwright-core
  fi
  
  local PW_VER
  PW_VER="$(node -p "require('playwright-core/package.json').version")"
  
  echo "Instalando dependencias y navegadores (chromium, firefox) para Playwright v${PW_VER}..."
  npx --yes "playwright@${PW_VER}" install --with-deps chromium firefox
  
  echo "✅ Comprobación de navegadores finalizada."
}

# ====== SSH ======
start_ssh() {
  if [[ "${ENABLE_SSH}" != "true" ]]; then
    echo "🔒 SSH deshabilitado"
    return
  fi
  echo "🧩 Iniciando servidor SSH..."
  if [ -f /app/clear_ssh_host.sh ]; then /app/clear_ssh_host.sh || true; fi
  service ssh start || /usr/sbin/sshd || true
  sleep 1
  echo "✅ SSH activo en puerto 22"
}

# ======================================================
# VNC + noVNC (Porque quieres verlo)
# ▼▼▼ SECCIÓN MODIFICADA (CON REINICIO AUTOMÁTICO) ▼▼▼
# ======================================================
start_vnc_stack() {
  echo "🖥️  Iniciando servidor gráfico Xvfb en ${DISPLAY}"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION}" -ac >/tmp/xvfb.log 2>&1 &
  sleep 1

  echo "🟟 Iniciando gestor de ventanas fluxbox"
  fluxbox >/tmp/fluxbox.log 2>&1 &

  # --- Bucle de reinicio para el servidor VNC (x11vnc) ---
  (
    while true; do
      echo "🔄 Iniciando servidor VNC (x11vnc)..."
      if [[ -n "${VNC_PASSWORD}" ]]; then
        echo "${VNC_PASSWORD}" > /tmp/vncpass
        x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -passwdfile /tmp/vncpass ${X11VNC_EXTRA}
      else
        x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -nopw ${X11VNC_EXTRA}
      fi
      echo "⚠️  x11vnc ha caído. Reiniciando en 2s..."
      sleep 2
    done
  ) >/tmp/x11vnc.log 2>&1 & # Redirige todo el log del bucle

  # --- Bucle de reinicio para el puente noVNC (websockify) ---
  (
    while true; do
      echo "🔄 Iniciando puente noVNC (websockify)..."
      websockify --web=/usr/share/novnc 0.0.0.0:${NOVNC_PORT} localhost:5901
      echo "⚠️  websockify ha caído. Reiniciando en 2s..."
      sleep 2
    done
  ) >/tmp/novnc.log 2>&1 & # Redirige todo el log del bucle

  wait_for_port "${NOVNC_PORT}" || echo "⚠️  noVNC tardó demasiado"
  echo "✅ VNC listo — Web: ${NOVNC_PORT}, VNC: 5901"
}
#
# ▲▲▲ FIN DE LA SECCIÓN MODIFICADA ▲▲▲
#

# ====== Lanzamiento infraestructura ======
start_ssh

# Exportamos la variable DISPLAY para que Playwright sepa dónde abrir
export DISPLAY
start_vnc_stack

# ¡Verificamos que Playwright esté listo!
playwright_ensure

# ====== Lanzamiento de tu app (El Menú) ======
echo "🚀 Lanzando Menú Interactivo (node /app/menu.js)..."
node /app/menu.js || echo "⚠️ Node salió con error"

# ====== Mantener contenedor activo ======
echo "🌀 Contenedor activo — Debug visual habilitado (VNC/novnc)."
echo "Si el menú se cierra, el contenedor seguirá vivo."
tail -f /dev/null