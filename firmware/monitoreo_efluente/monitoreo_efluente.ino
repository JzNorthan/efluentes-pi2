// ===================================================================
//  ÍNDICE                                                      Línea
// -------------------------------------------------------------------
//  CONFIGURACIÓN (editar solo aquí)
//    1. Pines ...................................................  66
//    2. Hardware ................................................  87
//    3. Calibración de turbidez (valores iniciales) ............. 104
//    4. Límites y rubros ........................................ 114
//    5. Tiempos ................................................. 142
//    6. Red y MQTT .............................................. 165
//  CÓDIGO
//    7. Objetos y estado global ................................. 188
//    8. Memoria flash (umbrales, rubro, calibración) ............ 252
//    9. Estadísticas de sesión .................................. 295
//   10. Red: cola de mensajes y tarea de conexión ............... 346
//   11. Publicación de mensajes (JSON) .......................... 456
//   12. Actuadores (relés, LEDs, buzzer) ........................ 603
//   13. Pruebas de componentes .................................. 674
//   14. Sensores ................................................ 752
//   15. Lógica de decisión ...................................... 799
//   16. Visualización (LCD y Serial) ............................ 890
//   17. Comandos (Serial y MQTT) ................................1002
//   18. Diagnóstico (watchdog, reinicio) ........................1136
//   19. setup() .................................................1190
//   20. loop() ..................................................1239
// -------------------------------------------------------------------
//  COMANDOS (Monitor Serie 115200 o panel web; mismos comandos)
//    a = automático        1 / 2 / 3 = forzar APTA / NO APTA / FALLA
//    d / i = solo válvula derecha / izquierda    c = cerrar ambas
//    lv / lr = probar LED verde / rojo   bz = buzzer   lcd = pantalla
//    auto = autoprueba completa          m = silenciar alarma
//    s = estado   e = estadísticas   r = reiniciar estadísticas
//    p = ver umbrales   tNN = temp. máx. (t35)   uNN = turbidez máx. (u40)
//    kRUBRO = elegir rubro (ktextil)     x = umbrales de fábrica
//    cl / cs = capturar voltaje agua limpia / sucia
//    ping = prueba de conexión           reboot = reiniciar ESP32
//    h = ayuda
//  ACTUALIZAR POR WI-FI: Herramientas > Puerto > "pi2-efluentes at <IP>" (mismo
//  hotspot que la PC). La primera vez se sube por cable.
//  LIBRERÍAS: MAX6675 library (Adafruit), LiquidCrystal I2C (Frank de
//  Brabander), PubSubClient (Nick O'Leary), ArduinoJson 7 (Benoit Blanchon)
// ===================================================================

#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <LiquidCrystal_I2C.h>
#include <max6675.h>
#include <PubSubClient.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include "secretos.h"            // Copiar de secretos.ejemplo.h y llenar
#ifndef OTA_PASS
#define OTA_PASS ""              // secretos.h antiguo sin OTA_PASS: OTA sin contraseña
#endif


// ###################################################################
// #                CONFIGURACIÓN — EDITAR SOLO AQUÍ                 #
// ###################################################################

// ===================================================================
// 1. PINES
// ===================================================================
// Sensores
const int PIN_TURBIDEZ    = 34;  // ADC1, solo entrada. Entra por divisor de voltaje
const int PIN_MAX6675_SCK = 26;
const int PIN_MAX6675_CS  = 27;
const int PIN_MAX6675_SO  = 25;

// Actuadores
const int PIN_RELE_DER    = 32;  // Válvula derecha   -> agua APTA
const int PIN_RELE_IZQ    = 4;   // Válvula izquierda -> agua NO APTA
                                 // Probado con prueba_reles. No usar GPIO 12 (strapping pin).
const int PIN_LED_VERDE   = 23;
const int PIN_LED_ROJO    = 19;
const int PIN_BUZZER      = 18;

// LCD (I2C)
const int PIN_LCD_SDA     = 21;
const int PIN_LCD_SCL     = 22;

// ===================================================================
// 2. HARDWARE
// ===================================================================
const char* VERSION_FIRMWARE  = "2.0";

const bool RELE_ACTIVO_EN_LOW = false;  // Módulos KY-019 se activan en HIGH.
                                        // Si el relé actúa invertido -> true.
const bool HABILITAR_RELES    = true;   // false = válvulas nunca se activan (LCD muestra "D")

const uint8_t LCD_DIRECCION = 0x27;     // Alternativa común: 0x3F
const int     LCD_COLUMNAS  = 16;
const int     LCD_FILAS     = 2;

const int   FRECUENCIA_BUZZER = 2000;   // Hz. tone() sirve para buzzer activo y pasivo
const float FACTOR_DIVISOR    = 1.5;    // (R1 + R2) / R2 con R1 = 10k, R2 = 20k
const int   MUESTRAS_TURBIDEZ = 21;     // Lecturas por medición (impar: mediana exacta)

// ===================================================================
// 3. CALIBRACIÓN DE TURBIDEZ (valores iniciales)
// ===================================================================
// Se reemplazan con los comandos cl / cs (o desde el panel) y quedan
// guardados en la memoria flash.
// Agua limpia = voltaje alto -> 0 %.  Muestra más sucia = voltaje bajo -> 100 %.
const float V_AGUA_LIMPIA_DEFECTO = 4.10;   // TODO: calibrar
const float V_AGUA_SUCIA_DEFECTO  = 2.50;   // TODO: calibrar
const float DIFERENCIA_MIN_CALIB  = 0.20;   // V mínimos entre limpia y sucia

// ===================================================================
// 4. LÍMITES Y RUBROS
// ===================================================================
// Valores de ejemplo, pendientes de justificar con su norma.
struct Rubro { const char* id; const char* nombre; float tempMax; float turbMax; };
const Rubro RUBROS[] = {
  { "ptar",       "PTAR doméstica",      35.0, 30.0 },   // Valores de fábrica
  { "textil",     "Textil",              35.0, 40.0 },
  { "alimentos",  "Alimentos y bebidas", 35.0, 25.0 },
  { "curtiembre", "Curtiembre",          35.0, 45.0 },
  { "mineria",    "Minería",             30.0, 20.0 },
  { "demo",       "Demo / laboratorio",  30.0, 50.0 },
};
const int   NUM_RUBROS        = sizeof(RUBROS) / sizeof(RUBROS[0]);
const char* RUBRO_DEFECTO     = "ptar";

const float HISTERESIS_TURB       = 5.0;   // Para volver a APTO: bajar a umbral - histéresis
const float HISTERESIS_TEMP       = 1.0;
const int   LECTURAS_PARA_CAMBIAR = 3;     // Lecturas consecutivas iguales para cambiar estado

// Rango aceptado al cambiar umbrales por comando
const float UMBRAL_TEMP_MIN = 5.0,  UMBRAL_TEMP_MAX = 90.0;    // °C
const float UMBRAL_TURB_MIN = 5.0,  UMBRAL_TURB_MAX = 95.0;    // %

// Rango físicamente posible para agua. Fuera de él la lectura se trata como falla.
const float TEMP_VALIDA_MIN = 0.0;     // °C
const float TEMP_VALIDA_MAX = 100.0;   // °C

// ===================================================================
// 5. TIEMPOS (ms)
// ===================================================================
const unsigned long INTERVALO_LECTURA       = 1000;  // MAX6675 requiere >= 250 ms
const unsigned long PAUSA_ENTRE_VALVULAS    = 500;   // Evita ambas válvulas activas a la vez
const unsigned long TIEMPO_MINIMO_ESTADO    = 5000;  // Permanencia mínima entre APTO y NO APTO
                                                     // (no aplica a FALLA: actúa de inmediato)
const unsigned long WATCHDOG_TIMEOUT        = 8000;  // Sin loop() en este tiempo -> reinicio
const unsigned long FIN_COMANDO_SIN_ENTER   = 100;   // Si el Monitor no envía Enter
const unsigned long DURACION_PRUEBA_INICIO  = 1500;
const unsigned long DURACION_PITIDO_INICIO  = 200;
const unsigned long DURACION_AVISO_REINICIO = 2000;  // Aviso en LCD tras reinicio anormal
const unsigned long PERIODO_ALARMA          = 1200;  // NO APTO: pitido cada 1.2 s
const unsigned long DURACION_PITIDO         = 180;
const unsigned long PERIODO_FALLA           = 600;   // FALLA: parpadeo/pitido cada 0.6 s
const unsigned long DURACION_FALLA          = 180;

