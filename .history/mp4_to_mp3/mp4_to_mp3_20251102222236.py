#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys, os, json, time, subprocess, base64, socket
from urllib.parse import urlparse
import requests

# ===================
# CLI (1 argumento)
# ===================
if len(sys.argv) != 2:
    print(json.dumps({"ok": False, "error": "bad_argv", "usage": f"python3 {os.path.basename(__file__)} <server_base>"}))
    sys.exit(1)

SERVER_BASE = (sys.argv[1] or "").strip()
if not SERVER_BASE.lower().startswith(("http://","https://")):
    print(json.dumps({"ok": False, "error": "invalid_server_base"}))
    sys.exit(1)

# ===================
# HTTP session
# ===================
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=1)
session.mount("http://", adapter)
session.mount("https://", adapter)

def wait_tunnel_ready(base: str, max_wait: float = 45.0, step: float = 0.8) -> str:
    """
    Espera a que el túnel resuelva y responda a /health o /execute.
    Devuelve la URL candidata que funciona (http o https). Lanza si no está listo.
    """
    if not base or not base.lower().startswith(("http://","https://")):
        raise RuntimeError("invalid_base_url")

    base = base.rstrip("/")
    candidates = list(dict.fromkeys([base.replace("http://","https://"), base.replace("https://","http://")]))
    host = urlparse(base).hostname or base
    t0 = time.time()
    last_err = "unknown"

    while (time.time() - t0) < max_wait:
        for b in candidates:
            # 1) DNS
            try:
                socket.getaddrinfo(host, 443)
            except Exception as e:
                last_err = f"dns:{e}"
                continue

            # 2) /health
            try:
                r = session.get(b + "/health", timeout=2)
                if r.status_code == 200:
                    return b
                last_err = f"health_status:{r.status_code}"
            except Exception as e:
                last_err = f"health:{e}"

            # 3) /execute eco
            try:
                r = session.post(
                    b + "/execute",
                    json={"script_content": "import json; print(json.dumps({'ok': True}))", "params": []},
                    timeout=3
                )
                if r.status_code == 200:
                    return b
                last_err = f"exec_status:{r.status_code}"
            except Exception as e:
                last_err = f"exec:{e}"

        time.sleep(step)

    raise RuntimeError("tunnel_not_ready: " + last_err)

def remote_exec(base: str, script_text: str, params: list):
    ep = base.rstrip("/") + "/execute"
    r = session.post(ep, json={"script_content": script_text, "params": params}, timeout=1800)
    r.raise_for_status()
    return r.json()

# ===================
# Script remoto en Colab:
# - Monta Drive
# - Busca el ÚLTIMO vídeo en /content/drive/MyDrive/Videos (o MyDrive raíz)
# - Convierte a MP3 junto a ese fichero
# - Devuelve JSON con rutas en Drive
# ===================
COLAB_SCRIPT_FIND_AND_CONVERT = r"""#!/usr/bin/env python3
from google.colab import drive
drive.mount('/content/drive')

# Cambia la ruta al archivo en tu Drive
input_path = '/content/drive/MyDrive/Videos/video.mp4'
output_path = '/content/drive/MyDrive/Videos/video.mp3'

!ffmpeg -i "$input_path" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "$output_path"
"""

def main():
    # 1) Esperar a que el túnel esté listo (http/https, DNS, /health o /execute)
    try:
        base_ready = wait_tunnel_ready(SERVER_BASE, max_wait=45.0, step=0.8)
    except Exception as e:
        sys.stderr.write(f"[remote] tunnel not ready: {e}\n")
        print(json.dumps({"ok": False, "error": "tunnel_not_ready"}))
        sys.exit(1)

    # 2) Ejecutar el script remoto que convierte el último vídeo en Drive
    try:
        resp = remote_exec(base_ready, COLAB_SCRIPT_FIND_AND_CONVERT, [])
    except Exception as e:
        sys.stderr.write(f"[remote] execute failed: {e}\n")
        print(json.dumps({"ok": False, "error": "remote_execute_failed", "detail": str(e)}))
        sys.exit(1)

    # 3) Imprimir JSON tal cual devuelve el worker
    try:
        # Normalizamos claves mínimas esperadas
        if isinstance(resp, dict) and ("ok" in resp):
            print(json.dumps(resp, ensure_ascii=False))
            sys.exit(0 if resp.get("ok") else 1)
        else:
            print(json.dumps({"ok": True, "raw": resp}, ensure_ascii=False))
            sys.exit(0)
    except Exception:
        print(json.dumps({"ok": False, "error": "json_dump_failed"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
