# Integración ESP32 - Sistema de Control de Acceso

## 📋 Flujo Completo del Sistema

### 1. Usuario ingresa código en la app móvil
### 2. App envía solicitud HTTP al servidor Node.js
### 3. Node.js publica evento en MQTT para abrir la puerta
### 4. ESP32 recibe comando MQTT y controla servo motor
### 5. Sensor de movimiento detecta apertura de puerta
### 6. ESP32 notifica confirmación al broker MQTT
### 7. Node.js registra el acceso según la respuesta

---

## 🔌 Topics MQTT

### Topics que el ESP32 debe escuchar:
- **`access/door/open/request`** - Comandos para abrir la puerta

### Topics que el ESP32 debe publicar:
- **`access/door/open/response`** - Respuesta del servo motor
- **`access/door/sensor/status`** - Estado del sensor de movimiento

---

## 📨 Formato de Mensajes MQTT

### 1. Comando para abrir puerta (Node.js → ESP32)
**Topic:** `access/door/open/request`
```json
{
  "requestId": "req_1699123456789_abc123def",
  "action": "open_door",
  "doorId": "Puerta Principal",
  "userId": "507f1f77bcf86cd799439011",
  "userName": "Juan Pérez",
  "timestamp": "2025-11-05T18:30:45.123Z"
}
```

### 2. Respuesta del servo motor (ESP32 → Node.js)
**Topic:** `access/door/open/response`
```json
{
  "requestId": "req_1699123456789_abc123def",
  "success": true,
  "error": null
}
```

### 3. Estado del sensor de movimiento (ESP32 → Node.js)
**Topic:** `access/door/sensor/status`
```json
{
  "requestId": "req_1699123456789_abc123def",
  "doorOpened": true,
  "timestamp": "2025-11-05T18:30:47.456Z"
}
```

---

## 🎯 Estados de Acceso que se Registran

1. **`acceso_concedido`** - Usuario válido y puerta se abrió correctamente
2. **`usuario_inactivo`** - Usuario existe pero está desactivado
3. **`codigo_invalido`** - Código no existe en la base de datos
4. **`error_puerta`** - Error en el servo motor o la puerta no se abrió
5. **`timeout`** - No hubo respuesta del ESP32 en 10 segundos

---

## ⚙️ Configuración del Servidor

### Variables de configuración en server.js:
```javascript
const MQTT_BROKER = 'mqtt://localhost:1883'; // Cambiar por tu broker
const TIMEOUT_SECONDS = 10; // Timeout para respuesta del ESP32
```

### Topics configurados:
```javascript
const TOPICS = {
  DOOR_OPEN_REQUEST: 'access/door/open/request',
  DOOR_OPEN_RESPONSE: 'access/door/open/response',
  DOOR_SENSOR_STATUS: 'access/door/sensor/status'
};
```

---

## 🔧 Código ESP32 (Ejemplo)

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Servo.h>

// Configuración WiFi
const char* ssid = "TU_WIFI";
const char* password = "TU_PASSWORD";

// Configuración MQTT
const char* mqtt_server = "TU_BROKER_IP";
const int mqtt_port = 1883;

// Pines
const int SERVO_PIN = 18;
const int SENSOR_PIN = 19;

WiFiClient espClient;
PubSubClient client(espClient);
Servo doorServo;

void setup() {
  Serial.begin(115200);
  
  // Configurar servo y sensor
  doorServo.attach(SERVO_PIN);
  pinMode(SENSOR_PIN, INPUT);
  
  // Conectar WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  // Configurar MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
}

void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  if (String(topic) == "access/door/open/request") {
    handleDoorOpenRequest(message);
  }
}

void handleDoorOpenRequest(String message) {
  JsonDocument doc;
  deserializeJson(doc, message);
  
  String requestId = doc["requestId"];
  
  // Mover servo para abrir puerta
  doorServo.write(90); // Abrir
  delay(500);
  
  // Responder que el servo se movió
  JsonDocument response;
  response["requestId"] = requestId;
  response["success"] = true;
  response["error"] = nullptr;
  
  String responseStr;
  serializeJson(response, responseStr);
  client.publish("access/door/open/response", responseStr.c_str());
  
  // Esperar sensor de movimiento
  waitForMovementSensor(requestId);
}

void waitForMovementSensor(String requestId) {
  unsigned long startTime = millis();
  bool doorOpened = false;
  
  while (millis() - startTime < 5000) { // 5 segundos timeout
    if (digitalRead(SENSOR_PIN) == HIGH) {
      doorOpened = true;
      break;
    }
    delay(100);
  }
  
  // Cerrar puerta después de detección
  if (doorOpened) {
    delay(3000); // Mantener abierta 3 segundos
    doorServo.write(0); // Cerrar
  }
  
  // Notificar estado del sensor
  JsonDocument sensorStatus;
  sensorStatus["requestId"] = requestId;
  sensorStatus["doorOpened"] = doorOpened;
  sensorStatus["timestamp"] = ""; // Agregar timestamp
  
  String statusStr;
  serializeJson(sensorStatus, statusStr);
  client.publish("access/door/sensor/status", statusStr.c_str());
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  client.loop();
}

void reconnect() {
  while (!client.connected()) {
    if (client.connect("ESP32_Door_Controller")) {
      client.subscribe("access/door/open/request");
    } else {
      delay(5000);
    }
  }
}
```

---

## 🔌 Broker MQTT Recomendado

### Opción 1: Mosquitto (Local)
```bash
# Instalar Mosquitto
sudo apt-get install mosquitto mosquitto-clients

# Iniciar broker
sudo systemctl start mosquitto
```

### Opción 2: HiveMQ Cloud (Gratuito)
- Crear cuenta en https://www.hivemq.com/
- Obtener credenciales del broker
- Actualizar configuración en server.js

---

## 🚀 Para Iniciar el Sistema

1. **Configurar broker MQTT** (Mosquitto o HiveMQ)
2. **Actualizar server.js** con la IP del broker
3. **Programar ESP32** con el código proporcionado
4. **Reiniciar servidor Node.js**
5. **Probar desde la app móvil**

¡El sistema estará listo para controlar la puerta físicamente! 🚪✨