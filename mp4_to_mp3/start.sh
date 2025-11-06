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
# "DIRECTO AL GRANO": La app busca 1193, el build instaló 1194.
# Creamos un enlace simbólico para engañar a la app.
# ======================================================
playwright_ensure() {
  echo "🔎 Verificando navegadores Playwright…"
  local BASE="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

  # 1) Detectar el chromium-* que haya
  local FOUND_DIR
  FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"

  # 2) Si no hay navegador, instalamos el que coincide con la versión de playwright-core
  if [ -z "${FOUND_DIR}" ]; then
    echo "ℹ️ No hay navegadores instalados en ${BASE}. Instalando Chromium…"
    # Instalamos exactamente el navegador que corresponde a la versión instalada de playwright-core
    local PW_VER
    PW_VER="$(node -p "require('playwright-core/package.json').version" 2>/dev/null || echo "")"
    if [ -z "${PW_VER}" ]; then
      echo "❌ No puedo leer la versión de playwright-core. ¿Está instalado?"
      exit 1
    fi
    echo "📦 playwright-core@${PW_VER}"
    npx --yes playwright@${PW_VER} install --with-deps chromium
    FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"
  fi

  if [ -z "${FOUND_DIR}" ]; then
    echo "❌ No se pudo instalar/detectar Chromium en ${BASE}"
    exit 1
  fi

  echo "✅ Detectado navegador: ${FOUND_DIR}"

  # 3) Validar ejecutable
  local EXE="${FOUND_DIR}/chrome-linux/chrome"
  if [ ! -x "${EXE}" ]; then
    echo "❌ Ejecutable no encontrado: ${EXE}"
    ls -la "${FOUND_DIR}" || true
    exit 1
  fi

  # 4) Compatibilidad hacia atrás: crea alias si tu app mira nombres antiguos
  #    (1193, 1194, etc). No pasa nada si ya existen.
  for alias in chromium-1193 chromium-1194 chromium-latest; do
    if [ ! -e "${BASE}/${alias}" ]; then
      ln -s "${FOUND_DIR}" "${BASE}/${alias}"
      echo "🔗 Alias creado: ${alias} -> $(basename "${FOUND_DIR}")"
    fi
  done

  echo "🆗 Playwright listo."
}


# ====== SSH ======
start_ssh() {
  if [[ "${ENABLE_SSH}" != "true" ]]; then
    echo "🔒 SSH deshabilitado por ENABLE_SSH=${ENABLE_SSH}"
    return
  fi
  echo "🧩 Iniciando servidor SSH..."
  /app/clear_ssh_host.sh || true
  service ssh start >/tmp/ssh_start.log 2>&1 || /usr/sbin/sshd >/tmp/sshd.log 2>&1 || true
  sleep 1
  if pgrep -x sshd >/dev/null; then
    echo "✅ SSH activo en puerto 22"
  else
    echo "⚠️ SSH no pudo iniciarse (revisar /tmp/ssh_start.log y /tmp/sshd.log)"
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
    echo "${VCN_PASSWORD}" > /tmp/vncpass
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
playwright_ensure # Esto ahora creará el enlace 1193 -> 1194

# ====== Lanzamiento de tu app ======
PYTHON_SCRIPT="/app/main.py"
VENV_PATH="/app/venv"

if [[ -f "${PYTHON_SCRIPT}" ]] && [[ -f "${VENV_PATH}/bin/activate" ]]; then
  echo "🐍 Lanzando app Python desde venv..."
  if [[ "${HEADLESS}" == "false" ]]; then export DISPLAY; fi
  source "${VENV_PATH}/bin/activate"
  python "${PYTHON_SCRIPT}" || echo "⚠️  Python salió con error ($?). Continuando..."
  deactivate || true
elif [[ -f /app/app.js ]]; then
  echo "🚀 Lanzando app Node..."
  if [[ "${HEADLESS}" == "false" ]]; then export DISPLAY; fi
  node -e "try{console.log('ℹ️ playwright-core version:', require('playwright-core/package.json').version)}catch(e){console.log('ℹC playwright-core no instalado en runtime')}"
  node /app/app.js || echo "⚠️  Node salió con error ($?)."
else
  echo "ℹ️  No se encontró script de Python (${PYTHON_SCRIPT}) ni de Node (/app/app.js) — omitiendo ejecución."
fi

# ====== Mantener contenedor activo ======
echo "🌀 Contenedor activo — SSH (22)${HEADLESS == "false" && ", noVNC (${NOVNC_PORT}) y VNC (5901)" || ""}."
echo "   (Si la app principal falla, el contenedor seguirá vivo para depuración)"
tail -f /dev/null