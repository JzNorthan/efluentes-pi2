// ===================================================================
//  Panel de control — monitoreo de efluentes (PI2, UTEC)
//  Se conecta al broker MQTT por WebSocket seguro y muestra/controla
//  el ESP32. Sin servidor propio: todo corre en el navegador.
// -------------------------------------------------------------------
//  1. Utilidades            5. Comandos
//  2. Estado y memoria      6. Gráficas (SVG)
//  3. Conexión MQTT         7. Vistas
//  4. Mensajes entrantes    8. Navegación y arranque
// ===================================================================
"use strict";

// ===================================================================
// 1. UTILIDADES
// ===================================================================
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, dec = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(dec));
const dos = (n) => String(n).padStart(2, "0");
const hora = (ms, seg = true) => { const d = new Date(ms); return `${dos(d.getHours())}:${dos(d.getMinutes())}${seg ? ":" + dos(d.getSeconds()) : ""}`; };
const fecha = (ms) => { const d = new Date(ms); return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}`; };
const fechaHora = (ms) => `${fecha(ms)} ${hora(ms)}`;
function duracion(s) {
  if (s === null || s === undefined) return "—";
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${dos(m)} min`;
  if (m) return `${m} min ${dos(s % 60)} s`;
  return `${s} s`;
}
const hace = (ms) => (ms ? duracion((Date.now() - ms) / 1000) : "—");
const esCelular = () => matchMedia("(max-width: 900px)").matches;
const origen = () => (esCelular() ? "celular" : "PC");
function pon(id, texto) { const el = document.getElementById(id); if (el && el.textContent !== String(texto)) el.textContent = texto; }

function aviso(texto, tipo = "") {
  const t = document.createElement("div");
  t.className = `toast ${tipo}`;
  t.textContent = texto;
  $("#avisos").append(t);
  setTimeout(() => t.remove(), 4500);
}

function confirmar(titulo, texto, textoOk) {
  const dlg = $("#dlg-confirmar");
  pon("dlg-titulo", titulo);
  pon("dlg-texto", texto);
  $("#dlg-ok").textContent = textoOk;
  dlg.showModal();
  return new Promise((ok) => {
    const fin = (v) => { dlg.close(); $("#dlg-ok").onclick = null; dlg.onclose = null; ok(v); };
    $("#dlg-ok").onclick = () => fin(true);
    dlg.onclose = () => ok(false);
    $("[data-cerrar]", dlg).onclick = () => fin(false);
  });
}

function descargarCsv(nombre, filas) {
  const txt = filas.map((f) => f.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + txt], { type: "text/csv" }));
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===================================================================
// 2. ESTADO Y MEMORIA LOCAL
// ===================================================================
// Las lecturas crudas (1 por segundo) se guardan solo en memoria, 6 h.
// Para rangos largos se guarda un resumen por minuto en el navegador (7 días).
const RAW_MAX_MS = 6 * 3600e3;
const MIN_MAX_MS = 7 * 86400e3;
const EVENTOS_MAX = 2000;
const CLAVE = { minutos: "pi2.minutos", eventos: "pi2.eventos", cred: "pi2.cred", rango: "pi2.rango" };

const S = {
  cliente: null, conectado: false, usuario: "",
  espConexion: null,          // "en_linea" | "desconectado" | null
  ultimaLectura: 0,           // ms de la última lectura recibida
  lectura: null, estado: null, config: null, stats: null, diag: null,
  raw: [],                    // {t, temp, turb, volt}
  minutos: leer(CLAVE.minutos, []),   // {t, temp, tMin, tMax, turb, uMin, uMax}
  eventos: leer(CLAVE.eventos, []),   // {t, tipo, detalle, temp, turb, origen}
  latencia: null,
  rango: leer(CLAVE.rango, 15 * 60e3),
  filtro: "Todos", busqueda: "",
  pendientes: new Map(),      // id de comando -> {resolver, temporizador, inicio}
};

function leer(clave, defecto) { try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; } }
function guardar(clave, valor) { try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* lleno o bloqueado */ } }

const espEnLinea = () => S.conectado && S.espConexion !== "desconectado" && Date.now() - S.ultimaLectura < CONFIG.sinDatosS * 1000;

// Acumulador del minuto en curso
let minutoActual = null;
function acumularMinuto(p) {
  const m = Math.floor(p.t / 60e3) * 60e3;
  if (minutoActual && minutoActual.t !== m) cerrarMinuto();
  if (!minutoActual) minutoActual = { t: m, n: 0, sT: 0, nT: 0, tMin: Infinity, tMax: -Infinity, sU: 0, uMin: Infinity, uMax: -Infinity };
  const a = minutoActual;
  a.n++; a.sU += p.turb; a.uMin = Math.min(a.uMin, p.turb); a.uMax = Math.max(a.uMax, p.turb);
  if (p.temp !== null) { a.nT++; a.sT += p.temp; a.tMin = Math.min(a.tMin, p.temp); a.tMax = Math.max(a.tMax, p.temp); }
}
function cerrarMinuto() {
  const a = minutoActual; minutoActual = null;
  if (!a || !a.n) return;
  S.minutos.push({
    t: a.t, temp: a.nT ? +(a.sT / a.nT).toFixed(2) : null,
    tMin: a.nT ? a.tMin : null, tMax: a.nT ? a.tMax : null,
    turb: +(a.sU / a.n).toFixed(1), uMin: a.uMin, uMax: a.uMax,
  });
  const limite = Date.now() - MIN_MAX_MS;
  while (S.minutos.length && S.minutos[0].t < limite) S.minutos.shift();
  guardar(CLAVE.minutos, S.minutos);
}

function agregarEvento(ev) {
  S.eventos.push(ev);
  if (S.eventos.length > EVENTOS_MAX) S.eventos.splice(0, S.eventos.length - EVENTOS_MAX);
  guardar(CLAVE.eventos, S.eventos);
}

// ===================================================================
// 3. CONEXIÓN MQTT
// ===================================================================
function conectar(usuario, clave, recordar) {
  if (S.cliente) S.cliente.end(true);
  S.usuario = usuario;
  const cliente = mqtt.connect(CONFIG.broker, {
    username: usuario, password: clave,
    clientId: `panel-${origen()}-${Math.random().toString(16).slice(2, 8)}`,
    clean: true, reconnectPeriod: 3000, connectTimeout: 10000, keepalive: 30,
  });
  S.cliente = cliente;
  let primeraVez = true;

  cliente.on("connect", () => {
    S.conectado = true;
    cliente.subscribe(CONFIG.topicoBase + "#", { qos: 0 });
    if (primeraVez) {
      primeraVez = false;
      const dato = JSON.stringify({ u: usuario, c: clave });
      if (recordar) localStorage.setItem(CLAVE.cred, dato); else sessionStorage.setItem(CLAVE.cred, dato);
      mostrarApp();
    }
    programarRender();
  });
  cliente.on("close", () => { S.conectado = false; programarRender(); });
  cliente.on("error", (e) => {
    const noAutorizado = /not authorized|bad user|auth/i.test(e.message);
    if (primeraVez) {
      cliente.end(true);
      errorAcceso(noAutorizado ? "Usuario o contraseña incorrectos." : `No se pudo conectar al broker: ${e.message}`);
    }
  });
  cliente.on("message", alRecibir);
}

function cerrarSesion() {
  localStorage.removeItem(CLAVE.cred);
  sessionStorage.removeItem(CLAVE.cred);
  if (S.cliente) S.cliente.end(true);
  location.hash = "";
  location.reload();
}

