const inquirer = require('inquirer');
const { spawn } = require('child_process');
const { getDb, initializeDatabase } = require('./db.js');
const crypto = require('crypto');

/**
 * Función para crear y autenticar una nueva sesión.
 * Llama a 'auth.js' para el QR en terminal.
 */

// Añade esto en menu.js, cerca de la función runScript

function runAuthScript(sessionId) {
  const args = [
    'auth.js', // ¡Llama a auth.js!
    sessionId
  ];
  
  // No necesitamos forzar PW_HEADLESS aquí
  const env = { ...process.env };

  return new Promise((resolve, reject) => {
    const authProcess = spawn('node', args, {
      stdio: 'inherit', // Para que veamos el QR en la terminal
      env: env
    });

    authProcess.on('close', (code) => {
      console.log(`\nEl script auth.js ha terminado con código ${code}.`);
      if (code !== 0) {
        reject(new Error(`El script de autenticación falló con código ${code}.`));
      } else {
        resolve(); // Éxito
      }
    });

    authProcess.on('error', (err) => {
      console.error('Error al iniciar auth.js:', err);
      reject(err);
    });
  });
}

async function createSession() {
  console.log('Iniciando nueva sesión... Se generará un ID temporal.');
  const tempSessionId = `session_${crypto.randomBytes(8).toString('hex')}`;
  
  const db = await getDb();
  await db.run(
    'INSERT INTO Sessions (sessionId, description) VALUES (?, ?)',
    tempSessionId,
    'Autenticando...' // auth.js lo actualizará con el nombre real
  );
  
  console.log(`ID Temporal ${tempSessionId} creado. Lanzando autenticador (auth.js)...`);
  
  try {
    // 3. Lanzar el bot de AUTENTICACIÓN
    await runScript('auth.js', [tempSessionId]);
    console.log(`\n✅ Autenticación para ${tempSessionId} completada. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante la autenticación: ${error.message}`);
    console.log(`Se borrará la sesión temporal ${tempSessionId} que no pudo ser autenticada.`);
    await db.run('DELETE FROM Sessions WHERE sessionId = ?', tempSessionId);
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
      default: 4,
      validate: (val) => val > 0 && val <= 20
    }
  ]);

  console.log(`🚀 Iniciando bot Playwright con la sesión: ${session}...`);
  console.log(`🔥 Nivel de concurrencia: ${concurrencyInput} tabs a la vez.`);
  
  try {
    // Lanzamos el bot de PLAYWRIGHT
    await runScript('export_wa.js', [session, String(concurrencyInput)], true); // true = es Playwright
    console.log(`\n✅ Proceso de scraping para ${session} completado. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante el scraping: ${error.message}`);
  }

  return mainMenu();
}

/**
 * Función genérica para lanzar un script y esperar a que termine.
 * @param {string} scriptName - El nombre del script (ej: 'auth.js')
 * @param {string[]} scriptArgs - Argumentos para el script
 * @param {boolean} isPlaywright - Si es Playwright, forzamos PW_HEADLESS=false
 * @returns {Promise<void>}
 */
function runScript(scriptName, scriptArgs = [], isPlaywright = false) {
  const args = [scriptName, ...scriptArgs];
  let env = { ...process.env }; // Hereda el entorno actual

  if (isPlaywright) {
    env["PW_HEADLESS"] = "false"; // Forzamos el modo visible en VNC
  }

  return new Promise((resolve, reject) => {
    const botProcess = spawn('node', args, {
      stdio: 'inherit', // Muestra la salida (logs) del bot en esta terminal
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
    sessions.forEach(s => {
      console.log(`- ${s.description} (ID: ${s.sessionId})`);
      console.log(`  Creada: ${s.createdAt}`);
    });
    console.log('----------------------------\n');
  }
  return mainMenu();
}

async function deleteSession() {
  const db = await getDb();
  const sessions = await db.all('SELECT * FROM Sessions');
  if (sessions.length === 0) {
    console.log('No hay sesiones para borrar.');
    return mainMenu();
  }

  const { sessionToDelete } = await inquirer.prompt([
    {
      type: 'list',
      name: 'sessionToDelete',
      message: 'Elige una sesión para eliminar:',
      choices: [
        ...sessions.map(s => ({
          name: `${s.description} (ID: ${s.sessionId})`,
          value: s.sessionId
        })),
        new inquirer.Separator(),
        { name: 'Cancelar', value: 'cancel' }
      ]
    }
  ]);

  if (sessionToDelete === 'cancel') {
    return mainMenu();
  }

  // TODO: Borrar la carpeta de sesión (ej: /app/sessions/SESSION_ID)
  // const fs = require('fs');
  // fs.rmSync(path.resolve(__dirname, 'sessions', sessionToDelete), { recursive: true, force: true });

  await db.run('DELETE FROM Sessions WHERE sessionId = ?', sessionToDelete);
  console.log(`Sesión ${sessionToDelete} eliminada de la base de datos.`);
  return mainMenu();
}

async function mainMenu() {
  try {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Gestor Híbrido de WhatsApp (QR-Term / Playwright-Scrape)',
        choices: [
          new inquirer.Separator('--- Gestión de Cuentas ---'),
          { name: 'Crear y Autenticar Nueva Sesión (con QR en Terminal)', value: 'create' },
          { name: 'Listar sesiones', value: 'list' },
          { name: 'Eliminar sesión', value: 'delete' },
          new inquirer.Separator('--- Ejecución del Bot ---'),
          { name: 'Iniciar Scraping (con Playwright en VNC)', value: 'start' },
          new inquirer.Separator('--- Utilidades ---'),
          { name: 'Limpiar Pantalla', value: 'clear' },
          { name: 'Salir', value: 'exit' },
        ]
      }
    ]);

    switch (answers.action) {
      case 'create':
        return createSession();
      case 'start':
        return startBot();
      case 'list':
        return listSessions();
      case 'delete':
        return deleteSession();
      case 'clear':
        console.clear();
        return mainMenu();
      case 'exit':
        console.log('Adiós.');
        process.exit(0);
    }
  } catch (e) {
    console.error('Error en el menú principal:', e);
  }
}

(async () => {
  try {
    await initializeDatabase();
    console.clear(); 
    await mainMenu();
  } catch (e) {
    console.error('Error al inicializar:', e);
  }
})();