import cv2
import numpy as np
import requests
from io import BytesIO
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib3
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from collections import deque
import time
import tempfile
import subprocess
import os
import json
import sys

# --- Parameters ---
# Accepts 3 arguments (3rd can be "NONE")
if len(sys.argv) != 4:
    print(f"Usage: python3 {sys.argv[0]} <start_url> <image_path> <gpu_worker_url_or_NONE>", file=sys.stderr)
    sys.exit(1)

start_url = sys.argv[1]
image_path_or_url = sys.argv[2]
GPU_WORKER_URL = sys.argv[3]    # Can be "http://..." or "NONE"
# --- End Parameter Modification ---


# --- Mode Detection ---
USE_GPU = GPU_WORKER_URL.lower().startswith("http")


# --- Constants ---
MAX_WORKERS = 16 # Workers for network/GPU calls
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
    print(f"Mode: CPU (Local OpenCV, GPU Worker not provided or invalid)", file=sys.stderr)

domain = urlparse(start_url).netloc.replace("www.", "")
headers = {"User-Agent": "Mozilla/5.0"}
max_retries = 3
timeout = 20 # Timeout for crawler requests (seconds)
max_pages = 500 # Max pages for crawler
max_workers_crawler = 10 # Workers specifically for crawling HTML

visited = set()
to_visit = deque([start_url])
all_urls = set()
all_images = set()

# --- Helper Functions (Common) ---

def fetch_url(url):
    """(Common) Downloads HTML from a page."""
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, headers=headers, verify=False, timeout=timeout)
            # Process only successful HTML responses
            if resp.status_code == 200 and "text/html" in resp.headers.get("Content-Type", ""):
                 try:
                    # Use lxml for faster parsing if available
                    return url, BeautifulSoup(resp.text, "lxml")
                 except Exception as parse_error:
                    print(f"⚠️ Error parsing HTML from {url}: {parse_error}", file=sys.stderr)
                    return url, None # Parsing failed
            # Log skipped non-HTML pages only on the last attempt
            elif attempt == max_retries - 1:
                 if resp.status_code != 200:
                      print(f"ℹ️ Skipping non-200 page {url} (Status: {resp.status_code})", file=sys.stderr)
                 elif "text/html" not in resp.headers.get("Content-Type", ""):
                      print(f"ℹ️ Skipping non-HTML content {url} (Type: {resp.headers.get('Content-Type', 'N/A')})", file=sys.stderr)
            return url, None # Not HTML or not 200 (within retries)
        except requests.exceptions.Timeout:
             print(f"⏳ Timeout on {url}, attempt {attempt+1}/{max_retries}", file=sys.stderr)
             if attempt < max_retries - 1: time.sleep(1) # Wait before retry
        except requests.exceptions.RequestException as e:
            print(f"⚠️ Network error on {url} ({type(e).__name__}), attempt {attempt+1}/{max_retries}", file=sys.stderr)
            if attempt < max_retries - 1: time.sleep(2) # Wait longer for other errors
    print(f"⏭️ Skipping {url} after {max_retries} failed attempts", file=sys.stderr)
    return url, None # Failed after retries

def url_to_bytes(url):
    """(Common / GPU Mode) Downloads a URL and returns its content as bytes."""
    for attempt in range(3): # Separate retry logic for images
        try:
            # Increased timeout for potentially large images
            resp = requests.get(url, timeout=45, headers=headers, verify=False)
            resp.raise_for_status() # Check for HTTP errors
            return resp.content
        except requests.exceptions.RequestException as e:
            print(f"⚠️ Error downloading bytes from {url} (attempt {attempt+1}/3): {e}", file=sys.stderr)
            if attempt < 2: time.sleep(2) # Wait before retrying image download
    print(f"❌ Failed to download bytes from {url} after 3 attempts", file=sys.stderr)
    return None

# --- GPU Mode Functions ---