// Pruebas de componentes
const unsigned long PRUEBA_LED_MS     = 2000;
const unsigned long PRUEBA_BUZZER_MS  = 500;
const unsigned long PRUEBA_LCD_MS     = 3000;
const unsigned long PRUEBA_VALVULA_MS = 2000;

// ===================================================================
// 6. RED Y MQTT
// ===================================================================
// Credenciales y broker: en secretos.h
const bool HABILITAR_RED = true;            // false = funciona sin Wi-Fi, solo Serial
const bool HABILITAR_OTA = true;            // Subir código por Wi-Fi desde Arduino IDE
const char* NOMBRE_EN_RED = "pi2-efluentes"; // Nombre del puerto de red en Arduino IDE
const char* TOPICO_BASE  = "pi2/efluente/";
const unsigned long PUBLICAR_ESTADISTICAS_MS = 30000;
const unsigned long PUBLICAR_DIAGNOSTICO_MS  = 10000;
const unsigned long REINTENTO_MQTT_MIN_MS    = 5000;
const unsigned long REINTENTO_MQTT_MAX_MS    = 30000;
const uint16_t MQTT_BUFFER       = 1400;    // Bytes; el mensaje "config" es el más grande
const uint16_t MQTT_KEEPALIVE_S  = 15;
const char* ZONA_HORARIA = "<-05>5";        // Lima, UTC-5 sin horario de verano
const char* SERVIDOR_NTP_1 = "pool.ntp.org";
const char* SERVIDOR_NTP_2 = "time.google.com";

// ###################################################################
// #                  FIN DE CONFIGURACIÓN                            #
// ###################################################################


// ===================================================================
// 7. OBJETOS Y ESTADO GLOBAL
// ===================================================================
LiquidCrystal_I2C lcd(LCD_DIRECCION, LCD_COLUMNAS, LCD_FILAS);
MAX6675 termopar(PIN_MAX6675_SCK, PIN_MAX6675_CS, PIN_MAX6675_SO);
Preferences memoria;
WiFiClientSecure clienteTls;
PubSubClient mqtt(clienteTls);

enum Estado { INICIANDO, APTO, NO_APTO, FALLA_SENSOR };
const int NUM_ESTADOS = 4;
const char* NOMBRE_ESTADO[NUM_ESTADOS] = { "INICIANDO", "APTO", "NO_APTO", "FALLA" };

// Causa del estado actual (se muestra en la LCD y se publica).
enum Motivo { SIN_MOTIVO, POR_TURBIDEZ, POR_TEMPERATURA, POR_AMBOS,
              FALLA_TEMP, FALLA_TURB, POR_COMANDO };
const char* NOMBRE_MOTIVO[] = { "", "TURBIDEZ", "TEMPERATURA", "AMBOS",
                                "FALLA_TEMP", "FALLA_TURB", "COMANDO" };

// Pruebas de componentes (sección 13). Declarado aquí para que Arduino IDE
// genere bien los prototipos de las funciones que lo usan.
enum Paso { P_NINGUNO, P_LED_VERDE, P_LED_ROJO, P_BUZZER, P_LCD, P_VALV_DER, P_VALV_IZQ };
const Paso SECUENCIA[] = { P_LED_VERDE, P_LED_ROJO, P_BUZZER, P_LCD, P_VALV_DER, P_VALV_IZQ };
const int  LARGO_SECUENCIA = sizeof(SECUENCIA) / sizeof(SECUENCIA[0]);

enum Valvula { NINGUNA, DERECHA, IZQUIERDA };
const char* NOMBRE_VALVULA[] = { "NINGUNA", "DER", "IZQ" };

Estado estadoActual      = INICIANDO;  // Estado aplicado a válvulas y LEDs
Motivo motivoActual      = SIN_MOTIVO;
Estado estadoCandidato   = INICIANDO;  // Estado propuesto por las últimas lecturas
int    contadorCandidato = 0;          // Veces consecutivas que se propuso
unsigned long tiempoUltimoCambio = 0;  // millis() del último cambio de estado
time_t horaUltimoCambio  = 0;          // Hora real del último cambio (0 = sin NTP)

bool modoManual        = false;        // true = estado fijado por comando
bool alarmaSilenciada  = false;        // Se borra al cambiar de estado
const char* textoPrueba = nullptr;     // Texto de LCD durante pruebas (nullptr = no hay)

Valvula valvulaAbierta = NINGUNA;
time_t  horaValvula    = 0;
unsigned long cambiosValvula = 0;

// Umbrales y calibración en uso (se cargan de la flash en setup)
char  rubroActual[16] = "ptar";
float limiteTemp  = 35.0, limiteTurb  = 30.0;   // En uso
float personalTemp = 35.0, personalTurb = 30.0; // Guardados del rubro "personalizado"
float vLimpia = V_AGUA_LIMPIA_DEFECTO, vSucia = V_AGUA_SUCIA_DEFECTO;

float temperatura   = NAN;             // °C. NAN = sin lectura válida
float turbidezPorc  = 0;               // 0 % limpia .. 100 % sucia
float voltajeSensor = 0;               // V reales del sensor de turbidez

unsigned long ultimoTiempoLectura = 0;
unsigned long ultimaPubEstadisticas = 0, ultimaPubDiagnostico = 0;
bool lcdResponde = true;

// Compartido con la tarea de red (otro núcleo)
volatile bool redConectada   = false;   // Wi-Fi y MQTT listos
volatile bool pedirRepublicar = false;  // Tras (re)conectar: reenviar retenidos
volatile bool otaEnCurso = false;       // Actualización por Wi-Fi en curso
volatile unsigned long msgEnviados = 0, msgRecibidos = 0, reconexiones = 0;


// ===================================================================
// 8. MEMORIA FLASH (UMBRALES, RUBRO, CALIBRACIÓN)
// ===================================================================
// Se conservan al apagar el ESP32 y al volver a subir el código.

/** @return Índice del rubro con ese id, o -1 (personalizado o desconocido). */
int buscarRubro(const char* id) {
  for (int i = 0; i < NUM_RUBROS; i++) if (strcmp(RUBROS[i].id, id) == 0) return i;
  return -1;
}

/** Aplica a limiteTemp/limiteTurb los valores del rubro activo. */
void aplicarRubro() {
  int i = buscarRubro(rubroActual);
  if (i >= 0) { limiteTemp = RUBROS[i].tempMax; limiteTurb = RUBROS[i].turbMax; }
  else        { limiteTemp = personalTemp;      limiteTurb = personalTurb; }
}

void cargarMemoria() {
  memoria.begin("efluente", true);
  String r = memoria.getString("rubro", RUBRO_DEFECTO);
  personalTemp = memoria.getFloat("ptemp", RUBROS[0].tempMax);
  personalTurb = memoria.getFloat("pturb", RUBROS[0].turbMax);
  vLimpia      = memoria.getFloat("vlimpia", V_AGUA_LIMPIA_DEFECTO);
  vSucia       = memoria.getFloat("vsucia", V_AGUA_SUCIA_DEFECTO);
  memoria.end();
  strlcpy(rubroActual, r.c_str(), sizeof(rubroActual));
  if (strcmp(rubroActual, "personalizado") != 0 && buscarRubro(rubroActual) < 0)
    strlcpy(rubroActual, RUBRO_DEFECTO, sizeof(rubroActual));
  aplicarRubro();
}

void guardarMemoria() {
  memoria.begin("efluente", false);
  memoria.putString("rubro", rubroActual);
  memoria.putFloat("ptemp", personalTemp);
  memoria.putFloat("pturb", personalTurb);
  memoria.putFloat("vlimpia", vLimpia);
  memoria.putFloat("vsucia", vSucia);
  memoria.end();
}


// ===================================================================
// 9. ESTADÍSTICAS DE SESIÓN
// ===================================================================
// Se reinician al encender el ESP32 o con el comando "r".

