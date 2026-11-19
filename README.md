# Monitoreo de efluentes — PI2 (UTEC)

ESP32 que mide temperatura (termocupla K + MAX6675) y turbidez, decide si el agua es **apta** (válvula derecha, descarga) o **no apta** (válvula izquierda, retención) y publica todo por MQTT a un panel web.

```
firmware/monitoreo_efluente/   Código del ESP32 (Arduino IDE)
panel/                         Panel web estático (GitHub Pages)
```

## Firmware

1. **Placa:** ESP32 Dev Module. Funciona con el core 2.x y 3.x de Espressif.
2. **Librerías** (Gestor de librerías):
   - *MAX6675 library* (Adafruit)
   - *LiquidCrystal I2C* (Frank de Brabander)
   - *PubSubClient* (Nick O'Leary)
   - *ArduinoJson* versión 7 (Benoit Blanchon)
3. Copia `secretos.ejemplo.h` como **`secretos.h`** en la misma carpeta y llena el Wi-Fi del hotspot y la contraseña del usuario `esp32` del broker. `secretos.h` está en `.gitignore`: **nunca se sube**.
4. Todo lo editable está arriba del `.ino` (secciones 1 a 6, con índice de líneas). Para usarlo sin internet: `HABILITAR_RED = false`.

Monitor Serie a 115200. Los comandos son los mismos desde el Monitor Serie y desde el panel (`h` muestra la lista).

## Panel

Página estática que se conecta al broker por WebSocket seguro (`wss://…:8084/mqtt`). Se entra con el usuario `panel` del broker. No guarda contraseñas en el código: se escriben en la pantalla de acceso y, si se marca *Recordar*, quedan solo en ese navegador.

Secciones: Centro de control, Gráficas (5 min a 7 días, marcas, CSV), Control (pruebas de LEDs, buzzer, pantalla, válvulas, autoprueba), Umbrales (rubros, personalizado, calibración), Registro (filtros, búsqueda, CSV) y Diagnóstico (Wi-Fi, memoria, reinicios, sensores). En el celular, Umbrales y Diagnóstico están juntos en *Ajustes*.

El historial de gráficas y el registro se arman en cada navegador mientras el panel está abierto (lecturas por segundo hasta 6 h en memoria; promedio por minuto 7 días guardado en el navegador).

## Contrato MQTT

Prefijo `pi2/efluente/`. Todo en JSON. `t` = hora Unix en segundos (`null` si el ESP32 aún no sincronizó NTP).

| Tema | Retenido | Quién publica | Contenido |
|---|---|---|---|
| `lecturas` | no | ESP32, cada 1 s | `t, temp, turb, volt` |
| `estado` | sí | ESP32, al cambiar | `t, estado (INICIANDO/APTO/NO_APTO/FALLA), motivo, modo (AUTO/MANUAL), valvula (NINGUNA/DER/IZQ), desde, valvulaDesde, cambiosValvula, silenciada, reles, prueba` |
| `config` | sí | ESP32, al cambiar | `rubro, tempMax, turbMax, histTemp, histTurb, lecturasCambio, tiempoMinimoS, intervaloS, vLimpia, vSucia, rubros[{id,nombre,t,u}], rangos{tMin,tMax,uMin,uMax}` |
| `estadisticas` | sí | ESP32, cada 30 s | `t, duracionS, lecturas, tiempoS{inicio,apta,noApta,falla}, vecesNoApta, noAptaTurb, noAptaTemp, noAptaAmbos, vecesFalla, tempMin, tempMax, turbMin, turbMax` |
| `diagnostico` | sí | ESP32, cada 10 s | `t, fw, uptimeS, heap, heapMin, rssi, ssid, reinicio, reinicioAnormal, reconexiones, enviados, recibidos, ntp, watchdogS, sensorTemp, sensorTurb, voltTurb, lcd, releDer, releIzq` |
| `eventos` | no | ESP32 | `t, tipo (Estado/Válvula/Comando/Comando rechazado/Prueba/Sistema), detalle, temp, turb, origen` |
| `conexion` | sí | ESP32 + Last Will | `estado: en_linea / desconectado` |
| `comandos` | no | Panel | `id, cmd, origen` |
| `respuestas` | no | ESP32 | `id, ok, detalle` |
| `marcas` | no | Panel | `t (ms), texto, origen` |

## Comandos

| Comando | Acción |
|---|---|
| `a` | Modo automático |
| `1` / `2` / `3` | Forzar apta / no apta / falla |
| `d` / `i` / `c` | Abrir solo derecha / solo izquierda / cerrar ambas |
| `lv` `lr` `bz` `lcd` | Probar LED verde, LED rojo, buzzer, pantalla |
| `auto` | Autoprueba completa |
| `m` | Silenciar alarma hasta el próximo cambio de estado |
| `s` `e` `p` | Ver estado, estadísticas, umbrales |
| `r` | Reiniciar estadísticas |
| `tNN` / `uNN` | Temperatura / turbidez máxima (pasa a rubro personalizado) |
| `kRUBRO` | Elegir rubro: `ptar`, `textil`, `alimentos`, `curtiembre`, `mineria`, `demo`, `personalizado` |
| `x` | Valores de fábrica (rubro PTAR) |
| `cl` / `cs` | Capturar voltaje de agua limpia / muestra sucia |
| `ping` | Prueba de conexión (no se registra) |
| `reboot` | Reiniciar el ESP32 |
