// ===================================================================
//  CREDENCIALES — PLANTILLA
//  1. Copia este archivo como "secretos.h" en la misma carpeta.
//  2. Llena tus datos en secretos.h.
//  3. secretos.h NO se sube a GitHub (está en .gitignore).
// ===================================================================
#pragma once

// Hotspot del celular (debe ser 2.4 GHz)
#define WIFI_SSID   "NOMBRE_DEL_HOTSPOT"
#define WIFI_PASS   "CONTRASEÑA_DEL_HOTSPOT"

// Broker EMQX Cloud (Serverless, solo TLS)
#define MQTT_HOST   "caf8f281.ala.us-east-1.emqxsl.com"
#define MQTT_PORT   8883
#define MQTT_USER   "esp32"
#define MQTT_PASS   "CONTRASEÑA_DEL_USUARIO_ESP32"

// Clave para subir código por Wi-Fi (Arduino IDE la pide al subir)
#define OTA_PASS    "CLAVE_PARA_ACTUALIZAR"

// Certificado CA del broker (EMQX Cloud → Overview → CA Certificate).
// Vacío = conexión cifrada pero SIN verificar el certificado del servidor.
// Para verificarlo, pega el contenido del .crt entre las comillas de R"( … )".
static const char MQTT_CA[] = R"()";
