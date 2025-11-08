// server.js
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = 'mongodb+srv://jgironm20:haxnJx9nctumRp3P@cluster0.ckdcpb7.mongodb.net/?appName=Cluster0';
const client = new MongoClient(uri);
let db, users, doors, accessLogs;

// MQTT Configuration
const MQTT_BROKER = 'mqtt://206.189.214.35:1883';
const mqttClient = mqtt.connect(MQTT_BROKER);

// Topics MQTT
const TOPICS = {
  DOOR_OPEN_REQUEST: 'access/door/open/request',
  DOOR_OPEN_RESPONSE: 'access/door/open/response',
  DOOR_SENSOR_STATUS: 'access/door/sensor/status',
  DOOR_DENIED: 'access/door/denied',
  UNAUTHORIZED_ACCESS: 'access/door/unauthorized'
};

// Constante de nombre de puerta única
const DOOR_ID = 'Puerta Principal';

// Store para manejar solicitudes pendientes
const pendingRequests = new Map();

// Set para evitar logs duplicados (usar hash de contenido)
const recentLogs = new Set();

// Helper para generar timestamp consistente
function getServerTimestamp() {
  return new Date().toISOString();
}

// Helper para crear hash de log (evitar duplicados)
function createLogHash(logEntry) {
  const { userId, accessCode, doorId, granted, status } = logEntry;
  const baseTime = Math.floor(Date.now() / 1000); // Segundos
  return `${userId}-${accessCode}-${doorId}-${granted}-${status}-${baseTime}`;
}

// Helper publish
function publish(topic, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  console.log(`[MQTT->] ${topic}: ${payload}`);
  mqttClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) console.error(`[ERROR publish] ${topic}:`, err);
  });
}

// Configurar cliente MQTT
mqttClient.on('connect', () => {
  console.log(`✓ Conectado al broker MQTT: ${MQTT_BROKER}`);

  mqttClient.subscribe(TOPICS.DOOR_OPEN_RESPONSE, (err) => {
    console.log('Sub DOOR_OPEN_RESPONSE', err ? `ERROR ${err.message}` : '✓');
  });

  mqttClient.subscribe(TOPICS.DOOR_SENSOR_STATUS, (err) => {
    console.log('Sub DOOR_SENSOR_STATUS', err ? `ERROR ${err.message}` : '✓');
  });

  mqttClient.subscribe(TOPICS.UNAUTHORIZED_ACCESS, (err) => {
    console.log('Sub UNAUTHORIZED_ACCESS', err ? `ERROR ${err.message}` : '✓');
  });
});

mqttClient.on('reconnect', () => console.log('⚠️ MQTT reconectando...'));
mqttClient.on('offline', () => console.log('⚠️ MQTT offline'));
mqttClient.on('error', (error) => console.error('✗ Error MQTT:', error));

mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log(`[MQTT<-] ${topic}:`, data);

    if (topic === TOPICS.DOOR_OPEN_RESPONSE) {
      await handleDoorOpenResponse(data);
    } else if (topic === TOPICS.DOOR_SENSOR_STATUS) {
      await handleDoorSensorStatus(data);
    } else if (topic === TOPICS.UNAUTHORIZED_ACCESS) {
      await handleUnauthorizedAccess(data);
    }
  } catch (error) {
    console.error('Error procesando mensaje MQTT:', error);
  }
});

async function handleDoorOpenResponse(data) {
  const { requestId, success, error } = data;
  console.log(`[handleDoorOpenResponse] RequestId: ${requestId}, Success: ${success}`);

  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    request.doorResponse = { success, error };

    if (!success) {
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: DOOR_ID,
        granted: false,
        reason: `Error en puerta: ${error}`,
        status: 'error_puerta'
      });

      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: false,
          granted: false,
          error: `Error del sistema: ${error}`,
          timestamp: getServerTimestamp()
        });
      }
      pendingRequests.delete(requestId);
    }
  }
}

