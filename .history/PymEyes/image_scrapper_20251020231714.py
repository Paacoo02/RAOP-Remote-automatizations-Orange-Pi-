#!/usr/bin/env python3

# =======================================================
# --- Imports (Se necesitan todos localmente) ---
# =======================================================
import cv2
import numpy as np
import requests
from io import BytesIO
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib3
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import time
import tempfile
import subprocess
import os
import json
import sys
import queue
import threading

# =======================================================
# 🔥 TAREA GPU (OBRERO) - Definida como String 🔥
# =======================================================
# Este es el script que se enviará al endpoint /execute de Colab.
# Contiene su propio código y lógica, autocontenido.

GPU_TASK_SCRIPT = """
#!/usr/bin/env python3
import sys
import json
import requests
import cv2
import numpy as np
from PIL import Image
import io
import time

# --- Constantes (deben coincidir con el modo CPU) ---
SCALE_MIN = 0.25
SCALE_MAX = 1.50
N_SCALES = 12
EARLY_STOP_THRESHOLD = 0.92

# --- Funciones de Ayuda (Autocontenidas) ---

def url_to_cv2(url: str):
    """Descarga una URL y la convierte a un objeto cv2 BGR."""
    try:
        # Añadido reintento simple para esta función
        for _ in range(2): # 2 intentos
            try:
                resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"}, verify=False)
                resp.raise_for_status()
                img_bytes = resp.content
                img_np = np.frombuffer(img_bytes, np.uint8)
                img_bgr = cv2.imdecode(img_np, cv2.IMREAD_COLOR)
                if img_bgr is None:
                     img_pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                     img_bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
                if img_bgr is not None:
                     return img_bgr
            except requests.exceptions.RequestException:
                time.sleep(1) # Esperar 1s antes de reintentar
        # Si ambos intentos fallan, se lanza la excepción
        raise ValueError(f"Fallaron 2 intentos de descarga para {url}")

    except Exception as e:
        print(f"Error en url_to_cv2({url}): {e}", file=sys.stderr)
        return None

def run_match_template(full_gray, crop_gray):
    """Realiza el matchTemplate multiescala."""
    fh, fw = full_gray.shape[:2]
    ch, cw = crop_gray.shape[:2]
    if ch > fh or cw > fw:
        max_scale_effective = min(SCALE_MAX, fw / cw, fh / ch)
        if max_scale_effective < SCALE_MIN: return -1.0, 1.0
        scales = np.geomspace(SCALE_MIN, max_scale_effective, num=N_SCALES)
    else:
        scales = np.geomspace(SCALE_MIN, SCALE_MAX, num=N_SCALES)
    
    best_score = -1.0
    best_scale = 1.0
    for s in scales:
        sw, sh = int(cw * s), int(ch * s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh: continue
        interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_CUBIC
        try:
             crop_s = cv2.resize(crop_gray, (sw, sh), interpolation=interp)
             if crop_s is None or crop_s.size == 0: continue
             res = cv2.matchTemplate(full_gray, crop_s, cv2.TM_CCOEFF_NORMED)
             _, max_val, _, _ = cv2.minMaxLoc(res)
             if max_val > best_score:
                 best_score = max_val
                 best_scale = s
             if best_score >= EARLY_STOP_THRESHOLD: break
        except Exception:
            continue
    return best_score, best_scale

# --- Función Principal del Script de Tarea ---
def main_task(full_image_url, crop_image_url):
    """Función principal que será ejecutada en Colab."""
    try:
        full_bgr = url_to_cv2(full_image_url)
        if full_bgr is None:
            raise ValueError(f"No se pudo cargar la imagen completa de {full_image_url}")
        full_gray = cv2.cvtColor(full_bgr, cv2.COLOR_BGR2GRAY)
        
        crop_bgr = url_to_cv2(crop_image_url)
        if crop_bgr is None:
             raise ValueError(f"No se pudo cargar la imagen crop de {crop_image_url}")
        crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)

        score, scale = run_match_template(full_gray, crop_gray)
        
        return {"score": float(score), "scale": float(scale), "error": None}
    except Exception as e:
        print(f"Error en main_task: {e}", file=sys.stderr)
        return {"score": -1.0, "scale": 1.0, "error": str(e)}

if __name__ == "__main__":
    # Este 'if' SÍ se ejecutará, pero DENTRO de Colab
    if len(sys.argv) != 3:
        print(json.dumps({
            "error": f"Uso incorrecto (en Colab). Se esperaban 2 argumentos (full_url, crop_url), se recibieron {len(sys.argv) - 1}",
            "score": -1.0, "scale": 1.0
        }))
        sys.exit(1)
    
    arg_full_url = sys.argv[1]
    arg_crop_url = sys.argv[2]
    
    result_json = main_task(arg_full_url, arg_crop_url)
    print(json.dumps(result_json)) # Devuelve el JSON al servidor de Colab
"""
# =======================================================
# --- FIN DE LA TAREA GPU (OBRERO) ---
# =======================================================


