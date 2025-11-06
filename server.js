// server.js
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const http = require('http');
const socketio = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

// Crear servidor HTTP y configurar Socket.IO
const server = http.createServer(app);
const io = socketio(server, { 
  cors: { 
    origin: ['http://206.189.214.35:3001', 'http://localhost:3001'],
    methods: ['GET', 'POST'],
    credentials: true
  } 
});

// MongoDB Connection
const uri = 'mongodb+srv://jgironm20:haxnJx9nctumRp3P@cluster0.ckdcpb7.mongodb.net/?appName=Cluster0';
const client = new MongoClient(uri);
let db, users, doors, accessLogs;

// MQTT Configuration
const MQTT_BROKER = 'mqtt://127.0.0.1:1883'; // Broker Mosquitto local
const mqttClient = mqtt.connect(MQTT_BROKER);

// Topics MQTT
const TOPICS = {
  DOOR_OPEN_REQUEST: 'access/door/open/request',
  DOOR_OPEN_RESPONSE: 'access/door/open/response',
  DOOR_SENSOR_STATUS: 'access/door/sensor/status'
};

// Store para manejar solicitudes pendientes
const pendingRequests = new Map();

// Configurar Socket.IO
io.on('connection', (socket) => {
  console.log('✅ Cliente conectado al WebSocket:', socket.id);
  console.log('📊 Total clientes conectados:', io.engine.clientsCount);
  
  // Enviar estado inicial al conectarse
  socket.emit('connection-status', { 
    status: 'connected', 
    timestamp: new Date().toISOString(),
    socketId: socket.id 
  });
  
  socket.on('disconnect', (reason) => {
    console.log('❌ Cliente desconectado del WebSocket:', socket.id, 'Razón:', reason);
    console.log('📊 Total clientes conectados:', io.engine.clientsCount);
  });

  // Manejar ping del cliente
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });
});

// Configurar cliente MQTT
mqttClient.on('connect', () => {
  console.log('✅ Conectado al broker MQTT');
  
  // Suscribirse a respuestas del ESP32
  mqttClient.subscribe(TOPICS.DOOR_OPEN_RESPONSE);
  mqttClient.subscribe(TOPICS.DOOR_SENSOR_STATUS);
  
  // Notificar a todos los clientes conectados
  io.emit('mqtt-status', { status: 'connected', timestamp: new Date().toISOString() });
});

mqttClient.on('error', (error) => {
  console.error('❌ Error MQTT:', error);
  io.emit('mqtt-status', { status: 'error', error: error.message, timestamp: new Date().toISOString() });
});

mqttClient.on('disconnect', () => {
  console.log('❌ Desconectado del broker MQTT');
  io.emit('mqtt-status', { status: 'disconnected', timestamp: new Date().toISOString() });
});

// Manejar mensajes MQTT del ESP32
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log(`📨 Mensaje MQTT recibido en ${topic}:`, data);
    
    // Emitir mensaje MQTT crudo a clientes para debugging
    io.emit('mqtt-message', { topic, data, timestamp: new Date().toISOString() });
    
    if (topic === TOPICS.DOOR_OPEN_RESPONSE) {
      await handleDoorOpenResponse(data);
    } else if (topic === TOPICS.DOOR_SENSOR_STATUS) {
      await handleDoorSensorStatus(data);
    }
  } catch (error) {
    console.error('❌ Error procesando mensaje MQTT:', error);
    io.emit('system-error', { 
      type: 'mqtt-parse-error', 
      error: error.message, 
      timestamp: new Date().toISOString() 
    });
  }
});