function publicar(sub, obj, retenido = false) {
  if (!S.conectado) return false;
  S.cliente.publish(CONFIG.topicoBase + sub, JSON.stringify(obj), { qos: 1, retain: retenido });
  return true;
}

// ===================================================================
// 4. MENSAJES ENTRANTES
// ===================================================================
function alRecibir(topico, buffer) {
  const sub = topico.slice(CONFIG.topicoBase.length);
  let d;
  try { d = JSON.parse(buffer.toString()); } catch { return; }
  const ahora = Date.now();

  switch (sub) {
    case "lecturas": {
      const p = { t: ahora, temp: d.temp ?? null, turb: d.turb ?? 0, volt: d.volt ?? 0 };
      S.lectura = p; S.ultimaLectura = ahora;
      S.raw.push(p);
      while (S.raw.length && S.raw[0].t < ahora - RAW_MAX_MS) S.raw.shift();
      acumularMinuto(p);
      break;
    }
    case "estado":       S.estado = d; break;
    case "config":       S.config = d; break;
    case "estadisticas": S.stats = d; break;
    case "diagnostico":  S.diag = { ...d, recibido: ahora }; break;
    case "conexion":     S.espConexion = d.estado; break;
    case "eventos":
      agregarEvento({ t: d.t ? d.t * 1000 : ahora, tipo: d.tipo, detalle: d.detalle, temp: d.temp, turb: d.turb, origen: d.origen });
      break;
    case "marcas":
      agregarEvento({ t: d.t || ahora, tipo: "Marca", detalle: d.texto, temp: S.lectura?.temp, turb: S.lectura?.turb, origen: d.origen });
      break;
    case "respuestas": {
      const p = S.pendientes.get(d.id);
      if (p) { clearTimeout(p.temporizador); S.pendientes.delete(d.id); p.resolver({ ...d, ms: ahora - p.inicio }); }
      break;
    }
    default: return;
  }
  programarRender();
}

// ===================================================================
// 5. COMANDOS
// ===================================================================
// Se publican en pi2/efluente/comandos como {id, cmd, origen}. El ESP32
// contesta en pi2/efluente/respuestas con el mismo id.
let contadorId = 0;
function comando(cmd, { silencioso = false } = {}) {
  return new Promise((resolver) => {
    if (!S.conectado) { if (!silencioso) aviso("Sin conexión con el broker.", "error"); return resolver({ ok: false }); }
    const id = `${Date.now().toString(36)}${(contadorId++).toString(36)}`;
    const temporizador = setTimeout(() => {
      S.pendientes.delete(id);
      if (!silencioso) aviso(`El ESP32 no respondió a “${cmd}”. Revisa que esté en línea.`, "error");
      resolver({ ok: false, sinRespuesta: true });
    }, CONFIG.esperaRespuestaMs);
    S.pendientes.set(id, { resolver: (r) => { if (!silencioso) aviso(r.detalle, r.ok ? "ok" : "error"); resolver(r); }, temporizador, inicio: Date.now() });
    publicar("comandos", { id, cmd, origen: origen() });
  });
}

async function comandoConfirmado(cmd, titulo, texto, textoOk) {
  if (await confirmar(titulo, texto, textoOk)) return comando(cmd);
  return { ok: false };
}

async function medirLatencia() {
  if (!espEnLinea()) { S.latencia = null; return; }
  const r = await comando("ping", { silencioso: true });
  S.latencia = r.ok ? r.ms : null;
  programarRender();
}

function agregarMarca() {
  const dlg = $("#dlg-marca");
  $("#marca-texto").value = "";
  dlg.showModal();
  $("[data-cerrar]", dlg).onclick = () => dlg.close();
  $("#marca-ok").onclick = () => {
    const texto = $("#marca-texto").value.trim();
    if (!texto) return $("#marca-texto").focus();
    if (publicar("marcas", { t: Date.now(), texto, origen: origen() })) aviso("Marca agregada.", "ok");
    dlg.close();
  };
}

// Acción de los botones con data-cmd (y data-confirmar opcional)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cmd]");
  if (!b || b.disabled) return;
  const conf = b.dataset.confirmar;
  b.disabled = true;
  if (conf) { const [t, x, ok] = conf.split("|"); await comandoConfirmado(b.dataset.cmd, t, x, ok); }
  else await comando(b.dataset.cmd);
  b.disabled = false;
  programarRender();
});

// ===================================================================
// 6. GRÁFICAS (SVG)
// ===================================================================
const COLOR = { agua: "#4FB3D9", apta: "#3FBF84", noApta: "#F07A3E", falla: "#E3B341", linea: "#24383F", tenue: "#93A7AD", texto: "#E6EEF0" };

/** Puntos de un rango: minutos guardados + lecturas crudas más recientes. */
function puntosRango(desde) {
  const crudoDesde = S.raw.length ? S.raw[0].t : Infinity;
  const largo = Date.now() - desde > RAW_MAX_MS * 0.99;
  const res = [];
  for (const m of S.minutos) if (m.t >= desde && (largo || m.t < crudoDesde)) res.push(m);
  if (!largo) { for (const p of S.raw) if (p.t >= desde) res.push(p); }
  else if (minutoActual && minutoActual.n) res.push({ t: minutoActual.t, temp: minutoActual.nT ? minutoActual.sT / minutoActual.nT : null, turb: minutoActual.sU / minutoActual.n });
  // Más de 1500 puntos: se promedian en grupos para no saturar el SVG
  if (res.length <= 1500) return res;
  const paso = Math.ceil(res.length / 1500), red = [];
  for (let i = 0; i < res.length; i += paso) {
    const g = res.slice(i, i + paso), tv = g.filter((p) => p.temp !== null);
    red.push({ t: g[0].t, temp: tv.length ? tv.reduce((s, p) => s + p.temp, 0) / tv.length : null, turb: g.reduce((s, p) => s + p.turb, 0) / g.length });
  }
  return red;
}

/**
 * Dibuja una serie con línea de umbral, eje de tiempo y marcas.
 * campo: "temp" | "turb".  Huecos de más de 3 intervalos cortan la línea.
 */
