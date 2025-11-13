const inquirer = require('inquirer');
const { spawn } = require('child_process');
const { getDb, initializeDatabase } = require('./db.js');
const crypto = require('crypto');

/**
 * Función para crear y autenticar una nueva sesión.
 * Llama a 'export_wa.js' en modo "creación".
 */
async function createSession() {
  console.log('Iniciando nueva sesión... Se generará un ID temporal.');
  const tempSessionId = `session_${crypto.randomBytes(8).toString('hex')}`;
  
  const db = await getDb();
  await db.run(
    'INSERT INTO Sessions (sessionId, description) VALUES (?, ?)',
    tempSessionId,
    'Autenticando...' // El bot lo actualizará con el nombre real
  );
  
  console.log(`ID Temporal ${tempSessionId} creado. Lanzando bot (fusión) para autenticar...`);
  
  try {
    // 3. Lanzar el bot en modo "creación" (keepLive=false)
    await runScript(tempSessionId, false);
    console.log(`\n✅ Autenticación para ${tempSessionId} completada. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante la autenticación: ${error.message}`);
    console.log(`Se borrará la sesión temporal ${tempSessionId} que no pudo ser autenticada.`);
    await db.run('DELETE FROM Sessions WHERE sessionId = ?', tempSessionId);
    // TODO: Borrar la carpeta /sessions/
  }
  
  return mainMenu();
}

/**
 * Inicia el proceso del bot en modo "Live".
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

  // ¡Pregunta de concurrencia eliminada!
  
  console.log(`🚀 Iniciando bot (fusión) con la sesión: ${session}...`);
  
  try {
    // Lanzamos el bot en modo "Live"
    await runScript(session, true);
    console.log(`\n✅ Proceso de scraping para ${session} completado. Volviendo al menú.`);
  
  } catch (error) {
    console.error(`\n❌ Error durante el scraping: ${error.message}`);
  }

  return mainMenu();
}

/**
 * Función genérica para lanzar el bot.
 * @param {string} sessionId - El ID de la sesión a usar
 * @param {boolean} keepLive - Si debe seguir corriendo o cerrarse tras la exportación
 * @returns {Promise<void>}
 */
function runScript(sessionId, keepLive) {
  const args = [
    'export_wa.js', // ¡EL SCRIPT FUSIONADO!
    sessionId,
    keepLive ? 'true' : 'false'
    // Ya no pasamos concurrencia
  ];
  
  const env = { 
    ...process.env, 
    "PW_HEADLESS": "false" // Forzamos el modo visible en VNC
  };

  return new Promise((resolve, reject) => {
    const botProcess = spawn('node', args, {
      stdio: 'inherit',
      env: env
    });

    botProcess.on('close', (code) => {
      console.log(`\nEl script export_wa.js (PID: ${botProcess.pid}) ha terminado con código ${code}.`);
      if (code !== 0) {
        reject(new Error(`El script falló con código de salida ${code}.`));
      } else {
        resolve(); // Éxito
      }
    });

    botProcess.on('error', (err) => {
      console.error('Error al iniciar el script export_wa.js:', err);
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
    console.clear(); // Limpia la pantalla
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
    console.clear(); // Limpia la pantalla
    return mainMenu();
  }

  // TODO: Borrar la carpeta de sesión (ej: /app/sessions/SESSION_ID)
  // const fs = require('fs');
  // fs.rmSync(path.resolve(__dirname, 'sessions', sessionToDelete), { recursive: true, force: true });

  await db.run('DELETE FROM Sessions WHERE sessionId = ?', sessionToDelete);
  console.log(`Sesión ${sessionToDelete} eliminada de la base de datos.`);
  
  console.clear(); // Limpia la pantalla
  return mainMenu();
}

async function mainMenu() {
  try {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Gestor WhatsApp (Motor: FUSIÓN)',
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