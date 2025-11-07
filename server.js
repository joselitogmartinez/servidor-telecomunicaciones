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

// Store para manejar solicitudes pendientes
const pendingRequests = new Map();

// Helper publish con trazas
function publish(topic, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  console.log(`[MQTT->publish] ${topic} ${payload}`);
  mqttClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
    if (err) console.error(`[MQTT publish ERROR] ${topic}:`, err);
  });
}

// Configurar cliente MQTT
mqttClient.on('connect', () => {
  console.log(`✓ Conectado al broker MQTT: ${MQTT_BROKER}`);

  mqttClient.subscribe(TOPICS.DOOR_OPEN_RESPONSE, (err) => {
    console.log('✓ Suscrito a DOOR_OPEN_RESPONSE', err ? `ERROR ${err.message}` : 'OK');
  });

  mqttClient.subscribe(TOPICS.DOOR_SENSOR_STATUS, (err) => {
    console.log('✓ Suscrito a DOOR_SENSOR_STATUS', err ? `ERROR ${err.message}` : 'OK');
  });

  mqttClient.subscribe(TOPICS.UNAUTHORIZED_ACCESS, (err) => {
    console.log('✓ Suscrito a UNAUTHORIZED_ACCESS', err ? `ERROR ${err.message}` : 'OK');
  });
});

mqttClient.on('reconnect', () => console.log('⚠️ MQTT reconectando...'));
mqttClient.on('offline', () => console.log('⚠️ MQTT offline'));
mqttClient.on('error', (error) => console.error('✗ Error MQTT:', error));

mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log(`[MQTT<-message] ${topic}:`, data);

    if (topic === TOPICS.DOOR_OPEN_RESPONSE) {
      await handleDoorOpenResponse(data);
    } else if (topic === TOPICS.DOOR_SENSOR_STATUS) {
      await handleDoorSensorStatus(data);
    } else if (topic === TOPICS.UNAUTHORIZED_ACCESS) {
      await handleUnauthorizedAccess(data);
    }
  } catch (error) {
    console.error('✗ Error procesando mensaje MQTT:', error);
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
        ...request,
        granted: false,
        reason: `Error en puerta: ${error}`,
        status: 'error_puerta',
        timestamp: new Date().toISOString()
      });
      
      if (request.res && !request.res.headersSent) {
        request.res.json({
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
  
  console.log('[handleDoorSensorStatus] Datos recibidos:', data);

  // Actualizar estado de la puerta inmediatamente
  const doorState = doorClosed ? 'closed' : (doorOpened ? 'open' : 'unknown');
  const currentTimestamp = timestamp || new Date().toISOString();

  await doors.updateOne(
    { doorId: 'Puerta Principal' },
    {
      $set: {
        state: doorState,
        lastEventTs: currentTimestamp,
        lastEvent: event || 'status_update'
      }
    },
    { upsert: true }
  );

  console.log(`✓ Estado de puerta actualizado: ${doorState} - Timestamp: ${currentTimestamp}`);

  // Si hay un requestId pendiente, procesarlo
  if (requestId && pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    
    if (doorOpened) {
      await logAccessAttempt({
        user: request.user,
        accessCode: request.accessCode,
        doorId: request.doorId,
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
    }
  }
}

async function handleUnauthorizedAccess(data) {
  const { timestamp, event, message, reason } = data;
  const currentTimestamp = timestamp || new Date().toISOString();
  
  console.log('⚠️ ALERTA: Acceso no autorizado detectado');

  // Registrar el intento de acceso no autorizado
  await accessLogs.insertOne({
    userId: null,
    userName: null,
    accessCode: null,
    doorId: 'Puerta Principal',
    granted: false,
    reason: reason || message || 'Apertura física sin autorización',
    status: 'acceso_no_autorizado',
    timestamp: currentTimestamp,
    event: event || 'unauthorized_access'
  });

  console.log(`✓ Acceso no autorizado registrado con timestamp: ${currentTimestamp}`);

  // Actualizar estado de la puerta
  await doors.updateOne(
    { doorId: 'Puerta Principal' },
    {
      $set: {
        state: 'open',
        lastEventTs: currentTimestamp,
        lastEvent: 'unauthorized_access'
      }
    },
    { upsert: true }
  );
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

  console.log('📝 Registrando acceso:', logEntry);
  await accessLogs.insertOne(logEntry);
}

async function connectDB() {
  try {
    await client.connect();
    console.log('✓ Conectado exitosamente a MongoDB Atlas');
    db = client.db('usuariotelecomunicaciones');
    users = db.collection('users');
    doors = db.collection('doors');
    accessLogs = db.collection('accessLogs');
    await initializeData();
  } catch (error) {
    console.error('✗ Error conectando a MongoDB:', error);
    process.exit(1);
  }
}

async function initializeData() {
  const userCount = await users.countDocuments();
  if (userCount === 0) {
    console.log('Creando usuarios iniciales...');
    await users.insertMany([
      { name: 'Admin', accessCode: '1234', isActive: true },
      { name: 'Usuario1', accessCode: '5678', isActive: true },
      { name: 'Usuario2', accessCode: '9999', isActive: false }
    ]);
  }
  const doorExists = await doors.findOne({ doorId: 'Puerta Principal' });
  if (!doorExists) {
    console.log('Creando puerta principal...');
    await doors.insertOne({
      doorId: 'Puerta Principal',
      state: 'closed',
      lastEventTs: new Date().toISOString(),
      lastEvent: 'initialized'
    });
  }
}

// ==================== ENDPOINTS API ====================

// Validar acceso - FLUJO MQTT COMPLETO
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = 'Puerta Principal' } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const currentTimestamp = new Date().toISOString();
    const user = await users.findOne({ accessCode: code });

    if (user && user.isActive) {
      console.log(`✓ Iniciando proceso MQTT para usuario: ${user.name}`);
      
      pendingRequests.set(requestId, {
        user,
        accessCode: code,
        doorId,
        res,
        timestamp: currentTimestamp
      });

      publish(TOPICS.DOOR_OPEN_REQUEST, {
        requestId,
        action: 'open_door',
        doorId,
        userId: user._id.toString(),
        userName: user.name,
        timestamp: currentTimestamp
      });

      setTimeout(async () => {
        if (pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId);
          await logAccessAttempt({
            ...request,
            granted: false,
            reason: 'Timeout - No hay respuesta del sistema de puerta',
            status: 'error_puerta',
            timestamp: new Date().toISOString()
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
      console.log(`⚠️ Usuario inactivo: ${user.name}`);
      
      // Publicar como acceso no autorizado al ESP32
      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        requestId,
        action: 'unauthorized_access',
        doorId,
        reason: 'Usuario inactivo',
        event: 'usuario_inactivo',
        timestamp: currentTimestamp
      });

      await logAccessAttempt({
        user,
        accessCode: code,
        doorId,
        granted: false,
        reason: 'Usuario inactivo',
        status: 'usuario_inactivo',
        timestamp: currentTimestamp
      });

      return res.json({
        granted: false,
        userId: user._id,
        userName: user.name,
        reason: 'Usuario inactivo',
        timestamp: currentTimestamp
      });
    } else {
      console.log(`⚠️ Código de acceso inválido: ${code}`);
      
      // Publicar como acceso no autorizado al ESP32
      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        requestId,
        action: 'unauthorized_access',
        doorId,
        reason: 'Código de acceso inválido',
        event: 'codigo_invalido',
        timestamp: currentTimestamp
      });

      await logAccessAttempt({
        user: null,
        accessCode: code,
        doorId,
        granted: false,
        reason: 'Código de acceso inválido',
        status: 'codigo_invalido',
        timestamp: currentTimestamp
      });

      return res.json({
        granted: false,
        userId: null,
        userName: null,
        reason: 'Código de acceso inválido',
        timestamp: currentTimestamp
      });
    }
  } catch (error) {
    console.error('✗ Error en validación de acceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para abrir puerta manualmente (administrador)
app.post('/api/doors/open/manual', async (req, res) => {
  try {
    const { adminName = 'Administrador', doorId = 'Puerta Principal' } = req.body;
    const requestId = `req_manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const currentTimestamp = new Date().toISOString();

    console.log(`✓ Solicitud manual de apertura por: ${adminName}`);

    // Crear solicitud pendiente
    pendingRequests.set(requestId, {
      user: { name: adminName, _id: 'admin' },
      accessCode: 'MANUAL',
      doorId,
      res,
      timestamp: currentTimestamp,
      isManual: true
    });

    // Publicar solicitud de apertura
    publish(TOPICS.DOOR_OPEN_REQUEST, {
      requestId,
      action: 'open_door',
      doorId,
      userId: 'admin',
      userName: adminName,
      manual: true,
      timestamp: currentTimestamp
    });

    // Timeout
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
    console.error('✗ Error en apertura manual:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener estado de la puerta en tiempo real
app.get('/api/doors/status/realtime', async (req, res) => {
  try {
    const door = await doors.findOne({ doorId: 'Puerta Principal' });
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
    console.error('✗ Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener accesos no autorizados recientes
app.get('/api/access/unauthorized', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const unauthorizedLogs = await accessLogs
      .find({
        $or: [
          { status: 'acceso_no_autorizado' },
          { status: 'usuario_inactivo' },
          { status: 'codigo_invalido' }
        ]
      })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .toArray();

    // Asegurar que todos los logs tengan timestamps válidos
    const logsWithValidTimestamps = unauthorizedLogs.map(log => ({
      ...log,
      timestamp: log.timestamp || new Date().toISOString()
    }));

    res.json(logsWithValidTimestamps);
  } catch (error) {
    console.error('✗ Error obteniendo accesos no autorizados:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Agregar usuario
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
    console.error('✗ Error creando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Estado de la puerta
app.get('/api/doors/:doorId/status', async (req, res) => {
  try {
    const { doorId } = req.params;
    const door = await doors.findOne({ doorId });
    if (!door) {
      return res.status(404).json({ error: 'Puerta no encontrada' });
    }
    res.json({
      doorId,
      state: door.state,
      lastEventTs: door.lastEventTs,
      lastEvent: door.lastEvent
    });
  } catch (error) {
    console.error('✗ Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener todos los usuarios
app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await users.find({}).toArray();
    res.json(allUsers);
  } catch (error) {
    console.error('✗ Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Actualizar usuario
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
    console.error('✗ Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Eliminar usuario
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await users.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    console.error('✗ Error eliminando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener historial de accesos
app.get('/api/access/logs', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await accessLogs.find({}).sort({ timestamp: -1 }).limit(parseInt(limit)).toArray();
    res.json(logs);
  } catch (error) {
    console.error('✗ Error obteniendo logs de acceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Cerrar conexión al terminar la aplicación
process.on('SIGINT', async () => {
  console.log('Cerrando conexión a MongoDB...');
  mqttClient.end();
  await client.close();
  process.exit(0);
});

// Inicializar la base de datos y luego el servidor
connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== Servidor escuchando en puerto ${PORT} ===`);
    console.log(`API disponible en: http://0.0.0.0:${PORT}/api`);
    console.log(`MQTT Broker: ${MQTT_BROKER}\n`);
  });
});