async function handleDoorSensorStatus(data) {
  const { requestId, doorOpened, doorClosed, event } = data;

  console.log('[handleDoorSensorStatus]', {
    requestId,
    doorOpened,
    doorClosed,
    event
  });

  // Determinar estado solo si hay cambio explícito
  let doorState = null;
  if (doorClosed === true) {
    doorState = 'closed';
  } else if (doorOpened === true) {
    doorState = 'open';
  }

  // Usar timestamp del servidor
  const serverTimestamp = getServerTimestamp();

  // Actualizar BD solo si hay cambio de estado confirmado
  if (doorState !== null) {
    await doors.updateOne(
      { doorId: DOOR_ID },
      {
        $set: {
          state: doorState,
          lastEventTs: serverTimestamp,
          lastEvent: event || 'sensor_update'
        }
      },
      { upsert: true }
    );
    console.log(`✓ Estado actualizado: ${doorState.toUpperCase()} - ${serverTimestamp}`);
  }

  // Procesar requestId pendiente SOLO si hubo apertura exitosa
  if (requestId && pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);

    if (doorOpened === true) {
      // Apertura exitosa - registrar UNA SOLA VEZ
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: DOOR_ID,
        granted: true,
        reason: request.isManual ? 'Apertura manual desde dashboard' : null,
        status: request.isManual ? 'apertura_manual' : 'acceso_concedido'
      });

      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: true,
          granted: true,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          manual: request.isManual || false,
          timestamp: serverTimestamp
        });
      }
      pendingRequests.delete(requestId);

    } else if (doorClosed === true && !doorOpened) {
      // Puerta no se abrió
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: DOOR_ID,
        granted: false,
        reason: 'La puerta no se abrió',
        status: 'error_puerta'
      });

      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: false,
          granted: false,
          error: 'La puerta no respondió correctamente',
          timestamp: serverTimestamp
        });
      }
      pendingRequests.delete(requestId);
    }
  }

  // Detectar puerta dejada abierta (sin requestId)
  if (!requestId && doorOpened === true && event === 'door_opened') {
    console.log('⚠️ ALERTA: Puerta abierta sin autorización');
    await handleUnauthorizedAccess({
      event: 'door_left_open',
      message: 'Puerta abierta físicamente sin autorización',
      reason: 'Apertura física sin autorización'
    });
  }
}

async function handleUnauthorizedAccess(data) {
  const { event, message, reason } = data;
  const serverTimestamp = getServerTimestamp();

  console.log('⚠️ Acceso no autorizado:', reason || message);

  // Registrar intento no autorizado UNA SOLA VEZ
  await logAccessAttempt({
    user: null,
    accessCode: null,
    doorId: DOOR_ID,
    granted: false,
    reason: reason || message || 'Apertura física sin autorización',
    status: 'acceso_no_autorizado'
  });

  // Solo actualizar estado si es apertura física real
  if (event === 'door_left_open' || (message && message.includes('físicamente'))) {
    await doors.updateOne(
      { doorId: DOOR_ID },
      {
        $set: {
          state: 'open',
          lastEventTs: serverTimestamp,
          lastEvent: event || 'unauthorized_access'
        }
      },
      { upsert: true }
    );
    console.log('✓ Estado actualizado: OPEN (acceso no autorizado)');
  }
}

async function logAccessAttempt(requestData) {
  const { user, accessCode, doorId, granted, reason, status } = requestData;

  const logEntry = {
    userId: user?._id || null,
    userName: user?.name || null,
    accessCode,
    doorId,
    granted,
    reason,
    status,
    timestamp: getServerTimestamp() // Usar timestamp del servidor
  };

  // Evitar duplicados usando hash temporal (1 segundo de ventana)
  const logHash = createLogHash(logEntry);
  
  if (recentLogs.has(logHash)) {
    console.log('⚠️ Log duplicado detectado, omitiendo...');
    return;
  }

  recentLogs.add(logHash);
  setTimeout(() => recentLogs.delete(logHash), 2000); // Limpiar después de 2s

  console.log('📝 Registrando acceso:', logEntry);
  await accessLogs.insertOne(logEntry);
}

