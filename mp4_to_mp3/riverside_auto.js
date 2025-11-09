const fs = require("fs");
const os = require("os");
const path = require("path");

// Reutilizamos el navegador "indetectable" persistente del proyecto
const { createUndetectableBrowser } = require("./auto_log_in.js");

/* ==================== Utilidades de disco ==================== */
function findLatestMp3({ preferName = "video.mp3", extraDirs = [] } = {}) {
  const dirs = Array.from(
    new Set([
      os.tmpdir(),
      "/tmp",
      "/app/downloads",
      "/root/Downloads",
      ...extraDirs.filter(Boolean),
    ])
  );

  const hits = [];
  for (const d of dirs) {
    try {
      const items = fs.readdirSync(d);
      for (const it of items) {
        if (!/\.mp3$/i.test(it)) continue;
        const p = path.join(d, it);
        const st = fs.statSync(p);
        hits.push({ file: p, mtime: st.mtimeMs });
      }
    } catch {}
  }
  if (!hits.length) return null;

  const exact = hits.find(
    (h) => path.basename(h.file).toLowerCase() === preferName.toLowerCase()
  );
  if (exact) return exact.file;

  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].file;
}

/* ==================== Helper genérico: parar en el primero que funcione ==================== */
async function runUntilTrue(tasks, { desc = "Tarea" } = {}) {
  for (const [name, fn] of tasks) {
    try {
      const res = await fn();
      if (res) {
        console.log(`✅ ${desc} completada con el método: ${name}`);
        return true;
      } else {
        console.log(`➡️  ${name}: sin efecto, probamos siguiente…`);
      }
    } catch (e) {
      console.log(`⚠️ ${name}: error → ${e.message}`);
    }
  }
  console.log(`⛔ ${desc}: ningún método tuvo éxito.`);
  return false;
}

/* ==================== Helpers UI ==================== */
async function acceptCookiesIfAny(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    "text=Accept all",
    "text=Accept",
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        console.log("🍪 Aceptando cookies…");
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(300);
        break;
      }
    } catch {}
  }
}

async function isUploadUIReady(page) {
  if ((await page.locator('input[type="file"]').count()) > 0) return true;
  if (
    (await page
      .locator('svg path[d^="M10.0003 4.16602V15.8327"]')
      .count()) > 0
  )
    return true;
  return false;
}

async function clickTranscribeNowAndWaitUploadUI(page) {
  console.log("🔘 Pulsando 'Transcribe now' antes de subir…");
  const candidates = [
    "#transcribe-main",
    'button:has-text("Transcribe now")',
    'button:has-text("Transcribe Now")',
    'a:has-text("Transcribe now")',
    'a:has-text("Transcribe Now")',
    '[data-testid="transcribe-now"]',
  ];

  for (let round = 1; round <= 3; round++) {
    let clicked = false;
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(120);
        await el.click({ force: true });
        console.log(`✅ Click en '${sel}' (ronda ${round})`);
        clicked = true;
        break;
      } catch (e) {
        console.log(`⚠️ Fallo al pulsar '${sel}': ${e.message}`);
      }
    }
    if (!clicked) {
      await page.mouse.wheel(0, 700).catch(() => {});
    }

    for (let i = 0; i < 10; i++) {
      if (await isUploadUIReady(page)) {
        console.log("🟢 UI de subida detectada.");
        return true;
      }
      await page.waitForTimeout(300);
    }
  }
  console.log(
    "⚠️ No se confirmó la UI de subida tras 'Transcribe now'. Seguimos igualmente."
  );
  return false;
}

