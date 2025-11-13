const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'whatsapp.db');

let db;

/**
 * Define el esquema de la base de datos.
 * Esta función crea las tablas si no existen.
 */
async function initializeDatabase() {
  db = await sqlite.open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Usamos "exec" para correr múltiples sentencias de creación
  await db.exec(`
    PRAGMA foreign_keys = ON;

    -- Almacena las sesiones que gestiona el menú
    CREATE TABLE IF NOT EXISTS Sessions (
      sessionId TEXT PRIMARY KEY NOT NULL,
      description TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Almacena todos los contactos (personas y grupos)
    CREATE TABLE IF NOT EXISTS Contacts (
      contactId TEXT PRIMARY KEY NOT NULL, -- ej: '123456@c.us' o 'Grupo 63 MFP UCAM'
      name TEXT,                      -- El nombre que le pones en tu agenda
      pushname TEXT,                  -- El nombre que tienen ellos en su perfil
      isGroup BOOLEAN NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Almacena todos los mensajes
    CREATE TABLE IF NOT EXISTS Messages (
      messageId TEXT PRIMARY KEY NOT NULL, -- ej: 'true_12345@c.us_ABCDEF' o el UID de scraping
      chatId TEXT NOT NULL,          -- ID del chat (sea grupo o persona)
      senderId TEXT NOT NULL,        -- ID de quien envía (sea 'Yo' o un contacto)
      body TEXT,
      timestamp INTEGER NOT NULL,      -- Guardamos como UNIX timestamp
      FOREIGN KEY (chatId) REFERENCES Contacts(contactId),
      FOREIGN KEY (senderId) REFERENCES Contacts(contactId)
    );

    -- Tabla "pivote" para saber quién está en qué grupo
    CREATE TABLE IF NOT EXISTS GroupMembers (
      groupId TEXT NOT NULL,
      contactId TEXT NOT NULL,
      isAdmin BOOLEAN DEFAULT 0,
      isSuperAdmin BOOLEAN DEFAULT 0,
      PRIMARY KEY (groupId, contactId),
      FOREIGN KEY (groupId) REFERENCES Contacts(contactId),
      FOREIGN KEY (contactId) REFERENCES Contacts(contactId)
    );
  `);

  console.log('[DB] Base de datos inicializada en', dbPath);
  return db;
}

/**
 * Inserta o actualiza un contacto (usuario o grupo).
 */
async function upsertContact(contact) {
  if (!db) await initializeDatabase();
  const { id, name, pushname, isGroup } = contact;
  
  await db.run(
    'INSERT OR IGNORE INTO Contacts (contactId, name, pushname, isGroup) VALUES (?, ?, ?, ?)',
    id, name || null, pushname || null, isGroup ? 1 : 0
  );
  
  // Actualiza el nombre por si cambió
  await db.run(
    'UPDATE Contacts SET name = ?, pushname = ? WHERE contactId = ? AND (name IS NOT ? OR pushname IS NOT ?)',
    name || null, pushname || null, id, name || null, pushname || null
  );
}

/**
 * Devuelve la instancia de la DB.
 */
async function getDb() {
  if (db) return db;
  return await initializeDatabase();
}

module.exports = {
  getDb,
  initializeDatabase,
  upsertContact
};