#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys, os, json, time, subprocess, base64
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
SERVER_BASE = (sys.argv[3] or "").strip()
USE_REMOTE  = SERVER_BASE.lower().startswith("http")

# ----------------------------
# Requests session (pooling)
# ----------------------------
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=2)
session.mount("http://", adapter)
session.mount("https://", adapter)

def print_json_and_exit(payload: dict, code: int):
    """Imprime JSON (una línea) y sale con código."""
    try:
        print(json.dumps(payload, ensure_ascii=False))
    except Exception:
        # Último recurso
        print('{"ok": false, "error": "json_dump_failed"}')
    sys.exit(code)

# ----------------------------
# FFMPEG local
# ----------------------------
def run_local_ffmpeg(inp: str, outp: str):
    t0 = time.time()
    os.makedirs(os.path.dirname(outp) or ".", exist_ok=True)
    cmd = [
        "bash","-lc",
        f'ffmpeg -y -i "{inp}" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "{outp}"'
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        # Pasamos logs a STDERR para no romper el JSON final
        sys.stderr.write(line)
    p.wait()
    return p.returncode, time.time() - t0

# ----------------------------
# Servidor universal: /health /upload /execute
# ----------------------------
def server_upload(local_path: str) -> str:
    """Sube el archivo y devuelve la ruta remota (string)."""
    ep = SERVER_BASE.rstrip("/") + "/upload"
    with open(local_path, "rb") as f:
        r = session.post(ep, files={"file": (os.path.basename(local_path), f)}, timeout=300)
    r.raise_for_status()
    data = r.json()
    return data["file_path"]

def remote_exec(script_text: str, params: list):
    ep = SERVER_BASE.rstrip("/") + "/execute"
    payload = {"script_content": script_text, "params": params}
    r = session.post(ep, json=payload, timeout=1800)
    r.raise_for_status()
    return r.json()

# ----------------------------
# Script que se ejecuta en Colab:
# - Convierte con ffmpeg (input_path -> output_path)
# - Lee el MP3 resultante y lo devuelve en base64
# ----------------------------
COLAB_SCRIPT_RETURN_B64 = r"""#!/usr/bin/env python3
import sys, json, time, subprocess, base64, os

def run_cmd(cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out_lines = []
    for line in p.stdout:
        out_lines.append(line.rstrip("\n"))
    p.wait()
    return p.returncode, "\n".join(out_lines)

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "bad_argv", "usage": "script <input_path> <output_path>"}))
        return

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    t0 = time.time()

    # Montar Drive (idempotente: no fallar si ya está montado)
    try:
        _code, _ = run_cmd(["python3", "-c", "from google.colab import drive; drive.mount('/content/drive')"])
    except Exception:
        pass

    # ffmpeg
    code, _out = run_cmd([
        "bash","-lc",
        f'ffmpeg -y -i "{input_path}" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "{output_path}"'
    ])
    dt = time.time() - t0

    if code != 0 or not os.path.exists(output_path):
        print(json.dumps({
            "ok": False,
            "error": "ffmpeg_failed",
            "code": int(code),
            "input": input_path,
            "output": output_path,
            "time_seconds": round(dt, 3)
        }))
        return

    try:
        with open(output_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"read_mp3_failed:{type(e).__name__}:{e}"}))
        return

    print(json.dumps({
        "ok": True,
        "method": "remote_colab",
        "input": input_path,
        "output": output_path,
        "time_seconds": round(dt, 3),
        "mp3_b64": b64
    }))

if __name__ == "__main__":
    main()
"""

# ----------------------------
# MAIN
# ----------------------------
def main():
    # Validaciones básicas
    if not os.path.exists(INPUT_PATH):
        print_json_and_exit({"ok": False, "error": "input_not_found", "path": INPUT_PATH}, 2)

    # Intento remoto (si corresponde)
    if USE_REMOTE:
        try:
            # 1) Subir el MP4 al worker
            remote_input = server_upload(INPUT_PATH)

            # 2) Decidir ruta de salida remota
            base = os.path.splitext(os.path.basename(OUTPUT_PATH))[0] or "output"
            remote_output = f"/content/{base}.mp3"  # ruta utilizable en Colab

            # 3) Ejecutar ffmpeg en el worker → devuelve base64 del MP3
            resp = remote_exec(COLAB_SCRIPT_RETURN_B64, [remote_input, remote_output])

            if isinstance(resp, dict) and resp.get("ok") and resp.get("mp3_b64"):
                # 4) Escribir MP3 local
                os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
                with open(OUTPUT_PATH, "wb") as f:
                    f.write(base64.b64decode(resp["mp3_b64"]))

                # 5) Salida OK
                out = {
                    "ok": True,
                    "method": "remote_colab",
                    "input": INPUT_PATH,
                    "output": OUTPUT_PATH,
                    "time_seconds": resp.get("time_seconds"),
                    "remote": {
                        "input_path": resp.get("input"),
                        "output_path": resp.get("output")
                    }
                }
                print_json_and_exit(out, 0)

            # Si el worker respondió pero sin ok/mp3_b64, caemos a local
            sys.stderr.write(f"[remote] unexpected response: {json.dumps(resp)[:400]}\n")

        except Exception as e:
            # DNS / conexión / HTTP / etc. → caemos a local
            sys.stderr.write(f"[remote] failed: {type(e).__name__}: {e}\n")

    # Fallback LOCAL
    code, dt = run_local_ffmpeg(INPUT_PATH, OUTPUT_PATH)
    if code != 0 or not os.path.exists(OUTPUT_PATH):
        print_json_and_exit({
            "ok": False,
            "error": "ffmpeg_failed_local",
            "code": int(code),
            "input": INPUT_PATH,
            "output": OUTPUT_PATH,
            "time_seconds": round(dt, 3)
        }, 1)

    print_json_and_exit({
        "ok": True,
        "method": "local_ffmpeg",
        "input": INPUT_PATH,
        "output": OUTPUT_PATH,
        "time_seconds": round(dt, 3)
    }, 0)

if __name__ == "__main__":
    main()