// Manejar respuesta de apertura de puerta del ESP32
async function handleDoorOpenResponse(data) {
  const { requestId, success, error } = data;
  
  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    request.doorResponse = { success, error };
    
    console.log(`🚪 Respuesta de puerta para ${requestId}: success=${success}, error=${error}`);
    
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
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: `Error en puerta: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
      
      pendingRequests.delete(requestId);
    }
  } else {
    console.log(`⚠️ No se encontró solicitud pendiente para requestId: ${requestId}`);
  }
}

// Manejar confirmación del sensor de movimiento
async function handleDoorSensorStatus(data) {
  const { requestId, doorOpened, timestamp } = data;
  
  if (pendingRequests.has(requestId)) {
    const request = pendingRequests.get(requestId);
    
    console.log(`🚪 Estado del sensor para ${requestId}: doorOpened=${doorOpened}`);
    
    if (doorOpened) {
      // Puerta se abrió exitosamente
      await logAccessAttempt({
        ...request,
        granted: true,
        reason: null,
        status: 'acceso_concedido'
      });
      
      // Actualizar estado de la puerta
      const doorUpdate = {
        doorId: request.doorId,
        state: 'open',
        lastEventTs: timestamp || new Date().toISOString()
      };
      
      await doors.updateOne(
        { doorId: request.doorId },
        { $set: doorUpdate },
        { upsert: true }
      );
      
      // Emitir cambio de estado de puerta
      io.emit('door-status-changed', doorUpdate);
      console.log('📡 Evento door-status-changed emitido:', doorUpdate);
      
      // Responder al cliente
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
      // La puerta no se abrió (timeout del sensor)
      await logAccessAttempt({
        ...request,
        granted: false,
        reason: 'La puerta no se abrió - Timeout del sensor',
        status: 'error_puerta'
      });
      
      // Responder al cliente
      if (request.res && !request.res.headersSent) {
        request.res.json({
          granted: false,
          userId: request.user?._id || null,
          userName: request.user?.name || null,
          reason: 'La puerta no se abrió - Timeout del sensor',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    pendingRequests.delete(requestId);
  } else {
    console.log(`⚠️ No se encontró solicitud pendiente para requestId: ${requestId}`);
  }
}

// Función para registrar intentos de acceso con notificación WebSocket
async function logAccessAttempt(requestData) {
  const { user, accessCode, doorId, granted, reason, status, timestamp } = requestData;
  
  const logEntry = {
    userId: user?._id || null,
    userName: user?.name || null,
    accessCode,
    doorId,
    granted,
    reason,
    status, // 'acceso_concedido', 'usuario_inactivo', 'codigo_invalido', 'error_puerta'
    timestamp: timestamp || new Date().toISOString()
  };
  
  try {
    // Guardar en base de datos
    await accessLogs.insertOne(logEntry);
    
    // Emitir evento WebSocket para actualizaciones en tiempo real
    io.emit('new-access-log', logEntry);
    console.log('📡 Evento new-access-log emitido:', {
      userName: logEntry.userName,
      granted: logEntry.granted,
      reason: logEntry.reason,
      timestamp: logEntry.timestamp
    });
    
    // Emitir estadísticas actualizadas
    await emitUpdatedStats();
    
  } catch (error) {
    console.error('❌ Error registrando acceso:', error);
    io.emit('system-error', { 
      type: 'log-error', 
      error: error.message, 
      timestamp: new Date().toISOString() 
    });
  }
}

// Función para emitir estadísticas actualizadas
async function emitUpdatedStats() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalUsers = await users.countDocuments();
    const activeUsers = await users.countDocuments({ isActive: true });
    const todayAccesses = await accessLogs.countDocuments({
      timestamp: { $gte: today.toISOString() }
    });
    const todayGranted = await accessLogs.countDocuments({
      timestamp: { $gte: today.toISOString() },
      granted: true
    });
    
    const stats = {
      totalUsers,
      activeUsers,
      todayAccesses,
      todayGranted,
      todayDenied: todayAccesses - todayGranted,
      timestamp: new Date().toISOString()
    };
    
    io.emit('stats-updated', stats);
    console.log('📊 Estadísticas actualizadas emitidas');
  } catch (error) {
    console.error('❌ Error calculando estadísticas:', error);
  }
}

async function connectDB() {
  try {
    await client.connect();
    console.log('✅ Conectado exitosamente a MongoDB Atlas');
    db = client.db('usuariotelecomunicaciones');
    users = db.collection('users');
    doors = db.collection('doors');
    accessLogs = db.collection('accessLogs');
    
    // Crear usuarios iniciales si no existen
    await initializeData();
    
    // Emitir estado de DB a clientes conectados
    io.emit('db-status', { status: 'connected', timestamp: new Date().toISOString() });
    
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    io.emit('db-status', { status: 'error', error: error.message, timestamp: new Date().toISOString() });
    process.exit(1);
  }
}

async function initializeData() {
  try {
    // Verificar si ya existen usuarios
    const userCount = await users.countDocuments();
    if (userCount === 0) {
      console.log('📝 Creando usuarios iniciales...');
      await users.insertMany([
        { name: 'Admin', accessCode: '1234', isActive: true },
        { name: 'Usuario1', accessCode: '5678', isActive: true },
        { name: 'Usuario2', accessCode: '9999', isActive: true }
      ]);
      
      // Emitir evento de usuarios creados
      io.emit('users-initialized', { count: 3, timestamp: new Date().toISOString() });
    }
    
    // Verificar si ya existe la puerta principal
    const doorExists = await doors.findOne({ doorId: 'Puerta Principal' });
    if (!doorExists) {
      console.log('🚪 Creando puerta principal...');
      await doors.insertOne({
        doorId: 'Puerta Principal',
        state: 'closed',
        lastEventTs: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('❌ Error inicializando datos:', error);
  }
}

// Validar acceso - FLUJO MQTT COMPLETO
app.post('/api/access/request', async (req, res) => {
  try {
    const { code, doorId = 'Puerta Principal' } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`🔐 Solicitud de acceso recibida - Código: ${code}, Puerta: ${doorId}, ID: ${requestId}`);
    
    // Buscar el usuario por código
    const user = await users.findOne({ accessCode: code });
    
    if (user && user.isActive) {
      // Usuario ACTIVO - Iniciar proceso MQTT
      console.log(`✅ Usuario activo encontrado: ${user.name}`);
      
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
      console.log(`📤 Comando MQTT enviado:`, mqttMessage);
      
      // Emitir evento de solicitud iniciada
      io.emit('access-request-started', {
        requestId,
        userName: user.name,
        doorId,
        timestamp: new Date().toISOString()
      });
      
      // Timeout de 10 segundos para respuesta del ESP32
      setTimeout(async () => {
        if (pendingRequests.has(requestId)) {
          console.log(`⏰ Timeout para solicitud ${requestId}`);
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
      console.log(`❌ Usuario inactivo: ${user.name}`);
      
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
      console.log(`❌ Código inválido: ${code}`);
      
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
    console.error('❌ Error en validación de acceso:', error);
    io.emit('system-error', { 
      type: 'access-validation-error', 
      error: error.message, 
      timestamp: new Date().toISOString() 
    });
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
    const newUser = { 
      _id: result.insertedId, 
      name, 
      accessCode, 
      isActive 
    };
    
    // Emitir evento de nuevo usuario
    io.emit('user-created', newUser);
    await emitUpdatedStats();
    
    res.status(201).json(newUser);
  } catch (error) {
    console.error('❌ Error creando usuario:', error);
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
    console.error('❌ Error obteniendo estado de puerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener todos los usuarios
app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await users.find({}).toArray();
    res.json(allUsers);
  } catch (error) {
    console.error('❌ Error obteniendo usuarios:', error);
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
    
    // Obtener el usuario actualizado
    const updatedUser = await users.findOne({ _id: new ObjectId(id) });
    
    // Emitir evento de usuario actualizado
    io.emit('user-updated', updatedUser);
    await emitUpdatedStats();
    
    res.json({ message: 'Usuario actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Eliminar usuario
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Obtener el usuario antes de eliminarlo
    const userToDelete = await users.findOne({ _id: new ObjectId(id) });
    
    const result = await users.deleteOne({ _id: new ObjectId(id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    // Emitir evento de usuario eliminado
    io.emit('user-deleted', { _id: id, name: userToDelete?.name });
    await emitUpdatedStats();
    
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    console.error('❌ Error eliminando usuario:', error);
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
    console.error('❌ Error obteniendo logs de acceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener estadísticas del sistema
app.get('/api/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalUsers = await users.countDocuments();
    const activeUsers = await users.countDocuments({ isActive: true });
    const todayAccesses = await accessLogs.countDocuments({
      timestamp: { $gte: today.toISOString() }
    });
    const todayGranted = await accessLogs.countDocuments({
      timestamp: { $gte: today.toISOString() },
      granted: true
    });
    
    res.json({
      totalUsers,
      activeUsers,
      todayAccesses,
      todayGranted,
      todayDenied: todayAccesses - todayGranted
    });
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para probar WebSocket manualmente
app.post('/api/test/websocket', (req, res) => {
  const testLog = {
    userId: null,
    userName: 'Test User',
    accessCode: 'TEST',
    doorId: 'Puerta Principal',
    granted: true,
    reason: 'Test desde API',
    status: 'test',
    timestamp: new Date().toISOString()
  };
  
  // Emitir evento de prueba
  io.emit('new-access-log', testLog);
  
  res.json({ 
    success: true, 
    message: 'Evento WebSocket de prueba enviado',
    connectedClients: io.engine.clientsCount,
    testLog 
  });
});

// Cerrar conexión al terminar la aplicación
process.on('SIGINT', async () => {
  console.log('🔄 Cerrando conexiones...');
  
  // Notificar a clientes que el servidor se está cerrando
  io.emit('server-shutdown', { message: 'Servidor reiniciándose...', timestamp: new Date().toISOString() });
  
  // Cerrar conexiones
  mqttClient.end();
  await client.close();
  io.close();
  
  console.log('✅ Conexiones cerradas correctamente');
  process.exit(0);
});

// Inicializar la base de datos y luego el servidor
connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
    console.log(`🔌 WebSocket disponible en ws://206.189.214.35:${PORT}`);
    console.log(`📡 Clientes conectados: ${io.engine.clientsCount}`);
    
    // Emitir estado del servidor cada 30 segundos
    setInterval(() => {
      io.emit('server-heartbeat', {
        timestamp: new Date().toISOString(),
        connectedClients: io.engine.clientsCount,
        pendingRequests: pendingRequests.size
      });
    }, 30000);
  });
}).catch(error => {
  console.error('❌ Error iniciando servidor:', error);
  process.exit(1);
});