def process_url_gpu(full_image_url, crop_image_bytes, gpu_endpoint):
    """(GPU Mode) Delegates matching to a remote GPU worker.
       Sends full_image_url as data, uploads only crop_image_bytes.
    """
    # Prepare form data (URL) and file upload (crop image bytes)
    data = {'full_image_url': full_image_url}
    files = {'crop_image': ('crop_image.jpg', crop_image_bytes, 'image/jpeg')} # Assume JPEG, adjust if needed

    try:
        # Send request to GPU worker with a long timeout
        response = requests.post(gpu_endpoint, data=data, files=files, timeout=120) # 2 min timeout for cold start + processing
        response.raise_for_status() # Check for HTTP errors (4xx, 5xx)

        result_data = response.json()

        # Check if the worker itself reported an error
        if result_data.get("error"):
            print(f" E GPU Worker error for {full_image_url}: {result_data['error']}", file=sys.stderr)
            return full_image_url, -1.0, 1.0 # Treat worker error as no match

        score = result_data.get("score", -1.0)
        scale = result_data.get("scale", 1.0)

        return full_image_url, score, scale

    except requests.exceptions.Timeout:
        print(f"⏳ Timeout calling GPU Worker for {full_image_url}", file=sys.stderr)
        return full_image_url, -1.0, 1.0 # Timeout is like no match
    except requests.exceptions.RequestException as e:
        print(f"❌ Network error calling GPU Worker for {full_image_url}: {e}", file=sys.stderr)
        return full_image_url, -1.0, 1.0 # Network error is like no match
    except json.JSONDecodeError:
        print(f"❌ GPU Worker returned non-JSON response for {full_image_url}.", file=sys.stderr)
        return full_image_url, -1.0, 1.0 # Bad response is like no match
    except Exception as e: # Catch any other unexpected errors during the call
         print(f" E Unexpected error in process_url_gpu for {full_image_url}: {type(e).__name__} - {e}", file=sys.stderr)
         return full_image_url, -1.0, 1.0


# --- CPU Mode Functions ---

def url_to_cv2_local(url):
    """(CPU Mode) Downloads URL and returns a cv2 image object."""
    img_bytes = url_to_bytes(url) # Use common byte downloader first
    if img_bytes is None:
        return None
    try:
        # Decode bytes to cv2 image using numpy and imdecode
        img_np = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(img_np, cv2.IMREAD_COLOR)

        # Fallback using PIL if imdecode fails (handles more formats sometimes)
        if img_bgr is None:
             print(f"ℹ️ cv2.imdecode failed for {url}, trying PIL...", file=sys.stderr)
             # Check if bytes look like SVG before trying PIL
             try:
                 if b'<svg' in img_bytes[:100]: # Quick check for SVG tag
                     print(f"ℹ️ Skipping likely SVG image: {url}", file=sys.stderr)
                     return None
             except: pass # Ignore errors during SVG check
             
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

    # Adjust max scale if crop is larger than full image
    if ch > fh or cw > fw:
        max_scale_effective = min(SCALE_MAX, fw / cw, fh / ch)
        # If even the minimum scale doesn't fit, it's impossible
        if max_scale_effective < SCALE_MIN:
             print(f"⚠️ (CPU) Target image ({cw}x{ch}) too large for base image ({fw}x{fh}) even at min scale.", file=sys.stderr)
             return -1.0, 1.0
        scales = np.geomspace(SCALE_MIN, max_scale_effective, num=N_SCALES)
    else:
        scales = np.geomspace(SCALE_MIN, SCALE_MAX, num=N_SCALES)

    best_score = -1.0
    best_scale = 1.0

    for s in scales:
        sw, sh = int(cw * s), int(ch * s)
        # Skip if scaled size is invalid or too small
        if sw < 8 or sh < 8 or sw > fw or sh > fh:
            continue
        # Choose interpolation based on scale factor
        interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_CUBIC
        try:
             # Resize the template
             crop_s = cv2.resize(crop_gray, (sw, sh), interpolation=interp)
             # Ensure resize was successful
             if crop_s is None or crop_s.size == 0: continue
             # Perform template matching
             res = cv2.matchTemplate(full_gray, crop_s, cv2.TM_CCOEFF_NORMED)
             # Find the best match score
             _, max_val, _, _ = cv2.minMaxLoc(res)
             # Update best score if current is better
             if max_val > best_score:
                 best_score = max_val
                 best_scale = s
             # Early exit if score is very high
             if best_score >= EARLY_STOP_THRESHOLD:
                 break
        except Exception as e: # Catch potential errors during resize/match
            print(f"⚠️ (CPU) Error during scale {s:.3f} processing: {e}", file=sys.stderr)
            continue # Skip this scale on error
    return best_score, best_scale

