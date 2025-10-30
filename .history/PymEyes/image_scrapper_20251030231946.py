#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# ==========================================
# DIRECTOR (crawler + prefilter + thumbnail-probe + batched matching)
# Servidor universal requerido:
#   - POST /upload    -> files={"file": (...)}
#   - POST /execute   -> json={"script_content": "...", "params":[...]}
# ==========================================

import cv2
import numpy as np
import requests, re
from io import BytesIO
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib3
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import time
import os
import json
import sys
import queue
import threading
from contextlib import contextmanager

# ----------------------------
# CLI
# ----------------------------
if len(sys.argv) != 4:
    print(f"Usage: python3 {sys.argv[0]} <start_url> <local_crop_image_path> <server_base_or_NONE>", file=sys.stderr)
    sys.exit(1)

start_url          = sys.argv[1]
local_crop_path    = sys.argv[2]
SERVER_BASE        = sys.argv[3].rstrip("/")  # ej. http://host:8000  |  NONE
USE_REMOTE_EXEC    = SERVER_BASE.lower().startswith("http")

# ----------------------------
# Constantes (afinadas)
# ----------------------------
MAX_WORKERS_FETCH        = 32   # descargas paralelas para "probe"
MAX_WORKERS_MATCH        = 8    # lotes en paralelo contra /execute
BATCH_SIZE               = 24   # URLs por lote
TOPK_CANDIDATES          = 240  # tras heurística html
TOPM_AFTER_PROBE         = 80   # tras probe de miniaturas
ASPECT_TOL_BASE          = 0.35 # ±35% de tolerancia base
ASPECT_TOL_MAX           = 0.70 # puede abrirse hasta ±70%
ASPECT_REJECT_FLOOR      = 0.20 # si tol se hace demasiado estrecha, usa al menos ±20%
HIST_TOL_SKIP_ASPECT     = 0.25 # si hist>=0.25 no descartes por aspecto
HIST_THR_PROBE           = 0.12 # hist bajo para probe rápido
EDGE_MIN_PROBE           = 450  # textura mínima en probe
SCALE_MIN                = 0.25
SCALE_MAX                = 1.50
N_SCALES                 = 12
EARLY_STOP_THRESHOLD     = 0.92

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
headers = {"User-Agent": "Mozilla/5.0"}

# Crawler
max_retries = 3
timeout = 20
max_pages = 500
max_workers_crawler = 10
IGNORED_EXTENSIONS = (
    '.pdf', '.zip', '.rar', '.mp3', '.mp4', '.avi', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.mov', '.wmv', '.svg'
)

# Estado crawler
to_visit_queue = queue.Queue()
visited = set()
visited_lock = threading.Lock()
results_lock = threading.Lock()
processed_pages = 0
processed_pages_lock = threading.Lock()

# Guardaremos metadatos por URL de imagen
# { url: {"w":int|None,"h":int|None,"ext":".jpg",".png",...,"from":page_url} }
image_meta = {}

# HTTP session pooling
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=128, pool_maxsize=128, max_retries=2)
session.mount("http://", adapter)
session.mount("https://", adapter)

# ----------------------------
# Silenciar libpng (opcional)
# ----------------------------
@contextmanager
def suppress_stderr():
    import os, sys
    fd = sys.stderr.fileno()
    saved = os.dup(fd)
    try:
        with open(os.devnull, 'wb') as devnull:
            os.dup2(devnull.fileno(), fd)
        yield
    finally:
        os.dup2(saved, fd)
        os.close(saved)

# ----------------------------
# Limpieza de PNGs: quitar chunks eXIf duplicados
# ----------------------------
PNG_SIG = b"\x89PNG\r\n\x1a\n"

