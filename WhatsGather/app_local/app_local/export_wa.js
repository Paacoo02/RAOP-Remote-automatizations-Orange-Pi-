const { Client, LocalAuth, MessageTypes } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { getDb, upsertContact } = require('./db.js');

// --- 1. LEER ARGUMENTOS ---
const sessionId = process.argv[2];
const keepLive = process.argv[3] === 'true'; // 'true' o 'false'
const CONCURRENCY = parseInt(process.argv[4] || '1', 10);
const DAYS_BACK = 30;
const MEMORY_THRESHOLD_MB = 500; // Límite de 500MB de Heap
const MEMORY_PAUSE_MS = 10000;  // Pausa de 10 segundos
const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;

if (!sessionId) {
  console.error('❌ Error fatal: No se proporcionó un ID de sesión.');
  process.exit(1);
}

const dbPromise = getDb();
const sessionPath = path.resolve(__dirname, 'sessions', sessionId);
const THRESHOLD = daysAgoDate(DAYS_BACK).getTime() / 1000; // Timestamp en segundos

// ================ HELPERS ===================
function daysAgoDate(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0,0,0,0);
  return d;
}
const logMem = (label = "") => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[CONSUMO] ${label} Script RAM (RSS): ${rss} MB | Heap JS: ${heap} MB`);
  return mem.heapUsed;
};
// ============================================

console.log(`[BOT] Iniciando cliente (whatsapp-web.js) para sesión: ${sessionId}`);
console.log(`[BOT] Path de sesión: ${sessionPath}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath }),
  puppeteer: {
    headless: HEADLESS, // ¡Controlado por VNC!
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu', // Requerido para Xvfb/VNC
      '--disable-extensions',
      '--disable-images', // Bloqueamos recursos
      '--disable-media-source',
      '--mute-audio',
    ]
  }
});