async function connectDB() {
  try {
    await client.connect();
    console.log('✓ Conectado a MongoDB Atlas');
    db = client.db('usuariotelecomunicaciones');
    users = db.collection('users');
    doors = db.collection('doors');
    accessLogs = db.collection('accessLogs');
    await initializeData();
  } catch (error) {
    console.error('Error conectando a MongoDB:', error);
    process.exit(1);
  }
}

async function initializeData() {
  // Crear usuarios por defecto
  const userCount = await users.countDocuments();
  if (userCount === 0) {
    console.log('Creando usuarios iniciales...');
    await users.insertMany([
      { name: 'Admin', accessCode: '1234', isActive: true },
      { name: 'Usuario1', accessCode: '5678', isActive: true },
      { name: 'Joselu', accessCode: '2222', isActive: false }
    ]);
  }

  // IMPORTANTE: Limpiar puertas con nombres incorrectos
  console.log('🧹 Limpiando puertas duplicadas...');
  await doors.deleteMany({ doorId: { $ne: DOOR_ID } });

  const doorExists = await doors.findOne({ doorId: DOOR_ID });
  if (!doorExists) {
    console.log(`Creando puerta única: ${DOOR_ID}`);
    await doors.insertOne({
      doorId: DOOR_ID,
      state: 'closed',
      lastEventTs: getServerTimestamp(),
      lastEvent: 'initialized'
    });
  } else {
    console.log(`✓ Puerta existente: ${DOOR_ID}`);
  }
}