def strip_png_exif_chunks(data: bytes) -> bytes:
    """Elimina todos los chunks eXIf de un PNG (si los hubiera). Si no es PNG, devuelve tal cual."""
    if not data.startswith(PNG_SIG):
        return data
    out = bytearray()
    out += PNG_SIG
    i = len(PNG_SIG)
    n = len(data)
    while i + 12 <= n:
        length = int.from_bytes(data[i:i+4], "big")
        ctype  = data[i+4:i+8]
        chunk_data_start = i + 8
        chunk_data_end   = chunk_data_start + length
        crc_end          = chunk_data_end + 4
        if crc_end > n:
            return bytes(out)
        if ctype != b"eXIf":
            out += data[i:crc_end]
        i = crc_end
        if ctype == b"IEND":
            break
    return bytes(out)

# ----------------------------
# Utils HTTP
# ----------------------------
def head_size(url):
    try:
        r = session.head(url, timeout=10, allow_redirects=True, headers=headers, verify=False)
        cl = r.headers.get("Content-Length")
        if cl:
            v = int(cl)
            return v if v > 0 else None
    except Exception:
        pass
    return None

def url_to_bytes(url):
    for attempt in range(3):
        try:
            resp = session.get(url, timeout=45, headers=headers, verify=False)
            resp.raise_for_status()
            return resp.content
        except requests.RequestException as e:
            print(f"⚠️ download {url} (attempt {attempt+1}/3): {e}", file=sys.stderr)
            time.sleep(0.35)
    return None

def decode_small_and_full(data_bytes):
    b = data_bytes
    if b.startswith(PNG_SIG):
        b = strip_png_exif_chunks(b)
    npb = np.frombuffer(b, np.uint8)
    with suppress_stderr():
        small = cv2.imdecode(npb, cv2.IMREAD_REDUCED_GRAYSCALE_4)
        full  = cv2.imdecode(npb, cv2.IMREAD_GRAYSCALE)
    return small, full

def url_to_cv2_fast_gray(url):
    b = url_to_bytes(url)
    if b is None:
        return None, None
    return decode_small_and_full(b)

# ----------------------------
# Métricas rápidas (probe)
# ----------------------------
def cheap_hist_sim(a_gray, b_gray):
    ha = cv2.calcHist([a_gray],[0],None,[32],[0,256]); cv2.normalize(ha, ha)
    hb = cv2.calcHist([b_gray],[0],None,[32],[0,256]); cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))

def lap_var(img_gray):
    return float(cv2.Laplacian(img_gray, cv2.CV_64F).var())

def edges_sum(img_gray):
    e = cv2.Canny(img_gray, 80, 160)
    return int(e.sum())

