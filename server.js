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
        status: 'error_puerta',
        timestamp: new Date().toISOString()
      });
      
      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: false,
          granted: false,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: `Error en puerta: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
      pendingRequests.delete(requestId);
    }
  }
}

async function handleDoorSensorStatus(data) {
  const { requestId, doorOpened, doorClosed, timestamp, event } = data;

  console.log('[handleDoorSensorStatus] Datos recibidos:', {
    requestId,
    doorOpened,
    doorClosed,
    event,
    timestamp
  });

  // Determinar estado solo si hay cambio explícito del sensor
  let doorState = null;
  const currentTimestamp = timestamp || new Date().toISOString();

  // CRÍTICO: Solo actualizar si hay valores booleanos explícitos
  if (doorClosed === true) {
    doorState = 'closed';
  } else if (doorOpened === true) {
    doorState = 'open';
  }

  // Actualizar BD solo si hay cambio de estado confirmado
  if (doorState !== null) {
    await doors.updateOne(
      { doorId: DOOR_ID },
      {
        $set: {
          state: doorState,
          lastEventTs: currentTimestamp,
          lastEvent: event || 'status_update'
        }
      },
      { upsert: true }
    );
    console.log(`✓ Estado actualizado: ${doorState.toUpperCase()} - Event: ${event}`);
  }

  // Procesar requestId pendiente SOLO si hubo apertura exitosa
  if (requestId && pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);

    if (doorOpened === true) {
      // Apertura exitosa
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: DOOR_ID,
        granted: true,
        reason: request.isManual ? 'Apertura manual desde dashboard' : null,
        status: request.isManual ? 'apertura_manual' : 'acceso_concedido',
        timestamp: currentTimestamp
      });

      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: true,
          granted: true,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          manual: request.isManual || false,
          timestamp: currentTimestamp
        });
      }
      pendingRequests.delete(requestId);
      
    } else if (doorClosed === true && !doorOpened) {
      // Puerta no se abrió (cerró antes de abrir)
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: DOOR_ID,
        granted: false,
        reason: 'La puerta no se abrió',
        status: 'error_puerta',
        timestamp: new Date().toISOString()
      });

      if (request.res && !request.res.headersSent) {
        request.res.json({
          success: false,
          granted: false,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: 'La puerta no se abrió',
          timestamp: new Date().toISOString()
        });
      }
      pendingRequests.delete(requestId);
    }
  }

  // Detectar puerta dejada abierta (sensor detecta apertura sin requestId)
  if (!requestId && doorOpened === true && event === 'door_opened') {
    console.log('⚠️ ALERTA: Puerta dejada abierta sin autorización');
    await handleUnauthorizedAccess({
      timestamp: currentTimestamp,
      event: 'door_left_open',
      message: 'Puerta dejada abierta físicamente sin autorización',
      reason: 'Apertura física sin autorización'
    });
  }
}

async function handleUnauthorizedAccess(data) {
  const { timestamp, event, message, reason } = data;
  const currentTimestamp = timestamp || new Date().toISOString();

  console.log('⚠️ ALERTA: Acceso no autorizado detectado -', reason || message);

  // Registrar intento no autorizado
  await accessLogs.insertOne({
    userId: null,
    userName: null,
    accessCode: null,
    doorId: DOOR_ID,
    granted: false,
    reason: reason || message || 'Apertura física sin autorización',
    status: 'acceso_no_autorizado',
    timestamp: currentTimestamp,
    event: event || 'unauthorized_access'
  });

  console.log(`✓ Acceso no autorizado registrado: ${reason || message}`);

  // Solo actualizar estado si es apertura física real (no código inválido)
  if (event === 'door_left_open' || (message && message.includes('físicamente'))) {
    await doors.updateOne(
      { doorId: DOOR_ID },
      {
        $set: {
          state: 'open',
          lastEventTs: currentTimestamp,
          lastEvent: 'unauthorized_access'
        }
      },
      { upsert: true }
    );
    console.log('✓ Estado actualizado: OPEN (acceso no autorizado físico)');
  }
}

async function logAccessAttempt(requestData) {
  const { user, accessCode, doorId, granted, reason, status, timestamp } = requestData;

  const logEntry = {
    userId: user?._id || null,
    userName: user?.name || null,
    accessCode,
    doorId,
    granted,
    reason,
    status,
    timestamp: timestamp || new Date().toISOString()
  };

  console.log('📝 Log de acceso:', logEntry);
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
      { name: 'Usuario2', accessCode: '9999', isActive: false }
    ]);
  }

  // IMPORTANTE: Limpiar puertas duplicadas y crear única
  await doors.deleteMany({ doorId: { $ne: DOOR_ID } }); // Eliminar MainDoor u otras
  
  const doorExists = await doors.findOne({ doorId: DOOR_ID });
  if (!doorExists) {
    console.log(`Creando puerta única: ${DOOR_ID}`);
    await doors.insertOne({
      doorId: DOOR_ID,
      state: 'closed',
      lastEventTs: new Date().toISOString(),
      lastEvent: 'initialized'
    });
  } else {
    console.log(`✓ Puerta existente: ${DOOR_ID}`);
  }
}

// Validar acceso - FLUJO MQTT COMPLETO
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = DOOR_ID } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const user = await users.findOne({ accessCode: code });

    if (user && user.isActive) {
      // Usuario válido y activo
      console.log(`✓ Usuario autorizado: ${user.name}`);
      
      pendingRequests.set(requestId, {
        user,
        accessCode: code,
        doorId,
        res,
        timestamp: new Date().toISOString()
      });

      publish(TOPICS.DOOR_OPEN_REQUEST, {
        requestId,
        action: 'open_door',
        doorId,
        userId: user._id.toString(),
        userName: user.name,
        timestamp: new Date().toISOString()
      });

      // Timeout de 10 segundos
      setTimeout(async () => {
        if (pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId);
          await logAccessAttempt({
            ...request,
            granted: false,
            reason: 'Timeout - No hay respuesta del sistema de puerta',
            status: 'error_puerta'
          });
          if (request.res && !request.res.headersSent) {
            request.res.json({
              granted: false,
              userId: user._id,
              userName: user.name,
              reason: 'Timeout - No hay respuesta del sistema de puerta',
              timestamp: new Date().toISOString()
            });
          }
          pendingRequests.delete(requestId);
        }
      }, 10000);

    } else if (user && !user.isActive) {
      // Usuario inactivo
      console.log(`✗ Usuario inactivo: ${user.name}`);

      // Publicar a ESP32 para encender LED rojo
      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        requestId,
        action: 'unauthorized_access',
        doorId,
        reason: 'Usuario inactivo',
        event: 'usuario_inactivo',
        timestamp: new Date().toISOString()
      });

      await logAccessAttempt({
        user,
        accessCode: code,
        doorId,
        granted: false,
        reason: 'Usuario inactivo',
        status: 'usuario_inactivo'
      });

      // Responder inmediatamente sin pendingRequest
      return res.json({
        granted: false,
        userId: user._id,
        userName: user.name,
        reason: 'Usuario inactivo',
        timestamp: new Date().toISOString()
      });

    } else {
      // Código inválido
      console.log(`✗ Código inválido: ${code}`);

      // Publicar a ESP32 para encender LED rojo
      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        requestId,
        action: 'unauthorized_access',
        doorId,
        reason: 'Código de acceso inválido',
        event: 'codigo_invalido',
        timestamp: new Date().toISOString()
      });

      await logAccessAttempt({
        user: null,
        accessCode: code,
        doorId,
        granted: false,
        reason: 'Código de acceso inválido',
        status: 'codigo_invalido'
      });

      // Responder inmediatamente sin pendingRequest
      return res.json({
        granted: false,
        userId: null,
        userName: null,
        reason: 'Código de acceso inválido',
        timestamp: new Date().toISOString()
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
    const { adminName = 'Administrador', doorId = DOOR_ID } = req.body;
    const requestId = `req_manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`✓ Apertura manual por: ${adminName}`);

    pendingRequests.set(requestId, {
      user: { name: adminName, _id: 'admin' },
      accessCode: 'MANUAL',
      doorId,
      res,
      timestamp: new Date().toISOString(),
      isManual: true
    });

    publish(TOPICS.DOOR_OPEN_REQUEST, {
      requestId,
      action: 'open_door',
      doorId,
      userId: 'admin',
      userName: adminName,
      manual: true,
      timestamp: new Date().toISOString()
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
          status: 'error_puerta',
          timestamp: new Date().toISOString()
        });
        if (request.res && !request.res.headersSent) {
          request.res.json({
            success: false,
            granted: false,
            reason: 'Timeout - No hay respuesta del sistema de puerta',
            timestamp: new Date().toISOString()
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

// Accesos no autorizados recientes
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

app.get('/api/access/logs', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await accessLogs.find({}).sort({ timestamp: -1 }).limit(parseInt(limit)).toArray();
    res.json(logs);
  } catch (error) {
    console.error('Error obteniendo logs de acceso:', error);
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
