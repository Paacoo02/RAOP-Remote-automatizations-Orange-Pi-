#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script: start_extension"

# =================== CONFIG ===================
HEADLESS="${HEADLESS:-false}"
DISPLAY="${DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
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
  local port="$1" tries="${2:-40}" sleep_s="${3:-0.25}"
  echo "⏳ Esperando a que el puerto ${port} quede disponible..."
  
  # Este bucle 'for' es el que falta en tu fichero
  for _ in $(seq 1 "${tries}"); do 
    if ss -tln | grep -q ":${port}"; then
      echo "✅ Puerto ${port} disponible"
      return 0
    fi
    sleep "${sleep_s}"
  done # <--- Este 'done' también falta

  echo "⚠️  El puerto ${port} no abrió a tiempo"
  return 1
}


fail() { echo "❌ $*" >&2; exit 1; }

hr() { printf '%*s\n' "${COLUMNS:-80}" '' | tr ' ' '─'; }

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

check_extension_files() {
  [[ -d "${EXT_PATH}" ]] || fail "EXT_PATH no existe: ${EXT_PATH}"
  [[ -r "${EXT_PATH}/manifest.json" ]] || fail "No existe/legible: ${EXT_PATH}/manifest.json"
  if command -v jq >/dev/null 2>&1; then
    jq . "${EXT_PATH}/manifest.json" >/dev/null || fail "manifest.json no es JSON válido"
  fi

  # Comprobación de recursos referenciados
  echo "🧪 Verificando archivos referenciados en manifest…"
  local popup background content pagehook icon128
  popup="$(jq -r '.action.default_popup // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
  background="$(jq -r '.background.service_worker // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
  content="$(jq -r '.content_scripts[0].js[0] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
  pagehook="$(jq -r '.web_accessible_resources[0].resources[0] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
  icon128="$(jq -r '.icons["128"] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"

  local missing=0
  for f in "${popup}" "${background}" "${content}" "${pagehook}" "${icon128}"; do
    [[ -z "${f}" ]] && continue
    if [[ ! -r "${EXT_PATH}/${f}" ]]; then
      echo "❌ Falta archivo referenciado: ${f}"
      missing=1
    fi
  done

  if [[ "${missing}" -eq 1 ]]; then
    echo "⚠️  Corrige los faltantes arriba. Si falta el popup o background, el botón puede no mostrarse o el SW no arrancará."
  fi

  echo "🧪 Extensión verificada en ${EXT_PATH}"
}

# =================== Lanzar Chromium ===================
launch_chromium_with_extension() {
  echo "🚀 Lanzando Chromium con extensión ${EXT_PATH}"
  export DISPLAY

  local URLS=()
  [[ "${OPEN_EXTENSIONS_TAB}" == "1" ]] && URLS+=("chrome://extensions")
  URLS+=("${START_URL}")

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

  ( which xset >/dev/null 2>&1 && xset -dpms s off ) || true

  "${CHROMIUM_PATH}" \
    "${DEFAULT_FLAGS[@]}" \
    ${BROWSER_ARGS} \
    "${URLS[@]}" \
    >/tmp/chrome.log 2>&1 &

  sleep 3

  if ! pgrep -f "chrome-linux/chrome.*--user-data-dir=/tmp/chrome-profile" >/dev/null; then
    echo "⚠️  Chrome parece no haberse quedado arrancado. Ultimas líneas de /tmp/chrome.log:"
    tail -n 120 /tmp/chrome.log || true
    echo "⏪ Relanzando sin extensión para aislar el fallo…"
    "${CHROMIUM_PATH}" \
      --no-sandbox --no-zygote --disable-dev-shm-usage --disable-gpu \
      --window-size=1280,800 --start-maximized --new-window \
      --remote-debugging-port=9223 \
      --user-data-dir=/tmp/chrome-profile-fallback \
      "chrome://version" \
      >/tmp/chrome_fallback.log 2>&1 &
    sleep 3
    if pgrep -f "chrome-linux/chrome.*chrome-profile-fallback" >/dev/null; then
      echo "✅ Chrome abierto en fallback (sin extensión). Revisa errores en /tmp/chrome.log (posible manifest/JS roto)."
    else
      echo "❌ Chrome tampoco abrió en fallback. Mira /tmp/chrome_fallback.log."
    fi
  else
    echo "🧩 Chromium lanzado (DevTools 9222). Logs: /tmp/chrome.log"
  fi
}

