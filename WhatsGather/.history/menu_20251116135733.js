// menu.js (Corregido)

const inquirer = require('inquirer');
const { spawn } = require('child_process');
const { getDb, initializeDatabase } = require('./db.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Llama a 'auth.js' (el nuevo, de Playwright) para el QR en terminal.
 */
async function createSession() {
  console.log('Iniciando nueva sesión... Se generará un ID temporal.');
  const tempSessionId = `session_${crypto.randomBytes(8).toString('hex')}`;
  
  const db = await getDb();
  await db.run(
    'INSERT INTO Sessions (sessionId, description) VALUES (?, ?)',
    tempSessionId,
    'Autenticando...' 
  );

  // =========================================================
  // --- INICIO DE LA CORRECCIÓN ---
  // Se debe crear el directorio de la sesión ANTES de que 'auth.js'
  // intente guardar los archivos de LocalAuth dentro de él.
  const sessionDir = path.resolve(__dirname, 'sessions', tempSessionId);
  if (!fs.existsSync(sessionDir)) {
    console.log(`[Menu] Creando directorio de sesión: ${sessionDir}`);
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  // --- FIN DE LA CORRECCIÓN ---
  // =========================================================
  
  console.log(`ID Temporal ${tempSessionId} creado. Lanzando script de autenticación (QR en terminal)...`);
  
  try {
    // Llama a 'auth.js' y espera
    // No pasa concurrencia, por eso el '1'
    await runScript('auth.js', [tempSessionId], false, 1);
    console.log(`\n✅ Autenticación para ${tempSessionId} completada. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante la autenticación: ${error.message}`);
    console.log(`Se borrará la sesión temporal ${tempSessionId} que no pudo ser autenticada.`);
    await db.run('DELETE FROM Sessions WHERE sessionId = ?', tempSessionId);
    
    // Borrar la carpeta si falló (usamos la variable 'sessionDir' ya definida)
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  
  return mainMenu();
}

/**
 * Inicia el proceso del bot de scraping (Playwright).
 */
async function startBot() {
  const db = await getDb();
  const sessions = await db.all('SELECT * FROM Sessions ORDER BY createdAt DESC');
  if (sessions.length === 0) {
    console.log('No hay sesiones iniciadas. Debes crear una primero.');
    return mainMenu();
  }

  const { session } = await inquirer.prompt([
    {
      type: 'list',
      name: 'session',
      message: 'Elige una sesión para iniciar el bot de scraping:',
      choices: sessions.map(s => ({
        name: `${s.description} (ID: ${s.sessionId})`,
        value: s.sessionId
      }))
    }
  ]);

  const { concurrencyInput } = await inquirer.prompt([
    {
      type: 'number',
      name: 'concurrencyInput',
      message: '¿Cuántos chats procesar en paralelo? (1-10):',
      default: 1, // Default a 1, como en tu script
      validate: (val) => val > 0 && val <= 20
    }
  ]);

  console.log(`🚀 Iniciando bot Playwright con la sesión: ${session}...`);
  console.log(`🔥 Nivel de concurrencia: ${concurrencyInput} tabs a la vez.`);
  
  try {
    // Llama a 'export_wa.js' y pasa los 3 argumentos
    await runScript('export_wa.js', [session, 'true', String(concurrencyInput)], true);
    console.log(`\n✅ Proceso de scraping para ${session} completado. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante el scraping: ${error.message}`);
  }

  return mainMenu();
}

/**
 * Función genérica para lanzar un script.
 * @param {string} scriptName - 'auth.js' o 'export_wa.js'
 * @param {string[]} scriptArgs - Argumentos para el script
 * @param {boolean} isPlaywright - (Ignorado, ahora siempre es PW)
 * @param {number} concurrency - (Solo para 'export_wa.js')
 * @returns {Promise<void>}
 */
function runScript(scriptName, scriptArgs = [], isPlaywright = false, concurrency = 1) {
  // Construimos los argumentos
  let args;
  if (scriptName === 'auth.js') {
    args = [scriptName, scriptArgs[0]]; // solo sessionId
  } else {
    args = [scriptName, scriptArgs[0], scriptArgs[1], String(concurrency)]; // sessionId, keepLive, concurrency
  }
  
  const env = { 
    ...process.env, 
    "PW_HEADLESS": "false" // Forzar siempre visible en VNC (necesario para Xvfb)
  };

  return new Promise((resolve, reject) => {
    const botProcess = spawn('node', args, {
      stdio: 'inherit',
      env: env
    });

    botProcess.on('close', (code) => {
      console.log(`\nEl script ${scriptName} (PID: ${botProcess.pid}) ha terminado con código ${code}.`);
      if (code !== 0) {
        reject(new Error(`El script ${scriptName} falló con código de salida ${code}.`));
      } else {
        resolve(); // Éxito
      }
    });

    botProcess.on('error', (err) => {
      console.error(`Error al iniciar el script ${scriptName}:`, err);
      reject(err);
    });
  });
}

async function listSessions() {
  console.clear();
  const db = await getDb();
  const sessions = await db.all('SELECT * FROM Sessions ORDER BY createdAt DESC');
  if (sessions.length === 0) {
    console.log('\nNo hay sesiones creadas.');
  } else {
    console.log('\n--- Sesiones Almacenadas ---');
    sessions.forEach(s => { console.log(`- ${s.description} (ID: ${s.sessionId})`); console.log(`  Creada: ${s.createdAt}`); });
    console.log('----------------------------\n');
  }
  return mainMenu();
}

async function deleteSession() {
  const db = await getDb();
  const sessions = await db.all('SELECT * FROM Sessions');
  if (sessions.length === 0) { console.log('No hay sesiones para borrar.'); console.clear(); return mainMenu(); }
  const { sessionToDelete } = await inquirer.prompt([
    {
      type: 'list', name: 'sessionToDelete', message: 'Elige una sesión para eliminar:',
      choices: [
        ...sessions.map(s => ({ name: `${s.description} (ID: ${s.sessionId})`, value: s.sessionId })),
        new inquirer.Separator(),
        { name: 'Cancelar', value: 'cancel' }
      ]
    }
  ]);
  if (sessionToDelete === 'cancel') { console.clear(); return mainMenu(); }
  
  // Borrar la carpeta de sesión
  const sessionDir = path.resolve(__dirname, 'sessions', sessionToDelete);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`Carpeta de sesión ${sessionDir} eliminada.`);
    }
  } catch (e) {
    console.error(`Error al eliminar la carpeta ${sessionDir}:`, e.message);
  }

  await db.run('DELETE FROM Sessions WHERE sessionId = ?', sessionToDelete);
  console.log(`Sesión ${sessionToDelete} eliminada de la base de datos.`);
  console.clear();
  return mainMenu();
}