struct Estadisticas {
  unsigned long inicio;                       // millis() al iniciar la sesión
  unsigned long inicioEstado;                 // millis() desde que se cuenta el estado actual
  unsigned long tiempoEnEstado[NUM_ESTADOS];  // ms acumulados por estado
  unsigned long lecturas;
  unsigned long vecesNoApta, vecesFalla;
  unsigned long noAptaPorTurb, noAptaPorTemp, noAptaPorAmbos;
  float tempMin, tempMax, turbMin, turbMax;
} stats;

void reiniciarEstadisticas() {
  stats = Estadisticas();
  stats.inicio = stats.inicioEstado = millis();
  stats.tempMin = stats.turbMin = 1e9;
  stats.tempMax = stats.turbMax = -1e9;
}

/** Suma al estado que termina el tiempo que estuvo activo. Llamar antes de cambiar estadoActual. */
void acumularTiempoEstado() {
  stats.tiempoEnEstado[estadoActual] += millis() - stats.inicioEstado;
  stats.inicioEstado = millis();
}

void registrarEntrada(Estado nuevo, Motivo motivo) {
  if (nuevo == FALLA_SENSOR) stats.vecesFalla++;
  if (nuevo == NO_APTO) {
    stats.vecesNoApta++;
    if (motivo == POR_TURBIDEZ)    stats.noAptaPorTurb++;
    if (motivo == POR_TEMPERATURA) stats.noAptaPorTemp++;
    if (motivo == POR_AMBOS)       stats.noAptaPorAmbos++;
  }
}

void registrarLectura() {
  stats.lecturas++;
  if (!isnan(temperatura)) {
    stats.tempMin = min(stats.tempMin, temperatura);
    stats.tempMax = max(stats.tempMax, temperatura);
  }
  if (voltajeSensor >= 0.1) {
    stats.turbMin = min(stats.turbMin, turbidezPorc);
    stats.turbMax = max(stats.turbMax, turbidezPorc);
  }
}


// ===================================================================
// 10. RED: COLA DE MENSAJES Y TAREA DE CONEXIÓN
// ===================================================================
// Wi-Fi, TLS y MQTT corren en una tarea del núcleo 0. Conectarse puede
// tardar segundos; así nunca congela loop() (válvulas, alarma, watchdog).
// loop() y la tarea solo se comunican por dos colas.

struct MensajeSalida  { char topico[40]; char datos[MQTT_BUFFER - 100]; bool retenido; };
struct ComandoEntrada { char cmd[40]; char id[20]; char origen[16]; };

QueueHandle_t colaSalida  = nullptr;
QueueHandle_t colaEntrada = nullptr;
const int TAM_COLA_SALIDA = 12, TAM_COLA_ENTRADA = 8;

/** Llega un mensaje al tema de comandos (corre en la tarea de red). */
void alRecibirMqtt(char* topico, byte* datos, unsigned int largo) {
  msgRecibidos++;
  JsonDocument doc;
  if (deserializeJson(doc, datos, largo)) return;          // JSON inválido: se ignora
  ComandoEntrada c = {};
  strlcpy(c.cmd,    doc["cmd"]    | "", sizeof(c.cmd));
  strlcpy(c.id,     doc["id"]     | "", sizeof(c.id));
  strlcpy(c.origen, doc["origen"] | "panel", sizeof(c.origen));
  if (c.cmd[0] != '\0') xQueueSend(colaEntrada, &c, 0);
}

/** @return true si conectó al broker. Bloquea unos segundos: solo desde la tarea de red. */
bool conectarMqtt() {
  char id[32], willTopico[48];
  snprintf(id, sizeof(id), "pi2-esp32-%06llx", (unsigned long long)(ESP.getEfuseMac() & 0xFFFFFF));
  snprintf(willTopico, sizeof(willTopico), "%sconexion", TOPICO_BASE);
  if (!mqtt.connect(id, MQTT_USER, MQTT_PASS, willTopico, 1, true, "{\"estado\":\"desconectado\"}"))
    return false;
  char t[48];
  snprintf(t, sizeof(t), "%scomandos", TOPICO_BASE);
  mqtt.subscribe(t, 1);
  mqtt.publish(willTopico, "{\"estado\":\"en_linea\"}", true);
  return true;
}

/** Actualización por Wi-Fi: el ESP32 aparece como puerto de red en Arduino IDE. */
void iniciarOta() {
  ArduinoOTA.setHostname(NOMBRE_EN_RED);
  if (strlen(OTA_PASS) > 0) ArduinoOTA.setPassword(OTA_PASS);
  ArduinoOTA.onStart([]() { otaEnCurso = true; });            // loop() cierra válvulas
  ArduinoOTA.onError([](ota_error_t) { otaEnCurso = false; });
  ArduinoOTA.begin();                                         // Al terminar, reinicia solo
}

