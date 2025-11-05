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
const MQTT_BROKER = 'mqtt://localhost:1883'; // Broker Mosquitto local
const mqttClient = mqtt.connect(MQTT_BROKER);

// Topics MQTT
const TOPICS = {
  DOOR_OPEN_REQUEST: 'access/door/open/request',
  DOOR_OPEN_RESPONSE: 'access/door/open/response',
  DOOR_SENSOR_STATUS: 'access/door/sensor/status'
};

// Store para manejar solicitudes pendientes
const pendingRequests = new Map();

// Configurar cliente MQTT
mqttClient.on('connect', () => {
  console.log('Conectado al broker MQTT');
  
  // Suscribirse a respuestas del ESP32
  mqttClient.subscribe(TOPICS.DOOR_OPEN_RESPONSE);
  mqttClient.subscribe(TOPICS.DOOR_SENSOR_STATUS);
});

mqttClient.on('error', (error) => {
  console.error('Error MQTT:', error);
});

// Manejar mensajes MQTT del ESP32
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log(`Mensaje MQTT recibido en ${topic}:`, data);
    
    if (topic === TOPICS.DOOR_OPEN_RESPONSE) {
      await handleDoorOpenResponse(data);
    } else if (topic === TOPICS.DOOR_SENSOR_STATUS) {
      await handleDoorSensorStatus(data);
    }
  } catch (error) {
    console.error('Error procesando mensaje MQTT:', error);
  }
});

// Manejar respuesta de apertura de puerta del ESP32
async function handleDoorOpenResponse(data) {
  const { requestId, success, error } = data;
  
  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    request.doorResponse = { success, error };
    
    // Si la puerta no se pudo abrir, registrar inmediatamente
    if (!success) {
      await logAccessAttempt({
        ...request,
        granted: false,
        reason: `Error en puerta: ${error}`,
        status: 'error_puerta'
      });
      
      // Responder al cliente
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: false,
          userId: request.user?.id || null,
          userName: request.user?.name || null,
          reason: `Error en puerta: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
      
      pendingRequests.delete(requestId);
    }
  }
}

// Manejar confirmación del sensor de movimiento
async function handleDoorSensorStatus(data) {
  const { requestId, doorOpened, timestamp } = data;
  
  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    
    if (doorOpened) {
      // Puerta se abrió exitosamente
      await logAccessAttempt({
        ...request,
        granted: true,
        reason: null,
        status: 'acceso_concedido'
      });
      
      // Actualizar estado de la puerta
      await doors.updateOne(
        { doorId: request.doorId },
        { $set: { state: 'open', lastEventTs: timestamp || new Date().toISOString() } },
        { upsert: true }
      );
      
      // Responder al cliente
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: true,
          userId: request.user?.id || null,
          userName: request.user?.name || null,
          reason: null,
          timestamp: timestamp || new Date().toISOString()
        });
      }
    } else {
      // La puerta no se abrió (timeout del sensor)
      await logAccessAttempt({
        ...request,
        granted: false,
        reason: 'La puerta no se abrió',
        status: 'error_puerta'
      });
      
      // Responder al cliente
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: false,
          userId: request.user?.id || null,
          userName: request.user?.name || null,
          reason: 'La puerta no se abrió',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    pendingRequests.delete(requestId);
  }
}

// Función para registrar intentos de acceso
async function logAccessAttempt(requestData) {
  const { user, accessCode, doorId, granted, reason, status, timestamp } = requestData;
  
  await accessLogs.insertOne({
    userId: user?._id || null,
    userName: user?.name || null,
    accessCode,
    doorId,
    granted,
    reason,
    status, // 'acceso_concedido', 'acceso_denegado', 'usuario_inactivo', 'codigo_invalido', 'error_puerta'
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
    
    // Crear usuarios iniciales si no existen
    await initializeData();
  } catch (error) {
    console.error('Error conectando a MongoDB:', error);
    process.exit(1);
  }
}

async function initializeData() {
  // Verificar si ya existen usuarios
  const userCount = await users.countDocuments();
  if (userCount === 0) {
    console.log('Creando usuarios iniciales...');
    await users.insertMany([
      { name: 'Admin', accessCode: '1234', isActive: true },
      { name: 'Usuario1', accessCode: '5678', isActive: true },
      { name: 'Usuario2', accessCode: '9999', isActive: true }
    ]);
  }
  
  // Verificar si ya existe la puerta principal
  const doorExists = await doors.findOne({ doorId: 'Puerta Principal' });
  if (!doorExists) {
    console.log('Creando puerta principal...');
    await doors.insertOne({
      doorId: 'Puerta Principal',
      state: 'closed',
      lastEventTs: new Date().toISOString()
    });
  }
}

// Validar acceso - FLUJO MQTT COMPLETO
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = 'Puerta Principal' } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Primero buscar el usuario por código (sin importar si está activo o no)
    const user = await users.findOne({ accessCode: code });
    
    if (user && user.isActive) {
      // Usuario ACTIVO - Iniciar proceso MQTT
      console.log(`Iniciando proceso MQTT para usuario: ${user.name}`);
      
      // Guardar solicitud pendiente
      pendingRequests.set(requestId, {
        user,
        accessCode: code,
        doorId,
        res,
        timestamp: new Date().toISOString()
      });
      
      // Enviar comando MQTT al ESP32 para abrir la puerta
      const mqttMessage = {
        requestId,
        action: 'open_door',
        doorId,
        userId: user._id.toString(),
        userName: user.name,
        timestamp: new Date().toISOString()
      };
      
      mqttClient.publish(TOPICS.DOOR_OPEN_REQUEST, JSON.stringify(mqttMessage));
      console.log(`Comando MQTT enviado:`, mqttMessage);
      
      // Timeout de 10 segundos para respuesta del ESP32
      setTimeout(async () => {
        if (pendingRequests.has(requestId)) {
          // No hubo respuesta del ESP32 o del sensor
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
      }, 10000); // 10 segundos de timeout
      
    } else if (user && !user.isActive) {
      // Usuario INACTIVO - Acceso denegado inmediatamente
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
      // Usuario NO encontrado - Código inválido
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
      lastEventTs: door.lastEventTs 
    });
  } catch (error) {
    console.error('Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener todos los usuarios (endpoint adicional útil)
app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await users.find({}).toArray();
    res.json(allUsers);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Actualizar usuario (activar/desactivar)
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