async function clickNearestClickableOfPlusIcon(page) {
  let plusPath = page
    .locator('svg path[d^="M10.0003 4.16602V15.8327"]')
    .first();
  if (!(await plusPath.count())) return false;
  try {
    await plusPath.scrollIntoViewIfNeeded().catch(() => {});
  } catch {}
  const parentBtn = plusPath.locator("xpath=ancestor::button[1]");
  if (await parentBtn.count()) {
    await parentBtn.click({ force: true }).catch(() => {});
    return true;
  }
  const parentAny = plusPath.locator(
    "xpath=ancestor::*[self::button or self::div][1]"
  );
  if (await parentAny.count()) {
    await parentAny.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function closeUploaderUI(page) {
  console.log("🧹 Cerrando adjuntador/overlay tras la subida…");
  try {
    await page.evaluate(() => {
      const input = document.querySelector('input[type="file"]');
      if (input) {
        input.value = "";
        input.style.display = "none";
        input.style.opacity = "0";
        input.setAttribute("hidden", "true");
        input.blur();
      }
    });
  } catch {}
  for (const sel of [
    'button[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("Done")',
    'button:has-text("Cancel")',
    '[role="dialog"] button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 1000 }).catch(() => {});
      }
    } catch {}
  }
  try {
    await page.keyboard.press("Escape");
  } catch {}
  try {
    await page.mouse.click(10, 10);
  } catch {}
  await page.waitForTimeout(250);
}

/* ====== Click fiable ====== */
async function reliableClick(page, selector) {
  const el = page.locator(selector).first();
  if (!(await el.count())) return false;
  try { await el.scrollIntoViewIfNeeded(); } catch {}
  await page.waitForTimeout(100);

  // click normal
  try { await el.click({ timeout: 1500 }); return true; } catch {}

  // click via DOM
  try {
    const handle = await el.elementHandle();
    if (handle) { await page.evaluate((n)=>n.click(), handle); return true; }
  } catch {}

  // click por bounding box
  try {
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width/2, box.y + box.height/2, { delay: 60 });
      return true;
    }
  } catch {}
  return false;
}

/* ====== Cambiar idioma ====== */
async function setLanguageTo(page, target = "spanish") {
  console.log(`🌐 Cambiando idioma a: ${target}`);
  // Abrir el dropdown
  let opened = await reliableClick(page, "#lang-btn");
  if (!opened) {
    // fallback suave
    await page.evaluate(() => document.querySelector("#lang-btn")?.click()).catch(()=>{});
    await page.waitForTimeout(150);
  }
  // Elegir la opción (varios selectores posibles)
  const optionCandidates = [
    `text=/^${target}$/i`,
    `//div[normalize-space(.)='${target}']`,
    `li:has-text("${target}")`,
    `button:has-text("${target}")`,
  ];
  let picked = false;
  for (const sel of optionCandidates) {
    try {
      const ok = await reliableClick(page, sel);
      if (ok) { picked = true; break; }
    } catch {}
  }
  if (!picked) {
    // Último recurso: buscar nodo por texto y hacer click
    await page.evaluate((tgt) => {
      const all = Array.from(document.querySelectorAll("div,li,button,span"));
      const node = all.find(n => (n.textContent||"").trim().toLowerCase() === tgt.toLowerCase());
      if (node) node.click();
    }, target).catch(()=>{});
  }
  await page.waitForTimeout(200);
  // Confirmar estado visual
  const shown = await page.evaluate(() => {
    const el = document.querySelector("#selected-lang-name");
    return el ? (el.textContent||"").trim().toLowerCase() : null;
  }).catch(()=>null);

  const ok = shown === target.toLowerCase();
  console.log(ok ? `✅ Idioma seleccionado: ${shown}` : `❌ No se pudo confirmar idioma (mostrado: ${shown})`);
  return ok;
}

/* ====== Debug del Checkbox ====== */
async function debugCheckboxState(page) {
  console.log("🔍 DEBUG DETALLADO DEL CHECKBOX:");

  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) {
    console.log("❌ Checkbox #human-verification no encontrado");
    return;
  }

  const state = await page
    .evaluate(() => {
      const cb = document.getElementById("human-verification");
      if (!cb) return null;

      return {
        checked: cb.checked,
        value: cb.value,
        attributes: Array.from(cb.attributes).map((attr) => ({
          name: attr.name,
          value: attr.value,
        })),
        disabled: cb.disabled,
        readOnly: cb.readOnly,
        style: cb.style.cssText,
        parentHTML: cb.parentElement
          ? cb.parentElement.outerHTML.slice(0, 200)
          : "no parent",
        eventListeners: {
          click: cb.onclick ? "present" : "none",
          change: cb.onchange ? "present" : "none",
        },
      };
    })
    .catch(() => null);

  console.log("📊 Estado del checkbox:", JSON.stringify(state, null, 2));
}

