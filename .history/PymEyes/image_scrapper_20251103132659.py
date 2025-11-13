#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Equivalente del script de Colab:
from google.colab import drive
drive.mount('/content/drive')

input_path = '/content/drive/MyDrive/Videos/video.mp4'
output_path = '/content/drive/MyDrive/Videos/video.mp3'

!ffmpeg -i "$input_path" -vn -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 "$output_path"

Ajustes:
- Sin magics `!`: usamos subprocess.run para llamar a ffmpeg.
- Si corre en Colab, montamos Drive. Si no, seguimos sin montar (paths locales).
- Acepta overrides por CLI: --in=, --out=, --mono/--stereo, --rate=, --quality=
- Devuelve un JSON por stdout (ok/errores).
"""

import sys, os, json, shutil, subprocess

# Defaults del ejemplo original
DEFAULT_INPUT  = '/content/drive/MyDrive/Videos/video.mp4'
DEFAULT_OUTPUT = '/content/drive/MyDrive/Videos/video.mp3'
DEFAULT_MONO   = True
DEFAULT_RATE   = 44100
DEFAULT_QUALITY= 5

def in_colab() -> bool:
    try:
        import google.colab  # type: ignore
        return True
    except Exception:
        return False

def mount_drive_if_colab():
    if in_colab():
        try:
            from google.colab import drive  # type: ignore
            drive.mount('/content/drive', force_remount=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "drive_mount_failed", "detail": str(e)}))
            sys.exit(1)

def which_ffmpeg() -> str:
    p = shutil.which("ffmpeg")
    return p or ""

def parse_args(argv):
    """
    Permite overrides:
      --in=/ruta.mp4   --out=/ruta.mp3
      --mono | --stereo
      --rate=44100     --quality=5
    """
    cfg = {
        "input": DEFAULT_INPUT,
        "output": DEFAULT_OUTPUT,
        "mono": DEFAULT_MONO,
        "rate": DEFAULT_RATE,
        "quality": DEFAULT_QUALITY,
    }
    for a in argv:
        if a.startswith("--in="):
            cfg["input"] = a.split("=",1)[1]
        elif a.startswith("--out="):
            cfg["output"] = a.split("=",1)[1]
        elif a in ("--mono","-m"):
            cfg["mono"] = True
        elif a == "--stereo":
            cfg["mono"] = False
        elif a.startswith("--rate="):
            try:
                cfg["rate"] = int(a.split("=",1)[1])
            except Exception:
                pass
        elif a.startswith("--quality="):
            try:
                cfg["quality"] = int(a.split("=",1)[1])
            except Exception:
                pass
    return cfg

def ensure_parent_dir(path: str):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)

def main():
    # Si estamos en Colab, monta Drive como en tu ejemplo
    mount_drive_if_colab()

    # Lee overrides desde sys.argv (tu /execute puede pasar params aquí)
    cfg = parse_args(sys.argv[1:])
    input_path  = cfg["input"]
    output_path = cfg["output"]
    mono        = cfg["mono"]
    rate        = cfg["rate"]
    quality     = cfg["quality"]

    # Comprobaciones básicas
    ffmpeg_bin = which_ffmpeg()
    if not ffmpeg_bin:
        print(json.dumps({"ok": False, "error": "ffmpeg_not_found"}))
        sys.exit(1)

    if not os.path.isfile(input_path):
        print(json.dumps({"ok": False, "error": "input_not_found", "path": input_path}))
        sys.exit(1)

    ensure_parent_dir(output_path)

    # Construye comando ffmpeg equivalente al de tu `!ffmpeg ...`
    cmd = [
        ffmpeg_bin, "-y",
        "-i", input_path,
        "-vn",
    ]
    if mono:
        cmd += ["-ac", "1"]
    cmd += [
        "-ar", str(rate),
        "-c:a", "libmp3lame",
        "-q:a", str(quality),
        output_path,
    ]

    # Ejecuta ffmpeg
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-1500:]
        print(json.dumps({"ok": False, "error": "ffmpeg_failed", "stderr_tail": tail}))
        sys.exit(1)

    # Verifica salida
    if not os.path.exists(output_path):
        print(json.dumps({"ok": False, "error": "output_missing", "path": output_path}))
        sys.exit(1)

    size = os.path.getsize(output_path)
    print(json.dumps({
        "ok": True,
        "input": input_path,
        "output": output_path,
        "bytes": size,
        "mono": mono,
        "rate": rate,
        "quality": quality
    }))
    sys.exit(0)

if __name__ == "__main__":
    main()
