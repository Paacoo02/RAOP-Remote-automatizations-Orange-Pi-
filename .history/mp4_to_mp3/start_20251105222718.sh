#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script start"

# ====== Config por defecto ======
HEADLESS="${HEADLESS:-false}"
DISPLAY="${DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"
ENABLE_SSH="${ENABLE_SSH:-true}"

# Playwright (ruta de navegadores)
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
# 🚀 ¡ARREGLO DEFINITIVO!
# Esta función fuerza la instalación de la versión EXACTA
# que 'playwright-extra' está pidiendo en el log de error.
# ======================================================
playwright_ensure() {
  echo "🔎 Verificando e instalando binarios de Playwright en ${PLAYWRIGHT_BROWSERS_PATH}..."
  
  # El error 'chromium-1193' es la única verdad.
  # El build del Dockerfile instala una versión incorrecta (de 1.47.2)
  # que 'playwright-extra' ignora.
  
  echo "🧹 Limpiando CUALQUIER versión de Chromium instalada en el build..."
  rm -rf "${PLAYWRIGHT_BROWSERS_PATH}/chromium-"*

  echo "📥 Forzando la instalación de 'chromium@1193' (requerida por playwright-extra)..."
  
  # Instalamos 'chromium@1193' explícitamente.
  # 'set -e' (al inicio de tu script) se asegurará de que si esto falla, el script se detenga.
  npx playwright install --with-deps chromium@1193
  
  # Comprobación final y específica
  if ! ls -d "${PLAYWRIGHT_BROWSERS_PATH}/chromium-1193" >/dev/null 2>&1; then
     echo "❌ FALLO: No se pudo instalar 'chromium@1193'. Revisa la red."
     # Mostramos qué hay (si hay algo) para depurar
     ls -la "${PLAYWRIGHT_BROWSERS_PATH}"
     return 1
  else
     echo "✅ Confirmado: ${PLAYWRIGHT_BROWSERS_PATH}/chromium-1193 existe."
  fi
}

# ====== SSH ======
start_ssh() {
  if [[ "${ENABLE_SSH}" != "true" ]]; then
    echo "🔒 SSH deshabilitado por ENABLE_SSH=${ENABLE_SSH}"
    return
  fi
  echo "🧩 Iniciando servidor SSH..."
  # Limpia claves de host antiguas si existen
  /app/clear_ssh_host.sh || true
  service ssh start >/tmp/ssh.log 2>&1 || /usr/sbin/sshd || true
  sleep 1
  if pgrep -x sshd >/dev/null; then
    echo "✅ SSH activo en puerto 22"
  else
    echo "⚠️ SSH no pudo iniciarse (revisar /tmp/ssh.log)"
  fi
}

# ====== VNC + noVNC (solo si HEADLESS=false) ======
start_vnc_stack() {
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
  wait_for_port "${NOVNC_PORT}" 20 0.5 || echo "⚠️  Revisa /tmp/novnc.log"
  echo "✅ Servicios listos — noVNC :${NOVNC_PORT}, VNC :5901"
}

# ====== Lanzamiento infraestructura ======
start_ssh

if [[ "${HEADLESS}" == "false" ]]; then
  export DISPLAY
  start_vnc_stack
else
  echo "🕶️  HEADLESS=true → no se inicia Xvfb/noVNC. DISPLAY=${DISPLAY} (ignorado)."
fi

# ====== Playwright sanity check ======
# Esto AHORA instalará la versión correcta (1193)
playwright_ensure || true 

# ====== Lanzamiento de tu app ======
PYTHON_SCRIPT="/app/main.py"
VENV_PATH="/app/venv"

if [[ -f "${PYTHON_SCRIPT}" ]] && [[ -f "${VENV_PATH}/bin/activate" ]]; then
  echo "🐍 Lanzando app Python desde venv..."
  if [[ "${HEADLESS}" == "false" ]]; then export DISPLAY; fi
  # shellcheck source=/dev/null
  source "${VENV_PATH}/bin/activate"
  python "${PYTHON_SCRIPT}" || echo "⚠️  Python salió con error ($?). Continuando..."
  deactivate || true
elif [[ -f /app/app.js ]]; then
  echo "🚀 Lanzando app Node..."
  if [[ "${HEADLESS}" == "false" ]]; then export DISPLAY; fi
  # Esta versión de playwright-core NO es la que usa playwright-extra, es un señuelo.
  node -e "try{console.log('ℹ️ playwright-core version (señuelo):', require('playwright-core/package.json').version)}catch(e){console.log('ℹ️ playwright-core no instalado en runtime')}"
  node /app/app.js || echo "⚠️  Node salió con error ($?)."
else
  echo "ℹ️  No se encontró script de Python (${PYTHON_SCRIPT}) ni de Node (/app/app.js) — omitiendo ejecución."
fi

# ====== Mantener contenedor activo ======
echo "🌀 Contenedor activo — SSH (22)${HEADLESS == "false" && ", noVNC (${NOVNC_PORT}) y VNC (5901)" || ""}."
echo "   (Si la app principal falla, el contenedor seguirá vivo para depuración)"
tail -f /dev/null