# =======================================================
# --- COMIENZO DEL "DIRECTOR" (Lógica Local) ---
# =======================================================

# --- Parameters ---
if len(sys.argv) != 4:
    print(f"Usage: python3 {sys.argv[0]} <start_url> <image_path_or_url> <gpu_worker_url_or_NONE>", file=sys.stderr)
    sys.exit(1)

# ¡Estos son los 3 argumentos que recibe de app.js!
start_url = sys.argv[1]
image_path_or_url = sys.argv[2] # Esta es la imagen a BUSCAR
GPU_WORKER_URL = sys.argv[3]    # <-- ¡AQUÍ ESTÁ LA URL DE CLOUDFLARE!

# --- Mode Detection ---
USE_GPU = GPU_WORKER_URL.lower().startswith("http")

# --- Constants ---
MAX_WORKERS = 16 # Workers para llamadas de red/GPU
SCALE_MIN = 0.25
SCALE_MAX = 1.50
N_SCALES = 12
EARLY_STOP_THRESHOLD = 0.92

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --- Configuration ---
print(f"Initializing crawler for: {start_url}", file=sys.stderr)
print(f"Target image: {image_path_or_url}", file=sys.stderr)
if USE_GPU:
    print(f"Mode: GPU (Remote Worker: {GPU_WORKER_URL})", file=sys.stderr)
else:
    print(f"Mode: CPU (Local OpenCV)", file=sys.stderr)

domain = urlparse(start_url).netloc.replace("www.", "")
headers = {"User-Agent": "Mozilla/5.0"}
max_retries = 3
timeout = 20 # Timeout para el crawler
max_pages = 500
max_workers_crawler = 10


# --- Funciones de Ayuda (Comunes) ---

def fetch_url(url):
    """(Common) Downloads HTML from a page."""
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, headers=headers, verify=False, timeout=timeout)
            if resp.status_code == 200 and "text/html" in resp.headers.get("Content-Type", ""):
                 try:
                    return url, BeautifulSoup(resp.text, "lxml")
                 except Exception as parse_error:
                    print(f"⚠️ Error parsing HTML from {url}: {parse_error}", file=sys.stderr)
                    return url, None
            elif attempt == max_retries - 1:
                 if resp.status_code != 200:
                      print(f"ℹ️ Skipping non-200 page {url} (Status: {resp.status_code})", file=sys.stderr)
                 elif "text/html" not in resp.headers.get("Content-Type", ""):
                      print(f"ℹ️ Skipping non-HTML content {url} (Type: {resp.headers.get('Content-Type', 'N/A')})", file=sys.stderr)
            return url, None
        except requests.exceptions.Timeout:
             print(f"⏳ Timeout on {url}, attempt {attempt+1}/{max_retries}", file=sys.stderr)
             if attempt < max_retries - 1: time.sleep(1)
        except requests.exceptions.RequestException as e:
            print(f"⚠️ Network error on {url} ({type(e).__name__}), attempt {attempt+1}/{max_retries}", file=sys.stderr)
            if attempt < max_retries - 1: time.sleep(2)
    print(f"⏭️ Skipping {url} after {max_retries} failed attempts", file=sys.stderr)
    return url, None