// Validar acceso
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = DOOR_ID } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const user = await users.findOne({ accessCode: code });

    if (user && user.isActive) {
      console.log(`✓ Acceso autorizado: ${user.name}`);

      pendingRequests.set(requestId, {
        user,
        accessCode: code,
        doorId,
        res,
        timestamp: getServerTimestamp(),
        isManual: false
      });

      publish(TOPICS.DOOR_OPEN_REQUEST, {
        requestId,
        action: 'open_door',
        doorId,
        userId: user._id.toString(),
        userName: user.name,
        timestamp: getServerTimestamp()
      });

      setTimeout(async () => {
        if (pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId);
          await logAccessAttempt({
            user,
            accessCode: code,
            doorId,
            granted: false,
            reason: 'Timeout - No hay respuesta del sistema de puerta',
            status: 'timeout'
          });
          if (request.res && !request.res.headersSent) {
            request.res.status(408).json({
              granted: false,
              error: 'Timeout esperando respuesta de puerta',
              timestamp: getServerTimestamp()
            });
          }
          pendingRequests.delete(requestId);
        }
      }, 10000);

    } else {
      const reason = user ? 'Usuario inactivo' : 'Código inválido';
      console.log(`✗ Acceso denegado: ${reason}`);

      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        action: 'unauthorized_access',
        doorId,
        reason,
        event: user ? 'usuario_inactivo' : 'codigo_invalido',
        timestamp: getServerTimestamp()
      });

      // Registrar UNA SOLA VEZ
      await logAccessAttempt({
        user,
        accessCode: code,
        doorId,
        granted: false,
        reason,
        status: user ? 'usuario_inactivo' : 'codigo_invalido'
      });

      return res.json({
        granted: false,
        userId: user?._id || null,
        userName: user?.name || null,
        reason,
        timestamp: getServerTimestamp()
      });
    }
  } catch (error) {
    console.error('Error en validación de acceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Abrir puerta manualmente
app.post('/api/doors/open/manual', async (req, res) => {
  try {
    const { adminName = 'Administrador Dashboard', doorId = DOOR_ID } = req.body;
    const requestId = `req_manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`✓ Apertura manual por: ${adminName}`);

    pendingRequests.set(requestId, {
      user: { name: adminName, _id: 'admin' },
      accessCode: 'MANUAL',
      doorId,
      res,
      timestamp: getServerTimestamp(),
      isManual: true
    });

    publish(TOPICS.DOOR_OPEN_REQUEST, {
      requestId,
      action: 'open_door',
      doorId,
      userId: 'admin',
      userName: adminName,
      manual: true,
      timestamp: getServerTimestamp()
    });

    setTimeout(async () => {
      if (pendingRequests.has(requestId)) {
        const request = pendingRequests.get(requestId);
        await accessLogs.insertOne({
          userId: 'admin',
          userName: adminName,
          accessCode: 'MANUAL',
          doorId,
          granted: false,
          reason: 'Timeout - No hay respuesta del sistema de puerta',
          status: 'timeout',
          timestamp: getServerTimestamp()
        });
        if (request.res && !request.res.headersSent) {
          request.res.status(408).json({
            success: false,
            error: 'Timeout esperando respuesta',
            timestamp: getServerTimestamp()
          });
        }
        pendingRequests.delete(requestId);
      }
    }, 10000);
  } catch (error) {
    console.error('Error en apertura manual:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Estado de puerta en tiempo real
app.get('/api/doors/status/realtime', async (req, res) => {
  try {
    const door = await doors.findOne({ doorId: DOOR_ID });
    if (!door) {
      return res.status(404).json({ error: 'Puerta no encontrada' });
    }
    res.json({
      doorId: door.doorId,
      state: door.state,
      lastEventTs: door.lastEventTs,
      lastEvent: door.lastEvent || 'unknown',
      isOpen: door.state === 'open',
      isClosed: door.state === 'closed'
    });
  } catch (error) {
    console.error('Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Historial de accesos - ORDENADO DEL MÁS RECIENTE AL MÁS ANTIGUO
app.get('/api/access/logs', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await accessLogs
      .find({})
      .sort({ timestamp: -1 }) // -1 = descendente (más reciente primero)
      .limit(parseInt(limit))
      .toArray();
    res.json(logs);
  } catch (error) {
    console.error('Error obteniendo logs de acceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Accesos no autorizados - ORDENADO DEL MÁS RECIENTE AL MÁS ANTIGUO
app.get('/api/access/unauthorized', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const unauthorizedLogs = await accessLogs
      .find({ status: 'acceso_no_autorizado' })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .toArray();
    res.json(unauthorizedLogs);
  } catch (error) {
    console.error('Error obteniendo accesos no autorizados:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// CRUD Usuarios
app.post('/api/users', async (req, res) => {
  try {
    const { name, accessCode, isActive = true } = req.body;
    if (!name || !accessCode) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    const exists = await users.findOne({ accessCode });
    if (exists) {
      return res.status(409).json({ error: 'Código ya en uso' });
    }
    const result = await users.insertOne({ name, accessCode, isActive });
    res.status(201).json({
      id: result.insertedId,
      name,
      accessCode,
      isActive
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await users.find({}).toArray();
    res.json(allUsers);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, accessCode, isActive } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (accessCode !== undefined) updateData.accessCode = accessCode;
    if (isActive !== undefined) updateData.isActive = isActive;
    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Usuario actualizado correctamente' });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await users.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/doors/:doorId/status', async (req, res) => {
  try {
    const door = await doors.findOne({ doorId: DOOR_ID });
    if (!door) {
      return res.status(404).json({ error: 'Puerta no encontrada' });
    }
    res.json({
      doorId: DOOR_ID,
      state: door.state,
      lastEventTs: door.lastEventTs,
      lastEvent: door.lastEvent
    });
  } catch (error) {
    console.error('Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

process.on('SIGINT', async () => {
  console.log('Cerrando conexión a MongoDB...');
  mqttClient.end();
  await client.close();
  process.exit(0);
});

connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== Servidor escuchando en puerto ${PORT} ===`);
    console.log(`API: http://0.0.0.0:${PORT}/api`);
    console.log(`MQTT: ${MQTT_BROKER}\n`);
  });
});