def process_url_local(url, crop_gray):
    """(CPU Mode) Full processing pipeline using local CPU."""
    full = url_to_cv2_local(url) # Load image using CPU function
    if full is None or full.size == 0:
        return url, -1.0, 1.0 # Loading failed
    try:
        # Convert full image to grayscale
        full_gray = cv2.cvtColor(full, cv2.COLOR_BGR2GRAY)
        # Ensure crop template is valid
        if crop_gray is None or crop_gray.size == 0:
             print(f"❌ (CPU) Critical Error: Reference crop image (crop_gray) is empty.", file=sys.stderr)
             return url, -1.0, 1.0
        # Perform matching
        score, scale = best_multiscale_tm_score_local(full_gray, crop_gray)
    except Exception as e: # Catch errors during conversion or matching
         print(f"⚠️ (CPU) OpenCV error processing {url}: {e}", file=sys.stderr)
         return url, -1.0, 1.0 # Error during processing
    return url, score, scale


# --- Crawler ---
print("--- Starting Crawler (Local) ---", file=sys.stderr)
crawl_start_time = time.time()
processed_pages = 0
while to_visit and processed_pages < max_pages:
    batch = []
    # Build batch of URLs to visit
    while to_visit and len(batch) < max_workers_crawler:
        u = to_visit.popleft()
        if u not in visited:
            parsed_u = urlparse(u)
            # Basic URL validation
            if parsed_u.scheme in ['http', 'https'] and parsed_u.netloc:
                 visited.add(u)
                 batch.append(u)
    if not batch: break # No more valid URLs to visit in queue

    print(f"  [Crawler] Processing batch of {len(batch)} URLs (Visited: {len(visited)} / Limit: {max_pages})", file=sys.stderr)

    processed_pages += len(batch)
    batch_found_urls = 0
    batch_found_imgs = 0
    # Process batch concurrently
    with ThreadPoolExecutor(max_workers=max_workers_crawler) as executor:
        futures = {executor.submit(fetch_url, url): url for url in batch}
        for future in as_completed(futures):
            url_origin = futures[future]
            try:
                url_fetched, soup = future.result() # Get result (URL, BeautifulSoup object or None)

                status_msg = "✅ OK" if soup else "❌ Failed/Skipped"

                if soup is None:
                    # Log only failures/skips if needed for brevity
                    # print(f"    [Crawler] Visited: {url_fetched} ({status_msg})", file=sys.stderr)
                    continue # Skip if fetch failed or not HTML

                # --- Extract Links and Images ---
                links_found_in_page = 0
                imgs_found_in_page = 0

                # Extract Links
                for a in soup.find_all("a", href=True):
                    try:
                        link_raw = a.get("href", "") # Use .get for safety
                        if not link_raw or link_raw.startswith(('#', 'javascript:', 'mailto:', 'tel:')): continue
                        link = urljoin(url_fetched, link_raw)
                        parsed_link = urlparse(link)
                        # Check scheme and if it belongs to the target domain/subdomain
                        if parsed_link.scheme in ['http', 'https'] and parsed_link.netloc.endswith(domain):
                            link_normalized = parsed_link._replace(fragment="").geturl() # Remove fragments
                            if link_normalized not in visited and link_normalized not in to_visit:
                                to_visit.append(link_normalized) # Add to queue if new
                            # Add to set (returns True if added, False if already present)
                            if all_urls.add(link_normalized): links_found_in_page += 1
                    except Exception: pass # Ignore errors processing individual links

                # Extract Images
                for img in soup.find_all("img", src=True):
                     try:
                        img_src = img.get("src", "")
                        if not img_src: continue
                        img_url = urljoin(url_fetched, img_src)
                        parsed_img_url = urlparse(img_url)
                        # Check scheme and common image extensions
                        if parsed_img_url.scheme in ['http', 'https'] and parsed_img_url.path.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                             # Add to set (returns True if added)
                             if all_images.add(img_url): imgs_found_in_page += 1
                     except Exception: pass # Ignore errors processing individual images

                # Update batch counts
                batch_found_urls += links_found_in_page
                batch_found_imgs += imgs_found_in_page

                # Log page details only if new links/images were found
                if links_found_in_page > 0 or imgs_found_in_page > 0:
                     print(f"    [Crawler] Visited: {url_fetched} ({status_msg}) +{links_found_in_page} URLs, +{imgs_found_in_page} Imgs", file=sys.stderr)
                # Optional: Log every page visit regardless
                # else:
                #      print(f"    [Crawler] Visited: {url_fetched} ({status_msg}) No new items found.", file=sys.stderr)


            except Exception as e_future:
                 print(f"⚠️ Error processing future for {url_origin}: {type(e_future).__name__} - {e_future}", file=sys.stderr)
        
        # Log summary after each batch
        print(f"    [Crawler] Batch complete. Found +{batch_found_urls} URLs, +{batch_found_imgs} Imgs. Totals: {len(all_urls)} URLs, {len(all_images)} Imgs", file=sys.stderr)


