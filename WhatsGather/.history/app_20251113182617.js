// export_wa.js
const { Client, LocalAuth, MessageTypes } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// ================== CONFIG ==================
const CONFIG = {
  // [2. GUARDAR SESIÓN] Carpeta para la sesión.
  SESSION_DIR: path.resolve(__dirname, ".wa-session"),
  EXPORT_DIR: path.resolve(__dirname, "exports"),
  DAYS_BACK: 30, // últimos N días
  LIVE_MINUTES: 0, // 0 = no escuchar; >0 = minutos escuchando
};

// ================ HELPERS ===================
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function sanitizeFilename(name = "whatsapp_chat") {
  let n = String(name).trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) n = "whatsapp_chat";
  if (n.length > 120) n = n.slice(0, 120).trim();
  return n;
}

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
// ============================================

console.log("Iniciando cliente de WhatsApp...");

// [2. GUARDAR SESIÓN]
// Usamos "LocalAuth" para guardar y reutilizar la sesión.
// La primera vez, generará un QR. Las siguientes, iniciará sesión automáticamente.
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CONFIG.SESSION_DIR }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// [1. GENERAR QR]
// Se dispara si no hay sesión guardada.
client.on('qr', (qr) => {
  console.log('¡NUEVO QR RECIBIDO! Escanéalo con tu teléfono.');
  // "Inyecta" (dibuja) el QR en la terminal.
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('Autenticado. La sesión ha sido guardada.');
});

client.on('auth_failure', msg => {
  console.error('ERROR DE AUTENTICACIÓN:', msg);
});

// ================== MAIN LOGIC ==================

// Cuando el cliente está listo (sesión cargada o QR escaneado)
client.on('ready', async () => {
  console.log('✅ ¡Cliente listo!');
  
  // Inicia la exportación del historial
  await exportAllChatHistory();

  // Si se configura, inicia el "modo live"
  if (CONFIG.LIVE_MINUTES > 0) {
    setupLiveListener();
  } else {
    console.log("Exportación de historial completada. Saliendo.");
    await client.destroy(); // Cierra la conexión
    process.exit(0);
  }
});

/**
 * Función principal para exportar el historial de chats.
 */
async function exportAllChatHistory() {
  console.log(`Iniciando exportación de los últimos ${CONFIG.DAYS_BACK} días...`);
  const THRESHOLD_DATE = daysAgoDate(CONFIG.DAYS_BACK);
  const THRESHOLD_TS = Math.floor(THRESHOLD_DATE.getTime() / 1000); // Timestamp en segundos

  ensureDir(CONFIG.EXPORT_DIR);
  const chats = await client.getChats();
  console.log(`Chats detectados: ${chats.length}`);

  // Procesamos los chats uno por uno para evitar rate limits
  for (const chat of chats) {
    const chatName = chat.name || chat.id.user;
    const fileName = sanitizeFilename(chatName) + ".txt";
    const filePath = path.join(CONFIG.EXPORT_DIR, fileName);

    // Usamos 'w' (write) para sobrescribir el archivo cada vez
    const ws = fs.createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });
    
    console.log(`▶️ Procesando: ${chatName}`);

    const allMessages = [];
    const seen = new Set();
    let keepFetching = true;
    let totalMsgsInChat = 0;

    while (keepFetching) {
      // fetchMessages es la clave. Trae mensajes en lotes (de más nuevo a más antiguo).
      const messages = await chat.fetchMessages({ limit: 50 });
      if (messages.length === 0) {
        break; // No hay más mensajes en el historial del chat
      }
      
      for (const msg of messages) {
        if (msg.timestamp < THRESHOLD_TS) {
          keepFetching = false; // Mensaje más antiguo que el límite, paramos
          break;
        }

        // Solo guardamos mensajes de texto (tipo 'chat')
        if (msg.type !== MessageTypes.TEXT) continue;
        if (seen.has(msg.id._serialized)) continue;

        allMessages.push(msg);
        seen.add(msg.id._serialized);
      }
      totalMsgsInChat += messages.length;
      process.stdout.write(`... ${totalMsgsInChat} mensajes revisados\r`);
      await new Promise(resolve => setTimeout(resolve, 250)); // Pequeña pausa
    }

    // Ordenamos los mensajes de más antiguo a más nuevo
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Escribimos en el archivo
    for (const msg of allMessages) {
      const line = await formatMessage(msg, chat.isGroup);
      ws.write(line + "\n");
    }

    ws.end();
    console.log(`✅ [${chatName}] Exportados ${allMessages.length} mensajes en ${fileName}`);
  }
}

/**
 * Inicia el listener para mensajes en vivo.
 */
function setupLiveListener() {
  console.log(`\n🎧 Escuchando mensajes en vivo durante ${CONFIG.LIVE_MINUTES} minutos...`);
  
  // Mapeo para guardar los streams de archivos abiertos
  const openStreams = new Map();

  client.on('message', async (msg) => {
    // Solo nos interesan mensajes nuevos (no del historial) y de texto
    if (msg.fromMe === false && msg.hasNewMessage && msg.type === MessageTypes.TEXT) {
      
      const chat = await msg.getChat();
      const chatName = chat.name || chat.id.user;
      
      let ws = openStreams.get(chat.id._serialized);
      
      // Si es el primer mensaje de este chat, abrimos su archivo en modo 'append'
      if (!ws) {
        const fileName = sanitizeFilename(chatName) + ".txt";
        const filePath = path.join(CONFIG.EXPORT_DIR, fileName);
        ws = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' }); // 'a' = append
        openStreams.set(chat.id._serialized, ws);
      }
      
      const line = await formatMessage(msg, chat.isGroup);
      console.log(`[NUEVO] ${line}`);
      ws.write("[NUEVO] " + line + "\n");
    }
  });

  // Temporizador para cerrar el script
  setTimeout(async () => {
    console.log("Tiempo de escucha finalizado. Cerrando streams y saliendo.");
    for (const stream of openStreams.values()) {
      stream.end();
    }
    await client.destroy();
    process.exit(0);
  }, CONFIG.LIVE_MINUTES * 60 * 1000);
}


/**
 * Formatea un objeto de mensaje en una línea de texto.
 */
async function formatMessage(msg, isGroup) {
  const d = new Date(msg.timestamp * 1000);
  const dateStr = fmtDate(d);
  
  let authorName = "Yo"; // Por defecto (si fromMe es true)
  
  if (isGroup && !msg.fromMe) {
    // msg.author es el ID (ej: 123456@c.us)
    // Para obtener el nombre, usamos getContact()
    try {
      const contact = await msg.getContact();
      authorName = contact.pushname || contact.name || msg.author;
    } catch (e) {
      authorName = msg.author; // Fallback al ID
    }
  }

  const text = (msg.body || "").replace(/\r?\n/g, " "); // Reemplaza saltos de línea
  return `[${dateStr}] ${authorName}: ${text}`;
}

// Iniciar el cliente
client.initialize();