function grafica({ puntos, campo, desde, hasta, umbral, unidad, minY, maxY, alto = 220, color = COLOR.agua, id }) {
  const W = esCelular() ? 420 : 800, H = alto, mI = 36, mD = 12, mS = 12, mB = 26;
  const vals = puntos.map((p) => p[campo]).filter((v) => v !== null && v !== undefined);
  let lo = Math.min(minY, ...vals, umbral ?? Infinity), hi = Math.max(maxY, ...vals, umbral ?? -Infinity);
  if (hi - lo < 1) hi = lo + 1;
  const pad = (hi - lo) * 0.08; lo = Math.max(minY === 0 ? 0 : -Infinity, lo - pad); hi += pad;
  const x = (t) => mI + ((t - desde) / (hasta - desde)) * (W - mI - mD);
  const y = (v) => mS + (1 - (v - lo) / (hi - lo)) * (H - mS - mB);

  // Rejilla y eje Y
  let s = "";
  const pasoY = escalaPaso(hi - lo, 4);
  for (let v = Math.ceil(lo / pasoY) * pasoY; v <= hi; v += pasoY) {
    s += `<line x1="${mI}" x2="${W - mD}" y1="${y(v)}" y2="${y(v)}" stroke="${COLOR.linea}"/>`;
    s += `<text x="${mI - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${COLOR.tenue}">${+v.toFixed(1)}</text>`;
  }
  // Eje X
  const ticks = ticksTiempo(desde, hasta);
  for (const t of ticks.lista) s += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${COLOR.tenue}">${ticks.fmt(t)}</text>`;

  // Umbral
  if (umbral !== null && umbral !== undefined) {
    s += `<line x1="${mI}" x2="${W - mD}" y1="${y(umbral)}" y2="${y(umbral)}" stroke="${COLOR.noApta}" stroke-dasharray="6 4"/>`;
    s += `<text x="${W - mD}" y="${y(umbral) - 5}" text-anchor="end" font-size="11" fill="${COLOR.noApta}">Límite ${num(umbral, 0)} ${unidad}</text>`;
  }
  // Marcas del registro
  for (const ev of S.eventos) {
    if (ev.tipo !== "Marca" || ev.t < desde || ev.t > hasta) continue;
    s += `<line x1="${x(ev.t)}" x2="${x(ev.t)}" y1="${mS}" y2="${H - mB}" stroke="${COLOR.falla}" stroke-width="1"/><circle cx="${x(ev.t)}" cy="${mS + 3}" r="3" fill="${COLOR.falla}"><title>${esc(ev.detalle)}</title></circle>`;
  }
  // Serie
  const hueco = Math.max(3500, ((hasta - desde) / Math.max(puntos.length, 1)) * 3);
  let d = "", prev = null;
  for (const p of puntos) {
    const v = p[campo];
    if (v === null || v === undefined) { prev = null; continue; }
    d += `${!prev || p.t - prev.t > hueco ? "M" : "L"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
    prev = p;
  }
  s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  if (!vals.length) s += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="${COLOR.tenue}">Sin lecturas en este rango</text>`;
  s += `<line class="cursor" x1="0" x2="0" y1="${mS}" y2="${H - mB}" stroke="${COLOR.texto}" stroke-opacity=".4" visibility="hidden"/>`;

  return `<svg class="grafica" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfica de ${campo === "temp" ? "temperatura" : "turbidez"}" data-desde="${desde}" data-hasta="${hasta}" data-campo="${campo}" data-unidad="${unidad}" data-mi="${mI}" data-md="${mD}" data-w="${W}">${s}</svg>`;
}

function escalaPaso(rango, n) {
  const bruto = rango / n, p = 10 ** Math.floor(Math.log10(bruto)), f = bruto / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function ticksTiempo(desde, hasta) {
  const r = hasta - desde;
  const pasos = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3];
  const paso = pasos.find((p) => r / p <= 6) ?? 86400e3;
  const tz = new Date().getTimezoneOffset() * 60e3, lista = [];
  for (let t = Math.ceil((desde - tz) / paso) * paso + tz; t <= hasta; t += paso) lista.push(t);
  return { lista, fmt: r > 2 * 86400e3 ? fecha : (t) => hora(t, false) };
}

/** Sparkline sin ejes (últimos minutos). */
function mini(puntos, campo, color, umbral) {
  const vals = puntos.map((p) => p[campo]).filter((v) => v !== null);
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 200 32"></svg>`;
  let lo = Math.min(...vals, umbral ?? Infinity), hi = Math.max(...vals, umbral ?? -Infinity);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const t0 = puntos[0].t, t1 = puntos[puntos.length - 1].t || t0 + 1;
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * 200, y = (v) => 30 - ((v - lo) / (hi - lo)) * 28;
  const d = puntos.filter((p) => p[campo] !== null).map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[campo]).toFixed(1)}`).join("");
  const u = umbral !== undefined ? `<line x1="0" x2="200" y1="${y(umbral)}" y2="${y(umbral)}" stroke="${COLOR.noApta}" stroke-dasharray="3 3"/>` : "";
  return `<svg class="spark" viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden="true">${u}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// Tooltip: busca el punto más cercano al cursor
document.addEventListener("pointermove", (e) => {
  const tip = $("#tooltip");
  const svg = e.target.closest?.("svg.grafica");
  $$("svg.grafica .cursor").forEach((c) => c !== svg?.querySelector(".cursor") && c.setAttribute("visibility", "hidden"));
  if (!svg) { tip.classList.add("oculto"); return; }
  const r = svg.getBoundingClientRect(), W = +svg.dataset.w;
  const mI = +svg.dataset.mi, mD = +svg.dataset.md, desde = +svg.dataset.desde, hasta = +svg.dataset.hasta;
  const xv = ((e.clientX - r.left) / r.width) * W;
  const t = desde + ((xv - mI) / (W - mI - mD)) * (hasta - desde);
  const pts = svg._puntos || [];
  let mejor = null;
  for (const p of pts) if (p[svg.dataset.campo] !== null && (!mejor || Math.abs(p.t - t) < Math.abs(mejor.t - t))) mejor = p;
  if (!mejor || Math.abs(mejor.t - t) > (hasta - desde) / 20) { tip.classList.add("oculto"); return; }
  const cx = mI + ((mejor.t - desde) / (hasta - desde)) * (W - mI - mD), cur = svg.querySelector(".cursor");
  cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); cur.setAttribute("visibility", "visible");
  tip.innerHTML = `<div class="tenue">${fechaHora(mejor.t)}</div><div class="medio">${num(mejor[svg.dataset.campo], svg.dataset.campo === "temp" ? 1 : 0)} ${esc(svg.dataset.unidad)}</div>`;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 150) + "px";
  tip.style.top = e.clientY - 60 + "px";
  tip.classList.remove("oculto");
});

function resumen(puntos, campo) {
  const v = puntos.map((p) => p[campo]).filter((x) => x !== null && x !== undefined);
  if (!v.length) return { min: null, max: null, prom: null };
  return { min: Math.min(...v), max: Math.max(...v), prom: v.reduce((a, b) => a + b, 0) / v.length };
}

// ===================================================================
// 7. VISTAS
// ===================================================================
const TXT_ESTADO = { APTO: "Apta", NO_APTO: "No apta", FALLA: "Falla de sensor", INICIANDO: "Iniciando" };
const CLASE_ESTADO = { APTO: "c-apta", NO_APTO: "c-noapta", FALLA: "c-falla" };
const TXT_MOTIVO = {
  TURBIDEZ: "Turbidez sobre el límite", TEMPERATURA: "Temperatura sobre el límite", AMBOS: "Turbidez y temperatura sobre el límite",
  FALLA_TEMP: "Termocupla sin lectura", FALLA_TURB: "Sensor de turbidez desconectado", COMANDO: "Forzado desde comando", "": "Dentro de los límites",
};
const RANGOS = [[5 * 60e3, "5 min"], [15 * 60e3, "15 min"], [3600e3, "1 h"], [6 * 3600e3, "6 h"], [86400e3, "24 h"], [7 * 86400e3, "7 días"]];
const TIPOS = ["Todos", "Estado", "Válvula", "Comando", "Prueba", "Sistema", "Marca"];

const sinEsp = () => (espEnLinea() ? "" : "disabled");
function textoEstado() {
  const e = S.estado;
  if (!e) return { txt: "Sin datos", cls: "tenue", motivo: "Esperando al ESP32" };
  if (e.prueba) return { txt: e.prueba.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), cls: "", motivo: e.modo === "MANUAL" ? "Modo manual" : "" };
  return { txt: TXT_ESTADO[e.estado] ?? e.estado, cls: CLASE_ESTADO[e.estado] ?? "", motivo: TXT_MOTIVO[e.motivo] ?? e.motivo };
}