crawl_elapsed = time.time() - crawl_start_time
print(f"\n🏁 Crawler finished in {crawl_elapsed:.2f} seconds.", file=sys.stderr)

# --- Save Results ---
images_file_path = f"/tmp/images_{os.getpid()}.txt"
urls_file_path = f"/tmp/urls_{os.getpid()}.txt"
try:
    # Use list comprehension and sort before writing
    sorted_urls = sorted(list(all_urls))
    with open(urls_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted_urls) + "\n")
    print(f"🔗 {len(sorted_urls)} URLs found and saved to {urls_file_path}", file=sys.stderr)
except Exception as e_write_urls:
     print(f"❌ Error saving URL file {urls_file_path}: {e_write_urls}", file=sys.stderr)
try:
    # Use list comprehension and sort before writing
    sorted_images = sorted(list(all_images))
    with open(images_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted_images) + "\n")
    print(f"🖼️ {len(sorted_images)} images found and saved to {images_file_path}", file=sys.stderr)
except Exception as e_write_images:
     print(f"❌ Error saving image file {images_file_path}: {e_write_images}", file=sys.stderr)


# --- Main Matching Function (Hybrid Logic) ---
def main(img_path_to_check, target_path, gpu_url):

    # 1. Load Template Image (crop) based on mode
    crop_data = None # Will hold bytes (GPU) or NumPy array (CPU Gray)
    error_msg = None

    if USE_GPU:
        print(f"--- Initializing Matching (Mode: GPU) ---", file=sys.stderr)
        # GPU Mode: Need template as bytes
        if os.path.exists(target_path):
            print(f"ℹ️ Reading local template image (bytes): {target_path}", file=sys.stderr)
            try:
                with open(target_path, 'rb') as f:
                    crop_data = f.read()
            except Exception as e: error_msg = f"Error reading local template (bytes) {target_path}: {e}"
        else:
            print(f"ℹ️ Downloading remote template image (bytes): {target_path}", file=sys.stderr)
            crop_data = url_to_bytes(target_path) # Use common byte downloader
    else:
        print(f"--- Initializing Matching (Mode: CPU) ---", file=sys.stderr)
        # CPU Mode: Need template as grayscale NumPy array
        crop_obj_bgr = None # Temporary holder for BGR image
        if os.path.exists(target_path):
            print(f"ℹ️ Reading local template image (cv2): {target_path}", file=sys.stderr)
            try: crop_obj_bgr = cv2.imread(target_path)
            except Exception as e: error_msg = f"Error reading local template (cv2) {target_path}: {e}"
        else:
            print(f"ℹ️ Downloading remote template image (cv2): {target_path}", file=sys.stderr)
            crop_obj_bgr = url_to_cv2_local(target_path) # Use CPU-specific loader

        # Convert to grayscale if loaded successfully
        if crop_obj_bgr is not None:
            try:
                crop_data = cv2.cvtColor(crop_obj_bgr, cv2.COLOR_BGR2GRAY)
                if crop_data is None: raise ValueError("cvtColor returned None")
            except Exception as e: error_msg = f"Error converting template image to grayscale: {e}"
        # If loading failed, error_msg might already be set
        elif not error_msg: error_msg = f"Failed to load template image (cv2): {target_path}"

    # 2. Handle Template Loading Error
    if crop_data is None:
        final_error = error_msg or f"Could not load template image: {target_path}"
        print(f"❌ {final_error}", file=sys.stderr)
        # Return error JSON immediately
        return json.dumps({"best_url": None, "score": -1.0, "scale": 1.0, "error": final_error})

    # 3. Read list of crawled image URLs
    urls = []
    total_images_in_file = 0
    if os.path.exists(img_path_to_check):
         try:
             with open(img_path_to_check, "r", encoding="utf-8") as f:
                 # Read and filter empty lines
                 urls = [ln.strip() for ln in f if ln.strip()]
             total_images_in_file = len(urls)
         except Exception as e_read:
             print(f"❌ Error reading image list file {img_path_to_check}: {e_read}", file=sys.stderr)
             # Continue with empty list, but log the error
    else:
        print(f"⚠️ Image list file not found: {img_path_to_check}", file=sys.stderr)
        # Continue with empty list

    # Handle case where crawler found no images or file couldn't be read
    if not urls:
        print("❌ No valid image URLs found to compare (crawler might have failed or file is empty/missing).", file=sys.stderr)
        return json.dumps({ "best_url": None, "score": -1.0, "scale": 1.0, "images_processed": 0, "total_images_found": 0, "error": "No image URLs found for comparison."})

    # 4. Execute Matching using ThreadPool and correct function
    print(f"--- Comparing against {len(urls)} images ---", file=sys.stderr)
    match_start_time = time.time()
    best_score = -1.0
    best_url = None
    best_scale = 1.0
    processed_count = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor: # Use matching workers

        # Select the correct processing function and arguments based on mode
        if USE_GPU:
            gpu_endpoint = urljoin(gpu_url, "/match") # Construct endpoint URL
            print(f"Submitting {len(urls)} tasks to GPU worker at {gpu_endpoint}", file=sys.stderr)
            # Submit tasks for GPU processing
            future_to_url = {
                executor.submit(process_url_gpu, url, crop_data, gpu_endpoint): url
                for url in urls
            }
        else:
            # Submit tasks for CPU processing
            print(f"Submitting {len(urls)} tasks for local CPU processing", file=sys.stderr)
            future_to_url = {
                executor.submit(process_url_local, url, crop_data): url
                for url in urls
            }

        # 5. Collect results and update best match
        print("--- Waiting for matching results ---", file=sys.stderr)
        for future in as_completed(future_to_url):
            url_processed = future_to_url[future]
            processed_count += 1
            try:
                # Get result from the completed future
                _, score, scale = future.result()

                # Log progress periodically or at the end
                if processed_count % 50 == 0 or processed_count == total_images_in_file :
                    current_time = time.time()
                    elapsed = current_time - match_start_time
                    rate = processed_count / elapsed if elapsed > 0 else 0
                    print(f"    ... ⏳ Progress: {processed_count}/{total_images_in_file} images processed ({elapsed:.1f}s, {rate:.1f} img/s).", file=sys.stderr)

                # Update best score if the current one is better
                if score > best_score:
                    best_score = score
                    best_url = url_processed
                    best_scale = scale
                    print_mode = "(GPU)" if USE_GPU else "(CPU)"
                    # Log finding a new best match
                    print(f"🔥 {print_mode} New best match ({processed_count}/{total_images_in_file}): {best_url} (Score: {best_score:.3f}, Scale: {best_scale:.3f})", file=sys.stderr)

            except Exception as exc: # Catch errors from the future.result() call
                print(f"⚠️ Error retrieving result for image {url_processed}: {exc}", file=sys.stderr)
                # Continue processing other images

    match_elapsed = time.time() - match_start_time
    print(f"--- Matching phase completed in {match_elapsed:.2f} seconds ---", file=sys.stderr)

    # 6. Return Final Result JSON
    final_result = {
        "best_url": best_url if best_url else None,
        "score": round(float(best_score), 3) if best_score > -1 else -1.0, # Ensure float conversion
        "scale": round(float(best_scale), 3) if best_scale != 1.0 or best_score > -1 else 1.0, # Ensure float
        "images_processed": processed_count,
        "total_images_found": total_images_in_file, # Use count from file reading
        "time_seconds": round(match_elapsed, 2)
    }
    return json.dumps(final_result)


# --- Main Execution ---
if __name__ == "__main__": # Ensures this runs only when script is executed directly
    # Call main function with command-line arguments
    final_json_output = main(images_file_path, image_path_or_url, GPU_WORKER_URL)

    # Print the final JSON result to standard output
    print(final_json_output)

    # --- Cleanup Temporary Files ---
    print("--- Cleaning up temporary files ---", file=sys.stderr)
    try:
        if 'urls_file_path' in locals() and os.path.exists(urls_file_path):
             os.remove(urls_file_path)
             print(f"Removed {urls_file_path}", file=sys.stderr)
        if 'images_file_path' in locals() and os.path.exists(images_file_path):
             os.remove(images_file_path)
             print(f"Removed {images_file_path}", file=sys.stderr)
    except Exception as e_clean:
        print(f"⚠️ Error during temporary file cleanup: {e_clean}", file=sys.stderr)