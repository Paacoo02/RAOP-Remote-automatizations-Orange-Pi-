#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script: start_extension"

# =================== CONFIG ===================
HEADLESS="${HEADLESS:-false}"
DISPLAY="${DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
# EXT_PATH puede venir del entorno. Si no, lo autodetectamos más abajo.
EXT_PATH="${EXT_PATH:-}"
START_URL="${START_URL:-https://cooltimedia.com/blog/video-background-con-html5}"
CHROMIUM_PATH="${CHROMIUM_PATH:-/ms-playwright/chromium-latest/chrome-linux/chrome}"
BROWSER_ARGS="${BROWSER_ARGS:-}"
ENABLE_SSH="${ENABLE_SSH:-false}"
X11VNC_EXTRA="${X11VNC_EXTRA:-}"
OPEN_EXTENSIONS_TAB="${OPEN_EXTENSIONS_TAB:-1}"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

# =================== HELPERS ===================
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

fail() { echo "❌ $*" >&2; exit 1; }

# =================== Playwright ===================
playwright_ensure() {
  echo "🔎 Verificando navegadores Playwright…"
  local BASE="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
  local FOUND_DIR
  FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"
  if [ -z "${FOUND_DIR}" ]; then
    echo "ℹ️ Instalando Chromium..."
    local PW_VER
    PW_VER="$(node -p "require('playwright-core/package.json').version" 2>/dev/null || echo "")"
    [ -n "${PW_VER}" ] || fail "No puedo leer la versión de playwright-core. ¿Está instalado?"
    npx --yes playwright@${PW_VER} install --with-deps chromium
    FOUND_DIR="$(ls -d "${BASE}/chromium-"* 2>/dev/null | head -n1 || true)"
  fi
  local EXE="${FOUND_DIR}/chrome-linux/chrome"
  [ -x "${EXE}" ] || fail "No se encontró el ejecutable Chromium en ${FOUND_DIR}"
  for alias in chromium-latest chromium-1193 chromium-1194; do
    ln -sfn "${FOUND_DIR}" "${BASE}/${alias}"
  done
  echo "✅ Chromium listo en ${FOUND_DIR}"
}

# =================== SSH opcional ===================
start_ssh() {
  if [[ "${ENABLE_SSH}" != "true" ]]; then
    echo "🔒 SSH deshabilitado por ENABLE_SSH=${ENABLE_SSH}"
    return
  fi
  echo "🧩 Iniciando servidor SSH..."
  service ssh start >/tmp/ssh_start.log 2>&1 || true
  pgrep -x sshd >/dev/null && echo "✅ SSH activo en puerto 22" || echo "⚠️ SSH no pudo iniciarse (revisar logs)"
}

# =================== VNC / noVNC ===================
start_vnc_stack() {
  echo "🖥️  Iniciando Xvfb en ${DISPLAY} (${XVFB_RESOLUTION})"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
  sleep 1
  echo "🪟 Iniciando fluxbox"
  fluxbox >/tmp/fluxbox.log 2>&1 &
  if [[ -n "${VNC_PASSWORD}" ]]; then
    echo "${VNC_PASSWORD}" > /tmp/vncpass
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -passwdfile /tmp/vncpass ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  else
    x11vnc -display "${DISPLAY}" -rfbport 5901 -forever -shared -nopw ${X11VNC_EXTRA} >/tmp/x11vnc.log 2>&1 &
  fi
  websockify --web=/usr/share/novnc 0.0.0.0:${NOVNC_PORT} localhost:5901 >/tmp/novnc.log 2>&1 &
  wait_for_port "${NOVNC_PORT}" 20 0.5 || echo "⚠️  Revisa /tmp/novnc.log"
  echo "✅ noVNC en :${NOVNC_PORT}, VNC en :5901"
}

# =================== Comprobación/ext autodetección ===================
autodetect_extension() {
  if [[ -n "${EXT_PATH}" && -r "${EXT_PATH}/manifest.json" ]]; then
    echo "🧩 EXT_PATH (env) -> ${EXT_PATH}"
    return 0
  fi
  local CANDIDATES=(
    "/app/my-video-summarizer"
    "/app/extension"
    "$(pwd)"
  )
  for d in "${CANDIDATES[@]}"; do
    if [[ -r "${d}/manifest.json" ]]; then
      EXT_PATH="${d}"
      echo "🧭 EXT_PATH autodetectado -> ${EXT_PATH}"
      return 0
    fi
  done
  fail "No encontré manifest.json. Pasa EXT_PATH=/ruta/a/tu/extension"
}