async function mainMenu() {
  try {
    const answers = await inquirer.prompt([
      {
        type: 'list', name: 'action', message: 'Gestor WhatsApp (Motor: Playwright Unificado)',
        choices: [
          new inquirer.Separator('--- Gestión de Cuentas ---'),
          { name: 'Crear y Autenticar Nueva Sesión (QR en Terminal)', value: 'create' },
          { name: 'Listar sesiones', value: 'list' },
          { name: 'Eliminar sesión', value: 'delete' },
          new inquirer.Separator('--- Ejecución del Bot ---'),
          { name: 'Iniciar Exportación (Modo Live)', value: 'start' },
          new inquirer.Separator('--- Utilidades ---'),
          { name: 'Limpiar Pantalla', value: 'clear' },
          { name: 'Salir', value: 'exit' },
        ]
      }
    ]);

    switch (answers.action) {
      case 'create': return createSession();
      case 'start': return startBot();
      case 'list': return listSessions();
      case 'delete': return deleteSession();
      case 'clear': console.clear(); return mainMenu();
      case 'exit': console.log('Adiós.'); process.exit(0);
    }
  } catch (e) { console.error('Error en el menú principal:', e); }
}

(async () => {
  try {
    await initializeDatabase();
    console.clear(); 
    await mainMenu();
  } catch (e) { console.error('Error al inicializar:', e); }
})();