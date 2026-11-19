// Configuración pública del panel. Aquí NO van contraseñas:
// el usuario y la contraseña se escriben en la pantalla de acceso.
window.CONFIG = {
  broker: "wss://caf8f281.ala.us-east-1.emqxsl.com:8084/mqtt",
  topicoBase: "pi2/efluente/",
  // Segundos sin lecturas para considerar al ESP32 sin datos
  sinDatosS: 5,
  // Tiempo máximo esperando la respuesta a un comando
  esperaRespuestaMs: 6000,
};