check_extension() {
  [[ -d "${EXT_PATH}" ]] || fail "EXT_PATH no existe: ${EXT_PATH}"
  [[ -r "${EXT_PATH}/manifest.json" ]] || fail "No existe/legible: ${EXT_PATH}/manifest.json"
  if command -v jq >/dev/null 2>&1; then
    jq . "${EXT_PATH}/manifest.json" >/dev/null || fail "manifest.json no es JSON válido"
  fi
  echo "🧪 Extensión verificada en ${EXT_PATH}"
}

# =================== Lanzar Chromium ===================
launch_chromium_with_extension() {
  echo "🚀 Lanzando Chromium con extensión ${EXT_PATH}"
  export DISPLAY

  # URLs iniciales: abrimos chrome://extensions y tu START_URL
  local URLS=()
  [[ "${OPEN_EXTENSIONS_TAB}" == "1" ]] && URLS+=("chrome://extensions")
  URLS+=("${START_URL}")

  # Flags robustas para entornos Docker/Xvfb
  local DEFAULT_FLAGS=(
    --no-sandbox
    --no-zygote
    --disable-dev-shm-usage
    --disable-gpu
    --disable-software-rasterizer
    --disable-renderer-backgrounding
    --disable-background-timer-throttling
    --disable-features=Translate,ChromeWhatsNewUI
    --no-first-run
    --no-default-browser-check
    --window-size=1280,800
    --start-maximized
    --new-window
    --force-color-profile=srgb
    --autoplay-policy=no-user-gesture-required
    --enable-extensions-menu
    --show-component-extension-options
    --remote-debugging-port=9222
    --user-data-dir=/tmp/chrome-profile
    --load-extension="${EXT_PATH}"
    --disable-extensions-except="${EXT_PATH}"
  )

  # Evita pantallazo en negro por ahorro de energía
  ( which xset >/dev/null 2>&1 && xset -dpms s off ) || true

  # Lanza Chrome
  "${CHROMIUM_PATH}" \
    "${DEFAULT_FLAGS[@]}" \
    ${BROWSER_ARGS} \
    "${URLS[@]}" \
    >/tmp/chrome.log 2>&1 &

  sleep 3

  # ¿Está el proceso?
  if ! pgrep -f "chrome-linux/chrome.*--user-data-dir=/tmp/chrome-profile" >/dev/null; then
    echo "⚠️  Chrome parece no haberse quedado arrancado. Revisando /tmp/chrome.log y relanzando sin extensión…"
    tail -n 50 /tmp/chrome.log || true

    # Fallback: relanza SIN la extensión por si ésta lo está rompiendo
    "${CHROMIUM_PATH}" \
      --no-sandbox --no-zygote --disable-dev-shm-usage --disable-gpu \
      --window-size=1280,800 --start-maximized --new-window \
      --remote-debugging-port=9222 \
      --user-data-dir=/tmp/chrome-profile-fallback \
      "chrome://version" \
      >/tmp/chrome_fallback.log 2>&1 &
    sleep 3

    if pgrep -f "chrome-linux/chrome.*chrome-profile-fallback" >/dev/null; then
      echo "✅ Chrome abierto en modo fallback (sin extensión). Revisa tu extensión o /tmp/chrome.log."
    else
      echo "❌ Chrome tampoco abrió en fallback. Mira /tmp/chrome_fallback.log."
    fi
  else
    echo "🧩 Chromium lanzado (DevTools 9222). Logs: /tmp/chrome.log"
  fi
}


# =================== MAIN ===================
start_ssh
if [[ "${HEADLESS}" == "false" ]]; then
  export DISPLAY
  start_vnc_stack
else
  echo "🕶️ HEADLESS=true — no se inicia VNC/noVNC"
fi

playwright_ensure
autodetect_extension
check_extension
launch_chromium_with_extension

echo "🌐 Listo. Accede a noVNC en :${NOVNC_PORT}"
tail -f /dev/null
