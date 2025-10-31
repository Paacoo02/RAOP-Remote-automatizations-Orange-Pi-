// gemini_auto.js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// Reusamos las utilidades de login Drive para aprovechar sesión Google
const { createUndetectableBrowser, gotoWithRetry, handleGoogleLogin } = require('./auto_log_in.js');

async function summarizeWithGemini({ prompt, text = "", audioPath = null }) {
  const { browser, context, page } = await createUndetectableBrowser();
  try {
    // Ir a Gemini (app pública)
    await gotoWithRetry(context, { page }, 'https://gemini.google.com/app');

    // Si pide login, lo hacemos con la misma función (el usuario lo completa)
    if (page.url().includes('accounts.google.com')) {
      await handleGoogleLogin(page, context);
      await gotoWithRetry(context, { page }, 'https://gemini.google.com/app');
    }

    // Esperar cuadro de entrada
    // Nueva UI: un editable (Quill). Buscamos contenteditable
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 60000 });

    // Escribir prompt + texto (si hay)
    const fullPrompt = text ? `${prompt}\n\n=== TRANSCRIPCIÓN ===\n${text}` : prompt;
    await editor.click();
    await editor.type(fullPrompt, { delay: 10 });

    // Adjuntar audio si se suministra (botón “Attach” / clip)
    if (audioPath) {
      // Botón adjuntar (intentos típicos)
      const attachSelCandidates = [
        'button[aria-label*="Attach"]',
        'button[aria-label*="Adjuntar"]',
        'button:has(svg)',
        'button:has-text("Attach")',
      ];
      let clickedAttach = false;
      for (const sel of attachSelCandidates) {
        const b = page.locator(sel).first();
        if (await b.count()) {
          // intentamos abrir filechooser
          const [fc] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }).catch(()=>null),
            b.click().catch(()=>null)
          ]);
          if (fc) {
            await fc.setFiles(audioPath);
            clickedAttach = true;
            break;
          }
        }
      }
      // Fallback: si hay <input type="file">
      if (!clickedAttach) {
        const input = page.locator('input[type="file"]').first();
        if (await input.count()) await input.setInputFiles(audioPath);
      }
    }

    // Enviar (Enter o botón enviar)
    const sendBtn = page.locator('button[aria-label*="Send"]').first()
                   .or(page.locator('button:has-text("Send")').first());
    if (await sendBtn.count()) {
      await sendBtn.click().catch(async () => {
        await editor.press('Enter');
      });
    } else {
      await editor.press('Enter');
    }

    // Esperar respuesta del modelo
    // Elemento típico de respuesta: bloques con role="article" o divs con rich text
    await page.waitForTimeout(2000);
    const reply = page.locator('[data-testid="markdown"]')
                  .or(page.locator('article'))
                  .or(page.locator('.response, .message, .markdown-body')).first();
    await reply.waitFor({ state: 'visible', timeout: 120000 }).catch(()=>{});

    const summary = (await reply.count()) ? (await reply.innerText().catch(()=>'')) : '';
    return { ok: true, summary, url: page.url() };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { summarizeWithGemini };
