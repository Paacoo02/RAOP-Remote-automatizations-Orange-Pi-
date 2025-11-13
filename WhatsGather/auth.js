const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { getDb } = require('./db.js');

// 1. Leer el ID de sesión temporal que nos pasa 'menu.js'
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('❌ Error fatal: No se proporcionó un ID de sesión a auth.js.');
  process.exit(1);
}

const dbPromise = getDb();
// ¡USA LA MISMA RUTA DE SESIÓN QUE PLAYWRIGHT USARÁ!
const sessionPath = path.resolve(__dirname, 'sessions', sessionId);

console.log(`[Auth] Preparando sesión en: ${sessionPath}`);
console.log("[Auth] Lanzando cliente (whatsapp-web.js) para obtener QR...");

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath }),
  puppeteer: {
    headless: true, // Este siempre es invisible
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// 2. Generar el QR en la terminal
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
  console.log('[Auth] Autenticado. La sesión ha sido guardada.');
});

// 3. Cuando está listo, actualiza la DB y CIERRA BRUSCAMENTE
client.on('ready', async () => {
  console.log('✅ ¡Cliente listo!');
  const profileName = client.info.pushname || "Perfil Desconocido";
  const myId = client.info.wid._serialized;

  console.log(`[Auth] Perfil detectado: ${profileName} (${myId})`);
  
  const db = await dbPromise;
  await db.run(
    'UPDATE Sessions SET description = ? WHERE sessionId = ?',
    profileName,
    sessionId
  );
  console.log(`[Auth] Sesión ${sessionId} actualizada con el nombre: ${profileName}`);
  
  // 4. ¡LA CORRECCIÓN!
  // No llamamos a client.destroy(). Salimos bruscamente para
  // dejar los archivos de sesión intactos para Playwright.
  console.log('[Auth] Sesión guardada. Saliendo... (process.exit)');
  process.exit(0); // ¡Éxito!
});

client.on('auth_failure', msg => {
  console.error('[Auth] ERROR DE AUTENTICACIÓN:', msg);
  process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log('[Auth] Cliente desconectado:', reason);
  process.exit(1);
});

// Iniciar el cliente de autenticación
client.initialize();