// ---------- Bloques reutilizables ----------
function bloqueIndicadores() {
  return `<div class="indicadores">
    <div class="ind estado" id="ind-estado"><span class="tenue">Estado del agua</span><span class="grande" id="v-estado">—</span><span id="v-motivo" class="tenue"></span><span class="tenue num" id="v-desde"></span></div>
    <div class="ind"><span class="tenue">Temperatura</span><span class="grande"><span id="v-temp">—</span> <small class="medio tenue">°C</small></span><span class="tenue num" id="v-temp-lim"></span><div id="spark-temp"></div></div>
    <div class="ind"><span class="tenue">Turbidez</span><span class="grande"><span id="v-turb">—</span> <small class="medio tenue">%</small></span><span class="tenue num" id="v-turb-lim"></span><div id="spark-turb"></div></div>
    <div class="ind ancho-cel"><span class="tenue">Válvulas</span>
      <div class="valvula-fila"><span class="marca-valvula c-apta"><span class="cuadro" id="cuadro-der"></span>Derecha · apta</span><span id="v-der" class="num"></span></div>
      <div class="valvula-fila"><span class="marca-valvula c-noapta"><span class="cuadro" id="cuadro-izq"></span>Izquierda · no apta</span><span id="v-izq" class="num"></span></div>
      <span class="tenue num" id="v-valv-info"></span></div>
  </div>`;
}
function actualizarIndicadores() {
  const e = textoEstado(), c = S.config, l = S.lectura;
  const ind = $("#ind-estado");
  if (ind) ind.className = `ind estado estado-${S.estado?.estado ?? ""}`;
  pon("v-estado", e.txt);
  const ve = $("#v-estado"); if (ve) ve.className = `grande ${e.cls}`;
  pon("v-motivo", e.motivo + (S.estado?.silenciada ? " · alarma silenciada" : ""));
  pon("v-desde", S.estado?.desde ? `Desde ${hora(S.estado.desde * 1000)} · modo ${S.estado.modo === "MANUAL" ? "manual" : "automático"}` : S.estado ? `Modo ${S.estado.modo === "MANUAL" ? "manual" : "automático"}` : "");
  pon("v-temp", l ? num(l.temp, 1) : "—");
  pon("v-turb", l ? num(l.turb, 0) : "—");
  pon("v-temp-lim", c ? `Límite ${num(c.tempMax, 0)} °C · vuelve bajo ${num(c.tempMax - c.histTemp, 0)}` : "");
  pon("v-turb-lim", c ? `Límite ${num(c.turbMax, 0)} % · ${num(l?.volt, 2)} V` : "");
  const ult = S.raw.slice(-120);
  const st = $("#spark-temp"); if (st) st.innerHTML = mini(ult, "temp", COLOR.agua, c?.tempMax);
  const su = $("#spark-turb"); if (su) su.innerHTML = mini(ult, "turb", COLOR.agua, c?.turbMax);
  const v = S.estado?.valvula;
  $("#cuadro-der")?.classList.toggle("abierta", v === "DER");
  $("#cuadro-izq")?.classList.toggle("abierta", v === "IZQ");
  pon("v-der", v === "DER" ? "Abierta" : "Cerrada");
  pon("v-izq", v === "IZQ" ? "Abierta" : "Cerrada");
  pon("v-valv-info", S.estado ? `${S.estado.cambiosValvula ?? 0} cambios${S.estado.valvulaDesde ? " · último " + hora(S.estado.valvulaDesde * 1000) : ""}${S.estado.reles === false ? " · relés deshabilitados" : ""}` : "");
}

function bloqueModo() {
  return `<div class="panel"><div class="panel-cab"><h2>Modo de operación</h2><span class="tenue" id="v-modo"></span></div>
    <button class="btn btn-primario" data-cmd="a" ${sinEsp()}>Volver a automático</button>
    <div class="grilla-3">
      <button class="btn btn-apta" data-cmd="1" ${sinEsp()} data-confirmar="¿Forzar agua apta?|Se abre la válvula derecha (descarga) sin importar las lecturas, hasta volver a automático.|Forzar apta">Forzar apta</button>
      <button class="btn btn-noapta" data-cmd="2" ${sinEsp()}>Forzar no apta</button>
      <button class="btn btn-falla" data-cmd="3" ${sinEsp()}>Forzar falla</button>
    </div>
    <div class="grilla-2">
      <button class="btn btn-borde" data-cmd="m" ${sinEsp()}>Silenciar alarma</button>
      <button class="btn btn-borde" data-cmd="c" ${sinEsp()}>Cerrar válvulas</button>
    </div></div>`;
}

function bloqueSesion() {
  return `<div class="panel"><div class="panel-cab"><h2>Sesión</h2><span class="tenue num" id="s-dur"></span></div>
    <div class="reparto" id="s-reparto"></div>
    <dl class="datos">
      <dt>Tiempo apta</dt><dd id="s-apta">—</dd><dt>Tiempo no apta</dt><dd id="s-noapta">—</dd><dt>Tiempo en falla</dt><dd id="s-falla">—</dd>
      <dt>Veces no apta</dt><dd id="s-veces">—</dd><dt>Por turbidez / temp. / ambos</dt><dd id="s-causas">—</dd>
      <dt>Temperatura mín. / máx.</dt><dd id="s-temp">—</dd><dt>Turbidez mín. / máx.</dt><dd id="s-turb">—</dd><dt>Lecturas</dt><dd id="s-lect">—</dd>
    </dl>
    <button class="btn btn-borde btn-chico" data-cmd="r" ${sinEsp()} data-confirmar="¿Reiniciar estadísticas?|Se ponen en cero los tiempos y conteos de la sesión en el ESP32.|Reiniciar">Reiniciar estadísticas</button></div>`;
}
function actualizarSesion() {
  const s = S.stats;
  if (!s) return;
  const t = s.tiempoS, tot = Math.max(1, t.inicio + t.apta + t.noApta + t.falla), pc = (v) => `${Math.round((v * 100) / tot)} %`;
  pon("s-dur", duracion(s.duracionS));
  const rep = $("#s-reparto");
  if (rep) rep.innerHTML = [[t.apta, COLOR.apta], [t.noApta, COLOR.noApta], [t.falla, COLOR.falla]].map(([v, c]) => `<span style="width:${(v * 100) / tot}%;background:${c}"></span>`).join("");
  pon("s-apta", `${duracion(t.apta)} · ${pc(t.apta)}`); pon("s-noapta", `${duracion(t.noApta)} · ${pc(t.noApta)}`); pon("s-falla", `${duracion(t.falla)} · ${pc(t.falla)}`);
  pon("s-veces", s.vecesNoApta); pon("s-causas", `${s.noAptaTurb} / ${s.noAptaTemp} / ${s.noAptaAmbos}`);
  pon("s-temp", s.tempMin !== undefined ? `${num(s.tempMin)} / ${num(s.tempMax)} °C` : "—");
  pon("s-turb", s.turbMin !== undefined ? `${num(s.turbMin, 0)} / ${num(s.turbMax, 0)} %` : "—");
  pon("s-lect", s.lecturas);
}

