#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script start (modo visual)"

# ====== Config por defecto ======
HEADLESS="${HEADLESS:-false}"              # SIEMPRE false por defecto
DISPLAY="${DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6081}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"
ENABLE_SSH="${ENABLE_SSH:-true}"
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
# Playwright: asegurar navegador instalado + alias
# ======================================================
playwright_ensure() {
  echo "🔎 Verificando navegadores Playwright…"
  local BASE="${PLAYWRIGHT_BROWSERS_PATH}"

  local FOUND_DIR
  FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"

  if [ -z "${FOUND_DIR}" ]; then
    echo "ℹ️ Instalando Chromium para Playwright…"
    local PW_VER
    PW_VER="$(node -p "require('playwright-core/package.json').version")"
    npx --yes "playwright@${PW_VER}" install --with-deps chromium
    FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"
  fi

  if [ -z "${FOUND_DIR}" ]; then
    echo "❌ No pude detectar ni instalar Chromium"
    exit 1
  fi

  echo "✅ Chromium detectado: ${FOUND_DIR}"

  local EXE="${FOUND_DIR}/chrome-linux/chrome"
  if [ ! -x "${EXE}" ]; then
    echo "❌ Ejecutable no encontrado: ${EXE}"
    exit 1
  fi
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

# ====== VNC + noVNC (porque siempre HEADLESS=false para pruebas) ======
start_vnc_stack() {
  echo "🖥️  Iniciando servidor gráfico Xvfb en ${DISPLAY}"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION}" -ac >/tmp/xvfb.log 2>&1 &
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
  wait_for_port "${NOVNC_PORT}" || echo "⚠️  noVNC tardó demasiado"
  echo "✅ VNC listo — Web: ${NOVNC_PORT}, VNC: 5901"
}

# ====== Lanzamiento infraestructura ======
start_ssh

export DISPLAY
start_vnc_stack

playwright_ensure

# ====== Lanzamiento de tu app (Playwright headed) ======
echo "🚀 Lanzando app Node wa_export_last30_playwright.js (modo visible)…"

# 👉 Playwright se lanza visible
export PW_HEADLESS="false"

node -e "try{console.log('ℹ️ playwright-core version:', require('playwright-core/package.json').version)}catch(e){console.log('ℹ️ playwright-core no instalado')}"
node /app/app.js || echo "⚠️ Node salió con error"

# ====== Mantener contenedor activo ======
echo "🌀 Contenedor activo — Debug visual habilitado (VNC/novnc)."
tail -f /dev/null
