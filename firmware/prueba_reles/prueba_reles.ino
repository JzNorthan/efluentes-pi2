// ================================================================
//  PRUEBA DE RELES Y LEDS (sin WiFi, sin sensores, sin MQTT)
//  Sirve para saber si la falla es del CABLEADO o del CODIGO.
//  Monitor Serie a 115200 y escribe un numero + Enter:
//    1 = APTA      -> rele derecho ON,  LED verde ON
//    2 = NO APTA   -> apaga derecho, espera 0,5 s, rele izquierdo ON, LED rojo ON
//    3 = Todo apagado
//    4 = Prueba automatica: prende y apaga cada salida, una por una
// ================================================================

const int PIN_RELE_IZQ = 4;   // valvula izquierda -> agua NO APTA
const int PIN_RELE_DER = 32;   // valvula derecha   -> agua APTA
const int PIN_LED_ROJO = 19;
const int PIN_LED_VERDE = 23;
const int PIN_BUZZER = 18;

// Si un rele hace clic cuando deberia estar APAGADO (al reves),
// tu modulo es "activo en bajo": cambia HIGH por LOW en la linea de abajo.
const int RELE_ON = HIGH;
const int RELE_OFF = (RELE_ON == HIGH) ? LOW : HIGH;

void releIzq(bool encendido) { digitalWrite(PIN_RELE_IZQ, encendido ? RELE_ON : RELE_OFF); }
void releDer(bool encendido) { digitalWrite(PIN_RELE_DER, encendido ? RELE_ON : RELE_OFF); }

void todoApagado() {
  releIzq(false);
  releDer(false);
  digitalWrite(PIN_LED_ROJO, LOW);
  digitalWrite(PIN_LED_VERDE, LOW);
  digitalWrite(PIN_BUZZER, LOW);
}

void modoApta() {
  Serial.println(">> APTA: apago izquierdo, prendo derecho y LED verde");
  releIzq(false);
  digitalWrite(PIN_LED_ROJO, LOW);
  delay(500);
  releDer(true);
  digitalWrite(PIN_LED_VERDE, HIGH);
  Serial.println("   listo (deberia sonar CLIC en el DERECHO)");
}

void modoNoApta() {
  Serial.println(">> NO APTA: apago derecho, prendo izquierdo y LED rojo");
  releDer(false);
  digitalWrite(PIN_LED_VERDE, LOW);
  delay(500);
  releIzq(true);
  digitalWrite(PIN_LED_ROJO, HIGH);
  Serial.println("   listo (deberia sonar CLIC en el IZQUIERDO y prender el ROJO)");
}

void probarUno(const char* nombre, int pin, int on, int off) {
  Serial.print("   ");
  Serial.print(nombre);
  Serial.print(" (GPIO ");
  Serial.print(pin);
  Serial.println(") ENCENDIDO 2 s...");
  digitalWrite(pin, on);
  delay(2000);
  digitalWrite(pin, off);
  delay(500);
}

void pruebaAutomatica() {
  Serial.println(">> PRUEBA AUTOMATICA: mira y escucha cada salida");
  todoApagado();
  probarUno("Rele DERECHO", PIN_RELE_DER, RELE_ON, RELE_OFF);
  probarUno("Rele IZQUIERDO", PIN_RELE_IZQ, RELE_ON, RELE_OFF);
  probarUno("LED VERDE", PIN_LED_VERDE, HIGH, LOW);
  probarUno("LED ROJO", PIN_LED_ROJO, HIGH, LOW);
  probarUno("BUZZER", PIN_BUZZER, HIGH, LOW);
  Serial.println("   fin de la prueba");
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELE_IZQ, OUTPUT);
  pinMode(PIN_RELE_DER, OUTPUT);
  pinMode(PIN_LED_ROJO, OUTPUT);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  todoApagado();
  delay(500);
  Serial.println();
  Serial.println("=== PRUEBA DE RELES ===");
  Serial.println("1 = APTA | 2 = NO APTA | 3 = Apagar todo | 4 = Prueba automatica");
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == '1') modoApta();
    else if (c == '2') modoNoApta();
    else if (c == '3') { todoApagado(); Serial.println(">> Todo apagado"); }
    else if (c == '4') pruebaAutomatica();
  }
}