function filaEvento(ev, corta) {
  const cls = /APTO a NO_APTO|a FALLA|rechazado/.test(ev.detalle ?? "") || ev.tipo === "Comando rechazado" ? "c-noapta" : /a APTO/.test(ev.detalle ?? "") ? "c-apta" : ev.tipo === "Marca" ? "c-falla" : "";
  if (corta) return `<li><span class="tenue num">${hora(ev.t, false)}</span><span class="${cls}">${esc(ev.detalle)}</span><span class="tenue">${esc(ev.origen)}</span></li>`;
  return `<tr><td class="tenue">${fechaHora(ev.t)}</td><td>${esc(ev.tipo)}</td><td class="${cls}">${esc(ev.detalle)}</td><td>${num(ev.temp)}</td><td>${num(ev.turb, 0)}</td><td class="tenue">${esc(ev.origen)}</td></tr>`;
}

// ---------- Centro de control ----------
const VISTAS = {};
VISTAS.inicio = {
  titulo: "Centro de control",
  html: () => `${bloqueIndicadores()}
    <div class="fila">
      <div class="col-2 panel">
        <div class="panel-cab"><h2>Últimos 15 minutos</h2><a href="#graficas">Ver gráficas</a></div>
        <div id="g-inicio-temp"></div><div id="g-inicio-turb"></div>
      </div>
      <div class="col-1" style="display:flex;flex-direction:column;gap:18px">${bloqueModo()}
        <div class="panel"><div class="panel-cab"><h2>Últimos eventos</h2><a href="#registro">Ver registro</a></div><ul class="lista" id="ev-inicio"></ul></div>
      </div>
    </div>
    <div class="fila"><div class="col-1">${bloqueSesion()}</div><div class="col-1">${bloqueConexionCorto()}</div></div>`,
  update() {
    actualizarIndicadores(); actualizarSesion(); actualizarConexionCorto();
    pon("v-modo", S.estado ? (S.estado.modo === "MANUAL" ? "Manual" : "Automático") : "");
    const hasta = Date.now(), desde = hasta - 15 * 60e3, pts = puntosRango(desde);
    dibujar("g-inicio-temp", { puntos: pts, campo: "temp", desde, hasta, umbral: S.config?.tempMax, unidad: "°C", minY: 15, maxY: 40, alto: esCelular() ? 160 : 170 });
    dibujar("g-inicio-turb", { puntos: pts, campo: "turb", desde, hasta, umbral: S.config?.turbMax, unidad: "%", minY: 0, maxY: 50, alto: esCelular() ? 160 : 170 });
    const ul = $("#ev-inicio");
    if (ul) ul.innerHTML = S.eventos.slice(-6).reverse().map((e) => filaEvento(e, true)).join("") || `<li class="vacio">Aún no hay eventos en este navegador.</li>`;
  },
};

function dibujar(id, opts) {
  const caja = document.getElementById(id);
  if (!caja) return;
  caja.innerHTML = grafica({ ...opts, id: id + "-svg" });
  caja.firstElementChild._puntos = opts.puntos;
}

function bloqueConexionCorto() {
  return `<div class="panel"><div class="panel-cab"><h2>Conexión</h2><a href="#diagnostico" class="solo-pc">Diagnóstico</a></div>
    <dl class="datos"><dt>ESP32</dt><dd id="k-esp">—</dd><dt>Última lectura</dt><dd id="k-ult">—</dd><dt>Latencia del comando</dt><dd id="k-lat">—</dd>
    <dt>Señal Wi-Fi</dt><dd id="k-rssi">—</dd><dt>Encendido hace</dt><dd id="k-up">—</dd><dt>Firmware</dt><dd id="k-fw">—</dd></dl></div>`;
}
function calidadRssi(r) { return r === undefined || r === null ? "—" : `${r} dBm · ${r > -60 ? "buena" : r > -72 ? "regular" : "débil"}`; }
function actualizarConexionCorto() {
  pon("k-esp", espEnLinea() ? "En línea" : S.espConexion === "desconectado" ? "Desconectado" : "Sin datos");
  pon("k-ult", S.ultimaLectura ? `hace ${hace(S.ultimaLectura)}` : "—");
  pon("k-lat", S.latencia !== null ? `${S.latencia} ms` : "—");
  pon("k-rssi", calidadRssi(S.diag?.rssi));
  pon("k-up", S.diag ? duracion(S.diag.uptimeS + (Date.now() - S.diag.recibido) / 1000) : "—");
  pon("k-fw", S.diag?.fw ?? "—");
}

// ---------- Gráficas ----------
VISTAS.graficas = {
  titulo: "Gráficas",
  html: () => `<div class="panel-cab">
      <div class="pildoras" role="group" aria-label="Rango de tiempo">${RANGOS.map(([ms, t]) => `<button data-rango="${ms}" aria-pressed="${S.rango === ms}">${t}</button>`).join("")}</div>
      <div style="display:flex;gap:8px"><button class="btn btn-borde btn-chico" id="b-marca" ${S.conectado ? "" : "disabled"}>Agregar marca</button><button class="btn btn-borde btn-chico" id="b-csv">Descargar CSV</button></div>
    </div>
    <div class="panel"><div class="panel-cab"><h2>Temperatura</h2><span class="tenue num" id="r-temp"></span></div><div id="g-temp"></div></div>
    <div class="panel"><div class="panel-cab"><h2>Turbidez</h2><span class="tenue num" id="r-turb"></span></div><div id="g-turb"></div></div>
    <p class="tenue" style="margin:0">Hasta 6 h se muestran las lecturas de cada segundo recibidas con esta página abierta; los rangos largos usan el promedio por minuto guardado en este navegador.</p>`,
  montar() {
    $$("[data-rango]").forEach((b) => (b.onclick = () => { S.rango = +b.dataset.rango; guardar(CLAVE.rango, S.rango); $$("[data-rango]").forEach((x) => x.setAttribute("aria-pressed", x === b)); this.update(); }));
    $("#b-marca").onclick = agregarMarca;
    $("#b-csv").onclick = () => {
      const pts = puntosRango(Date.now() - S.rango);
      descargarCsv(`lecturas_${fecha(Date.now()).replace("/", "-")}.csv`, [["fecha_hora", "temperatura_C", "turbidez_pct"], ...pts.map((p) => [fechaHora(p.t), num(p.temp, 2), num(p.turb, 1)])]);
    };
  },
  update() {
    const hasta = Date.now(), desde = hasta - S.rango, pts = puntosRango(desde), alto = esCelular() ? 230 : 240;
    dibujar("g-temp", { puntos: pts, campo: "temp", desde, hasta, umbral: S.config?.tempMax, unidad: "°C", minY: 15, maxY: 40, alto });
    dibujar("g-turb", { puntos: pts, campo: "turb", desde, hasta, umbral: S.config?.turbMax, unidad: "%", minY: 0, maxY: 50, alto });
    const a = resumen(pts, "temp"), b = resumen(pts, "turb");
    pon("r-temp", `mín. ${num(a.min)} · prom. ${num(a.prom)} · máx. ${num(a.max)} °C`);
    pon("r-turb", `mín. ${num(b.min, 0)} · prom. ${num(b.prom, 0)} · máx. ${num(b.max, 0)} %`);
  },
};