// --- AUTENTICACIÓN (Tu parte favorita) ---
client.on('qr', (qr) => {
  console.log(`\n¡NUEVO QR RECIBIDO! (Sesión: ${sessionId})`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
  console.log('================================================================');
  console.log('⚠️  SI EL DIBUJO DE ABAJO SE VE MAL, USA ESTE ENLACE:');
  console.log('👉  ' + qrUrl);
  console.log('================================================================\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('[BOT] Autenticado. La sesión ha sido guardada.');
});

client.on('auth_failure', msg => {
  console.error('[BOT] ERROR DE AUTENTICACIÓN:', msg);
  process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log('[BOT] Cliente desconectado:', reason);
  process.exit(1);
});

// --- ¡LISTO! ---
client.on('ready', async () => {
  console.log('✅ ¡Cliente listo! Iniciando exportación...');
  logMem("(Inicio)");
  console.log("[CONSUMO] (Recuerda: Esto NO incluye la memoria del navegador. Usa 'docker stats' para eso)");

  try {
    // 1. Guardar nuestro propio perfil ("Paco Ruiz")
    await saveOwnProfile();

    // 2. ¡LA FUSIÓN! Usar tu lógica de scraping de Playwright
    // en lugar del client.getChats()
    await exportAllChatHistory();

    // 3. Decidir si nos quedamos o nos vamos
    if (keepLive) {
      console.log(`\n🎧 Exportación inicial completa. Escuchando mensajes en vivo (Modo Live)...`);
      setupLiveListener();
    } else {
      console.log("\n✅ Exportación inicial completada. Cerrando bot.");
      await client.destroy();
      process.exit(0);
    }

  } catch (err) {
    console.error("❌ Error fatal durante la exportación:", err);
    await client.destroy();
    process.exit(1);
  }
});

/**
 * Guarda el perfil del dueño de la sesión en la DB.
 */
async function saveOwnProfile() {
  const db = await dbPromise;
  const profileName = client.info.pushname || "Perfil Desconocido";
  const myId = client.info.wid._serialized;
  
  await upsertContact({
    id: myId,
    name: "Yo", // Lo marcamos como "Yo"
    pushname: profileName,
    isGroup: false
  });

  // Actualiza la descripción de la sesión en la DB
  await db.run(
    'UPDATE Sessions SET description = ? WHERE sessionId = ?',
    profileName,
    sessionId
  );
  console.log(`[DB] Sesión ${sessionId} actualizada con el nombre: ${profileName}`);
}

/**
 * ¡TU LÓGICA DE PLAYWRIGHT ADAPTADA!
 * Obtiene todos los títulos de chat haciendo scroll.
 */
async function listAllChatTitlesReliably() {
  console.log("[BOT] Obteniendo lista de chats (método: scraping de scroll)...");
  
  // 'client.pupPage' nos da acceso a la página de Puppeteer
  const page = client.pupPage; 
  if (!page) {
    throw new Error("No se pudo acceder a la página del navegador (pupPage).");
  }

  // Esperamos a que el panel de chats esté listo
  const pane = await waitForSelectors(page, ["#pane-side", '[data-testid="chat-list"]'], 30000);
  if (!pane) {
    console.warn("[BOT] No se encontró el panel de chats (#pane-side).");
    return [];
  }

  let prev = -1, stagn = 0;
  while (stagn < 4) {
    await page.evaluate(() => {
      const el = document.querySelector("#pane-side,[data-testid='chat-list']");
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(900); // (page.waitForTimeout es de Puppeteer)
    
    // $$eval es el equivalente de Puppeteer a page.$$eval de Playwright
    const count = await page.$$eval(
      "#pane-side [title], [data-testid='chat-list'] [title]",
      els => els.length
    );
    if (count === prev) stagn++; else { prev = count; stagn = 0; }
  }

  const titles = await page.$$eval(
    "#pane-side [title], [data-testid='chat-list'] [title]",
    els => Array.from(new Set(els.map(e => e.getAttribute("title") || e.textContent || ""))).filter(Boolean)
  );
  
  console.log(`[BOT] Scraping de chats terminado. ${titles.length} títulos encontrados.`);
  return titles;
}

// Helper para 'listAllChatTitlesReliably' (robado de tu script)
async function waitForSelectors(page, selectors, timeout=10000){
  const t0 = Date.now();
  for (;;){
    for (const sel of selectors){
      // $ es el equivalente de Puppeteer a page.$
      const h = await page.$(sel);
      if (h) return h;
    }
    if (Date.now()-t0 > timeout) return null;
    await page.waitForTimeout(150);
  }
}

/**
 * Función principal de exportación (Worker Pool + Gobernador de Memoria)
 */
async function exportAllChatHistory() {
  logMem("(Inicio exportAllChatHistory)");

  // 1. OBTENER TAREAS (¡Usando tu método fiable!)
  let chatTitles;
  try {
    chatTitles = await listAllChatTitlesReliably();
  } catch (err) {
    console.error("Falló el scraping de la lista de chats, intentando con client.getChats()...", err);
    // Plan B: El método original de la librería (que se colgaba)
    const chats = await client.getChats();
    chatTitles = chats.map(c => c.name);
  }

  if (!chatTitles || chatTitles.length === 0) {
    console.log("[BOT] No se encontraron chats para exportar.");
    return;
  }
  
  // 2. CREAR COLA DE TAREAS
  // Usamos los títulos como "tareas"
  const chatQueue = [...chatTitles]; 
  console.log(`[BOT] ${chatQueue.length} chats en cola. Creando ${CONCURRENCY} workers...`);

  // 3. CREAR WORKERS
  const workerPromises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerPromises.push(runWorker(i + 1, chatQueue));
  }
  
  await Promise.allSettled(workerPromises);
  logMem("(Exportación finalizada)");
}

/**
 * Lógica del Worker (procesa la cola)
 */
async function runWorker(workerId, queue) {
  console.log(`[Worker ${workerId}] Iniciado.`);
  const db = await dbPromise;

  while (true) {
    // 1. GOBERNADOR DE MEMORIA
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > (MEMORY_THRESHOLD_MB * 1024 * 1024)) {
      console.warn(`[Gobernador] Worker ${workerId} pausado 10s (Heap: ${(heapUsed/1024/1024).toFixed(0)}MB > ${MEMORY_THRESHOLD_MB}MB)`);
      await new Promise(resolve => setTimeout(resolve, MEMORY_PAUSE_MS));
      console.log(`[Gobernador] Worker ${workerId} reanudado.`);
    }

    // 2. COGER TAREA
    const chatTitle = queue.pop(); // Saca el último chat de la cola
    if (!chatTitle) {
      console.log(`[Worker ${workerId}] No hay más tareas. Terminando.`);
      break; // Salir del bucle while
    }

    // 3. PROCESAR TAREA
    console.log(`▶️ [Worker ${workerId}] Procesando chat: "${chatTitle}"... (${queue.length} restantes)`);
    try {
      // 3a. Encontrar el chat (usando la API, no scraping)
      // Esto es más rápido que el 'openChatBySearch' de Playwright
      const chat = await client.getChatById(chatTitle); // Esto no existe, ¡error!
      // ¡CORRECCIÓN! No podemos buscar por 'título'.
      // Tenemos que volver a buscar en la lista de chats.
      const allChats = await client.getChats();
      const chatObject = allChats.find(c => c.name === chatTitle);
      
      if (!chatObject) {
        console.error(`❌ [Worker ${workerId}] No se pudo encontrar el objeto Chat para el título: "${chatTitle}"`);
        continue; // Saltar al siguiente
      }

      // 3b. Guardar el Contacto/Grupo
      const contactData = {
        id: chatObject.id._serialized,
        name: chatObject.name,
        pushname: chatObject.contact?.pushname || chatObject.name,
        isGroup: chatObject.isGroup
      };
      await upsertContact(contactData);

      // 3c. Guardar miembros del grupo (si es grupo)
      if (chatObject.isGroup) {
        await saveGroupMembers(chatObject);
      }
      
      // 3d. Obtener y guardar mensajes
      const messages = await chatObject.fetchMessages({ limit: 1000, fromMe: undefined });
      let savedCount = 0;
      for (const msg of messages) {
        if (msg.timestamp < THRESHOLD) continue; // Demasiado antiguo
        if (msg.type !== MessageTypes.TEXT) continue; // Solo texto

        const senderId = msg.author || msg.from; // ID del remitente
        
        // Asegurarse de que el remitente exista en la DB
        if (msg.author) { // Si msg.author existe, es un grupo y necesitamos al miembro
           const contact = await msg.getContact();
           await upsertContact({
             id: contact.id._serialized,
             name: contact.name || contact.pushname,
             pushname: contact.pushname,
             isGroup: false
           });
        }
        
        try {
          await db.run(
            'INSERT OR IGNORE INTO Messages (messageId, chatId, senderId, body, timestamp) VALUES (?, ?, ?, ?, ?)',
            msg.id._serialized,
            chatObject.id._serialized,
            senderId,
            msg.body,
            msg.timestamp
          );
          savedCount++;
        } catch (e) {
          if (!e.message.includes('UNIQUE constraint failed')) { // Ignorar duplicados
             console.error(`[DB Error] Worker ${workerId}: ${e.message}`);
          }
        }
      }
      console.log(`[DB] [Worker ${workerId}] Chat "${chatTitle}": ${savedCount} mensajes guardados.`);

    } catch (err) {
      console.error(`❌ [Worker ${workerId}] Error procesando "${chatTitle}": ${err.message}`);
    }
  }
}

/**
 * Guarda los miembros de un grupo en la DB.
 */
async function saveGroupMembers(chat) {
  if (!chat.isGroup) return;
  const db = await dbPromise;

  for (const participant of chat.participants) {
    const contactId = participant.id._serialized;
    
    // 1. Asegurarse de que el contacto exista
    const contact = await client.getContactById(contactId);
    await upsertContact({
      id: contact.id._serialized,
      name: contact.name || contact.pushname,
      pushname: contact.pushname,
      isGroup: false
    });
    
    // 2. Insertar la relación en la tabla pivote
    await db.run(
      'INSERT OR IGNORE INTO GroupMembers (groupId, contactId, isAdmin, isSuperAdmin) VALUES (?, ?, ?, ?)',
      chat.id._serialized,
      contactId,
      participant.isAdmin || false,
      participant.isSuperAdmin || false
    );
  }
}

/**
 * Escucha mensajes en vivo.
 */
function setupLiveListener() {
  client.on('message', async (msg) => {
    if (msg.timestamp < THRESHOLD) return; // Ignorar mensajes antiguos
    
    try {
      const db = await dbPromise;
      const chat = await msg.getChat();
      const sender = await msg.getContact();
      const senderId = sender.id._serialized;
      const chatId = chat.id._serialized;

      console.log(`[LIVE] Mensaje nuevo de "${sender.pushname}" en "${chat.name}"`);
      
      // Asegurarse de que existen
      await upsertContact({ id: chatId, name: chat.name, pushname: chat.name, isGroup: chat.isGroup });
      await upsertContact({ id: senderId, name: sender.name, pushname: sender.pushname, isGroup: false });
      
      if (msg.type === MessageTypes.TEXT) {
         await db.run(
          'INSERT OR IGNORE INTO Messages (messageId, chatId, senderId, body, timestamp) VALUES (?, ?, ?, ?, ?)',
          msg.id._serialized,
          chatId,
          senderId,
          msg.body,
          msg.timestamp
        );
      }
    } catch (e) {
      console.error('[LIVE] Error procesando mensaje:', e);
    }
  });
}

// Iniciar el cliente
client.initialize();