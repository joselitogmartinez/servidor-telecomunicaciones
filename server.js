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
  console.log(`Conectado al broker MQTT: ${MQTT_BROKER}`);

  mqttClient.subscribe(TOPICS.DOOR_OPEN_RESPONSE, (err) => {
    console.log('Sub DOOR_OPEN_RESPONSE', err ? `ERROR ${err.message}` : 'OK');
  });

  mqttClient.subscribe(TOPICS.DOOR_SENSOR_STATUS, (err) => {
    console.log('Sub DOOR_SENSOR_STATUS', err ? `ERROR ${err.message}` : 'OK');
  });

  mqttClient.subscribe(TOPICS.UNAUTHORIZED_ACCESS, (err) => {
    console.log('Sub UNAUTHORIZED_ACCESS', err ? `ERROR ${err.message}` : 'OK');
  });
});

mqttClient.on('reconnect', () => console.log('MQTT reconectando...'));
mqttClient.on('offline', () => console.log('MQTT offline'));
mqttClient.on('error', (error) => console.error('Error MQTT:', error));

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
    console.error('Error procesando mensaje MQTT:', error);
  }
});

async function handleDoorOpenResponse(data) {
  const { requestId, success, error } = data;
  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    request.doorResponse = { success, error };
    if (!success) {
      await logAccessAttempt({
        ...request,
        granted: false,
        reason: `Error en puerta: ${error}`,
        status: 'error_puerta'
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

  // Actualizar estado de la puerta en la base de datos
  const doorState = doorClosed ? 'closed' : 'open';
  await doors.updateOne(
    { doorId: 'Puerta Principal' },
    {
      $set: {
        state: doorState,
        lastEventTs: timestamp || new Date().toISOString(),
        lastEvent: event || 'status_update'
      }
    },
    { upsert: true }
  );

  // Si hay un requestId pendiente, procesarlo
  if (requestId && pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    if (doorOpened) {
      await logAccessAttempt({
        ...request,
        granted: true,
        reason: null,
        status: 'acceso_concedido'
      });
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: true,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: null,
          timestamp: timestamp || new Date().toISOString()
        });
      }
    } else {
      await logAccessAttempt({
        ...request,
        granted: false,
        reason: 'La puerta no se abrió',
        status: 'error_puerta'
      });
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: false,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: 'La puerta no se abrió',
          timestamp: new Date().toISOString()
        });
      }
    }
    pendingRequests.delete(requestId);
  }
}

async function handleUnauthorizedAccess(data) {
  const { timestamp, event, message, reason } = data;
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
    timestamp: timestamp || new Date().toISOString(),
    event: event || 'unauthorized_access'
  });

  // Actualizar estado de la puerta
  await doors.updateOne(
    { doorId: 'Puerta Principal' },
    {
      $set: {
        state: 'open',
        lastEventTs: timestamp || new Date().toISOString(),
        lastEvent: 'unauthorized_access'
      }
    },
    { upsert: true }
  );
}

async function logAccessAttempt(requestData) {
  const { user, accessCode, doorId, granted, reason, status, timestamp } = requestData;
  await accessLogs.insertOne({
    userId: user?._id || null,
    userName: user?.name || null,
    accessCode,
    doorId,
    granted,
    reason,
    status,
    timestamp: timestamp || new Date().toISOString()
  });
}

async function connectDB() {
  try {
    await client.connect();
    console.log('Conectado exitosamente a MongoDB Atlas');
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
  const userCount = await users.countDocuments();
  if (userCount === 0) {
    console.log('Creando usuarios iniciales...');
    await users.insertMany([
      { name: 'Admin', accessCode: '1234', isActive: true },
      { name: 'Usuario1', accessCode: '5678', isActive: true },
      { name: 'Usuario2', accessCode: '9999', isActive: true }
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

// Validar acceso - FLUJO MQTT COMPLETO
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = 'Puerta Principal' } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const user = await users.findOne({ accessCode: code });

    if (user && user.isActive) {
      console.log(`Iniciando proceso MQTT para usuario: ${user.name}`);
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
      // Publicar como acceso no autorizado al ESP32
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

      return res.json({
        granted: false,
        userId: user._id,
        userName: user.name,
        reason: 'Usuario inactivo',
        timestamp: new Date().toISOString()
      });
    } else {
      // Publicar como acceso no autorizado al ESP32
      publish(TOPICS.UNAUTHORIZED_ACCESS, {
        requestId,
        action: 'unauthorized_access',
        doorId,
        reason: 'Código de acceso inválido',
        event: 'codigo_invalido',
        accessCode: code,
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
    console.error('Error creando usuario:', error);
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
    console.error('Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener todos los usuarios
app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await users.find({}).toArray();
    res.json(allUsers);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
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
    console.error('Error actualizando usuario:', error);
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
    console.error('Error eliminando usuario:', error);
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
    console.error('Error obteniendo logs de acceso:', error);
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
    console.log(`Servidor escuchando en puerto ${PORT}`);
  });
});