// ---------- Control y pruebas ----------
VISTAS.control = {
  titulo: "Control",
  html: () => `<div class="fila">
    <div class="col-1 panel"><div class="panel-cab"><h2>Pruebas de componentes</h2><span class="tenue" id="v-prueba"></span></div>
      <p class="tenue" style="margin:0">Cada prueba pasa el sistema a manual, cierra las válvulas y enciende el componente unos segundos. Al terminar, vuelve a automático.</p>
      <div class="grilla-2">
        <button class="btn" data-cmd="lv" ${sinEsp()}>LED verde · 2 s</button><button class="btn" data-cmd="lr" ${sinEsp()}>LED rojo · 2 s</button>
        <button class="btn" data-cmd="bz" ${sinEsp()}>Buzzer · 0,5 s</button><button class="btn" data-cmd="lcd" ${sinEsp()}>Pantalla · 3 s</button>
      </div>
      <button class="btn btn-primario" data-cmd="auto" ${sinEsp()}>Autoprueba completa · 12 s</button>
      <span class="tenue">Orden: LED verde, LED rojo, buzzer, pantalla, válvula derecha, válvula izquierda.</span></div>
    <div class="col-1 panel"><div class="panel-cab"><h2>Válvulas</h2><span class="tenue" id="v-valv-estado"></span></div>
      <p class="tenue" style="margin:0">Quedan abiertas hasta que elijas otra opción o vuelvas a automático. Nunca se abren las dos a la vez.</p>
      <button class="btn btn-apta" data-cmd="d" ${sinEsp()} data-confirmar="¿Abrir la válvula derecha?|El agua se descarga como apta sin importar las lecturas.|Abrir derecha">Abrir derecha (descarga)</button>
      <button class="btn btn-noapta" data-cmd="i" ${sinEsp()}>Abrir izquierda (retención)</button>
      <button class="btn btn-borde" data-cmd="c" ${sinEsp()}>Cerrar ambas</button></div>
    <div class="col-1" style="display:flex;flex-direction:column;gap:18px">${bloqueModo()}
      <div class="panel"><h2>Sistema</h2>
        <div class="grilla-2"><button class="btn btn-borde" id="b-ping" ${sinEsp()}>Medir latencia</button>
        <button class="btn btn-borde" data-cmd="reboot" ${sinEsp()} data-confirmar="¿Reiniciar el ESP32?|Se cierran las válvulas y el equipo vuelve a arrancar. Tarda unos 10 s en volver.|Reiniciar ESP32">Reiniciar ESP32</button></div></div>
    </div></div>
    <div class="panel"><div class="panel-cab"><h2>Comando libre</h2><span class="tenue">Los mismos del Monitor Serie</span></div>
      <form id="f-libre" style="display:flex;gap:8px"><input type="search" id="i-libre" placeholder="Ej.: t35, u40, ktextil, s" style="flex:1" autocomplete="off" aria-label="Comando"><button class="btn" ${sinEsp()}>Enviar</button></form></div>`,
  montar() {
    $("#b-ping").onclick = async () => { await medirLatencia(); aviso(S.latencia !== null ? `Latencia ${S.latencia} ms` : "Sin respuesta", S.latencia !== null ? "ok" : "error"); };
    $("#f-libre").onsubmit = (e) => { e.preventDefault(); const v = $("#i-libre").value.trim(); if (v) { comando(v); $("#i-libre").value = ""; } };
  },
  update() {
    pon("v-prueba", S.estado?.prueba ? S.estado.prueba.toLowerCase() : "Ninguna en curso");
    pon("v-modo", S.estado ? (S.estado.modo === "MANUAL" ? "Manual" : "Automático") : "");
    const v = S.estado?.valvula;
    pon("v-valv-estado", v === "DER" ? "Derecha abierta" : v === "IZQ" ? "Izquierda abierta" : "Ambas cerradas");
  },
};

// ---------- Umbrales ----------
VISTAS.umbrales = {
  titulo: "Umbrales",
  html: () => `<div class="fila">
    <div class="col-2 panel"><div class="panel-cab"><h2>Rubro</h2><span class="tenue">El ESP32 lo guarda en su memoria</span></div>
      <div role="radiogroup" aria-label="Rubro" id="rubros"><div class="rubro-op tenue" style="font-size:13px;border-top:0"><span>Rubro</span><span>Temp. máx.</span><span>Turbidez máx.</span></div></div>
      <p class="tenue" style="margin:0">Valores de ejemplo para el prototipo; justificarlos con la norma de cada rubro.</p></div>
    <div class="col-1 panel"><h2>Personalizado</h2>
      <form id="f-umbral" style="display:flex;flex-direction:column;gap:12px">
        <label class="campo"><span class="tenue">Temperatura máxima (°C)</span><input id="i-tmax" type="number" inputmode="decimal" step="0.5" required></label>
        <label class="campo"><span class="tenue">Turbidez máxima (%)</span><input id="i-umax" type="number" inputmode="decimal" step="1" required></label>
        <span class="tenue" id="t-rango"></span>
        <button class="btn btn-primario" ${sinEsp()}>Guardar umbrales</button>
      </form></div></div>
    <div class="fila">
      <div class="col-1 panel"><h2>Reglas de cambio</h2><dl class="datos">
        <dt>Histéresis de temperatura</dt><dd id="u-ht">—</dd><dt>Histéresis de turbidez</dt><dd id="u-hu">—</dd>
        <dt>Lecturas iguales para cambiar</dt><dd id="u-lc">—</dd><dt>Tiempo mínimo entre apta y no apta</dt><dd id="u-tm">—</dd><dt>Intervalo de lectura</dt><dd id="u-il">—</dd></dl>
        <span class="tenue">Se cambian en el firmware (sección 4 y 5).</span>
        <button class="btn btn-borde btn-chico" data-cmd="x" ${sinEsp()} data-confirmar="¿Volver a valores de fábrica?|El rubro pasa a PTAR doméstica (35 °C, 30 %). El personalizado se conserva.|Restaurar">Restaurar valores de fábrica</button></div>
      <div class="col-1 panel"><div class="panel-cab"><h2>Calibración de turbidez</h2><span class="num" id="c-volt"></span></div>
        <dl class="datos"><dt>Agua limpia (0 %)</dt><dd id="c-limpia">—</dd><dt>Muestra sucia (100 %)</dt><dd id="c-sucia">—</dd></dl>
        <span class="tenue">Sumerge el sensor en la muestra, espera a que el voltaje se estabilice y captura.</span>
        <div class="grilla-2">
          <button class="btn" data-cmd="cl" ${sinEsp()} data-confirmar="¿Capturar agua limpia?|El voltaje actual del sensor pasa a ser 0 % de turbidez.|Capturar">Capturar agua limpia</button>
          <button class="btn" data-cmd="cs" ${sinEsp()} data-confirmar="¿Capturar muestra sucia?|El voltaje actual del sensor pasa a ser 100 % de turbidez.|Capturar">Capturar muestra sucia</button></div></div>
    </div>`,
  montar() {
    this.cargado = false;
    $("#f-umbral").onsubmit = async (e) => {
      e.preventDefault();
      const t = parseFloat($("#i-tmax").value), u = parseFloat($("#i-umax").value);
      const r1 = await comando(`t${t}`);
      if (r1.ok) await comando(`u${u}`);
    };
  },
  update() {
    const c = S.config;
    if (!c) return;
    const caja = $("#rubros");
    if (caja) {
      const filas = c.rubros.map((r) => `<button class="rubro-op" role="radio" aria-checked="${r.id === c.rubro}" data-rubro="${esc(r.id)}" ${sinEsp()}><span>${esc(r.nombre)}</span><span class="num">${num(r.t, 0)} °C</span><span class="num">${num(r.u, 0)} %</span></button>`).join("");
      const clave = JSON.stringify([c.rubro, c.rubros, espEnLinea()]);
      if (caja.dataset.clave !== clave) {
        caja.dataset.clave = clave;
        $$(".rubro-op[data-rubro]", caja).forEach((x) => x.remove());
        caja.insertAdjacentHTML("beforeend", filas);
        $$("[data-rubro]", caja).forEach((b) => (b.onclick = () => comando(`k${b.dataset.rubro}`)));
      }
    }
    const p = c.rubros.find((r) => r.id === "personalizado");
    if (!this.cargado && p) { $("#i-tmax").value = p.t; $("#i-umax").value = p.u; this.cargado = true; }
    if (c.rangos) { $("#i-tmax").min = c.rangos.tMin; $("#i-tmax").max = c.rangos.tMax; $("#i-umax").min = c.rangos.uMin; $("#i-umax").max = c.rangos.uMax;
      pon("t-rango", `Rango permitido: ${c.rangos.tMin}–${c.rangos.tMax} °C y ${c.rangos.uMin}–${c.rangos.uMax} %. Al guardar, el rubro pasa a Personalizado.`); }
    pon("u-ht", `${num(c.histTemp)} °C`); pon("u-hu", `${num(c.histTurb, 0)} %`); pon("u-lc", c.lecturasCambio);
    pon("u-tm", `${num(c.tiempoMinimoS, 0)} s`); pon("u-il", `${num(c.intervaloS, 1)} s`);
    pon("c-limpia", `${num(c.vLimpia, 3)} V`); pon("c-sucia", `${num(c.vSucia, 3)} V`);
    pon("c-volt", S.lectura ? `Ahora ${num(S.lectura.volt, 3)} V` : "");
  },
};

