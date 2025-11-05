# Script de Prueba MQTT - Sistema de Control de Acceso

## 🧪 **Prueba del Flujo Completo**

### **Paso 1:** Ya tienes corriendo:
- ✅ Mosquitto broker (`mosquitto.exe`)
- ✅ Servidor Node.js (puerto 3000)
- ✅ Dashboard React (puerto 3001)
- ✅ Simulador ESP32 escuchando

### **Paso 2:** Probar validación de acceso

Envía una solicitud HTTP al servidor usando cURL o desde tu app:

```bash
# Código válido (usuario activo)
curl -X POST http://localhost:3000/api/access/request \
  -H "Content-Type: application/json" \
  -d '{"code": "1234"}'

# Debería enviar comando MQTT al "ESP32"
```

### **Paso 3:** Simular respuesta del ESP32

Cuando veas el comando MQTT en la terminal del simulador, responde con:

```cmd
# Terminal 2: Simular que el servo se movió correctamente
cd "C:\Program Files\mosquitto"
.\mosquitto_pub.exe -h localhost -t "access/door/open/response" -m "{\"requestId\":\"[COPIA_EL_REQUEST_ID]\",\"success\":true,\"error\":null}"
```

### **Paso 4:** Simular sensor de movimiento

```cmd
# Terminal 3: Simular que el sensor detectó apertura
.\mosquitto_pub.exe -h localhost -t "access/door/sensor/status" -m "{\"requestId\":\"[MISMO_REQUEST_ID]\",\"doorOpened\":true,\"timestamp\":\"2025-11-05T19:00:00.000Z\"}"
```

---

## 🎯 **Flujo de Prueba Rápida**

### **Opción A: Usar PowerShell**
```powershell
# Enviar solicitud de acceso
Invoke-RestMethod -Uri "http://localhost:3000/api/access/request" -Method POST -ContentType "application/json" -Body '{"code": "1234"}'
```

### **Opción B: Usar tu Dashboard**
1. Ve a: http://localhost:3001
2. Revisa la pestaña "Historial de Accesos"
3. Haz una solicitud desde tu app móvil

---

## 📱 **Códigos de Prueba Disponibles:**
- **1234** - Admin (activo)
- **5678** - Usuario1 (activo)
- **9999** - Usuario2 (activo)
- **0000** - Código inválido

---

## 🔍 **Monitoreo en Tiempo Real:**

### **Terminal 1:** Servidor Node.js
- Verás los comandos MQTT enviados
- Logs de validación de usuarios

### **Terminal 2:** Simulador ESP32
- Verás los comandos JSON que llegan

### **Terminal 3:** Dashboard
- http://localhost:3001
- Historial de accesos en tiempo real

**¡Todo está listo para probar el sistema completo!** 🚪🔐✨