# =================== DIAGNÓSTICO DE EXTENSIÓN ===================
diagnose_extension() {
  hr
  echo "🔬 Diagnóstico de carga de extensión"

  # 1) DevTools activo
  if ! wait_for_port 9222 40 0.25; then
    echo "❌ DevTools (9222) no está accesible; no puedo inspeccionar targets."
    return 0
  fi

  # 2) ¿Responde /json/version?
  if curl -fsS "http://127.0.0.1:9222/json/version" >/tmp/devtools_version.json 2>/dev/null; then
    echo "✅ DevTools responde: $(jq -r '.Browser' /tmp/devtools_version.json 2>/dev/null || echo '(sin jq)')"
  else
    echo "❌ No responde /json/version en 9222"
  fi

  # 3) Lista de targets
  if curl -fsS "http://127.0.0.1:9222/json/list" >/tmp/devtools_list.json 2>/dev/null; then
    local ext_targets
    ext_targets="$(jq -r '.[] | select(.url | startswith("chrome-extension://")) | "\(.type) \(.url)"' /tmp/devtools_list.json 2>/dev/null || true)"
    local num_ext
    num_ext="$(printf "%s\n" "${ext_targets}" | sed '/^$/d' | wc -l | tr -d ' ')"
    echo "🔎 Targets chrome-extension:// detectados: ${num_ext:-0}"
    if [[ -n "${ext_targets}" ]]; then
      echo "${ext_targets}" | sed 's/^/   • /'
    fi
    if [[ "${num_ext:-0}" -eq 0 ]]; then
      echo "⚠️  No hay targets de extensión listados todavía (MV3 SW en reposo o extensión no cargada)."
    fi
  else
    echo "❌ No pude leer /json/list en DevTools."
  fi

  # 4) Errores comunes en /tmp/chrome.log
  echo "📜 Escaneando /tmp/chrome.log en busca de errores de extensión…"
  if [[ -r /tmp/chrome.log ]]; then
    grep -E -i 'extension|manifest|service worker|background|Unrecognized manifest key|Could not load|runtime\.onInstalled|errors parsing|Failed to load extension' /tmp/chrome.log | tail -n 80 || true
  else
    echo "⚠️  No existe /tmp/chrome.log todavía."
  fi

  # 5) Resumen de archivos en EXT_PATH
  echo "📁 Contenido de ${EXT_PATH}:"
  (cd "${EXT_PATH}" && ls -la) || true

  # 6) Manifest resumen y archivo faltante detallado
  if command -v jq >/dev/null 2>&1; then
    echo "🧾 Resumen manifest:"
    jq '{name, version, action, background, icons, content_scripts, web_accessible_resources}' "${EXT_PATH}/manifest.json" || true

    echo "🧩 Verificación puntual de referencias:"
    local popup background content pagehook icon128
    popup="$(jq -r '.action.default_popup // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
    background="$(jq -r '.background.service_worker // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
    content="$(jq -r '.content_scripts[0].js[0] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
    pagehook="$(jq -r '.web_accessible_resources[0].resources[0] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"
    icon128="$(jq -r '.icons["128"] // empty' "${EXT_PATH}/manifest.json" 2>/dev/null || true)"

    for f in "${popup}" "${background}" "${content}" "${pagehook}" "${icon128}"; do
      [[ -z "${f}" ]] && continue
      if [[ -r "${EXT_PATH}/${f}" ]]; then
        echo "   ✅ ${f}"
      else
        echo "   ❌ ${f} (no existe)"
      fi
    done
  fi

  # 7) Consejos de último paso
  echo "💡 Si no ves el icono:"
  echo "   - Abre chrome://extensions (ya se abrió) y pulsa 'Recargar' en la tarjeta."
  echo "   - Abre el puzzle (barra) y 'fija' la extensión."
  echo "   - Si NO aparece en la lista de extensiones: el manifest/archivos están mal o Chrome no pudo cargarla (ver /tmp/chrome.log)."
  hr
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
check_extension_files
launch_chromium_with_extension

echo "🌐 Listo. Accede a noVNC en :${NOVNC_PORT}"

# 🔎 LANZAR DIAGNÓSTICO (espera a DevTools y revisa logs/targets)
diagnose_extension

# Mantener contenedor vivo
tail -f /dev/null
