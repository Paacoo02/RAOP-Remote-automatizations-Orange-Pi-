#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys, os, json, time, subprocess
import requests

USAGE = f"Usage: python3 {os.path.basename(__file__)} <input_path> <output_path> <server_base_or_NONE>"

# ----------------------------
# CLI
# ----------------------------
if len(sys.argv) != 4:
    print(USAGE, file=sys.stderr)
    sys.exit(1)

INPUT_PATH  = sys.argv[1]
OUTPUT_PATH = sys.argv[2]
SERVER_BASE = sys.argv[3].strip()
USE_REMOTE  = SERVER_BASE and SERVER_BASE.upper() != "NONE"

# ----------------------------
# Helpers
# ----------------------------
session = requests.Session()
session.mount("http://", requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32))
session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32))

def remote_exec(script_text: str, params: list):
    """POST /execute con el script y parámetros. Devuelve JSON del worker."""
    ep = SERVER_BASE.rstrip("/") + "/execute"
    payload = {"script_content": script_text, "params": params}
    r = session.post(ep, json=payload, timeout=1800)  # 30 min por si ffmpeg tarda
    r.raise_for_status()
    return r.json()

# ----------------------------
# Script remoto para Colab
# - Monta Drive
# - Ejecuta ffmpeg con los parámetros recibidos
# - Devuelve JSON {ok:..., time_seconds:..., input:..., output:...}
# ----------------------------
COLAB_SCRIPT = r"""#!/usr/bin/env python3
import sys, json, time, subprocess

def run_cmd(cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out_lines = []
    for line in p.stdout:
        out_lines.append(line.rstrip("\n"))
        # No imprimir nada para no romper el JSON final del caller
    p.wait()
    return p.returncode, "\n".join(out_lines)

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "bad_argv", "usage": "script <input_path> <output_path>"}))
        return

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    t0 = time.time()

    # Montar Drive (idempotente)
    code, _ = run_cmd(["python3", "-c", "from google.colab import drive; drive.mount('/content/drive')"])
    # No fallamos aunque devuelva código no-cero si ya está montado.

    # ffmpeg (mono 44.1kHz, libmp3lame, calidad q=5; -y para sobrescribir)
    cmd = [
        "bash","-lc",
        f'ffmpeg -y -i "{input_path}" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "{output_path}"'
    ]
    code, out = run_cmd(cmd)
    dt = time.time() - t0

    if code != 0:
        print(json.dumps({
            "ok": False, "error": "ffmpeg_failed", "code": code,
            "input": input_path, "output": output_path,
            "time_seconds": round(dt, 3)
        }))
        return

    print(json.dumps({
        "ok": True, "input": input_path, "output": output_path,
        "time_seconds": round(dt, 3), "method": "remote_colab"
    }))

if __name__ == "__main__":
    main()
"""

# ----------------------------
# Local conversion (ffmpeg en el contenedor)
# ----------------------------
def run_local_ffmpeg(inp: str, outp: str):
    t0 = time.time()
    # Creamos directorio destino si no existe
    try:
        os.makedirs(os.path.dirname(outp) or ".", exist_ok=True)
    except Exception:
        pass

    cmd = [
        "bash","-lc",
        f'ffmpeg -y -i "{inp}" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "{outp}"'
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:  # log a stderr para no romper JSON final
        sys.stderr.write(line)
    p.wait()
    dt = time.time() - t0
    return p.returncode, dt

# ----------------------------
# Main
# ----------------------------
def main():
    if USE_REMOTE:
        # Ejecutar en Colab/worker pasando INPUT_PATH y OUTPUT_PATH como params
        try:
            resp = remote_exec(COLAB_SCRIPT, [INPUT_PATH, OUTPUT_PATH])
            # Compatibilidad: si el worker ya devuelve un JSON de colab_script, resp puede ser ese dict;
            # si el worker envuelve, intenta extraer campos típicos.
            if isinstance(resp, dict) and ("ok" in resp or "output" in resp or "input" in resp):
                print(json.dumps(resp))
            else:
                # Forzamos estructura mínima si el worker respondió algo distinto.
                print(json.dumps({
                    "ok": True,
                    "method": "remote_colab",
                    "raw": resp
                }))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"remote_exec_failed: {type(e).__name__}: {e}"}))
        return

    # Fallback local
    if not os.path.exists(INPUT_PATH):
        print(json.dumps({"ok": False, "error": "input_not_found", "path": INPUT_PATH}))
        return

    code, dt = run_local_ffmpeg(INPUT_PATH, OUTPUT_PATH)
    if code != 0:
        print(json.dumps({
            "ok": False, "error": "ffmpeg_failed_local", "code": code,
            "input": INPUT_PATH, "output": OUTPUT_PATH, "time_seconds": round(dt, 3)
        }))
        return

    print(json.dumps({
        "ok": True, "method": "local_ffmpeg",
        "input": INPUT_PATH, "output": OUTPUT_PATH, "time_seconds": round(dt, 3)
    }))

if __name__ == "__main__":
    main()