# ----------------------------
# Matching local (fallback)
# ----------------------------
def make_scales(fw, fh, cw, ch, smin=SCALE_MIN, smax=SCALE_MAX, n=N_SCALES):
    exp = min(fw/max(1,cw), fh/max(1,ch))
    lo = max(smin, min(0.7*exp, exp))
    hi = min(smax, max(1.3*exp, exp))
    if hi < lo:
        lo, hi = smin, min(smax, exp)
    steps = max(6, n//2)
    return np.geomspace(lo, hi, num=steps)

def run_match_template_edges(full_gray, crop_gray, scales):
    full_e = cv2.Canny(full_gray, 80, 160)
    crop_e = cv2.Canny(crop_gray, 80, 160)
    fh, fw = full_e.shape[:2]
    ch, cw = crop_e.shape[:2]
    best_score, best_scale = -1.0, 1.0
    for s in scales:
        sw, sh = int(cw*s), int(ch*s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh:
            continue
        ce = cv2.resize(crop_e, (sw, sh), interpolation=cv2.INTER_AREA if s<1.0 else cv2.INTER_CUBIC)
        res = cv2.matchTemplate(full_e, ce, cv2.TM_CCOEFF_NORMED)
        _, mv, _, _ = cv2.minMaxLoc(res)
        if mv > best_score:
            best_score, best_scale = float(mv), float(s)
        if best_score >= EARLY_STOP_THRESHOLD:
            break
    return best_score, best_scale

def best_multiscale_tm_score_local(full_gray, crop_gray, scales):
    fh, fw = full_gray.shape[:2]
    ch, cw = crop_gray.shape[:2]
    best_score = -1.0
    best_scale = 1.0
    for s in scales:
        sw, sh = int(cw*s), int(ch*s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh:
            continue
        c = cv2.resize(crop_gray, (sw, sh), interpolation=cv2.INTER_AREA if s<1.0 else cv2.INTER_CUBIC)
        res = cv2.matchTemplate(full_gray, c, cv2.TM_CCOEFF_NORMED)
        _, mv, _, _ = cv2.minMaxLoc(res)
        if mv > best_score:
            best_score, best_scale = float(mv), float(s)
        if best_score >= EARLY_STOP_THRESHOLD:
            break
    return best_score, best_scale

def process_url_local(url, crop_gray):
    try:
        small, full = url_to_cv2_fast_gray(url)
        if small is None:
            return url, -1.0, 1.0, "download_fail"
        # NO apliques aspecto duro aquí; ya lo filtramos en probe
        if full is None:
            return url, -1.0, 1.0, "full_decode_fail"
        fh, fw = full.shape[:2]
        ch, cw = crop_gray.shape[:2]
        scales = make_scales(fw, fh, cw, ch)
        score_e, scale_e = run_match_template_edges(full, crop_gray, scales)
        if score_e < 0.60:
            return url, score_e, scale_e, "edges_low"
        score, scale = best_multiscale_tm_score_local(full, crop_gray, scales)
        return url, score, scale, "ok"
    except Exception as e:
        return url, -1.0, 1.0, f"err:{type(e).__name__}"

# ----------------------------
# Crawler
# ----------------------------
def fetch_url(url):
    for attempt in range(max_retries):
        try:
            resp = session.get(url, headers=headers, verify=False, timeout=timeout)
            if resp.status_code == 200 and "text/html" in resp.headers.get("Content-Type", ""):
                try:
                    return url, BeautifulSoup(resp.text, "lxml")
                except Exception as parse_error:
                    print(f"⚠️ parse {url}: {parse_error}", file=sys.stderr)
                    return url, None
            elif attempt == max_retries - 1:
                if resp.status_code != 200:
                    print(f"ℹ️ non-200 {url} ({resp.status_code})", file=sys.stderr)
                elif "text/html" not in resp.headers.get("Content-Type", ""):
                    print(f"ℹ️ non-HTML {url}", file=sys.stderr)
            return url, None
        except requests.exceptions.Timeout:
            print(f"⏳ timeout {url} ({attempt+1}/{max_retries})", file=sys.stderr)
            time.sleep(0.35)
        except requests.RequestException as e:
            print(f"⚠️ net {url}: {e}", file=sys.stderr)
            time.sleep(0.55)
    print(f"⏭️ skip {url}", file=sys.stderr)
    return url, None

def _int_or_none(s):
    try:
        v = int(s)
        if v > 0:
            return v
    except:
        pass
    return None

DIM_IN_NAME_RE = re.compile(r'(\d{2,5})[xX×](\d{2,5})')

def estimate_dims_from_tag_or_name(img_tag, url):
    # 1) Atributos HTML
    w = _int_or_none(img_tag.get("width")) if hasattr(img_tag, "get") else None
    h = _int_or_none(img_tag.get("height")) if hasattr(img_tag, "get") else None
    # 2) Patrones en nombre de archivo (…-1024x768.jpg)
    m = DIM_IN_NAME_RE.search(url)
    if m and (w is None or h is None):
        w2, h2 = _int_or_none(m.group(1)), _int_or_none(m.group(2))
        if w is None: w = w2
        if h is None: h = h2
    return w, h

def crawler_worker(domain):
    global processed_pages
    while True:
        try:
            current_url = to_visit_queue.get(timeout=3.0)
        except queue.Empty:
            return
        try:
            with processed_pages_lock:
                if processed_pages >= max_pages:
                    to_visit_queue.task_done()
                    continue
                processed_pages += 1
                n = processed_pages
            if n % 25 == 0 or n == 1:
                print(f"[Crawler] Page #{n}/{max_pages} (Q={to_visit_queue.qsize()}) -> {current_url}", file=sys.stderr)
            url_fetched, soup = fetch_url(current_url)
            if soup:
                for a in soup.find_all("a", href=True):
                    href = a.get("href","")
                    if not href or href.startswith(('#','javascript:','mailto:','tel:')):
                        continue
                    link = urljoin(url_fetched, href)
                    p = urlparse(link)
                    if p.scheme in ('http','https') and p.netloc.endswith(domain):
                        link_norm = p._replace(fragment="").geturl()
                        if link_norm.lower().endswith(IGNORED_EXTENSIONS): continue
                        with visited_lock:
                            if link_norm not in visited:
                                visited.add(link_norm)
                                to_visit_queue.put(link_norm)
                for img in soup.find_all("img", src=True):
                    src = img.get("src","")
                    if not src: continue
                    u = urljoin(url_fetched, src)
                    p = urlparse(u)
                    if p.scheme in ('http','https') and p.path.lower().endswith(('.png','.jpg','.jpeg','.gif','.bmp','.webp')):
                        w,h = estimate_dims_from_tag_or_name(img, u)
                        ext = os.path.splitext(p.path.lower())[1]
                        with results_lock:
                            if u not in image_meta:
                                image_meta[u] = {"w": w, "h": h, "ext": ext, "from": url_fetched}
        except Exception as e:
            print(f"‼️ crawler error {current_url}: {e}", file=sys.stderr)
        finally:
            to_visit_queue.task_done()

def start_crawler(start_url):
    domain = urlparse(start_url).netloc.replace("www.","")
    visited.add(start_url)
    to_visit_queue.put(start_url)
    print("--- Starting crawler ---", file=sys.stderr)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=max_workers_crawler, thread_name_prefix="Crawler") as ex:
        for _ in range(max_workers_crawler):
            ex.submit(crawler_worker, domain)
    to_visit_queue.join()
    dt = time.time() - t0
    print(f"🏁 Crawler done in {dt:.2f}s | pages={processed_pages} | imgs={len(image_meta)}", file=sys.stderr)

# ----------------------------
# Prefiltro heurístico (sin descargar bytes)
# ----------------------------
def rank_and_cut_candidates(crop_w, crop_h):
    ar_crop = crop_w / max(1, crop_h)
    def ext_weight(ext):
        if ext in (".jpg", ".jpeg", ".png", ".webp"): return 0
        if ext in (".gif", ".bmp"): return 0.2
        return 0.3

    ranked = []
    for url, meta in image_meta.items():
        w = meta["w"]; h = meta["h"]; ext = meta["ext"]
        tiny_penalty = 0.0
        if w and h and (w*h < 120*120):
            tiny_penalty += 0.8
        if w and h:
            ar_img = (w / max(1,h))
            ar_diff = abs(ar_img - ar_crop)
        else:
            ar_diff = 0.35  # sin info, pequeña penalización
        epen = ext_weight(ext)
        score = ar_diff + tiny_penalty + epen
        ranked.append((score, url))

    ranked.sort(key=lambda x: x[0])
    return [u for _, u in ranked[:min(TOPK_CANDIDATES, len(ranked))]]

# ----------------------------
# PROBE de miniaturas (descarga ligera de TOP-K)
# ----------------------------
def probe_one(url, crop_gray, ar_crop, tol):
    # devolvemos: (keep_bool, score_pref, details_dict)
    # donde score_pref sirve para re-ordenar pre-MATCH (menor es mejor)
    b = url_to_bytes(url)
    if not b:
        return False, 9e9, {"url": url, "why":"download_fail"}

    small, full = decode_small_and_full(b)
    if small is None:
        return False, 9e9, {"url": url, "why":"decode_small_fail"}
    Hf, Wf = small.shape[:2]
    if Hf < 16 or Wf < 16:
        return False, 9e9, {"url": url, "why":"too_small"}

    # señales
    ar_img = Wf / max(1, Hf)
    ar_ratio = ar_img / max(1e-6, ar_crop)
    # hist sobre small vs crop resized
    ch, cw = crop_gray.shape[:2]
    # adaptamos crop al tamaño mínimo razonable
    tgt_w = min(Wf, max(32, cw))
    tgt_h = int(tgt_w * (ch/max(1,cw)))
    cand = cv2.resize(crop_gray, (tgt_w, max(8, tgt_h)), interpolation=cv2.INTER_AREA)
    hist = cheap_hist_sim(small, cand)
    edg  = edges_sum(small)
    lap  = lap_var(small)

    # si hist ya es medio decente, NO descartes por aspecto
    aspect_ok = (1 - tol <= ar_ratio <= 1 + tol) or (hist >= HIST_TOL_SKIP_ASPECT)

    # textura mínima
    texture_ok = (edg >= EDGE_MIN_PROBE) or (lap >= 3.5)

    if not aspect_ok:
        return False, 9e9, {"url": url, "why":f"aspect(ar={ar_img:.2f}, tol±{int(tol*100)}%)", "hist":round(hist,3)}

    if hist < HIST_THR_PROBE and not texture_ok:
        return False, 9e9, {"url": url, "why":"flat_or_low_hist", "hist":round(hist,3), "edges":edg, "lap":round(lap,2)}

    # score de preferencia: combina |ar_diff| + (1-hist) + penaliza baja textura
    ar_diff_score = abs(ar_ratio - 1.0)
    hist_score = 1.0 - max(0.0, min(1.0, hist))
    texture_pen = 0.15 if not texture_ok else 0.0
    pref = ar_diff_score*0.7 + hist_score*0.5 + texture_pen
    return True, pref, {"url":url, "w":Wf, "h":Hf, "hist":round(hist,3), "edges":edg, "lap":round(lap,2)}

def probe_candidates(candidates, crop_gray, ar_crop):
    # primera pasada con tolerancia base
    tol = max(ASPECT_REJECT_FLOOR, ASPECT_TOL_BASE)
    keep = []
    rejects = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS_FETCH) as ex:
        futs = {ex.submit(probe_one, u, crop_gray, ar_crop, tol): u for u in candidates}
        for i, fut in enumerate(as_completed(futs), 1):
            ok, pref, info = fut.result()
            if ok: keep.append((pref, info))
            else:  rejects.append(info)
            if i % 40 == 0 or i == len(candidates):
                dt = time.time() - t0
                rate = i / max(1e-6, dt)
                print(f"    [probe] {i}/{len(candidates)} en {dt:.1f}s ({rate:.1f}/s)", file=sys.stderr)

    ratio_kept = len(keep) / max(1, len(candidates))
    rej_aspect = sum(1 for r in rejects if str(r.get("why","")).startswith("aspect"))
    # si hemos tirado demasiadas por aspecto, abrimos tolerancia y reintentamos las rechazadas por aspecto
    if ratio_kept < 0.25 and rej_aspect > (0.5*len(candidates)) and tol < ASPECT_TOL_MAX:
        new_tol = min(ASPECT_TOL_MAX, tol * 1.75)
        print(f"🔁 Reintento probe con tolerancia de aspecto más amplia: ±{int(new_tol*100)}% (antes ±{int(tol*100)}%)", file=sys.stderr)
        to_retry = [r["url"] for r in rejects if str(r.get("why","")).startswith("aspect")]
        with ThreadPoolExecutor(max_workers=MAX_WORKERS_FETCH) as ex:
            futs = {ex.submit(probe_one, u, crop_gray, ar_crop, new_tol): u for u in to_retry}
            for fut in as_completed(futs):
                ok, pref, info = fut.result()
                if ok: keep.append((pref, info))

    keep.sort(key=lambda x: x[0])
    # nos quedamos con TOP-M
    keep = keep[:min(TOPM_AFTER_PROBE, len(keep))]
    print(f"🎯 Probe final: {len(keep)}/{len(candidates)} pasan a matching (TOP-M={TOPM_AFTER_PROBE}).", file=sys.stderr)
    return [k[1]["url"] for k in keep]

# ----------------------------
# (Remoto) Script GPU por LOTES
# ----------------------------
GPU_TASK_SCRIPT_BATCH = r"""#!/usr/bin/env python3
import sys, json, time, requests, cv2, numpy as np

PNG_SIG = b"\x89PNG\r\n\x1a\n"

def strip_png_exif_chunks(data: bytes) -> bytes:
    if not data.startswith(PNG_SIG):
        return data
    out = bytearray(); out += PNG_SIG
    i = len(PNG_SIG); n = len(data)
    while i + 12 <= n:
        length = int.from_bytes(data[i:i+4], "big")
        ctype  = data[i+4:i+8]
        chunk_data_start = i + 8
        chunk_data_end   = chunk_data_start + length
        crc_end          = chunk_data_end + 4
        if crc_end > n:
            return bytes(out)
        if ctype != b"eXIf":
            out += data[i:crc_end]
        i = crc_end
        if ctype == b"IEND":
            break
    return bytes(out)

SCALE_MIN=0.25; SCALE_MAX=1.50; N_SCALES=12; EARLY_STOP=0.92

def url_to_cv2_fast_gray(url, headers=None):
    for _ in range(2):
        try:
            r = requests.get(url, timeout=30, headers=headers or {"User-Agent":"Mozilla/5.0"}, verify=False)
            r.raise_for_status()
            b = r.content
            if b.startswith(PNG_SIG):
                b = strip_png_exif_chunks(b)
            npb = np.frombuffer(b, np.uint8)
            small = cv2.imdecode(npb, cv2.IMREAD_REDUCED_GRAYSCALE_4)
            full  = cv2.imdecode(npb, cv2.IMREAD_GRAYSCALE)
            return small, full
        except Exception:
            time.sleep(0.25)
    return None, None

def cheap_hist_sim(a_gray, b_gray):
    ha = cv2.calcHist([a_gray],[0],None,[32],[0,256]); cv2.normalize(ha, ha)
    hb = cv2.calcHist([b_gray],[0],None,[32],[0,256]); cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))

def quick_reject(img_small_gray, crop_gray, aspect_tol=0.20, min_edge=900, hist_thresh=0.15):
    Hf, Wf = img_small_gray.shape[:2]; Hc, Wc = crop_gray.shape[:2]
    ar_f = Wf / max(1, Hf); ar_c = Wc / max(1, Hc)
    ratio = ar_f / max(1e-6, ar_c)
    # evaluamos hist primero; si es bueno, no forzamos aspecto
    a = img_small_gray
    b = cv2.resize(crop_gray, (min(Wc, Wf), min(Hc, Hf))) if (Wc>Wf or Hc>Hf) else crop_gray
    ha = cv2.calcHist([a],[0],None,[32],[0,256]); cv2.normalize(ha, ha)
    hb = cv2.calcHist([b],[0],None,[32],[0,256]); cv2.normalize(hb, hb)
    sim = float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))
    if sim < 0.25:
        if not (1 - aspect_tol <= ratio <= 1 + aspect_tol): return True, "aspect"
        edges = cv2.Canny(img_small_gray, 80, 160)
        if int(edges.sum()) < min_edge: return True, "edges"
    return False, "pass"

def make_scales(fw, fh, cw, ch, smin=SCALE_MIN, smax=SCALE_MAX, n=N_SCALES):
    exp = min(fw/max(1,cw), fh/max(1,ch))
    lo = max(smin, min(0.7*exp, exp))
    hi = min(smax, max(1.3*exp, exp))
    if hi < lo: lo, hi = smin, min(smax, exp)
    steps = max(6, n//2)
    return np.geomspace(lo, hi, num=steps)

def run_match_edges(full_gray, crop_gray, scales):
    full_e = cv2.Canny(full_gray, 80, 160)
    crop_e = cv2.Canny(crop_gray, 80, 160)
    fh, fw = full_e.shape[:2]; ch, cw = crop_e.shape[:2]
    best, bscale = -1.0, 1.0
    for s in scales:
        sw, sh = int(cw*s), int(ch*s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh: continue
        ce = cv2.resize(crop_e, (sw, sh), interpolation=cv2.INTER_AREA if s<1.0 else cv2.INTER_CUBIC)
        res = cv2.matchTemplate(full_e, ce, cv2.TM_CCOEFF_NORMED)
        _, mv, _, _ = cv2.minMaxLoc(res)
        if mv > best: best, bscale = float(mv), float(s)
        if best >= EARLY_STOP: break
    return best, bscale

def run_match_int(full_gray, crop_gray, scales):
    fh, fw = full_gray.shape[:2]; ch, cw = crop_gray.shape[:2]
    best, bscale = -1.0, 1.0
    for s in scales:
        sw, sh = int(cw*s), int(ch*s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh: continue
        c = cv2.resize(crop_gray, (sw, sh), interpolation=cv2.INTER_AREA if s<1.0 else cv2.INTER_CUBIC)
        res = cv2.matchTemplate(full_gray, c, cv2.TM_CCOEFF_NORMED)
        _, mv, _, _ = cv2.minMaxLoc(res)
        if mv > best: best, bscale = float(mv), float(s)
        if best >= EARLY_STOP: break
    return best, bscale

def score_one(full_url, crop_gray):
    small, full = url_to_cv2_fast_gray(full_url)
    if small is None: return {"url": full_url, "score": -1.0, "scale": 1.0, "stage": "download_fail"}
    rej, reason = quick_reject(small, crop_gray)
    if rej: return {"url": full_url, "score": -1.0, "scale": 1.0, "stage": f"rej:{reason}"}
    if full is None: return {"url": full_url, "score": -1.0, "scale": 1.0, "stage": "decode_full_fail"}
    fh, fw = full.shape[:2]; ch, cw = crop_gray.shape[:2]
    scales = make_scales(fw, fh, cw, ch)
    sc_e, sca_e = run_match_edges(full, crop_gray, scales)
    if sc_e < 0.60:
        return {"url": full_url, "score": sc_e, "scale": sca_e, "stage": "edges_low"}
    sc_i, sca_i = run_match_int(full, crop_gray, scales)
    if sc_i >= sc_e:
        return {"url": full_url, "score": sc_i, "scale": sca_i, "stage": "int_done"}
    return {"url": full_url, "score": sc_e, "scale": sca_e, "stage": "edges_done"}

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error":"bad_argv","usage":"script <json_urls> <crop_path>"}))
        return
    urls = json.loads(sys.argv[1])
    crop_path = sys.argv[2]
    crop_bgr = cv2.imread(crop_path)
    if crop_bgr is None:
        print(json.dumps({"error":"crop_fail"})); return
    crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)

    out = []
    for u in urls:
        out.append(score_one(u, crop_gray))
    print(json.dumps(out))

if __name__ == "__main__":
    main()
"""

# ----------------------------
# Llamadas al servidor universal
# ----------------------------
def server_upload(local_path):
    ep = f"{SERVER_BASE}/upload"
    with open(local_path, "rb") as f:
        r = session.post(ep, files={"file": (os.path.basename(local_path), f)}, timeout=60)
    r.raise_for_status()
    return r.json()["file_path"]

def remote_exec(script_text, params):
    ep = f"{SERVER_BASE}/execute"
    payload = {"script_content": script_text, "params": params}
    r = session.post(ep, json=payload, timeout=1200)
    r.raise_for_status()
    return r.json()

# ----------------------------
# Main
# ----------------------------
def main():
    print(f"Server: {SERVER_BASE}  (remote_exec={'ON' if USE_REMOTE_EXEC else 'OFF'})", file=sys.stderr)

    if not os.path.exists(local_crop_path):
        print(json.dumps({"error":"crop_not_found"})); return
    crop_bgr = cv2.imread(local_crop_path)
    if crop_bgr is None:
        print(json.dumps({"error":"crop_open_fail"})); return
    ch, cw = crop_bgr.shape[:2]
    crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    ar_crop = cw / max(1,ch)

    # 1) CRAWL
    start_crawler(start_url)
    total_found = len(image_meta)
    if total_found == 0:
        print(json.dumps({"best_url": None, "score": -1.0, "scale": 1.0, "images_processed": 0, "total_images_found": 0}))
        return

    # 2) PREFILTRO HEURÍSTICO (rápido, sin descargar)
    candidates = rank_and_cut_candidates(cw, ch)
    print(f"🎯 Prefiltro: {len(candidates)}/{total_found} candidatos tras heurística.", file=sys.stderr)

    # 3) PROBE de miniaturas (descargar reducido) → TOP-M
    candidates2 = probe_candidates(candidates, crop_gray, ar_crop)
    if not candidates2:
        print(json.dumps({
            "best_url": None,
            "score": -1.0,
            "scale": 1.0,
            "images_processed": 0,
            "total_images_found": total_found,
            "candidates_after_prefilter": len(candidates),
            "candidates_after_probe": 0,
            "time_seconds": 0.0
        }))
        return

    # 4) SUBIR CROP UNA VEZ (si remoto)
    crop_remote = None
    if USE_REMOTE_EXEC:
        try:
            crop_remote = server_upload(local_crop_path)
            print(f"✅ Crop remoto en: {crop_remote}", file=sys.stderr)
        except Exception as e:
            print(f"⚠️ upload crop failed: {e}", file=sys.stderr)

    best_score, best_url, best_scale = -1.0, None, 1.0
    processed = 0
    t0 = time.time()

    if USE_REMOTE_EXEC and crop_remote:
        # MATCHING REMOTO EN LOTES (sobre candidatos2)
        def chunks(lst, n):
            for i in range(0, len(lst), n):
                yield lst[i:i+n]

        with ThreadPoolExecutor(max_workers=MAX_WORKERS_MATCH) as ex:
            futs = []
            for batch in chunks(candidates2, BATCH_SIZE):
                futs.append(ex.submit(remote_exec, GPU_TASK_SCRIPT_BATCH, [json.dumps(batch), crop_remote]))
            for fut in as_completed(futs):
                try:
                    arr = fut.result()
                    if isinstance(arr, dict) and "stdout" in arr:
                        arr = json.loads(arr.get("stdout","[]"))
                except Exception as e:
                    arr = []
                for item in arr:
                    processed += 1
                    sc = float(item.get("score",-1.0))
                    sca = float(item.get("scale",1.0))
                    stage = item.get("stage","n/a")
                    u = item.get("url")
                    if processed % 25 == 0 or processed == len(candidates2):
                        dt = time.time() - t0
                        rate = processed / max(1e-6, dt)
                        print(f"    ... ⏳ {processed}/{len(candidates2)} ({dt:.1f}s, {rate:.1f} img/s) stage={stage}", file=sys.stderr)
                    if sc > best_score:
                        best_score, best_url, best_scale = sc, u, sca
                        print(f"🔥 REMOTE new best: {best_url} (score={best_score:.3f}, scale={best_scale:.3f}, stage={stage})", file=sys.stderr)
    else:
        # MATCHING LOCAL (CPU) — sólo sobre TOP-M
        with ThreadPoolExecutor(max_workers=MAX_WORKERS_MATCH) as ex:
            fut2url = {ex.submit(process_url_local, u, crop_gray): u for u in candidates2}
            for fut in as_completed(fut2url):
                u, sc, sca, stage = fut.result()
                processed += 1
                if processed % 25 == 0 or processed == len(candidates2):
                    dt = time.time() - t0
                    rate = processed / max(1e-6, dt)
                    print(f"    ... ⏳ {processed}/{len(candidates2)} ({dt:.1f}s, {rate:.1f} img/s) stage={stage}", file=sys.stderr)
                if sc > best_score:
                    best_score, best_url, best_scale = sc, u, sca
                    print(f"🔥 LOCAL new best: {best_url} (score={best_score:.3f}, scale={best_scale:.3f}, stage={stage})", file=sys.stderr)

    dt = time.time() - t0
    print(f"--- Matching finished in {dt:.2f}s ---", file=sys.stderr)
    print(json.dumps({
        "best_url": best_url,
        "score": round(float(best_score), 3),
        "scale": round(float(best_scale), 3),
        "images_processed": processed,
        "total_images_found": total_found,
        "candidates_after_prefilter": len(candidates),
        "candidates_after_probe": len(candidates2),
        "time_seconds": round(dt, 2)
    }))

if __name__ == "__main__":
    main()