/* ====== Verificación humana MEJORADA con activación del botón ====== */
async function markConsentCheckbox(page) {
  console.log("☑️ Intentando marcar el consentimiento…");

  // Estrategia 1: Enfoque directo con múltiples métodos
  const checkbox = page.locator('#human-verification');
  if (await checkbox.count() > 0) {
    console.log("✅ Encontrado checkbox específico #human-verification");
    
    // Método 1: JavaScript directo con múltiples enfoques
    const jsMethods = [
      // Método directo
      () => {
        const cb = document.getElementById('human-verification');
        if (cb) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('click', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      // Método con focus y blur
      () => {
        const cb = document.getElementById('human-verification');
        if (cb) {
          cb.focus();
          cb.checked = true;
          cb.blur();
          const event = new Event('change', { bubbles: true });
          cb.dispatchEvent(event);
        }
      },
      // Método con propiedad directa y eventos nativos
      () => {
        const cb = document.getElementById('human-verification');
        if (cb) {
          Object.defineProperty(cb, 'checked', { value: true });
          cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    ];

    for (let i = 0; i < jsMethods.length; i++) {
      console.log(`🔄 Intentando método JavaScript ${i + 1}...`);
      await page.evaluate(jsMethods[i]);
      await page.waitForTimeout(800);
      
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (isChecked) {
        console.log(`✅ Checkbox marcado con método JS ${i + 1}`);
        
        // Disparar evento personalizado que active el botón
        await page.evaluate(() => {
          const cb = document.getElementById('human-verification');
          if (cb) {
            // Disparar todos los eventos posibles que podrían activar el botón
            const events = [
              'change', 'click', 'input', 'mousedown', 'mouseup', 
              'focus', 'blur', 'keydown', 'keyup'
            ];
            events.forEach(eventType => {
              cb.dispatchEvent(new Event(eventType, { bubbles: true }));
            });
            
            // También disparar en el formulario padre si existe
            const form = cb.closest('form');
            if (form) {
              form.dispatchEvent(new Event('input', { bubbles: true }));
              form.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
        
        return true;
      }
    }

    // Método 2: Simulación de interacción humana más realista
    console.log("👤 Simulando interacción humana...");
    await checkbox.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    
    // Mover mouse de forma natural hacia el checkbox
    const box = await checkbox.boundingBox();
    if (box) {
      const steps = 10;
      const startX = box.x + box.width / 2;
      const startY = box.y - 100;
      for (let step = 0; step <= steps; step++) {
        const x = startX;
        const y = startY + (box.y - startY) * (step / steps);
        await page.mouse.move(x, y);
        await page.waitForTimeout(50);
      }
      await page.mouse.click(
        box.x + box.width / 2 + Math.random() * 10 - 5, 
        box.y + box.height / 2 + Math.random() * 10 - 5,
        { delay: 100 + Math.random() * 100 }
      );
      await page.waitForTimeout(1000);
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (isChecked) {
        console.log("✅ Checkbox marcado con simulación humana");
        return true;
      }
    }

    // Método 3: Forzar a través del label asociado
    console.log("🏷️ Buscando label asociado...");
    const label = page.locator('label[for="human-verification"]');
    if (await label.count() > 0) {
      await label.click({ force: true });
      await page.waitForTimeout(1000);
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (isChecked) {
        console.log("✅ Checkbox marcado a través del label");
        return true;
      }
    }

    // Método 4: Enfoque nuclear - modificar directamente las propiedades
    console.log("💥 Enfoque nuclear - modificando propiedades profundas...");
    await page.evaluate(() => {
      const cb = document.getElementById('human-verification');
      if (cb) {
        cb.checked = true;
        cb.setAttribute('checked', 'checked');
        cb.value = 'on';
        const events = ['click', 'change', 'input', 'mousedown', 'mouseup', 'focus', 'blur'];
        events.forEach(eventType => {
          cb.dispatchEvent(new Event(eventType, { bubbles: true }));
        });
        cb.style.setProperty('checked', 'true', 'important');
        
        // Forzar actualización del estado del formulario
        const form = cb.closest('form');
        if (form) {
          form.dispatchEvent(new Event('change', { bubbles: true }));
          form.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });

    await page.waitForTimeout(1500);
    const finalChecked = await checkbox.isChecked().catch(() => false);
    console.log(`ℹ️ Estado final del checkbox después de todos los métodos: ${finalChecked ? 'MARCADO' : 'NO MARCADO'}`);
    
    return finalChecked;
  }

  // Si llegamos aquí, el checkbox no existe o no se pudo marcar
  console.log("❌ No se pudo encontrar o marcar el checkbox #human-verification");
  return false;
}

/* ====== Señalización de verificación ====== */
async function waitForVerificationTokenOrError(page, timeoutMs = 4000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // Error visible
    const errorSelectors = [
      "text=Verification failed",
      "text=verification failed",
      "text=Human verification failed",
      ".verification-error",
    ];
    for (const selector of errorSelectors) {
      if ((await page.locator(selector).count()) > 0) {
        return { failed: true, token: null };
      }
    }

    // Token presente (turnstile/hcaptcha)
    const tokenSelectors = [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      'input[name="h-captcha-response"]',
      'textarea[name="h-captcha-response"]',
    ];
    for (const selector of tokenSelectors) {
      const token = await page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.value && el.value.length > 10 ? el.value : null;
        }, selector)
        .catch(() => null);

      if (token) {
        return { failed: false, token };
      }
    }

    // Indicadores visuales de éxito
    const successIndicators = [
      ".verification-success",
      ".success",
      '[class*="success"]',
      "text=Verification successful",
    ];
    for (const selector of successIndicators) {
      if ((await page.locator(selector).count()) > 0) {
        return { failed: false, token: "visual_success" };
      }
    }

    await page.waitForTimeout(200);
  }

  return { failed: false, token: null };
}

/**
 * Considera "fallo persistente" solo si el texto de fallo está presente sin interrupción
 * durante toda la ventana (p.ej. 2.5 s). Así evitamos falsos positivos transitorios.
 */
async function isVerificationFailedPersistently(page, windowMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const seen =
      (await page.locator("text=Verification failed").count()) > 0 ||
      (await page.locator("text=verification failed").count()) > 0 ||
      (await page.locator("text=Human verification failed").count()) > 0 ||
      (await page.locator(".verification-error").count()) > 0;

    if (!seen) return false; // desapareció en la ventana → no persistente
    await page.waitForTimeout(150);
  }
  return true; // estuvo visible toda la ventana → persistente
}

/* ====== ACTIVAR BOTÓN START TRANSCRIBING ====== */
async function activateStartButton(page) {
  console.log("🎯 Intentando activar el botón 'Start transcribing'...");
  
  const startBtn = page.locator("#start-transcribing")
    .or(page.locator('button:has-text("Start transcribing")'))
    .first();

  if (!(await startBtn.count())) {
    console.log("❌ Botón 'Start transcribing' no encontrado");
    return false;
  }

  // Verificar si ya está habilitado
  const isEnabled = await startBtn.isEnabled().catch(() => false);
  if (isEnabled) {
    console.log("✅ Botón ya está habilitado");
    return true;
  }

  console.log("🔧 Botón deshabilitado, intentando activarlo...");

  // Estrategia 1: Disparar eventos de cambio en todos los campos del formulario
  await page.evaluate(() => {
    // Disparar eventos en todos los inputs y formularios
    const allInputs = document.querySelectorAll('input, select, textarea, checkbox');
    allInputs.forEach(input => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    // Disparar eventos en todos los formularios
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      form.dispatchEvent(new Event('change', { bubbles: true }));
      form.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Forzar re-render del componente React si existe
    if (window.React && window.ReactDOM) {
      const root = document.getElementById('root') || document.body;
      window.ReactDOM.unstable_batchedUpdates(() => {
        // Intentar forzar actualización
      });
    }
  });

  await page.waitForTimeout(1000);

  // Estrategia 2: Simular interacción con otros elementos del formulario
  await page.evaluate(() => {
    // Hacer click en otros elementos interactivos
    const interactiveElements = document.querySelectorAll(
      'button, [role="button"], .btn, [tabindex="0"]'
    );
    interactiveElements.forEach(el => {
      if (!el.disabled && el.offsetWidth > 0 && el.offsetHeight > 0) {
        el.click();
      }
    });
  });

  await page.waitForTimeout(500);

  // Estrategia 3: Intentar focus y blur en el botón
  await startBtn.focus().catch(() => {});
  await page.waitForTimeout(200);
  await page.evaluate(() => document.activeElement?.blur());

  // Estrategia 4: Verificar validaciones específicas
  await page.evaluate(() => {
    // Remover clases de error si existen
    const errorElements = document.querySelectorAll('.error, .invalid, [aria-invalid="true"]');
    errorElements.forEach(el => {
      el.classList.remove('error', 'invalid');
      el.setAttribute('aria-invalid', 'false');
    });

    // Forzar estado válido
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      form.classList.remove('invalid', 'error');
      form.setAttribute('aria-invalid', 'false');
    });
  });

  await page.waitForTimeout(1000);

  // Verificar resultado
  const finalEnabled = await startBtn.isEnabled().catch(() => false);
  console.log(finalEnabled ? "✅ Botón activado exitosamente" : "❌ No se pudo activar el botón");
  
  return finalEnabled;
}

/* ==================== FLUJO PRINCIPAL MEJORADO ==================== */
async function transcribeFromTmpOrPath({
  mp3Path = null,
  keepOpen = false,
} = {}) {
  // 1) Resolver ruta del MP3
  let resolved = mp3Path && fs.existsSync(mp3Path) ? mp3Path : null;
  if (!resolved) resolved = findLatestMp3({ preferName: "video.mp3" });
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error("No se encontró ningún .mp3 en /tmp (ni ruta proporcionada).");
  }

  console.log("🎧 Archivo a subir:", resolved);
  const { context, page } = await createUndetectableBrowser();
  try {
    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.com/transcription#", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() =>
        page.goto("https://riverside.fm/transcription#", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        })
      );

    await acceptCookiesIfAny(page);

    // 2) Abrir UI de subida
    await clickTranscribeNowAndWaitUploadUI(page);

    // 3) SUBIDA (parar en el primero que funcione)
    console.log("📂 Subiendo archivo…");
    const fileSet = await runUntilTrue(
      [
        [
          "Filechooser + click en '+'",
          async () => {
            let chooserHandled = false;
            try {
              page.once("filechooser", async (fc) => {
                try {
                  console.log("📎 Filechooser → setFiles:", resolved);
                  await fc.setFiles(resolved);
                  chooserHandled = true;
                } catch (e) {
                  console.log("⚠️ Error asignando en filechooser:", e.message);
                }
              });
              const clicked = await clickNearestClickableOfPlusIcon(page);
              if (clicked) await page.waitForTimeout(1200);
              return chooserHandled;
            } catch {
              return false;
            }
          },
        ],
        [
          "setInputFiles en input[type=file]",
          async () => {
            let fileInput = page.locator('input[type="file"]').first();
            for (let i = 0; i < 8 && !(await fileInput.count()); i++) {
              await page.waitForTimeout(350);
              fileInput = page.locator('input[type="file"]').first();
            }
            if (await fileInput.count()) {
              console.log("✅ Input localizado. Subiendo vía setInputFiles…");
              await fileInput.setInputFiles(resolved).catch(() => {});
              return true;
            }
            return false;
          },
        ],
        [
          "ElementHandle cercano al '+' → setInputFiles",
          async () => {
            try {
              const handle = await page.evaluateHandle(() => {
                const plus = document.querySelector(
                  'svg path[d^="M10.0003 4.16602V15.8327"]'
                );
                let el = plus ? plus.parentElement : null;
                while (el && el !== document.body) {
                  const inp = el.querySelector('input[type="file"]');
                  if (inp) return inp;
                  el = el.parentElement;
                }
                return document.querySelector('input[type="file"]') || null;
              });
              if (!handle) return false;
              console.log("🔎 Input cercano localizado via DOM → setInputFiles(handle)…");
              await handle.setInputFiles(resolved).catch(() => {});
              return true;
            } catch (e) {
              console.log("⚠️ No se pudo setear vía ElementHandle:", e.message);
              return false;
            }
          },
        ],
      ],
      { desc: "Subida del archivo" }
    );

    if (!fileSet)
      throw new Error("❌ No se pudo subir el archivo: ni filechooser ni input[type=file] disponibles.");

    await closeUploaderUI(page);

    // 4) **Primero** cambiar el idioma a "spanish"
    await setLanguageTo(page, "spanish").catch(()=>{});

    // 5) **Después** marcar el checkbox tal cual está montado
    console.log("🔍 Debug inicial del checkbox (opcional)...");
    await debugCheckboxState(page).catch(() => {});
    await markConsentCheckbox(page);

    // 6) **NUEVO: Intentar activar el botón Start transcribing**
    await activateStartButton(page);

    // 7) Señalización/verificación
    let { failed, token } = await waitForVerificationTokenOrError(page, 2000);
    if (failed) {
      const checkedNow = await page
        .locator("#human-verification")
        .isChecked()
        .catch(() => false);
      if (!checkedNow) {
        console.log("↪️ Reintento de marcado tras fallo de verificación…");
        await markConsentCheckbox(page);
        // Reintentar activación del botón
        await activateStartButton(page);
      }
    }

    const stillFailed = await isVerificationFailedPersistently(page, 2500);
    console.log(
      stillFailed
        ? "⛔ FALLO persistente de verificación"
        : "🟢 Sin fallo persistente (ok para continuar)"
    );

    // 8) Pulsar Start si existe y está habilitado
    console.log("▶️ Buscando botón 'Start transcribing'…");
    const startBtn = page
      .locator("#start-transcribing")
      .or(page.locator('button:has-text("Start transcribing")'))
      .first();

    if (await startBtn.count()) {
      await startBtn.scrollIntoViewIfNeeded().catch(() => {});
      
      // Verificar estado final del botón
      const isEnabled = await startBtn.isEnabled().catch(() => false);
      const disabledAttr = await startBtn.getAttribute("disabled").catch(() => null);
      
      console.log(`🔎 Estado final del botón Start → disabled=${!!disabledAttr}, enabled=${isEnabled}`);
      
      if (isEnabled && !disabledAttr && !stillFailed) {
        console.log("✅ Pulsando 'Start transcribing'…");
        await Promise.all([
          page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {}),
          startBtn.click().catch(() => {}),
        ]);
        console.log("🚀 Transcripción iniciada");
      } else {
        console.log("ℹ️ Start deshabilitado o verificación fallida; no se puede iniciar.");
        // Último intento: forzar click aunque esté deshabilitado
        if (!stillFailed) {
          console.log("🔄 Intentando forzar click en botón deshabilitado...");
          await page.evaluate(() => {
            const btn = document.querySelector('#start-transcribing') || 
                       document.querySelector('button:has-text("Start transcribing")');
            if (btn) {
              btn.removeAttribute('disabled');
              btn.click();
            }
          }).catch(() => {});
        }
      }
    } else {
      console.log("ℹ️ No se encontró botón de inicio (algunos flujos arrancan solos).");
    }

    // 9) Espera best-effort
    console.log("🕰️ Esperando transcripción (máx 2 min)...");
    let transcript = "";
    try {
      await page.waitForSelector(
        '[data-testid="transcript"], .transcript, [class*="transcript"]',
        { timeout: 120000 }
      );
      const block = page
        .locator('[data-testid="transcript"], .transcript, [class*="transcript"]')
        .first();
      if (await block.count()) {
        transcript = await block.innerText({ timeout: 10000 }).catch(() => "");
        console.log("📜 Fragmento transcrito:", transcript.slice(0, 150));
      } else {
        console.log("⚠️ Bloque de transcripción no encontrado.");
      }
    } catch (e) {
      console.warn("⌛ Timeout esperando transcripción:", e.message);
    }

    return {
      ok: !stillFailed,
      usedFile: resolved,
      transcript,
      transcriptUrl: page.url(),
      started: !stillFailed,
      humanVerificationPassed: !stillFailed,
    };
  } finally {
    if (!keepOpen) {

    }
  }
}

module.exports = {
  transcribeFromTmpOrPath,
  findLatestMp3,
};