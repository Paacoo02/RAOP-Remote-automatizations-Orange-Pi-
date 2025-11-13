#!/usr/bin/env bash
set -euo pipefail

echo "▶️  Boot script: start_extension (Simple macOS + Brave Mode)"

# =================== CONFIG ===================
# Ruta estándar de Brave Browser en macOS
BROWSER_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

# El resto de la configuración se mantiene
EXT_PATH="${EXT_PATH:-}"
START_URL="${START_URL:-https://cooltimedia.com/blog/video-background-con-html5}"
OPEN_EXTENSIONS_TAB="${OPEN_EXTENSIONS_TAB:-1}"
# Usaremos un perfil temporal para no afectar tu Brave normal
USER_DATA_DIR="/tmp/brave-profile-dev-$$"

# =================== HELPERS ===================
wait_for_port() {
  local port="$1" tries="${2:-40}" sleep_s="${3:-0.25}"
  echo "⏳ Esperando a que el puerto ${port} quede disponible..."
  
  for _ in $(seq 1 "${tries}"); do 
    if netstat -anv | grep -qE "(\.${port}\ |^\*${port}\ ).*LISTEN"; then
      echo "✅ Puerto ${port} disponible"
      return 0
    fi
    sleep "${sleep_s}"
  done

  echo "⚠️  El puerto ${port} no abrió a tiempo"
  return 1
}

fail() { echo "❌ $*" >&2; exit 1; }
hr() { printf '%*s\n' "${COLUMNS:-80}" '' | tr ' ' '─'; }

# =================== Comprobación/ext autodetección ===================
autodetect_extension() {
  if [[ -n "${EXT_PATH}" && -r "${EXT_PATH}/manifest.json" ]]; then
    echo "🧩 EXT_PATH (env) -> ${EXT_PATH}"
    return 0
  fi
  # Autodetectar en la carpeta actual
  if [[ -r "$(pwd)/manifest.json" ]]; then
      EXT_PATH="$(pwd)"
      echo "🧭 EXT_PATH autodetectado -> ${EXT_PATH}"
      return 0
  fi
  
  local CANDIDATES=(
    "/app/my-video-summarizer"
    "/app/extension"
  )
  for d in "${CANDIDATES[@]}"; do
    if [[ -r "${d}/manifest.json" ]]; then
      EXT_PATH="${d}"
      echo "🧭 EXT_PATH autodetectado -> ${EXT_PATH}"
      return 0
    fi
  done
  fail "No encontré manifest.json en la carpeta actual. Pasa EXT_PATH=/ruta/a/tu/extension"
}

check_extension_files() {
  [[ -d "${EXT_PATH}" ]] || fail "EXT_PATH no existe: ${EXT_PATH}"
  [[ -r "${EXT_PATH}/manifest.json" ]] || fail "No existe/legible: ${EXT_PATH}/manifest.json"
  if command -v jq >/dev/null 2>&1; then
    jq . "${EXT_PATH}/manifest.json" >/dev/null || fail "manifest.json no es JSON válido"
  fi
  echo "🧪 Extensión verificada en ${EXT_PATH}"
}

# =================== Lanzar Brave ===================
launch_brave_with_extension() {
  echo "🚀 Lanzando Brave Browser con extensión ${EXT_PATH}"
  echo "ℹ️  Usando perfil temporal: ${USER_DATA_DIR}"

  local URLS=()
  [[ "${OPEN_EXTENSIONS_TAB}" == "1" ]] && URLS+=("chrome://extensions")
  URLS+=("${START_URL}")

  local DEFAULT_FLAGS=(
    # Flags para un perfil limpio y depuración
    --no-first-run
    --no-default-browser-check
    --window-size=1280,800
    --new-window
    --remote-debugging-port=9222
    --user-data-dir="${USER_DATA_DIR}"
    
    # Flags para cargar la extensión
    --load-extension="${EXT_PATH}"
    --disable-extensions-except="${EXT_PATH}"
    --enable-extensions-menu
  )

  echo "ℹ️  Cierra esta ventana de Brave cuando termines. El perfil se borrará."
  echo "   (Para borrarlo manualmente, ejecuta: rm -rf ${USER_DATA_DIR})"

  "${BROWSER_PATH}" \
    "${DEFAULT_FLAGS[@]}" \
    "${URLS[@]}" \
    >/tmp/brave.log 2>&1 &

  sleep 3

  # Verificar si el proceso está corriendo
  if ! pgrep -f "user-data-dir=${USER_DATA_DIR}" >/dev/null; then
    echo "⚠️  Brave parece no haberse quedado arrancado. Ultimas líneas de /tmp/brave.log:"
    tail -n 20 /tmp/brave.log || true
  else
    echo "🧩 Brave lanzado (DevTools 9222). Logs: /tmp/brave.log"
  fi
}

# =================== DIAGNÓSTICO DE EXTENSIÓN ===================
diagnose_extension() {
  hr
  echo "🔬 Diagnóstico de carga de extensión"

  if ! wait_for_port 9222 40 0.25; then
    echo "❌ DevTools (9222) no está accesible; no puedo inspeccionar targets."
    return 0
  fi
  
  echo "✅ DevTools (9222) accesible."
  
  if ! command -v jq >/dev/null 2>&1; then
    echo "⚠️  (Opcional) Instala 'jq' (con 'brew install jq') para ver más detalles."
    return 0
  fi
  
  echo "🔎 Intentando obtener lista de targets de DevTools..."
  local list_json
  list_json="$(curl -fsS "http://127.0.0.1:9222/json/list" 2>/dev/null || echo "[]")"
  
  if [[ -z "${list_json}" ]]; then
    echo "❌ No pude leer /json/list en DevTools."
    return 0
  fi
  
  local ext_targets
  ext_targets="$(echo "${list_json}" | jq -r '.[] | select(.url | startswith("chrome-extension://")) | "\(.type) \(.url)"' || true)"
  local num_ext
  num_ext="$(printf "%s\n" "${ext_targets}" | sed '/^$/d' | wc -l | tr -d ' ')"
  
  echo "🔎 Targets chrome-extension:// detectados: ${num_ext:-0}"
  if [[ -n "${ext_targets}" ]]; then
    echo "${ext_targets}" | sed 's/^/   • /'
  fi
  if [[ "${num_ext:-0}" -eq 0 ]]; then
    echo "⚠️  No hay targets de extensión listados todavía (MV3 SW en reposo o extensión no cargada)."
  fi
  
  hr
}

# =================== MAIN ===================
# 1. Comprobar que Brave existe
if [[ ! -x "${BROWSER_PATH}" ]]; then
  fail "No se encontró Brave Browser en ${BROWSER_PATH}.
Por favor, instálalo o corrige la variable BROWSER_PATH en este script."
fi

# 2. Encontrar la extensión
autodetect_extension

# 3. Verificar los archivos de la extensión
check_extension_files

# 4. Lanzar Brave
launch_brave_with_extension

# 5. Diagnosticar
diagnose_extension

echo "✅ Script finalizado. La ventana de Brave debería estar abierta."
# Ya no necesitamos 'tail -f' porque el navegador se lanza en el escritorio.