// ---------- Registro ----------
VISTAS.registro = {
  titulo: "Registro",
  html: () => `<div class="panel-cab">
      <div class="pildoras" role="group" aria-label="Tipo">${TIPOS.map((t) => `<button data-tipo="${t}" aria-pressed="${S.filtro === t}">${t}</button>`).join("")}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="search" id="i-buscar" placeholder="Buscar" value="${esc(S.busqueda)}" aria-label="Buscar en el registro">
      <button class="btn btn-borde btn-chico" id="b-marca2" ${S.conectado ? "" : "disabled"}>Agregar marca</button>
      <button class="btn btn-borde btn-chico" id="b-csv2">Descargar CSV</button></div></div>
    <div class="panel"><div class="panel-cab"><h2 id="r-cuenta">Eventos</h2><button class="btn btn-borde btn-chico" id="b-borrar">Borrar de este navegador</button></div>
      <div class="tabla-caja"><table><thead><tr><th>Fecha y hora</th><th>Tipo</th><th>Detalle</th><th>°C</th><th>%</th><th>Origen</th></tr></thead><tbody id="t-eventos"></tbody></table></div></div>
    <p class="tenue" style="margin:0">El registro se arma con los eventos recibidos mientras el panel está abierto y se guarda en este navegador (últimos ${EVENTOS_MAX}).</p>`,
  montar() {
    $$("[data-tipo]").forEach((b) => (b.onclick = () => { S.filtro = b.dataset.tipo; $$("[data-tipo]").forEach((x) => x.setAttribute("aria-pressed", x === b)); this.firma = null; this.update(); }));
    $("#i-buscar").oninput = (e) => { S.busqueda = e.target.value; this.firma = null; this.update(); };
    $("#b-marca2").onclick = agregarMarca;
    $("#b-csv2").onclick = () => descargarCsv("registro.csv", [["fecha_hora", "tipo", "detalle", "temperatura_C", "turbidez_pct", "origen"], ...this.filtrados().map((e) => [fechaHora(e.t), e.tipo, e.detalle, e.temp, e.turb, e.origen])]);
    $("#b-borrar").onclick = async () => { if (await confirmar("¿Borrar el registro?", "Solo se borra de este navegador; los demás dispositivos conservan el suyo.", "Borrar")) { S.eventos = []; guardar(CLAVE.eventos, []); this.firma = null; this.update(); } };
  },
  filtrados() {
    const q = S.busqueda.toLowerCase();
    return S.eventos.filter((e) => (S.filtro === "Todos" || e.tipo === S.filtro || (S.filtro === "Comando" && e.tipo === "Comando rechazado")) && (!q || `${e.tipo} ${e.detalle} ${e.origen}`.toLowerCase().includes(q)));
  },
  update() {
    const firma = `${S.eventos.length}:${S.eventos.at(-1)?.t}`;
    if (this.firma === firma) return;
    this.firma = firma;
    const f = this.filtrados();
    pon("r-cuenta", `${f.length} eventos`);
    const tb = $("#t-eventos");
    if (tb) tb.innerHTML = f.slice(-500).reverse().map((e) => filaEvento(e, false)).join("") || `<tr><td colspan="6" class="vacio">No hay eventos con este filtro.</td></tr>`;
  },
};

// ---------- Diagnóstico ----------
VISTAS.diagnostico = {
  titulo: "Diagnóstico",
  html: () => `<div class="fila">
    <div class="col-1 panel"><h2>Conexión</h2><dl class="datos">
      <dt>Broker (este panel)</dt><dd id="d-broker">—</dd><dt>Usuario</dt><dd>${esc(S.usuario)}</dd><dt>ESP32</dt><dd id="k-esp">—</dd><dt>Última lectura</dt><dd id="k-ult">—</dd>
      <dt>Latencia del comando</dt><dd id="k-lat">—</dd><dt>Red Wi-Fi</dt><dd id="d-ssid">—</dd><dt>Señal</dt><dd id="k-rssi">—</dd>
      <dt>Reconexiones al broker</dt><dd id="d-recon">—</dd><dt>Mensajes enviados / recibidos</dt><dd id="d-msg">—</dd><dt>Hora sincronizada (NTP)</dt><dd id="d-ntp">—</dd></dl>
      <button class="btn btn-borde btn-chico" id="b-ping2" ${sinEsp()}>Medir latencia</button></div>
    <div class="col-1 panel"><h2>Dispositivo</h2><dl class="datos">
      <dt>Firmware</dt><dd id="k-fw">—</dd><dt>Encendido hace</dt><dd id="k-up">—</dd><dt>Último reinicio</dt><dd id="d-reinicio">—</dd>
      <dt>Memoria libre / mínima</dt><dd id="d-heap">—</dd><dt>Watchdog</dt><dd id="d-wdt">—</dd><dt>Relés (pin der. / izq.)</dt><dd id="d-reles">—</dd><dt>Diagnóstico recibido</dt><dd id="d-recib">—</dd></dl></div>
    <div class="col-1 panel"><h2>Sensores y pantalla</h2><dl class="datos">
      <dt>Termocupla (MAX6675)</dt><dd id="d-stemp">—</dd><dt>Sensor de turbidez</dt><dd id="d-sturb">—</dd><dt>Voltaje del sensor</dt><dd id="d-volt">—</dd><dt>Pantalla LCD (I2C)</dt><dd id="d-lcd">—</dd></dl>
      <span class="tenue">Voltaje menor a 0,1 V: cable del sensor suelto. Termocupla sin lectura: revisar el conector del MAX6675.</span></div></div>`,
  montar() { $("#b-ping2").onclick = medirLatencia; },
  update() {
    actualizarConexionCorto();
    const d = S.diag, ok = (v) => (v === "ok" ? "Funciona" : v === "falla" ? "Falla" : "—");
    pon("d-broker", S.conectado ? "Conectado" : "Reconectando…");
    if (!d) return;
    pon("d-ssid", d.ssid || "—"); pon("d-recon", d.reconexiones); pon("d-msg", `${d.enviados} / ${d.recibidos}`); pon("d-ntp", d.ntp ? "Sí" : "No");
    pon("d-reinicio", d.reinicio); pon("d-heap", `${Math.round(d.heap / 1024)} / ${Math.round(d.heapMin / 1024)} kB`);
    pon("d-wdt", `${d.watchdogS} s`); pon("d-reles", `GPIO ${d.releDer} / ${d.releIzq}`); pon("d-recib", `hace ${hace(d.recibido)}`);
    pon("d-stemp", ok(d.sensorTemp)); pon("d-sturb", ok(d.sensorTurb)); pon("d-volt", `${num(d.voltTurb, 3)} V`); pon("d-lcd", ok(d.lcd));
    $("#d-reinicio")?.classList.toggle("c-falla", !!d.reinicioAnormal);
    for (const [id, v] of [["d-stemp", d.sensorTemp], ["d-sturb", d.sensorTurb], ["d-lcd", d.lcd]]) $("#" + id)?.classList.toggle("c-noapta", v === "falla");
  },
};