def url_to_bytes(url):
    """(Common) Downloads a URL and returns its content as bytes."""
    for attempt in range(3):
        try:
            resp = requests.get(url, timeout=45, headers=headers, verify=False)
            resp.raise_for_status()
            return resp.content
        except requests.exceptions.RequestException as e:
            print(f"⚠️ Error downloading bytes from {url} (attempt {attempt+1}/3): {e}", file=sys.stderr)
            if attempt < 2: time.sleep(2)
    print(f"❌ Failed to download bytes from {url} after 3 attempts", file=sys.stderr)
    return None

# --- GPU Mode Function (Genérica) ---

def process_url_generic_gpu(full_image_url, script_content_str, crop_image_url_str, gpu_endpoint):
    """
    (GPU Mode) Envía un script genérico y sus parámetros al endpoint /execute.
    """
    payload = {
        "script_content": script_content_str, # El string gigante GPU_TASK_SCRIPT
        "params": [
            full_image_url,       # Se convertirá en sys.argv[1] en Colab
            crop_image_url_str    # Se convertirá en sys.argv[2] en Colab
        ]
    }
    try:
        # Timeout del cliente > timeout del servidor (300s)
        response = requests.post(gpu_endpoint, json=payload, timeout=320) 
        response.raise_for_status()
        result_data = response.json()
        if result_data.get("error"):
            # Esto es un error LÓGICO devuelto por el script "Obrero"
            print(f" E GPU Worker (Script) error for {full_image_url}: {result_data['error']}", file=sys.stderr)
            return full_image_url, -1.0, 1.0
        return full_image_url, result_data.get("score", -1.0), result_data.get("scale", 1.0)
    
    except requests.exceptions.HTTPError as http_err:
        # Esto es un error del SERVIDOR (ej: 404, 500, 408 Timeout)
        try:
            err_details = http_err.response.json()
            print(f"❌ HTTP {http_err.response.status_code} llamando a GPU Worker para {full_image_url}. Error: {err_details.get('error')} Stderr: {err_details.get('stderr')}", file=sys.stderr)
        except:
            print(f"❌ HTTP {http_err.response.status_code} llamando a GPU Worker para {full_image_url}. Respuesta: {http_err.response.text}", file=sys.stderr)
        return full_image_url, -1.0, 1.0
    except requests.exceptions.Timeout:
        print(f"⏳ Timeout (320s) llamando a GPU Worker para {full_image_url}", file=sys.stderr)
        return full_image_url, -1.0, 1.0
    except Exception as e:
         print(f" E Error inesperado en process_url_generic_gpu para {full_image_url}: {type(e).__name__} - {e}", file=sys.stderr)
         return full_image_url, -1.0, 1.0

# --- CPU Mode Functions (Locales) ---

def url_to_cv2_local(url):
    """(CPU Mode) Downloads URL and returns a cv2 image object."""
    img_bytes = url_to_bytes(url)
    if img_bytes is None: return None
    try:
        img_np = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(img_np, cv2.IMREAD_COLOR)
        if img_bgr is None:
             img_pil = Image.open(BytesIO(img_bytes)).convert("RGB")
             img_bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
        return img_bgr
    except Exception as e:
        print(f"⚠️ (CPU) Error decoding image {url}: {e}", file=sys.stderr)
        return None

def best_multiscale_tm_score_local(full_gray, crop_gray):
    """(CPU Mode) Performs multiscale template matching using local CPU."""
    fh, fw = full_gray.shape[:2]
    ch, cw = crop_gray.shape[:2]
    if ch > fh or cw > fw:
        max_scale_effective = min(SCALE_MAX, fw / cw, fh / ch)
        if max_scale_effective < SCALE_MIN:
             return -1.0, 1.0
        scales = np.geomspace(SCALE_MIN, max_scale_effective, num=N_SCALES)
    else:
        scales = np.geomspace(SCALE_MIN, SCALE_MAX, num=N_SCALES)
    best_score = -1.0
    best_scale = 1.0
    for s in scales:
        sw, sh = int(cw * s), int(ch * s)
        if sw < 8 or sh < 8 or sw > fw or sh > fh: continue
        interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_CUBIC
        try:
             crop_s = cv2.resize(crop_gray, (sw, sh), interpolation=interp)
             if crop_s is None or crop_s.size == 0: continue
             res = cv2.matchTemplate(full_gray, crop_s, cv2.TM_CCOEFF_NORMED)
             _, max_val, _, _ = cv2.minMaxLoc(res)
             if max_val > best_score:
                 best_score = max_val
                 best_scale = s
             if best_score >= EARLY_STOP_THRESHOLD: break
        except Exception as e:
            continue
    return best_score, best_scale