void tareaRed(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  if (strlen(MQTT_CA) > 0) clienteTls.setCACert(MQTT_CA);
  else                     clienteTls.setInsecure();     // Cifrado sin verificar el servidor
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(MQTT_BUFFER);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setCallback(alRecibirMqtt);

  bool ntpIniciado = false, otaIniciado = false;
  unsigned long ultimoIntento = 0, espera = 0;

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      redConectada = false;
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    if (!ntpIniciado) {
      configTzTime(ZONA_HORARIA, SERVIDOR_NTP_1, SERVIDOR_NTP_2);
      ntpIniciado = true;
    }
    if (HABILITAR_OTA) {
      if (!otaIniciado) { iniciarOta(); otaIniciado = true; }
      ArduinoOTA.handle();               // Durante una subida bloquea esta tarea (no loop())
    }
    if (!mqtt.connected()) {
      redConectada = false;
      if (millis() - ultimoIntento >= espera) {
        ultimoIntento = millis();
        if (conectarMqtt()) {
          espera = REINTENTO_MQTT_MIN_MS;
          reconexiones++;
          redConectada = true;
          pedirRepublicar = true;
        } else {
          espera = constrain(espera * 2, REINTENTO_MQTT_MIN_MS, REINTENTO_MQTT_MAX_MS);
        }
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    mqtt.loop();
    MensajeSalida m;
    while (xQueueReceive(colaSalida, &m, 0) == pdTRUE) {
      if (mqtt.publish(m.topico, m.datos, m.retenido)) msgEnviados++;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void iniciarRed() {
  colaSalida  = xQueueCreate(TAM_COLA_SALIDA, sizeof(MensajeSalida));
  colaEntrada = xQueueCreate(TAM_COLA_ENTRADA, sizeof(ComandoEntrada));
  xTaskCreatePinnedToCore(tareaRed, "red", 12288, nullptr, 1, nullptr, 0);
}


// ===================================================================
// 11. PUBLICACIÓN DE MENSAJES (JSON)
// ===================================================================

/** @return Hora real en segundos, o 0 si aún no hay NTP. */
time_t horaActual() {
  time_t t = time(nullptr);
  return t > 1700000000 ? t : 0;
}

/** Agrega "clave": hora o null. */
void ponerHora(JsonDocument& doc, const char* clave, time_t t) {
  if (t > 0) doc[clave] = (long long)t;
  else       doc[clave] = nullptr;
}

/** Encola un JSON para el tema pi2/efluente/<sub>. No bloquea: si la cola está llena, se descarta. */
void publicar(const char* sub, JsonDocument& doc, bool retenido) {
  if (!HABILITAR_RED || colaSalida == nullptr || !redConectada) return;
  MensajeSalida m;
  snprintf(m.topico, sizeof(m.topico), "%s%s", TOPICO_BASE, sub);
  if (serializeJson(doc, m.datos, sizeof(m.datos)) == 0) return;
  m.retenido = retenido;
  xQueueSend(colaSalida, &m, 0);
}

void publicarLectura() {
  JsonDocument doc;
  ponerHora(doc, "t", horaActual());
  if (isnan(temperatura)) doc["temp"] = nullptr; else doc["temp"] = round(temperatura * 100) / 100.0;
  doc["turb"] = round(turbidezPorc * 10) / 10.0;
  doc["volt"] = round(voltajeSensor * 1000) / 1000.0;
  publicar("lecturas", doc, false);
}

void publicarEstado() {
  JsonDocument doc;
  ponerHora(doc, "t", horaActual());
  doc["estado"]     = NOMBRE_ESTADO[estadoActual];
  doc["motivo"]     = NOMBRE_MOTIVO[motivoActual];
  doc["modo"]       = modoManual ? "MANUAL" : "AUTO";
  doc["valvula"]    = NOMBRE_VALVULA[valvulaAbierta];
  ponerHora(doc, "desde", horaUltimoCambio);
  ponerHora(doc, "valvulaDesde", horaValvula);
  doc["cambiosValvula"] = cambiosValvula;
  doc["silenciada"] = alarmaSilenciada;
  doc["reles"]      = HABILITAR_RELES;
  if (textoPrueba) doc["prueba"] = textoPrueba; else doc["prueba"] = nullptr;
  publicar("estado", doc, true);
}

void publicarConfig() {
  JsonDocument doc;
  doc["rubro"]    = rubroActual;
  doc["tempMax"]  = limiteTemp;
  doc["turbMax"]  = limiteTurb;
  doc["histTemp"] = HISTERESIS_TEMP;
  doc["histTurb"] = HISTERESIS_TURB;
  doc["lecturasCambio"] = LECTURAS_PARA_CAMBIAR;
  doc["tiempoMinimoS"]  = TIEMPO_MINIMO_ESTADO / 1000.0;
  doc["intervaloS"]     = INTERVALO_LECTURA / 1000.0;
  doc["vLimpia"]  = vLimpia;
  doc["vSucia"]   = vSucia;
  JsonArray lista = doc["rubros"].to<JsonArray>();
  for (int i = 0; i < NUM_RUBROS; i++) {
    JsonObject r = lista.add<JsonObject>();
    r["id"] = RUBROS[i].id; r["nombre"] = RUBROS[i].nombre;
    r["t"] = RUBROS[i].tempMax; r["u"] = RUBROS[i].turbMax;
  }
  JsonObject p = lista.add<JsonObject>();
  p["id"] = "personalizado"; p["nombre"] = "Personalizado"; p["t"] = personalTemp; p["u"] = personalTurb;
  JsonObject lim = doc["rangos"].to<JsonObject>();
  lim["tMin"] = UMBRAL_TEMP_MIN; lim["tMax"] = UMBRAL_TEMP_MAX;
  lim["uMin"] = UMBRAL_TURB_MIN; lim["uMax"] = UMBRAL_TURB_MAX;
  publicar("config", doc, true);
}

void publicarEstadisticas() {
  unsigned long tiempos[NUM_ESTADOS];
  for (int i = 0; i < NUM_ESTADOS; i++) tiempos[i] = stats.tiempoEnEstado[i];
  tiempos[estadoActual] += millis() - stats.inicioEstado;

  JsonDocument doc;
  ponerHora(doc, "t", horaActual());
  doc["duracionS"] = (millis() - stats.inicio) / 1000;
  doc["lecturas"]  = stats.lecturas;
  JsonObject te = doc["tiempoS"].to<JsonObject>();
  te["inicio"] = tiempos[INICIANDO] / 1000; te["apta"] = tiempos[APTO] / 1000;
  te["noApta"] = tiempos[NO_APTO] / 1000;   te["falla"] = tiempos[FALLA_SENSOR] / 1000;
  doc["vecesNoApta"] = stats.vecesNoApta;
  doc["noAptaTurb"]  = stats.noAptaPorTurb;
  doc["noAptaTemp"]  = stats.noAptaPorTemp;
  doc["noAptaAmbos"] = stats.noAptaPorAmbos;
  doc["vecesFalla"]  = stats.vecesFalla;
  if (stats.tempMax > -1e8) { doc["tempMin"] = stats.tempMin; doc["tempMax"] = stats.tempMax; }
  if (stats.turbMax > -1e8) { doc["turbMin"] = stats.turbMin; doc["turbMax"] = stats.turbMax; }
  publicar("estadisticas", doc, true);
}

const char* motivoReinicio(bool &anormal);   // Definida en la sección 18

void publicarDiagnostico() {
  bool anormal;
  JsonDocument doc;
  ponerHora(doc, "t", horaActual());
  doc["fw"]          = VERSION_FIRMWARE;
  doc["uptimeS"]     = millis() / 1000;
  doc["heap"]        = ESP.getFreeHeap();
  doc["heapMin"]     = ESP.getMinFreeHeap();
  doc["rssi"]        = WiFi.RSSI();
  doc["ssid"]        = WiFi.SSID();
  doc["reinicio"]    = motivoReinicio(anormal);
  doc["reinicioAnormal"] = anormal;
  doc["reconexiones"] = (unsigned long)(reconexiones > 0 ? reconexiones - 1 : 0);
  doc["enviados"]    = (unsigned long)msgEnviados;
  doc["recibidos"]   = (unsigned long)msgRecibidos;
  doc["ntp"]         = horaActual() > 0;
  doc["watchdogS"]   = WATCHDOG_TIMEOUT / 1000;
  doc["sensorTemp"]  = (!isnan(temperatura) && temperatura >= TEMP_VALIDA_MIN && temperatura <= TEMP_VALIDA_MAX) ? "ok" : "falla";
  doc["sensorTurb"]  = voltajeSensor >= 0.1 ? "ok" : "falla";
  doc["voltTurb"]    = round(voltajeSensor * 1000) / 1000.0;
  doc["lcd"]         = lcdResponde ? "ok" : "falla";
  doc["releDer"]     = PIN_RELE_DER;
  doc["releIzq"]     = PIN_RELE_IZQ;
  publicar("diagnostico", doc, true);
}

/** Evento del registro: tipo (Estado, Válvula, Comando, Prueba, Sistema), detalle, origen. */
void publicarEvento(const char* tipo, const char* detalle, const char* origen) {
  JsonDocument doc;
  ponerHora(doc, "t", horaActual());
  doc["tipo"]    = tipo;
  doc["detalle"] = detalle;
  if (isnan(temperatura)) doc["temp"] = nullptr; else doc["temp"] = round(temperatura * 10) / 10.0;
  doc["turb"]    = round(turbidezPorc);
  doc["origen"]  = origen;
  publicar("eventos", doc, false);
}

void responder(const char* id, bool ok, const char* detalle) {
  if (id == nullptr || id[0] == '\0') return;
  JsonDocument doc;
  doc["id"] = id; doc["ok"] = ok; doc["detalle"] = detalle;
  publicar("respuestas", doc, false);
}


// ===================================================================
// 12. ACTUADORES
// ===================================================================

/** Activa/desactiva un relé respetando su lógica (HIGH o LOW). */
void escribirRele(int pin, bool encendido) {
  if (!HABILITAR_RELES) encendido = false;
  if (RELE_ACTIVO_EN_LOW) digitalWrite(pin, encendido ? LOW : HIGH);
  else                    digitalWrite(pin, encendido ? HIGH : LOW);
}

/** Registra un cambio de válvula (contador, hora y evento). */
void anotarValvula(Valvula v) {
  if (v == valvulaAbierta) return;
  valvulaAbierta = v;
  horaValvula = horaActual();
  cambiosValvula++;
  const char* txt = v == DERECHA ? "Derecha abierta, izquierda cerrada"
                  : v == IZQUIERDA ? "Izquierda abierta, derecha cerrada" : "Ambas cerradas";
  publicarEvento("Válvula", txt, "ESP32");
}

/** Cierra ambas válvulas. */
void cerrarAmbas() {
  escribirRele(PIN_RELE_DER, false);
  escribirRele(PIN_RELE_IZQ, false);
  anotarValvula(NINGUNA);
}

/** Abre solo la válvula indicada; cierra la otra antes para evitar picos de corriente. */
void abrirSolo(int pinAbrir) {
  escribirRele(PIN_RELE_DER, false);
  escribirRele(PIN_RELE_IZQ, false);
  delay(PAUSA_ENTRE_VALVULAS);
  escribirRele(pinAbrir, true);
  anotarValvula(pinAbrir == PIN_RELE_DER ? DERECHA : IZQUIERDA);
}

/**
 * Enciende/apaga el buzzer solo si cambia de estado. tone()/noTone() en el
 * core 3.x encolan un mensaje a otra tarea: llamarlos en cada loop() llena
 * la cola, bloquea loop() y dispara el watchdog.
 */
void buzzer(bool encendido) {
  static bool actual = false;
  if (encendido == actual) return;
  actual = encendido;
  if (encendido) tone(PIN_BUZZER, FRECUENCIA_BUZZER);
  else           noTone(PIN_BUZZER);
}

bool pruebaEnCurso();   // Definida en la sección 13

/** Patrón de LED rojo y buzzer según el estado. No bloqueante: llamar en cada loop(). */
void actualizarAlarma() {
  if (pruebaEnCurso()) return;                          // La prueba maneja LEDs y buzzer
  unsigned long t = millis();

  if (estadoActual == NO_APTO) {
    digitalWrite(PIN_LED_ROJO, HIGH);
    buzzer(!alarmaSilenciada && (t % PERIODO_ALARMA) < DURACION_PITIDO);
  } else if (estadoActual == FALLA_SENSOR) {
    bool on = (t % PERIODO_FALLA) < DURACION_FALLA;
    digitalWrite(PIN_LED_ROJO, on ? HIGH : LOW);
    buzzer(on && !alarmaSilenciada);
  } else {
    buzzer(false);
  }
}


// ===================================================================
// 13. PRUEBAS DE COMPONENTES
// ===================================================================
// Cada prueba enciende un componente un tiempo fijo y lo apaga. La
// autoprueba recorre todas en orden. Ninguna bloquea loop().

Paso pasoActual = P_NINGUNO;
unsigned long finPaso = 0;
bool enSecuencia = false;
int  indiceSecuencia = 0;

bool pruebaEnCurso() { return pasoActual != P_NINGUNO; }

void lineaLCD(int fila, const char* texto);  // Definida en la sección 16
void aplicarEstado(Estado nuevo, Motivo motivo);

/** Deja el sistema en reposo para probar: manual, alarma callada, válvulas cerradas. */
void prepararPrueba() {
  modoManual = true;
  aplicarEstado(INICIANDO, POR_COMANDO);
  buzzer(false);
  digitalWrite(PIN_LED_VERDE, LOW);
  digitalWrite(PIN_LED_ROJO, LOW);
}

void iniciarPaso(Paso p) {
  pasoActual = p;
  unsigned long dur = PRUEBA_LED_MS;
  switch (p) {
    case P_LED_VERDE: digitalWrite(PIN_LED_VERDE, HIGH); textoPrueba = "PRUEBA LED VERDE"; break;
    case P_LED_ROJO:  digitalWrite(PIN_LED_ROJO, HIGH);  textoPrueba = "PRUEBA LED ROJO";  break;
    case P_BUZZER:    buzzer(true); dur = PRUEBA_BUZZER_MS; textoPrueba = "PRUEBA BUZZER"; break;
    case P_LCD:       dur = PRUEBA_LCD_MS; textoPrueba = "PRUEBA PANTALLA";
                      lineaLCD(0, "0123456789ABCDEF"); lineaLCD(1, "PRUEBA PANTALLA"); break;
    case P_VALV_DER:  abrirSolo(PIN_RELE_DER); dur = PRUEBA_VALVULA_MS; textoPrueba = "PRUEBA VALV DER"; break;
    case P_VALV_IZQ:  abrirSolo(PIN_RELE_IZQ); dur = PRUEBA_VALVULA_MS; textoPrueba = "PRUEBA VALV IZQ"; break;
    default: break;
  }
  finPaso = millis() + dur;
  publicarEstado();
}

void terminarPaso(Paso p) {
  switch (p) {
    case P_LED_VERDE: digitalWrite(PIN_LED_VERDE, LOW); break;
    case P_LED_ROJO:  digitalWrite(PIN_LED_ROJO, LOW);  break;
    case P_BUZZER:    buzzer(false); break;
    case P_VALV_DER:
    case P_VALV_IZQ:  cerrarAmbas(); break;
    default: break;
  }
}

/** Inicia una prueba suelta o la autoprueba (p = P_NINGUNO). */
void iniciarPrueba(Paso p) {
  if (pruebaEnCurso()) terminarPaso(pasoActual);
  prepararPrueba();
  enSecuencia = (p == P_NINGUNO);
  indiceSecuencia = 0;
  iniciarPaso(enSecuencia ? SECUENCIA[0] : p);
}

/** Avanza las pruebas. Llamar en cada loop(). */
void actualizarPruebas() {
  if (!pruebaEnCurso() || (long)(millis() - finPaso) < 0) return;
  terminarPaso(pasoActual);
  if (enSecuencia && ++indiceSecuencia < LARGO_SECUENCIA) {
    iniciarPaso(SECUENCIA[indiceSecuencia]);
    return;
  }
  if (enSecuencia) publicarEvento("Prueba", "Autoprueba completa terminada", "ESP32");
  pasoActual  = P_NINGUNO;
  enSecuencia = false;
  textoPrueba = "PRUEBA TERMINADA";
  publicarEstado();
}


// ===================================================================
// 14. SENSORES
// ===================================================================

/** @return Temperatura en °C, o NAN si la termocupla está desconectada. */
float leerTemperatura() {
  return termopar.readCelsius();
}

/** @return true si la temperatura existe y es físicamente posible para agua. */
bool temperaturaValida() {
  return !isnan(temperatura) &&
         temperatura >= TEMP_VALIDA_MIN && temperatura <= TEMP_VALIDA_MAX;
}

/**
 * Toma MUESTRAS_TURBIDEZ lecturas y usa la MEDIANA (descarta picos por
 * burbujas o ruido), corrige el divisor y convierte a %.
 * Actualiza voltajeSensor (útil para calibrar).
 * @return Turbidez en % [0, 100].
 */
float leerTurbidezPorc() {
  uint32_t muestras[MUESTRAS_TURBIDEZ];
  for (int i = 0; i < MUESTRAS_TURBIDEZ; i++) {
    muestras[i] = analogReadMilliVolts(PIN_TURBIDEZ);
    delay(2);
  }
  for (int i = 1; i < MUESTRAS_TURBIDEZ; i++) {          // Ordenamiento por inserción
    uint32_t x = muestras[i];
    int j = i - 1;
    while (j >= 0 && muestras[j] > x) { muestras[j + 1] = muestras[j]; j--; }
    muestras[j + 1] = x;
  }
  float voltajeESP = muestras[MUESTRAS_TURBIDEZ / 2] / 1000.0;   // Mediana, en V
  voltajeSensor = voltajeESP * FACTOR_DIVISOR;

  // Interpolación lineal: vLimpia -> 0 %, vSucia -> 100 %
  float porc = (vLimpia - voltajeSensor) * 100.0 / (vLimpia - vSucia);
  return constrain(porc, 0.0f, 100.0f);
}

/** @return true si el pin lee ~0 V (cable del sensor suelto; R2 del divisor lo lleva a GND). */
bool turbidezDesconectada() {
  return voltajeSensor < 0.1;
}


// ===================================================================
// 15. LÓGICA DE DECISIÓN
// ===================================================================

/**
 * Propone un estado a partir de las lecturas actuales (no actúa).
 * Aplica histéresis si el estado actual es NO_APTO.
 */
Estado evaluarAgua(Motivo &motivo) {
  if (!temperaturaValida())   { motivo = FALLA_TEMP; return FALLA_SENSOR; }
  if (turbidezDesconectada()) { motivo = FALLA_TURB; return FALLA_SENSOR; }

  float limTurb = limiteTurb, limTemp = limiteTemp;
  if (estadoActual == NO_APTO) {
    limTurb -= HISTERESIS_TURB;
    limTemp -= HISTERESIS_TEMP;
  }
  bool turbAlta = turbidezPorc > limTurb;
  bool tempAlta = temperatura  > limTemp;

  if (turbAlta && tempAlta) { motivo = POR_AMBOS;       return NO_APTO; }
  if (turbAlta)             { motivo = POR_TURBIDEZ;    return NO_APTO; }
  if (tempAlta)             { motivo = POR_TEMPERATURA; return NO_APTO; }
  motivo = SIN_MOTIVO;
  return APTO;
}

/** Aplica un estado a válvulas y LED verde; lo publica y lo registra. */
void aplicarEstado(Estado nuevo, Motivo motivo) {
  Estado anterior = estadoActual;
  acumularTiempoEstado();
  if (nuevo != anterior) {
    registrarEntrada(nuevo, motivo);
    alarmaSilenciada = false;
  }
  estadoActual       = nuevo;
  motivoActual       = motivo;
  tiempoUltimoCambio = millis();
  horaUltimoCambio   = horaActual();
  textoPrueba        = nullptr;

  switch (nuevo) {
    case APTO:
      abrirSolo(PIN_RELE_DER);
      digitalWrite(PIN_LED_VERDE, HIGH);
      digitalWrite(PIN_LED_ROJO, LOW);
      break;
    case NO_APTO:
      abrirSolo(PIN_RELE_IZQ);
      digitalWrite(PIN_LED_VERDE, LOW);
      break;
    case FALLA_SENSOR:
    case INICIANDO:
    default:
      cerrarAmbas();                       // Sin datos confiables no se descarga
      digitalWrite(PIN_LED_VERDE, LOW);
      digitalWrite(PIN_LED_ROJO, LOW);
      break;
  }

  if (nuevo != anterior && nuevo != INICIANDO) {
    char detalle[64];
    snprintf(detalle, sizeof(detalle), "%s a %s%s%s", NOMBRE_ESTADO[anterior], NOMBRE_ESTADO[nuevo],
             motivo != SIN_MOTIVO ? ", " : "", NOMBRE_MOTIVO[motivo]);
    publicarEvento("Estado", detalle, motivo == POR_COMANDO ? "comando" : "ESP32");
  }
  publicarEstado();
}

/**
 * Decisión automática con filtro de estabilidad y tiempo mínimo por estado.
 * FALLA_SENSOR se aplica sin esperar TIEMPO_MINIMO_ESTADO (seguridad).
 */
void decidir() {
  Motivo motivoPropuesto;
  Estado propuesto = evaluarAgua(motivoPropuesto);

  if (propuesto == estadoCandidato) contadorCandidato++;
  else { estadoCandidato = propuesto; contadorCandidato = 1; }

  if (propuesto == estadoActual) {                 // Solo cambia la causa (ej. TURB -> AMBOS)
    if (motivoActual != motivoPropuesto) { motivoActual = motivoPropuesto; publicarEstado(); }
    return;
  }
  bool estable      = contadorCandidato >= LECTURAS_PARA_CAMBIAR;
  bool tiempoCumple = (estadoActual == INICIANDO) || (propuesto == FALLA_SENSOR) ||
                      (millis() - tiempoUltimoCambio >= TIEMPO_MINIMO_ESTADO);
  if (estable && tiempoCumple) aplicarEstado(propuesto, motivoPropuesto);
}


// ===================================================================
// 16. VISUALIZACIÓN (LCD Y SERIAL)
// ===================================================================

/** @return Texto de estado para la LCD (máx. 16 caracteres). */
const char* textoEstado() {
  if (textoPrueba != nullptr) return textoPrueba;
  switch (estadoActual) {
    case APTO: return "APTA -> DERECHA";
    case NO_APTO:
      switch (motivoActual) {
        case POR_TURBIDEZ:    return "NO APTA: TURB";
        case POR_TEMPERATURA: return "NO APTA: TEMP";
        case POR_AMBOS:       return "NO APTA: AMBOS";
        default:              return "NO APTA: MANUAL";
      }
    case FALLA_SENSOR:
      switch (motivoActual) {
        case FALLA_TEMP: return "FALLA: SENSOR T";
        case FALLA_TURB: return "FALLA: TURBIDEZ";
        default:         return "FALLA: MANUAL";
      }
    default: return modoManual ? "MANUAL" : "INICIANDO...";
  }
}

/** Escribe una fila completa, rellenando con espacios para borrar texto previo. */
void lineaLCD(int fila, const char* texto) {
  char buf[LCD_COLUMNAS + 1];
  snprintf(buf, sizeof(buf), "%-*s", LCD_COLUMNAS, texto);
  if (!lcdResponde) return;           // Sin LCD: cada escritura I2C esperaría su timeout
  lcd.setCursor(0, fila);
  lcd.print(buf);
}

/**
 * Fila 0: "T:24C Tb: 12%  M"   Fila 1: estado y motivo.
 * Última columna: M = manual, D = relés deshabilitados, * = conectado al panel.
 */
void mostrarLCD() {
  if (pasoActual == P_LCD) return;                 // La prueba de pantalla usa la LCD
  char linea1[LCD_COLUMNAS + 1];
  if (isnan(temperatura)) snprintf(linea1, sizeof(linea1), "T:--C Tb:%3d%%", (int)turbidezPorc);
  else snprintf(linea1, sizeof(linea1), "T:%2dC Tb:%3d%%", (int)temperatura, (int)turbidezPorc);

  char bandera = modoManual ? 'M' : (!HABILITAR_RELES ? 'D' : (redConectada ? '*' : ' '));
  char buf[LCD_COLUMNAS + 1];
  snprintf(buf, sizeof(buf), "%-*s%c", LCD_COLUMNAS - 1, linea1, bandera);
  lineaLCD(0, buf);
  lineaLCD(1, textoEstado());
}

void mostrarSerial() {
  Serial.print("Temp: ");
  if (isnan(temperatura)) Serial.print("--"); else Serial.print(temperatura, 2);
  Serial.print(" C | V turb: ");  Serial.print(voltajeSensor, 3);
  Serial.print(" V | Turb: ");    Serial.print(turbidezPorc, 0);
  Serial.print(" % | ");          Serial.print(textoEstado());
  Serial.print(modoManual ? " | MANUAL" : " | AUTO");
  Serial.println(redConectada ? " | en linea" : " | sin red");
}

void mostrarUmbrales() {
  Serial.println("------ UMBRALES ------");
  Serial.printf("Rubro              : %s\n", rubroActual);
  Serial.printf("Temperatura maxima : %.1f C  (vuelve a APTA bajo %.1f C)\n", limiteTemp, limiteTemp - HISTERESIS_TEMP);
  Serial.printf("Turbidez maxima    : %.1f %%  (vuelve a APTA bajo %.1f %%)\n", limiteTurb, limiteTurb - HISTERESIS_TURB);
  Serial.printf("Calibracion        : limpia %.2f V, sucia %.2f V\n", vLimpia, vSucia);
  Serial.println("----------------------");
}

void formatoTiempo(unsigned long ms, char* buf, size_t n) {
  unsigned long s = ms / 1000;
  snprintf(buf, n, "%lu:%02lu:%02lu", s / 3600, (s / 60) % 60, s % 60);
}

void mostrarEstadisticas() {
  unsigned long tiempos[NUM_ESTADOS];
  for (int i = 0; i < NUM_ESTADOS; i++) tiempos[i] = stats.tiempoEnEstado[i];
  tiempos[estadoActual] += millis() - stats.inicioEstado;
  const char* nombres[NUM_ESTADOS] = { "Inicio/prueba", "APTA", "NO APTA", "FALLA" };
  unsigned long total = millis() - stats.inicio;
  char buf[16];

  Serial.println("------ ESTADISTICAS DE SESION ------");
  formatoTiempo(total, buf, sizeof(buf));
  Serial.printf("Duracion           : %s  (%lu lecturas)\n", buf, stats.lecturas);
  for (int i = 0; i < NUM_ESTADOS; i++) {
    formatoTiempo(tiempos[i], buf, sizeof(buf));
    Serial.printf("Tiempo %-12s: %s  (%.0f %%)\n", nombres[i], buf, total > 0 ? tiempos[i] * 100.0 / total : 0.0);
  }
  Serial.printf("Veces NO APTA      : %lu  (turbidez %lu, temperatura %lu, ambos %lu)\n",
                stats.vecesNoApta, stats.noAptaPorTurb, stats.noAptaPorTemp, stats.noAptaPorAmbos);
  Serial.printf("Veces FALLA        : %lu\n", stats.vecesFalla);
  if (stats.tempMax > -1e8) Serial.printf("Temperatura min/max: %.2f / %.2f C\n", stats.tempMin, stats.tempMax);
  if (stats.turbMax > -1e8) Serial.printf("Turbidez min/max   : %.0f / %.0f %%\n", stats.turbMin, stats.turbMax);
  Serial.println("------------------------------------");
}

void mostrarAyuda() {
  Serial.println();
  Serial.println("Comandos (escribir y Enter):");
  Serial.println("  a = automatico      1/2/3 = forzar APTA / NO APTA / FALLA");
  Serial.println("  d/i = solo valvula derecha/izquierda   c = cerrar ambas");
  Serial.println("  lv/lr = LED verde/rojo  bz = buzzer  lcd = pantalla  auto = autoprueba");
  Serial.println("  m = silenciar alarma   s = estado   e = estadisticas   r = reiniciar estad.");
  Serial.println("  p = umbrales   tNN / uNN = temp / turbidez max   kRUBRO = rubro   x = fabrica");
  Serial.println("  cl / cs = capturar agua limpia / sucia   ping   reboot   h = ayuda");
  Serial.println();
}


// ===================================================================
// 17. COMANDOS (SERIAL Y MQTT)
// ===================================================================
// Los dos caminos usan ejecutarComando(). Se compara la palabra completa
// antes que la primera letra ("auto" no es "a", "reboot" no es "r").

bool reiniciarPendiente = false;
unsigned long horaReinicio = 0;

/** Cambia un umbral personalizado si está en rango y lo guarda. */
bool cambiarUmbral(bool esTemp, float valor, char* detalle, size_t n) {
  float mn = esTemp ? UMBRAL_TEMP_MIN : UMBRAL_TURB_MIN, mx = esTemp ? UMBRAL_TEMP_MAX : UMBRAL_TURB_MAX;
  if (isnan(valor) || valor < mn || valor > mx) {
    snprintf(detalle, n, "Fuera de rango (%.0f a %.0f)", mn, mx);
    return false;
  }
  if (strcmp(rubroActual, "personalizado") != 0) {   // Parte de los valores del rubro actual
    personalTemp = limiteTemp; personalTurb = limiteTurb;
    strlcpy(rubroActual, "personalizado", sizeof(rubroActual));
  }
  if (esTemp) personalTemp = valor; else personalTurb = valor;
  aplicarRubro();
  guardarMemoria();
  publicarConfig();
  snprintf(detalle, n, "Umbral %s %.1f%s", esTemp ? "temperatura" : "turbidez", valor, esTemp ? " C" : " %");
  return true;
}

bool capturarCalibracion(bool limpia, char* detalle, size_t n) {
  float nuevaLimpia = limpia ? voltajeSensor : vLimpia;
  float nuevaSucia  = limpia ? vSucia : voltajeSensor;
  if (voltajeSensor < 0.1) { snprintf(detalle, n, "Sensor desconectado"); return false; }
  if (nuevaLimpia - nuevaSucia < DIFERENCIA_MIN_CALIB) {
    snprintf(detalle, n, "Limpia debe superar a sucia por %.2f V", DIFERENCIA_MIN_CALIB);
    return false;
  }
  vLimpia = nuevaLimpia; vSucia = nuevaSucia;
  guardarMemoria();
  publicarConfig();
  snprintf(detalle, n, "Calibrado %s: %.3f V", limpia ? "agua limpia" : "muestra sucia", voltajeSensor);
  return true;
}

/**
 * Ejecuta un comando. origen: "Serial", "celular", "PC"...; id: para la
 * respuesta MQTT (vacío desde Serial).
 */
void ejecutarComando(const char* linea, const char* origen, const char* id) {
  char cmd[40];
  strlcpy(cmd, linea, sizeof(cmd));
  for (char* p = cmd; *p; p++) *p = tolower(*p);
  char detalle[80] = "";
  bool ok = true, registrar = true;
  const char* arg = cmd + 1;

  if      (!strcmp(cmd, "auto"))   { iniciarPrueba(P_NINGUNO);   strcpy(detalle, "Autoprueba completa iniciada"); }
  else if (!strcmp(cmd, "lv"))     { iniciarPrueba(P_LED_VERDE); strcpy(detalle, "Prueba LED verde"); }
  else if (!strcmp(cmd, "lr"))     { iniciarPrueba(P_LED_ROJO);  strcpy(detalle, "Prueba LED rojo"); }
  else if (!strcmp(cmd, "bz"))     { iniciarPrueba(P_BUZZER);    strcpy(detalle, "Prueba buzzer"); }
  else if (!strcmp(cmd, "lcd"))    { iniciarPrueba(P_LCD);       strcpy(detalle, "Prueba pantalla"); }
  else if (!strcmp(cmd, "cl"))     { ok = capturarCalibracion(true, detalle, sizeof(detalle)); }
  else if (!strcmp(cmd, "cs"))     { ok = capturarCalibracion(false, detalle, sizeof(detalle)); }
  else if (!strcmp(cmd, "ping"))   { strcpy(detalle, "pong"); registrar = false; }
  else if (!strcmp(cmd, "reboot")) { strcpy(detalle, "Reiniciando en 1 s"); reiniciarPendiente = true; horaReinicio = millis(); }
  else if (!strcmp(cmd, "a")) {
    modoManual = false; estadoCandidato = INICIANDO; contadorCandidato = 0;
    if (pruebaEnCurso()) { terminarPaso(pasoActual); pasoActual = P_NINGUNO; enSecuencia = false; }
    aplicarEstado(INICIANDO, SIN_MOTIVO);
    strcpy(detalle, "Modo automatico");
  }
  else if (!strcmp(cmd, "1")) { modoManual = true; aplicarEstado(APTO, POR_COMANDO);         strcpy(detalle, "Forzado: APTA"); }
  else if (!strcmp(cmd, "2")) { modoManual = true; aplicarEstado(NO_APTO, POR_COMANDO);      strcpy(detalle, "Forzado: NO APTA"); }
  else if (!strcmp(cmd, "3")) { modoManual = true; aplicarEstado(FALLA_SENSOR, POR_COMANDO); strcpy(detalle, "Forzado: FALLA"); }
  else if (!strcmp(cmd, "d")) { prepararPrueba(); abrirSolo(PIN_RELE_DER); textoPrueba = "MANUAL: VALV DER"; publicarEstado(); strcpy(detalle, "Valvula derecha abierta"); }
  else if (!strcmp(cmd, "i")) { prepararPrueba(); abrirSolo(PIN_RELE_IZQ); textoPrueba = "MANUAL: VALV IZQ"; publicarEstado(); strcpy(detalle, "Valvula izquierda abierta"); }
  else if (!strcmp(cmd, "c")) { prepararPrueba(); textoPrueba = "MANUAL: CERRADAS"; publicarEstado(); strcpy(detalle, "Ambas valvulas cerradas"); }
  else if (!strcmp(cmd, "m")) { alarmaSilenciada = true; buzzer(false); publicarEstado(); strcpy(detalle, "Alarma silenciada"); }
  else if (!strcmp(cmd, "s")) { mostrarSerial(); publicarEstado(); strcpy(detalle, "Estado enviado"); registrar = false; }
  else if (!strcmp(cmd, "e")) { mostrarEstadisticas(); publicarEstadisticas(); strcpy(detalle, "Estadisticas enviadas"); registrar = false; }
  else if (!strcmp(cmd, "r")) { reiniciarEstadisticas(); publicarEstadisticas(); strcpy(detalle, "Estadisticas reiniciadas"); }
  else if (!strcmp(cmd, "p")) { mostrarUmbrales(); publicarConfig(); strcpy(detalle, "Umbrales enviados"); registrar = false; }
  else if (!strcmp(cmd, "x")) {
    strlcpy(rubroActual, RUBRO_DEFECTO, sizeof(rubroActual));
    aplicarRubro(); guardarMemoria(); publicarConfig();
    strcpy(detalle, "Umbrales de fabrica");
  }
  else if (!strcmp(cmd, "h")) { mostrarAyuda(); strcpy(detalle, "Ayuda en Monitor Serie"); registrar = false; }
  else if (cmd[0] == 't' && *arg) { ok = cambiarUmbral(true,  atof(arg), detalle, sizeof(detalle)); }
  else if (cmd[0] == 'u' && *arg) { ok = cambiarUmbral(false, atof(arg), detalle, sizeof(detalle)); }
  else if (cmd[0] == 'k' && *arg) {
    if (!strcmp(arg, "personalizado") || buscarRubro(arg) >= 0) {
      strlcpy(rubroActual, arg, sizeof(rubroActual));
      aplicarRubro(); guardarMemoria(); publicarConfig();
      snprintf(detalle, sizeof(detalle), "Rubro %s", arg);
    } else { ok = false; snprintf(detalle, sizeof(detalle), "Rubro desconocido: %s", arg); }
  }
  else { ok = false; registrar = false; snprintf(detalle, sizeof(detalle), "Comando desconocido: %s", cmd); }

  Serial.printf("> [%s] %s: %s\n", origen, ok ? "OK" : "ERROR", detalle);
  if (!ok && !strcmp(origen, "Serial")) mostrarAyuda();
  if (registrar) publicarEvento(ok ? "Comando" : "Comando rechazado", detalle, origen);
  responder(id, ok, detalle);
}

/** Lee el Monitor Serie hasta Enter (o una pausa). No bloqueante. */
void procesarSerial() {
  static char buffer[40];
  static uint8_t largo = 0;
  static unsigned long ultimoCaracter = 0;

  while (Serial.available()) {
    char c = Serial.read();
    ultimoCaracter = millis();
    if (c == '\n' || c == '\r') {
      if (largo > 0) { buffer[largo] = '\0'; ejecutarComando(buffer, "Serial", ""); largo = 0; }
    } else if (c != ' ' && largo < sizeof(buffer) - 1) {
      buffer[largo++] = c;
    }
  }
  if (largo > 0 && millis() - ultimoCaracter > FIN_COMANDO_SIN_ENTER) {
    buffer[largo] = '\0';
    ejecutarComando(buffer, "Serial", "");
    largo = 0;
  }
}

/** Ejecuta los comandos que llegaron por MQTT (los deja la tarea de red). */
void procesarMqtt() {
  if (colaEntrada == nullptr) return;
  ComandoEntrada c;
  while (xQueueReceive(colaEntrada, &c, 0) == pdTRUE) ejecutarComando(c.cmd, c.origen, c.id);
}


// ===================================================================
// 18. DIAGNÓSTICO (WATCHDOG Y MOTIVO DE REINICIO)
// ===================================================================

/** Activa el watchdog de loop(). La tarea de red no está vigilada. */
void iniciarWatchdog() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg;
  cfg.timeout_ms     = WATCHDOG_TIMEOUT;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic  = true;
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);  // Core 3.x
#else
  esp_task_wdt_init(WATCHDOG_TIMEOUT / 1000, true);                       // Core 2.x
#endif
  esp_task_wdt_add(NULL);
}

const char* motivoReinicio(bool &anormal) {
  anormal = true;
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  anormal = false; return "Encendido normal";
    case ESP_RST_EXT:      anormal = false; return "Boton EN / reset externo";
    case ESP_RST_SW:       anormal = false; return "Reinicio por software";
    case ESP_RST_BROWNOUT: return "BROWNOUT: caida de voltaje";
    case ESP_RST_PANIC:    return "PANIC: error del programa";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "WATCHDOG: programa colgado";
    default:               return "Desconocido";
  }
}

void reportarReinicio() {
  bool anormal;
  const char* motivo = motivoReinicio(anormal);
  Serial.print("Ultimo reinicio: ");
  Serial.println(motivo);
  if (anormal) {
    lineaLCD(0, "REINICIO ANORMAL");
    lineaLCD(1, motivo);
    if (esp_reset_reason() == ESP_RST_BROWNOUT)
      Serial.println("  Revisar fuente: posible consumo alto al activar electrovalvulas.");
    delay(DURACION_AVISO_REINICIO);
  }
}

/** @return true si la LCD responde en el bus I2C. */
bool probarLcd() {
  Wire.beginTransmission(LCD_DIRECCION);
  return Wire.endTransmission() == 0;
}


// ===================================================================
// 19. SETUP
// ===================================================================
void setup() {
  // Fijar nivel "apagado" ANTES de pinMode para que las válvulas no se
  // activen un instante al arrancar.
  escribirRele(PIN_RELE_DER, false);
  escribirRele(PIN_RELE_IZQ, false);
  pinMode(PIN_RELE_DER, OUTPUT);
  pinMode(PIN_RELE_IZQ, OUTPUT);

  Serial.begin(115200);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_ROJO, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  analogSetPinAttenuation(PIN_TURBIDEZ, ADC_11db);   // Rango 0 – ~3.1 V

  Wire.begin(PIN_LCD_SDA, PIN_LCD_SCL);
  Wire.setTimeOut(20);                // ms por transacción I2C (por defecto 50)
  lcdResponde = probarLcd();
  if (lcdResponde) { lcd.init(); lcd.backlight(); }
  else Serial.printf("LCD no detectada en 0x%02X: se sigue sin pantalla\n", LCD_DIRECCION);

  reportarReinicio();
  cargarMemoria();
  reiniciarEstadisticas();
  if (HABILITAR_RED) iniciarRed();

  lineaLCD(0, "Monitoreo agua");
  lineaLCD(1, "Iniciando...");
  digitalWrite(PIN_LED_VERDE, HIGH);                 // Autoprueba visual al encender
  digitalWrite(PIN_LED_ROJO, HIGH);
  buzzer(true);
  delay(DURACION_PITIDO_INICIO);
  buzzer(false);
  delay(DURACION_PRUEBA_INICIO);                     // También da tiempo al MAX6675
  digitalWrite(PIN_LED_VERDE, LOW);
  digitalWrite(PIN_LED_ROJO, LOW);

  Serial.printf("Sistema listo. Firmware %s\n", VERSION_FIRMWARE);
  if (!HABILITAR_RELES) Serial.println("RELES DESHABILITADOS (solo LEDs/LCD/buzzer)");
  if (!HABILITAR_RED)   Serial.println("RED DESHABILITADA (solo Monitor Serie)");
  mostrarUmbrales();
  mostrarAyuda();

  iniciarWatchdog();   // Al final: los delay() de setup no deben dispararlo
}


// ===================================================================
// 20. LOOP
// ===================================================================
void loop() {
  esp_task_wdt_reset();

  // Actualización por Wi-Fi: válvulas cerradas y todo en reposo hasta que reinicie
  static bool reposoOta = false;
  if (otaEnCurso) {
    if (!reposoOta) {
      reposoOta = true;
      escribirRele(PIN_RELE_DER, false);
      escribirRele(PIN_RELE_IZQ, false);
      digitalWrite(PIN_LED_VERDE, LOW);
      digitalWrite(PIN_LED_ROJO, LOW);
      buzzer(false);
      lineaLCD(0, "ACTUALIZANDO");
      lineaLCD(1, "por Wi-Fi...");
      Serial.println("Actualizacion por Wi-Fi en curso: valvulas cerradas");
    }
    delay(50);
    return;
  }
  reposoOta = false;
  procesarSerial();
  procesarMqtt();
  actualizarPruebas();
  actualizarAlarma();

  if (reiniciarPendiente && millis() - horaReinicio > 1000) ESP.restart();

  if (pedirRepublicar) {                 // Tras (re)conectar: estado completo al panel
    pedirRepublicar = false;
    publicarEstado(); publicarConfig(); publicarEstadisticas(); publicarDiagnostico();
    publicarEvento("Sistema", "Conectado al broker", "ESP32");
  }

  if (millis() - ultimoTiempoLectura < INTERVALO_LECTURA) return;
  ultimoTiempoLectura = millis();

  temperatura  = leerTemperatura();
  turbidezPorc = leerTurbidezPorc();
  registrarLectura();

  if (!modoManual) decidir();

  mostrarLCD();
  mostrarSerial();
  publicarLectura();

  if (millis() - ultimaPubEstadisticas >= PUBLICAR_ESTADISTICAS_MS) {
    ultimaPubEstadisticas = millis();
    publicarEstadisticas();
  }
  if (millis() - ultimaPubDiagnostico >= PUBLICAR_DIAGNOSTICO_MS) {
    ultimaPubDiagnostico = millis();
    bool antes = lcdResponde;
    lcdResponde = probarLcd();
    if (lcdResponde && !antes) { lcd.init(); lcd.backlight(); }   // LCD conectada en caliente
    publicarDiagnostico();
  }
}