// ---------- Ajustes (celular: umbrales + diagnóstico) ----------
VISTAS.ajustes = {
  titulo: "Ajustes",
  html: () => `${VISTAS.umbrales.html()}${VISTAS.diagnostico.html()}<button class="btn btn-borde" id="b-salir2">Cerrar sesión</button>`,
  montar() { VISTAS.umbrales.montar.call(VISTAS.umbrales); VISTAS.diagnostico.montar(); $("#b-salir2").onclick = cerrarSesion; },
  update() { VISTAS.umbrales.update.call(VISTAS.umbrales); VISTAS.diagnostico.update(); },
};

// ===================================================================
// 8. NAVEGACIÓN Y ARRANQUE
// ===================================================================
const ICONO = {
  inicio: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  graficas: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  control: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  umbrales: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  registro: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>',
  diagnostico: '<path d="M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const NAV_PC = ["inicio", "graficas", "control", "umbrales", "registro", "diagnostico"];
const NAV_CEL = ["inicio", "graficas", "control", "registro", "ajustes"];
const svgIcono = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONO[k]}</svg>`;
const NOMBRE_NAV = { inicio: "Inicio", graficas: "Gráficas", control: "Control", umbrales: "Umbrales", registro: "Registro", diagnostico: "Diagnóstico", ajustes: "Ajustes" };

let vistaActual = null;
function vistaDesdeHash() {
  let v = location.hash.slice(1) || "inicio";
  if (!VISTAS[v]) v = "inicio";
  if (!esCelular() && v === "ajustes") v = "umbrales";
  if (esCelular() && (v === "umbrales" || v === "diagnostico")) v = "ajustes";
  return v;
}
function navegar() {
  const v = vistaDesdeHash();
  vistaActual = v;
  const vista = VISTAS[v];
  pon("titulo", vista.titulo);
  document.title = `${vista.titulo} — Efluentes PI2`;
  $("#nav-lateral").innerHTML = `<div class="marca-app">Efluentes PI2</div>` + NAV_PC.map((k) => `<a class="nav-item" href="#${k}" ${k === v ? 'aria-current="page"' : ""}>${svgIcono(k)}${NOMBRE_NAV[k]}</a>`).join("") +
    `<div style="flex:1"></div><button class="nav-item btn-borde" style="border:0;background:none" id="b-salir">Cerrar sesión</button>`;
  $("#nav-inferior").innerHTML = NAV_CEL.map((k) => `<a href="#${k}" ${k === v ? 'aria-current="page"' : ""}>${svgIcono(k)}${NOMBRE_NAV[k]}</a>`).join("");
  $("#b-salir").onclick = cerrarSesion;
  $("#vista").innerHTML = vista.html();
  vista.montar?.call(vista);
  vista.firma = null;
  render();
  $("#contenido").scrollTop = 0;
  scrollTo(0, 0);
}

// Repinta como máximo una vez por cuadro aunque lleguen muchos mensajes
let renderPendiente = false;
let ultimoOnline = null;
function programarRender() { if (!renderPendiente) { renderPendiente = true; requestAnimationFrame(() => { renderPendiente = false; render(); }); } }
function render() {
  if (!vistaActual) return;
  const online = espEnLinea();
  // Si cambia la disponibilidad del ESP32, se rehace la vista para habilitar/deshabilitar botones
  if (ultimoOnline !== null && online !== ultimoOnline) { ultimoOnline = online; return navegar(); }
  ultimoOnline = online;

  const chip = (ok, texto) => `<span class="chip"><span class="punto ${ok === null ? "" : ok ? "ok" : "mal"}"></span>${texto}</span>`;
  $("#chips").innerHTML =
    chip(S.conectado, S.conectado ? "Broker" : "Broker: reconectando") +
    chip(online, online ? "ESP32 en línea" : S.espConexion === "desconectado" ? "ESP32 desconectado" : "ESP32 sin datos") +
    (S.latencia !== null && online ? chip(null, `${S.latencia} ms`) : "") +
    (S.config ? `<span class="chip solo-pc">${esc(S.config.rubros?.find((r) => r.id === S.config.rubro)?.nombre ?? S.config.rubro)}</span>` : "");

  const av = $("#aviso-conexion");
  if (!S.conectado) { av.textContent = "Sin conexión con el broker. Reintentando cada 3 s; revisa el internet de este dispositivo."; av.classList.remove("oculto"); }
  else if (!online) {
    av.textContent = S.ultimaLectura
      ? `El ESP32 no envía datos desde las ${hora(S.ultimaLectura, false)}. Los botones se activan cuando vuelva.`
      : "Esperando datos del ESP32. Revisa que esté encendido y conectado al hotspot.";
    av.classList.remove("oculto");
  } else av.classList.add("oculto");

  VISTAS[vistaActual].update.call(VISTAS[vistaActual]);
}

function mostrarApp() {
  $("#acceso").classList.add("oculto");
  $("#app").classList.remove("oculto");
  navegar();
}
function errorAcceso(msg) {
  $("#acceso").classList.remove("oculto");
  $("#app").classList.add("oculto");
  const e = $("#acc-error"); e.textContent = msg; e.classList.remove("oculto");
  $("#form-acceso button").disabled = false;
}

window.addEventListener("hashchange", navegar);
let eraCelular = esCelular();
window.addEventListener("resize", () => { if (esCelular() !== eraCelular) { eraCelular = esCelular(); if (vistaActual) navegar(); } });
setInterval(() => { if (minutoActual && Math.floor(Date.now() / 60e3) * 60e3 !== minutoActual.t) cerrarMinuto(); render(); }, 1000);
setInterval(medirLatencia, 15000);
window.addEventListener("beforeunload", () => guardar(CLAVE.minutos, S.minutos));

$("#form-acceso").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#acc-error").classList.add("oculto");
  e.submitter && (e.submitter.disabled = true);
  conectar($("#acc-usuario").value.trim(), $("#acc-clave").value, $("#acc-recordar").checked);
});

(() => {
  const c = leer(CLAVE.cred, null) ?? (() => { try { return JSON.parse(sessionStorage.getItem(CLAVE.cred)); } catch { return null; } })();
  if (c?.u) { $("#acc-usuario").value = c.u; conectar(c.u, c.c, !!localStorage.getItem(CLAVE.cred)); }
})();