def process_url_local(url, crop_gray):
    """(CPU Mode) Full processing pipeline using local CPU."""
    full = url_to_cv2_local(url)
    if full is None or full.size == 0: return url, -1.0, 1.0
    try:
        full_gray = cv2.cvtColor(full, cv2.COLOR_BGR2GRAY)
        if crop_gray is None or crop_gray.size == 0:
             print(f"❌ (CPU) Critical Error: Reference crop image (crop_gray) is empty.", file=sys.stderr)
             return url, -1.0, 1.0
        score, scale = best_multiscale_tm_score_local(full_gray, crop_gray)
    except Exception as e:
         print(f"⚠️ (CPU) OpenCV error processing {url}: {e}", file=sys.stderr)
         return url, -1.0, 1.0
    return url, score, scale

# =======================================================
# --- CRAWLER (Lógica del Director) ---
# =======================================================

# --- Variables Globales del Crawler ---
to_visit_queue = queue.Queue()
visited = set([start_url]) # Empezar con la URL inicial ya visitada
visited_lock = threading.Lock()
results_lock = threading.Lock()
processed_pages = 0
processed_pages_lock = threading.Lock()
all_urls = set()
all_images = set()
# --- Fin Variables Globales ---

to_visit_queue.put(start_url) # Poner el primer trabajo en la cola

def crawler_worker():
    """
    Función worker que toma URLs de la cola, las procesa y añade nuevas
    URLs encontradas de vuelta a la cola.
    """
    global processed_pages # Usar las variables globales

    while True:
        try:
            # 1. Obtener una URL de la cola
            current_url = to_visit_queue.get(timeout=3.0)
        except queue.Empty:
            # Cola vacía, el trabajo de este hilo ha terminado
            return

        # 2. Comprobar el límite de páginas (de forma segura)
        with processed_pages_lock:
            if processed_pages >= max_pages:
                to_visit_queue.task_done() # Marcar como hecha para 'join()'
                continue # Seguir vaciando la cola sin procesar
            processed_pages += 1
            current_page_num = processed_pages

        # Imprimir progreso
        if current_page_num % 25 == 0 or current_page_num == 1:
            print(f"  [Crawler] Processing #{current_page_num}/{max_pages} (Queue: {to_visit_queue.qsize()}) -> {current_url}", file=sys.stderr)

        # 3. Procesar la URL (usando la función de ayuda existente)
        url_fetched, soup = fetch_url(current_url)

        if soup:
            # 4. Encontrar Links (<a>)
            for a in soup.find_all("a", href=True):
                try:
                    link_raw = a.get("href", "")
                    if not link_raw or link_raw.startswith(('#', 'javascript:', 'mailto:', 'tel:')):
                        continue
                    link = urljoin(url_fetched, link_raw)
                    parsed_link = urlparse(link)

                    # Quedarse solo en el dominio
                    if parsed_link.scheme in ['http', 'https'] and parsed_link.netloc.endswith(domain):
                        link_normalized = parsed_link._replace(fragment="").geturl()
                        
                        should_add = False
                        with visited_lock:
                            if link_normalized not in visited:
                                visited.add(link_normalized)
                                should_add = True
                        
                        if should_add:
                            to_visit_queue.put(link_normalized) # ¡Añadir nuevo trabajo!
                except Exception:
                    pass

            # 5. Encontrar Imágenes (<img>)
            for img in soup.find_all("img", src=True):
                 try:
                    img_src = img.get("src", "")
                    if not img_src: continue
                    img_url = urljoin(url_fetched, img_src)
                    parsed_img_url = urlparse(img_url)
                    if parsed_img_url.scheme in ['http', 'https] and parsed_img_url.path.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                         with results_lock:
                             all_images.add(img_url)
                 except Exception:
                     pass

            # 6. (Opcional) Guardar URLs visitadas
            with results_lock:
                all_urls.add(url_fetched)

        # 7. Marcar la tarea como completada
        to_visit_queue.task_done()

# --- Lanzar el Pool de Workers del Crawler ---
print("--- Starting Crawler (Concurrent Queue Model) ---", file=sys.stderr)
crawl_start_time = time.time()
with ThreadPoolExecutor(max_workers=max_workers_crawler, thread_name_prefix="Crawler_") as executor:
    for _ in range(max_workers_crawler):
        executor.submit(crawler_worker)
    
    print(f"--- {max_workers_crawler} workers iniciados. Esperando a que la cola se procese... ---", file=sys.stderr)
    to_visit_queue.join()
    print("--- Cola de crawling completada. ---", file=sys.stderr)

crawl_elapsed = time.time() - crawl_start_time
print(f"\n🏁 Crawler finished in {crawl_elapsed:.2f} seconds.", file=sys.stderr)
print(f"  Total pages processed: {processed_pages}", file=sys.stderr)
print(f"  Total unique Images found: {len(all_images)}", file=sys.stderr)

# =======================================================
# --- FUNCIÓN 'main' (Lógica del Director) ---
# =======================================================
def main(target_path, gpu_url):
    """
    Función principal que gestiona el matching (CPU o GPU)
    después de que el crawler haya finalizado.
    """
    print("--- Entered main() function (All-in-One) ---", file=sys.stderr) 

    # 1. Cargar Datos/Template según el modo
    crop_data = None
    error_msg = None
    gpu_task_script_content = "" # Variable para el script del "Obrero"

    if USE_GPU:
        print(f"--- Initializing Matching (Mode: GPU) ---", file=sys.stderr)
        # --- ¡CAMBIO AQUÍ! ---
        # En lugar de leer un archivo, usamos la variable de este mismo script
        gpu_task_script_content = GPU_TASK_SCRIPT
        print(f"ℹ️ Usando script de tarea GPU incrustado.", file=sys.stderr)
        
        # 'target_path' (sys.argv[2]) es la imagen a buscar.
        # Debe ser una URL para que el script "Obrero" pueda descargarla.
        crop_data = target_path 
        if not target_path.startswith("http"):
            print(f"⚠️ ADVERTENCIA: El modo GPU genérico espera una URL para la imagen a buscar (target_path),", file=sys.stderr)
            print(f"⚠️ pero recibió lo que parece ser una ruta local: {target_path}", file=sys.stderr)
            print(f"⚠️ ... esto fallará si el script 'Obrero' en Colab no puede acceder a ella.", file=sys.stderr)
            # Si 'target_path' es un archivo (ej: /tmp/...), esta arquitectura
            # necesitaría un paso extra para subirlo a un host (ej: imgbb)
            # o modificar el servidor de Colab para aceptar la subida de 2 archivos.
            # Por simplicidad, asumimos que 'target_path' ES una URL accesible.

    else:
        # El modo CPU funciona con la ruta local O una URL, esto está bien
        print(f"--- Initializing Matching (Mode: CPU) ---", file=sys.stderr)
        crop_obj_bgr = None
        if os.path.exists(target_path):
            print(f"ℹ️ Reading local template image (cv2): {target_path}", file=sys.stderr)
            try: crop_obj_bgr = cv2.imread(target_path)
            except Exception as e: error_msg = f"Error reading local template (cv2) {target_path}: {e}"
        else:
            # El modo CPU también puede descargar si no es una ruta local
            print(f"ℹ️ Downloading remote template image (cv2): {target_path}", file=sys.stderr)
            crop_obj_bgr = url_to_cv2_local(target_path)

        if crop_obj_bgr is not None:
            try:
                crop_data = cv2.cvtColor(crop_obj_bgr, cv2.COLOR_BGR2GRAY)
            except Exception as e: error_msg = f"Error converting template image to grayscale: {e}"
        elif not error_msg: error_msg = f"Failed to load template image (cv2): {target_path}"

    # 2. Handle Template/Datos Loading Error
    if crop_data is None:
        final_error = error_msg or f"Could not load template data (image path: {target_path})."
        print(f"❌ {final_error}", file=sys.stderr)
        return json.dumps({"best_url": None, "score": -1.0, "scale": 1.0, "error": final_error})

    # 3. Obtener lista de URLs del crawler
    # (El crawler ya guardó las imágenes en la variable global 'all_images')
    urls = sorted(list(all_images))
    total_images_in_file = len(urls)

    if not urls:
        print("❌ No valid image URLs found by crawler to compare.", file=sys.stderr)
        return json.dumps({ "best_url": None, "score": -1.0, "scale": 1.0, "images_processed": 0, "total_images_found": 0, "error": "No image URLs found by crawler."})

    # 4. Ejecutar Matching
    print(f"--- Comparing against {len(urls)} images ---", file=sys.stderr)
    match_start_time = time.time()
    best_score = -1.0
    best_url = None
    best_scale = 1.0
    processed_count = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        if USE_GPU:
            # ¡El endpoint es /execute! (Usando la URL de Cloudflare de sys.argv[3])
            gpu_endpoint = urljoin(gpu_url, "/execute") 
            print(f"Submitting {len(urls)} tasks to GPU Executor at {gpu_endpoint}", file=sys.stderr)
            # crop_data (GPU) contiene la URL de la imagen crop (target_path)
            future_to_url = {
                executor.submit(process_url_generic_gpu, url, gpu_task_script_content, crop_data, gpu_endpoint): url
                for url in urls
            }
        else:
            print(f"Submitting {len(urls)} tasks for local CPU processing", file=sys.stderr)
            # crop_data (CPU) contiene el objeto cv2 (crop_gray)
            future_to_url = { executor.submit(process_url_local, url, crop_data): url for url in urls }

        # 5. Recolectar resultados
        print("--- Waiting for matching results ---", file=sys.stderr)
        for future in as_completed(future_to_url):
            url_processed = future_to_url[future]
            processed_count += 1
            try:
                _, score, scale = future.result()
                if processed_count % 50 == 0 or processed_count == total_images_in_file :
                    current_time = time.time()
                    elapsed = current_time - match_start_time
                    rate = processed_count / elapsed if elapsed > 0 else 0
                    print(f"    ... ⏳ Progress: {processed_count}/{total_images_in_file} images processed ({elapsed:.1f}s, {rate:.1f} img/s).", file=sys.stderr)
                if score > best_score:
                    best_score = score
                    best_url = url_processed
                    best_scale = scale
                    print_mode = "(GPU)" if USE_GPU else "(CPU)"
                    print(f"🔥 {print_mode} New best match ({processed_count}/{total_images_in_file}): {best_url} (Score: {best_score:.3f}, Scale: {best_scale:.3f})", file=sys.stderr)
            except Exception as exc:
                print(f"⚠️ Error retrieving result for image {url_processed}: {exc}", file=sys.stderr)

    match_elapsed = time.time() - match_start_time
    print(f"--- Matching phase completed in {match_elapsed:.2f} seconds ---", file=sys.stderr)

    # 6. Devolver JSON Final
    final_result = {
        "best_url": best_url if best_url else None,
        "score": round(float(best_score), 3) if best_score > -1 else -1.0,
        "scale": round(float(best_scale), 3) if best_scale != 1.0 or best_score > -1 else 1.0,
        "images_processed": processed_count,
        "total_images_found": total_images_in_file,
        "time_seconds": round(match_elapsed, 2)
    }
    return json.dumps(final_result)


# =======================================================
# --- PUNTO DE ENTRADA PRINCIPAL (Lógica del Director) ---
# =======================================================
if __name__ == "__main__":
    # Este 'if' SÍ se ejecutará, en la máquina LOCAL
    
    # El crawler se ejecuta primero y llena la variable global 'all_images'
    
    # image_path_or_url (sys.argv[2]) es la imagen a buscar
    # GPU_WORKER_URL (sys.argv[3]) es la URL de Colab
    
    # Pasamos los args directamente a main()
    final_json_output = main(
        image_path_or_url, # target_path (la imagen a buscar)
        GPU_WORKER_URL     # gpu_url (la URL de Colab)
    )
    
    # Imprime el JSON final que leerá app.js
    print(final_json_output) 

    print("--- Script local finalizado ---", file=sys.stderr)