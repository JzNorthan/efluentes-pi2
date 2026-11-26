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
function guardar(clave, valor) { if (S.sim && clave !== "pi2.suavizar" && clave !== "pi2.tema" && clave !== CLAVE.rango) return; try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* lleno o bloqueado */ } }

const espEnLinea = () => S.sim || S.conectado && S.espConexion !== "desconectado" && Date.now() - S.ultimaLectura < CONFIG.sinDatosS * 1000;

// Acumulador del minuto en curso
let minutoActual = null;
function acumularMinuto(p) {
  const m = Math.floor(p.t / 60e3) * 60e3;
  if (minutoActual && minutoActual.t !== m) cerrarMinuto();
  if (!minutoActual) minutoActual = { t: m, n: 0, sT: 0, nT: 0, tMin: Infinity, tMax: -Infinity, sU: 0, uMin: Infinity, uMax: -Infinity };
  const a = minutoActual;
  a.n++; if (p.turb !== null) { a.nU = (a.nU || 0) + 1; a.sU += p.turb; a.uMin = Math.min(a.uMin, p.turb); a.uMax = Math.max(a.uMax, p.turb); }
  if (p.temp !== null) { a.nT++; a.sT += p.temp; a.tMin = Math.min(a.tMin, p.temp); a.tMax = Math.max(a.tMax, p.temp); }
}
function cerrarMinuto() {
  const a = minutoActual; minutoActual = null;
  if (!a || !a.n) return;
  S.minutos.push({
    t: a.t, temp: a.nT ? +(a.sT / a.nT).toFixed(2) : null,
    tMin: a.nT ? a.tMin : null, tMax: a.nT ? a.tMax : null,
    turb: a.nU ? +(a.sU / a.nU).toFixed(1) : null, uMin: a.nU ? a.uMin : null, uMax: a.nU ? a.uMax : null,
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
  if (S.sim) { location.hash = ""; return location.reload(); }
  localStorage.removeItem(CLAVE.cred);
  sessionStorage.removeItem(CLAVE.cred);
  if (S.cliente) S.cliente.end(true);
  location.hash = "";
  location.reload();
}

function publicar(sub, obj, retenido = false) {
  if (S.sim) { if (sub === "marcas") simEmitir("marcas", obj); return true; }
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
      const sinTurb = d.volt !== undefined && d.volt !== null && d.volt < 0.1;   // cable del sensor suelto
      const p = { t: ahora, temp: d.temp ?? null, turb: sinTurb ? null : d.turb ?? null, volt: d.volt ?? 0, e: S.estado?.estado };
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
      if (S.actualizando && /Actualizacion fallida/.test(d.detalle || "")) { S.actualizando = null; aviso(d.detalle, "error"); }
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
  if (S.sim) return new Promise((ok) => setTimeout(() => { const r = simComando(cmd); if (!silencioso) aviso(r.detalle, r.ok ? "ok" : "error"); ok({ ...r, ms: 40 + Math.round(Math.random() * 30) }); }, 60));
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
// 6. GRÁFICAS (ECharts, animadas)
// ===================================================================
// Cada gráfica se crea una vez por vista y luego solo se actualizan
// sus datos: la línea avanza de forma continua en lugar de redibujarse.
// El eje Y cambia solo cuando los datos salen del rango (no "salta").
const GRAF = new Map();   // id del contenedor -> { caja, chart, lo, hi }
S.suavizar = leer("pi2.suavizar", true);

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function paleta() {
  return { agua: cssVar("--agua"), apta: cssVar("--apta"), noapta: cssVar("--noapta"), falla: cssVar("--falla"),
    texto: cssVar("--texto"), tenue: cssVar("--tenue"), linea: cssVar("--linea"), sup2: cssVar("--sup-2") };
}
function conAlfa(hex, a) {
  const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function liberarGraficas() { GRAF.forEach((g) => g.chart.isDisposed() || g.chart.dispose()); GRAF.clear(); }
window.addEventListener("resize", () => GRAF.forEach((g) => g.chart.isDisposed() || g.chart.resize()));

/** Puntos de un rango: minutos guardados + lecturas crudas más recientes. */
function puntosRango(desde) {
  const crudoDesde = S.raw.length ? S.raw[0].t : Infinity;
  const largo = Date.now() - desde > RAW_MAX_MS * 0.99;
  const res = [];
  for (const m of S.minutos) if (m.t >= desde && (largo || m.t < crudoDesde)) res.push(m);
  if (!largo) { for (const p of S.raw) if (p.t >= desde) res.push(p); }
  else if (minutoActual && minutoActual.n) res.push({ t: minutoActual.t, temp: minutoActual.nT ? minutoActual.sT / minutoActual.nT : null, turb: minutoActual.nU ? minutoActual.sU / minutoActual.nU : null });
  if (res.length <= 1500) return res;
  const paso = Math.ceil(res.length / 1500), red = [];
  for (let i = 0; i < res.length; i += paso) {
    const g = res.slice(i, i + paso), tv = g.filter((p) => p.temp !== null), uv = g.filter((p) => p.turb !== null);
    red.push({ t: g[0].t, temp: tv.length ? tv.reduce((s, p) => s + p.temp, 0) / tv.length : null, turb: uv.length ? uv.reduce((s, p) => s + p.turb, 0) / uv.length : null, e: g.at(-1).e });
  }
  return red;
}

/** Serie [t, v]. Con "suavizar", media móvil de 5 lecturas (solo para ver; el ESP32 decide con el dato real). */
function serie(puntos, campo, suave = S.suavizar) {
  const out = [], cola = [];
  let prev = null;
  for (const p of puntos) {
    const v = p[campo];
    if (v === null || v === undefined || (prev && p.t - prev > 4000 && p.t - prev > (puntos.at(-1).t - puntos[0].t) / 60)) {
      cola.length = 0; out.push([p.t, null]);
      if (v === null || v === undefined) { prev = p.t; continue; }
    }
    prev = p.t;
    if (!suave) { out.push([p.t, v]); continue; }
    cola.push(v); if (cola.length > 5) cola.shift();
    out.push([p.t, cola.reduce((a, b) => a + b, 0) / cola.length]);
  }
  return out;
}

function escalaPaso(rango, n) {
  const bruto = rango / n, p = 10 ** Math.floor(Math.log10(bruto)), f = bruto / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function rangoEstable(g, vals, umbral, minY, maxY) {
  let lo = Math.min(minY, ...vals, umbral ?? Infinity), hi = Math.max(maxY, ...vals, umbral ?? -Infinity);
  const paso = escalaPaso(Math.max(hi - lo, 1), 4);
  lo = Math.floor(lo / paso) * paso; hi = Math.ceil((hi + paso * 0.25) / paso) * paso;
  if (minY >= 0) lo = Math.max(0, lo);
  if (g.lo !== null && g.lo <= lo && g.hi >= hi && g.hi - g.lo <= (hi - lo) * 1.8) return [g.lo, g.hi];
  g.lo = lo; g.hi = hi;
  return [lo, hi];
}
/** Tramos en NO APTO o FALLA, según el estado que tenía el ESP32 en cada lectura. */
function tramos(puntos, hasta) {
  const res = [];
  let ini = null, est = null;
  for (const p of puntos) {
    if (p.e === undefined) continue;
    if (p.e !== est) { if (est === "NO_APTO" || est === "FALLA") res.push([ini, p.t, est]); est = p.e; ini = p.t; }
  }
  if (est === "NO_APTO" || est === "FALLA") res.push([ini, hasta, est]);
  return res;
}
const fmtEje = (rango) => (v) => (rango > 2 * 86400e3 ? fecha(v) : hora(v, rango < 10 * 60e3));

/**
 * Dibuja o actualiza una gráfica. campo: "temp" | "turb".
 * mini: sin ejes (tarjetas). color: por defecto el del agua.
 */
function dibujar(id, o) {
  const caja = document.getElementById(id);
  if (!caja || typeof echarts === "undefined") return;
  let g = GRAF.get(id);
  if (!g || g.caja !== caja || g.chart.isDisposed()) {
    g?.chart.isDisposed() === false && g.chart.dispose();
    g = { caja, chart: echarts.init(caja, null, { renderer: "canvas" }), lo: null, hi: null };
    GRAF.set(id, g);
  }
  const c = paleta(), color = o.color || c.agua, dec = o.campo === "temp" ? 1 : 0;
  const datos = serie(o.puntos, o.campo, o.mini ? true : S.suavizar);
  const vals = datos.map((d) => d[1]).filter((v) => v !== null);
  const [lo, hi] = rangoEstable(g, vals, o.mini ? null : o.umbral, o.minY, o.maxY);
  const ultimo = [...datos].reverse().find((d) => d[1] !== null);
  const enVivo = espEnLinea() && ultimo && Date.now() - ultimo[0] < 5000;
  const lineas = [];
  if (o.umbral !== null && o.umbral !== undefined && (!o.mini || (o.umbral >= lo && o.umbral <= hi))) lineas.push({ yAxis: o.umbral, label: { formatter: o.mini ? "" : `Límite ${num(o.umbral, 0)} ${o.unidad}` } });
  if (!o.mini) for (const ev of S.eventos) if (ev.tipo === "Marca" && ev.t >= o.desde && ev.t <= o.hasta)
    lineas.push({ xAxis: ev.t, lineStyle: { color: c.falla, type: "solid", width: 1 }, label: { formatter: ev.detalle, color: c.falla, position: "insideEndTop", fontSize: 11 } });

  g.chart.setOption({
    animation: true, animationDuration: 500, animationDurationUpdate: o.mini ? 600 : 950, animationEasingUpdate: "linear",
    textStyle: { fontFamily: "IBM Plex Sans, system-ui, sans-serif" },
    grid: o.mini ? { left: 2, right: 6, top: 4, bottom: 2 } : { left: 40, right: 16, top: 14, bottom: 24 },
    tooltip: o.mini ? { show: false } : {
      trigger: "axis", backgroundColor: c.sup2, borderColor: c.linea, textStyle: { color: c.texto, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: c.tenue, type: "dashed" } },
      formatter: (ps) => { const p = ps.find((x) => x.seriesIndex === 0); return p ? `<div style="opacity:.7">${fechaHora(p.value[0])}</div><b>${num(p.value[1], dec)} ${o.unidad}</b>${S.suavizar ? '<div style="opacity:.6;font-size:11px">media de 5 lecturas</div>' : ""}` : ""; },
    },
    xAxis: { type: "time", min: o.desde, max: o.hasta, show: !o.mini, axisLine: { lineStyle: { color: c.linea } }, axisTick: { show: false },
      axisLabel: { color: c.tenue, fontSize: 11, hideOverlap: true, formatter: fmtEje(o.hasta - o.desde) }, splitLine: { show: false } },
    yAxis: { type: "value", min: lo, max: hi, show: !o.mini, splitNumber: 4, axisLabel: { color: c.tenue, fontSize: 11 },
      splitLine: { lineStyle: { color: c.linea, type: [3, 4] } } },
    series: [
      { type: "line", data: datos, smooth: 0.45, smoothMonotone: "x", showSymbol: false, connectNulls: false, sampling: "lttb",
        lineStyle: { width: o.mini ? 1.6 : 2.2, color }, itemStyle: { color },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: conAlfa(color, o.mini ? 0.22 : 0.26) }, { offset: 1, color: conAlfa(color, 0) }]) },
        markLine: { silent: true, symbol: "none", animation: false, data: lineas,
          lineStyle: { color: c.noapta, type: [6, 4], width: 1.4 }, label: { color: c.noapta, position: "insideEndTop", fontSize: 11 } },
        markArea: { silent: true, data: o.mini ? [] : tramos(o.puntos, o.hasta).map(([a, b, e]) => [{ xAxis: a, itemStyle: { color: conAlfa(e === "FALLA" ? c.falla : c.noapta, 0.12) } }, { xAxis: b }]) },
      },
      { type: "effectScatter", data: enVivo && !o.mini ? [ultimo] : [], symbolSize: 7, rippleEffect: { scale: 3, brushType: "stroke" },
        itemStyle: { color }, silent: true, z: 5 },
    ],
  });
}

function resumen(puntos, campo) {
  const v = puntos.map((p) => p[campo]).filter((x) => x !== null && x !== undefined);
  if (!v.length) return { min: null, max: null, prom: null };
  return { min: Math.min(...v), max: Math.max(...v), prom: v.reduce((a, b) => a + b, 0) / v.length };
}

/** Número que llega al nuevo valor en 0,7 s en lugar de saltar. */
function animarNum(id, valor, dec) {
  const el = document.getElementById(id);
  if (!el) return;
  if (valor === null || valor === undefined || Number.isNaN(valor)) { el._v = null; el.textContent = "—"; return; }
  if (el._v === valor) return;
  const de = el._v ?? valor, t0 = performance.now(), dur = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700;
  el._v = valor;
  cancelAnimationFrame(el._raf);
  const paso = (t) => {
    const k = dur ? Math.min(1, (t - t0) / dur) : 1, e = 1 - (1 - k) ** 3;
    el.textContent = (de + (valor - de) * e).toFixed(dec);
    if (k < 1) el._raf = requestAnimationFrame(paso);
  };
  el._raf = requestAnimationFrame(paso);
}

/** Barra de estados en el tiempo (como "state timeline" de Grafana). */
function lineaTiempo(id, desde, hasta) {
  const caja = document.getElementById(id);
  if (!caja) return;
  const pts = S.raw.filter((p) => p.t >= desde && p.e !== undefined), tot = hasta - desde, seg = [];
  let ini = desde, est = "x", prev = null;
  for (const p of pts) {
    if (prev && p.t - prev > 5000) { seg.push([ini, prev, est]); ini = prev; est = "x"; }
    if (p.e !== est) { seg.push([ini, p.t, est]); ini = p.t; est = p.e; }
    prev = p.t;
  }
  seg.push([ini, prev && Date.now() - prev < 5000 ? hasta : (prev ?? hasta), est]);
  if (prev && Date.now() - prev >= 5000) seg.push([prev, hasta, "x"]);
  const html = seg.filter(([a, b]) => b > a).map(([a, b, e]) => `<span class="lt-${e}" style="width:${((b - a) / tot) * 100}%" title="${TXT_ESTADO[e] ?? "Sin datos"} · ${hora(a)}–${hora(b)}"></span>`).join("");
  caja.innerHTML = html;
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
/** "hoy 20:58", "ayer 20:58" o "24/11 20:58". */
function cuando(ms) {
  if (!ms) return "—";
  const d = new Date(ms), hoy = new Date(), ayer = new Date(Date.now() - 86400e3);
  const mismoDia = (x, y) => x.toDateString() === y.toDateString();
  return `${mismoDia(d, hoy) ? "hoy" : mismoDia(d, ayer) ? "ayer" : fecha(ms)} ${hora(ms, false)}`;
}
/** Último momento en que se supo algo del ESP32 (lectura en vivo o mensaje retenido). */
function ultimoDato() {
  return Math.max(S.ultimaLectura || 0, (S.estado?.t || 0) * 1000, (S.diag?.t || 0) * 1000, S.diag?.recibido && S.ultimaLectura ? S.diag.recibido : 0);
}
const COLOR_ESTADO = { APTO: "apta", NO_APTO: "noapta", FALLA: "falla" };

/** Esquema hidráulico del prototipo (concepto C): entrada, sensores, T y dos válvulas. */
function esquemaSvg() {
  const valv = (x, id, tag) => `<g class="esq-valv" id="${id}" transform="translate(${x} 178)">
      <line x1="0" y1="0" x2="0" y2="-26" stroke="var(--linea-fuerte)" stroke-width="2"/>
      <rect x="-10" y="-40" width="20" height="15" rx="3"/>
      <path d="M-17 -12 L0 0 L-17 12 Z M17 -12 L0 0 L17 12 Z"/>
      <text class="esq-tag" x="0" y="32" text-anchor="middle">${tag}</text></g>`;
  return `<svg viewBox="0 0 600 300" role="img" aria-labelledby="esq-tit">
    <title id="esq-tit">Esquema del prototipo: el agua entra, se mide y sale por la válvula derecha (descarga) o izquierda (retención)</title>
    <path class="esq-borde" d="M300 14 V178 M300 178 H70 V246 M300 178 H530 V246"/>
    <path class="esq-tubo" d="M300 14 V178 M300 178 H70 V246 M300 178 H530 V246"/>
    <path class="esq-flujo" id="fl-in" d="M300 14 V178" stroke="var(--agua)"/>
    <path class="esq-flujo" id="fl-izq" d="M300 178 H70 V246" stroke="var(--noapta)"/>
    <path class="esq-flujo" id="fl-der" d="M300 178 H530 V246" stroke="var(--apta)"/>
    <path class="esq-senal" d="M222 50 V36 H438 M150 138 V36 H222 M372 96 V82 H476 V68 M520 68 V146 H460"/>
    <g class="esq-burbuja" id="b-tt"><line x1="244" y1="70" x2="292" y2="70" stroke="var(--linea-fuerte)" stroke-width="1.5"/>
      <circle cx="222" cy="70" r="20"/><text class="esq-tag" x="222" y="74" text-anchor="middle">TT</text>
      <text class="esq-lectura" x="226" y="114" text-anchor="middle" id="e-temp">—</text><text class="esq-chico" x="226" y="129" text-anchor="middle">temperatura</text></g>
    <g class="esq-burbuja" id="b-at"><line x1="308" y1="116" x2="350" y2="116" stroke="var(--linea-fuerte)" stroke-width="1.5"/>
      <circle cx="372" cy="116" r="20"/><text class="esq-tag" x="372" y="120" text-anchor="middle">AT</text>
      <text class="esq-lectura" x="400" y="122" id="e-turb">—</text><text class="esq-chico" x="400" y="138">turbidez</text></g>
    <g class="esq-ctrl"><rect x="438" y="20" width="120" height="48" rx="8"/>
      <text class="esq-rot" x="498" y="41" text-anchor="middle" style="font-weight:600">ESP32</text>
      <text class="esq-chico" x="498" y="57" text-anchor="middle" id="e-modo">control</text></g>
    ${valv(150, "e-valv-izq", "V-IZQ")}${valv(450, "e-valv-der", "V-DER")}
    <g class="esq-tanque" id="t-izq"><rect x="22" y="244" width="96" height="44" rx="6"/><rect class="nivel" x="24" y="268" width="92" height="18" rx="4" fill="var(--noapta)"/>
      <text class="esq-rot" x="70" y="262" text-anchor="middle">Retención</text></g>
    <g class="esq-tanque" id="t-der"><rect x="482" y="244" width="96" height="44" rx="6"/><rect class="nivel" x="484" y="268" width="92" height="18" rx="4" fill="var(--apta)"/>
      <text class="esq-rot" x="530" y="262" text-anchor="middle">Descarga</text></g>
    <text class="esq-chico" x="312" y="26">entrada del efluente</text>
  </svg>`;
}

function actualizarEsquema() {
  const est = S.estado, v = est?.valvula, l = S.lectura, c = S.config, vivo = espEnLinea();
  const abiertaIzq = vivo && v === "IZQ", abiertaDer = vivo && v === "DER";
  $("#fl-in")?.classList.toggle("on", abiertaIzq || abiertaDer);
  $("#fl-izq")?.classList.toggle("on", abiertaIzq);
  $("#fl-der")?.classList.toggle("on", abiertaDer);
  $("#t-izq")?.classList.toggle("on", abiertaIzq);
  $("#t-der")?.classList.toggle("on", abiertaDer);
  const pinta = (id, abierta, color) => { const g = $(id); if (!g) return; g.classList.toggle("abierta", abierta); $$("path", g).forEach((p) => (p.style.fill = abierta ? color : "")); };
  pinta("#e-valv-izq", v === "IZQ", "var(--noapta)");
  pinta("#e-valv-der", v === "DER", "var(--apta)");
  pon("e-temp", l?.temp !== null && l?.temp !== undefined ? `${num(l.temp, 1)} °C` : l ? "sin dato" : "—");
  pon("e-turb", l ? (l.turb === null ? "sin dato" : `${num(l.turb, 0)} %`) : "—");
  $("#b-tt")?.classList.toggle("alto", !!(c && l?.temp > c.tempMax));
  $("#b-at")?.classList.toggle("alto", !!(c && l?.turb > c.turbMax));
  pon("e-modo", est ? (est.modo === "MANUAL" ? "modo manual" : "modo automático") : "sin datos");
}

function bloqueIndicadores() {
  return `<section class="hero vivo" id="hero">
      <div class="esquema">${esquemaSvg()}</div>
      <div class="estado-caja" aria-live="polite">
        <div style="display:flex;flex-direction:column;gap:8px">
          <span class="estado-rot" id="v-rot">Estado del agua</span>
          <span class="estado-grande" id="v-estado">—</span>
          <span class="estado-motivo" id="v-motivo"></span>
        </div>
        <dl class="estado-meta" id="v-meta"></dl>
      </div>
    </section>
    <div class="metricas">
      <div class="metrica vivo"><div class="metrica-cab"><span class="rot">Temperatura</span><span class="tendencia" id="d-temp"></span></div>
        <span class="valor"><span id="v-temp">—</span><small>°C</small></span>
        <div class="medidor" aria-hidden="true"><span class="zona" id="z-temp"></span><span class="relleno" id="r-temp"></span><span class="limite" id="l-temp"></span></div>
        <div class="mini-graf" id="g-mini-temp"></div>
        <span class="pie" id="v-temp-lim"></span></div>
      <div class="metrica vivo"><div class="metrica-cab"><span class="rot">Turbidez</span><span class="tendencia" id="d-turb"></span></div>
        <span class="valor"><span id="v-turb">—</span><small>%</small></span>
        <div class="medidor" aria-hidden="true"><span class="zona" id="z-turb"></span><span class="relleno" id="r-turb"></span><span class="limite" id="l-turb"></span></div>
        <div class="mini-graf" id="g-mini-turb"></div>
        <span class="pie" id="v-turb-lim"></span></div>
      <div class="metrica vivo"><div class="metrica-cab"><span class="rot">Válvulas</span><span class="pie" id="v-modo-corto"></span></div>
        <div class="valvulas-caja">
          <div class="valvula" id="valv-der"><span class="rot">Derecha · descarga</span><span class="valv-estado" id="v-der">—</span></div>
          <div class="valvula" id="valv-izq"><span class="rot">Izquierda · retención</span><span class="valv-estado" id="v-izq">—</span></div>
        </div>
        <span class="pie" id="v-valv-info"></span>
        <span class="pie">Nunca se abren las dos a la vez; ante una falla se cierran ambas.</span>
      </div>
    </div>`;
}

/** Medidor horizontal de 0 a escala, con la zona sobre el límite rayada. */
function medidor(sufijo, valor, limite, escala) {
  const r = document.getElementById("r-" + sufijo), l = document.getElementById("l-" + sufijo), z = document.getElementById("z-" + sufijo);
  if (!r) return;
  const pc = (v) => `${Math.max(0, Math.min(100, (v / escala) * 100))}%`;
  r.style.width = valor === null || valor === undefined ? "0%" : pc(valor);
  r.classList.toggle("alto", valor !== null && valor !== undefined && limite !== undefined && valor > limite);
  if (limite !== undefined) { l.style.left = pc(limite); z.style.left = pc(limite); }
}

/** Cambio en los últimos 30 s, para la flecha de tendencia. */
function tendencia(id, campo, dec, unidad) {
  const el = document.getElementById(id);
  if (!el) return;
  const ahora = S.raw.at(-1), antes = S.raw.find((p) => p.t >= Date.now() - 30e3);
  if (!ahora || !antes || ahora[campo] === null || antes[campo] === null || ahora.t - antes.t < 10e3) { el.textContent = ""; return; }
  const d = ahora[campo] - antes[campo], umbral = campo === "temp" ? 0.3 : 2;
  el.className = "tendencia" + (d > umbral ? " sube" : d < -umbral ? " baja" : "");
  el.textContent = Math.abs(d) <= umbral ? "estable" : `${d > 0 ? "↑" : "↓"} ${num(Math.abs(d), dec)} ${unidad} en 30 s`;
}

function actualizarIndicadores() {
  const enLinea = espEnLinea(), e = textoEstado(), c = S.config, l = S.lectura, est = S.estado;
  const hero = $("#hero");
  if (!hero) return;
  const ult = ultimoDato();
  if (!enLinea && est) {
    hero.className = "hero vivo sin-conexion";
    pon("v-rot", S.conectado ? "ESP32 desconectado" : "Panel sin internet");
    pon("v-estado", "Sin conexión");
    pon("v-motivo", `Último estado conocido: ${e.txt}${ult ? ", " + cuando(ult) : ""}. Los datos no están en vivo.`);
  } else {
    hero.className = `hero vivo ${COLOR_ESTADO[est?.estado] ?? "neutro"}`;
    pon("v-rot", S.sim ? "Estado del agua · simulación" : "Estado del agua");
    pon("v-estado", e.txt);
    pon("v-motivo", e.motivo + (est?.silenciada ? " · alarma silenciada" : ""));
  }
  const meta = $("#v-meta");
  if (meta && est) {
    const abierta = est.valvula === "DER" ? "Derecha" : est.valvula === "IZQ" ? "Izquierda" : "Ninguna";
    const html = `<div><dt>Modo</dt><dd>${est.modo === "MANUAL" ? "Manual" : "Automático"}</dd></div>
      <div><dt>En este estado desde</dt><dd>${est.desde ? cuando(est.desde * 1000) : "—"}</dd></div>
      <div><dt>Válvula abierta</dt><dd>${abierta}</dd></div>
      <div><dt>Rubro</dt><dd>${esc(c?.rubros?.find((r) => r.id === c.rubro)?.nombre ?? "—")}</dd></div>`;
    if (meta.dataset.h !== html) { meta.dataset.h = html; meta.innerHTML = html; }
  }
  animarNum("v-temp", l?.temp ?? null, 1);
  animarNum("v-turb", l?.turb ?? null, 0);
  pon("v-temp-lim", c ? `Límite ${num(c.tempMax, 0)} °C · termocupla K` : "");
  pon("v-turb-lim", c ? `Límite ${num(c.turbMax, 0)} % · sensor a ${num(l?.volt, 2)} V` : "");
  medidor("temp", l?.temp, c?.tempMax, 60);
  medidor("turb", l?.turb, c?.turbMax, 100);
  tendencia("d-temp", "temp", 1, "°C");
  tendencia("d-turb", "turb", 0, "%");
  const v = est?.valvula;
  for (const [id, lado] of [["der", "DER"], ["izq", "IZQ"]]) {
    $("#valv-" + id)?.classList.toggle("abierta", v === lado);
    pon("v-" + id, est ? (v === lado ? "Abierta" : "Cerrada") : "—");
  }
  pon("v-modo-corto", est ? (est.modo === "MANUAL" ? "manual" : "automático") : "");
  pon("v-valv-info", est ? `${est.cambiosValvula ?? 0} cambios${est.valvulaDesde ? " · último " + cuando(est.valvulaDesde * 1000) : ""}${est.reles === false ? " · relés deshabilitados" : ""}` : "");
  actualizarEsquema();
  const hasta = Date.now(), desde = hasta - 2 * 60e3, pts = S.raw.filter((p) => p.t >= desde);
  dibujar("g-mini-temp", { puntos: pts, campo: "temp", desde, hasta, umbral: c?.tempMax, unidad: "°C", minY: 20, maxY: 30, mini: true });
  dibujar("g-mini-turb", { puntos: pts, campo: "turb", desde, hasta, umbral: c?.turbMax, unidad: "%", minY: 0, maxY: 20, mini: true });
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
  return `<div class="panel vivo"><div class="panel-cab"><h2>Sesión</h2><span class="tenue num" id="s-dur"></span></div>
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
  if (rep) rep.innerHTML = [[t.apta, "var(--apta)"], [t.noApta, "var(--noapta)"], [t.falla, "var(--falla)"]].map(([v, c]) => `<span style="width:${(v * 100) / tot}%;background:${c}"></span>`).join("");
  pon("s-apta", `${duracion(t.apta)} · ${pc(t.apta)}`); pon("s-noapta", `${duracion(t.noApta)} · ${pc(t.noApta)}`); pon("s-falla", `${duracion(t.falla)} · ${pc(t.falla)}`);
  pon("s-veces", s.vecesNoApta); pon("s-causas", `${s.noAptaTurb} / ${s.noAptaTemp} / ${s.noAptaAmbos}`);
  pon("s-temp", s.tempMin !== undefined ? `${num(s.tempMin)} / ${num(s.tempMax)} °C` : "—");
  pon("s-turb", s.turbMin !== undefined ? `${num(s.turbMin, 0)} / ${num(s.turbMax, 0)} %` : "—");
  pon("s-lect", s.lecturas);
}

function filaEvento(ev, corta) {
  const d = ev.detalle ?? "";
  const cls = /a NO_APTO|rechazado/.test(d) || ev.tipo === "Comando rechazado" ? "noapta" : /a FALLA/.test(d) || ev.tipo === "Marca" ? "falla" : /a APTO/.test(d) ? "apta" : "";
  const txt = d.replace(/\bFALLA_TURB\b/g, "sensor de turbidez").replace(/\bFALLA_TEMP\b/g, "termocupla").replace(/, COMANDO\b/g, ", por comando")
    .replace(/\bTURBIDEZ\b/g, "turbidez").replace(/\bTEMPERATURA\b/g, "temperatura").replace(/\bAMBOS\b/g, "turbidez y temperatura")
    .replace(/\bNO_APTO\b/g, "NO APTA").replace(/\bAPTO\b/g, "APTA");
  if (corta) return `<li class="${cls ? "ev-" + cls : ""}" data-t="${ev.t}"><span class="tenue num">${hora(ev.t)}</span><span class="${cls ? "c-" + cls.replace("noapta", "noapta") : ""}">${esc(txt)}</span><span class="tenue">${esc(ev.origen)}</span></li>`;
  return `<tr><td class="tenue">${fechaHora(ev.t)}</td><td>${esc(ev.tipo)}</td><td class="${cls ? "c-" + cls : ""}">${esc(txt)}</td><td>${num(ev.temp)}</td><td>${num(ev.turb, 0)}</td><td class="tenue">${esc(ev.origen)}</td></tr>`;
}

/** Lista corta de eventos; resalta los que llegaron recién. */
function listaEventos(id, n) {
  const ul = document.getElementById(id);
  if (!ul) return;
  const firma = `${S.eventos.length}:${S.eventos.at(-1)?.t}`;
  if (ul.dataset.firma === firma) return;
  const ultimoVisto = +(ul.dataset.ultimo || 0);
  ul.dataset.firma = firma;
  ul.innerHTML = S.eventos.slice(-n).reverse().map((e) => filaEvento(e, true)).join("") || `<li class="vacio">Aún no hay eventos en este navegador.</li>`;
  if (ultimoVisto) $$("li[data-t]", ul).forEach((li) => +li.dataset.t > ultimoVisto && li.classList.add("nuevo"));
  ul.dataset.ultimo = S.eventos.at(-1)?.t ?? 0;
}

// ---------- Centro de control ----------
const VISTAS = {};
VISTAS.inicio = {
  titulo: "Centro de control",
  html: () => `${bloqueIndicadores()}
    <div class="fila">
      <div class="col-2 panel vivo">
        <div class="panel-cab"><h2>Últimos 15 minutos</h2>
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <label class="interruptor"><input type="checkbox" id="sw-suave" ${S.suavizar ? "checked" : ""}> Suavizar</label>
            <a href="#graficas">Ver gráficas</a></div></div>
        <div class="graf-cab"><h3>Temperatura (°C)</h3></div><div class="graf" id="g-inicio-temp"></div>
        <div class="graf-cab"><h3>Turbidez (%)</h3></div><div class="graf" id="g-inicio-turb"></div>
        <div><div class="graf-cab" style="margin-bottom:6px"><h3>Estado en el tiempo</h3>
          <div class="leyenda"><span><i class="lt-APTO"></i>Apta</span><span><i class="lt-NO_APTO"></i>No apta</span><span><i class="lt-FALLA"></i>Falla</span></div></div>
          <div class="linea-tiempo" id="lt-inicio"></div><div class="lt-eje"><span>hace 15 min</span><span>ahora</span></div></div>
      </div>
      <div class="col-1 columna">
        ${S.sim ? bloqueSim() : ""}
        ${bloqueModo()}
        <div class="panel" style="flex:1"><div class="panel-cab"><h2>Eventos en vivo</h2><a href="#registro">Ver registro</a></div><ul class="lista" id="ev-inicio"></ul></div>
      </div>
    </div>
    <div class="fila"><div class="col-1">${bloqueSesion()}</div><div class="col-1">${bloqueConexionCorto()}</div></div>`,
  montar() { $("#sw-suave").onchange = (e) => { S.suavizar = e.target.checked; guardar("pi2.suavizar", S.suavizar); render(); }; },
  update() {
    actualizarIndicadores(); actualizarSesion(); actualizarConexionCorto(); actualizarSim();
    pon("v-modo", S.estado ? (S.estado.modo === "MANUAL" ? "Manual" : "Automático") : "");
    const hasta = Date.now(), desde = hasta - 15 * 60e3, pts = puntosRango(desde);
    dibujar("g-inicio-temp", { puntos: pts, campo: "temp", desde, hasta, umbral: S.config?.tempMax, unidad: "°C", minY: 20, maxY: 30 });
    dibujar("g-inicio-turb", { puntos: pts, campo: "turb", desde, hasta, umbral: S.config?.turbMax, unidad: "%", minY: 0, maxY: 40 });
    lineaTiempo("lt-inicio", desde, hasta);
    listaEventos("ev-inicio", 8);
  },
};
function bloqueConexionCorto() {
  return `<div class="panel"><div class="panel-cab"><h2>Conexión</h2><a href="#diagnostico" class="solo-pc">Diagnóstico</a></div>
    <dl class="datos"><dt>ESP32</dt><dd id="k-esp">—</dd><dt>Última lectura</dt><dd id="k-ult">—</dd><dt>Latencia del comando</dt><dd id="k-lat">—</dd>
    <dt>Señal Wi-Fi</dt><dd id="k-rssi">—</dd><dt>Encendido hace</dt><dd id="k-up">—</dd><dt>Firmware</dt><dd id="k-fw">—</dd></dl></div>`;
}
function calidadRssi(r) { return r === undefined || r === null ? "—" : `${r} dBm · ${r > -60 ? "buena" : r > -72 ? "regular" : "débil"}`; }
function actualizarConexionCorto() {
  pon("k-esp", espEnLinea() ? "En línea" : S.espConexion === "desconectado" ? "Desconectado" : "Sin datos");
  pon("k-ult", espEnLinea() ? `hace ${hace(S.ultimaLectura)}` : cuando(ultimoDato()));
  pon("k-lat", S.latencia !== null ? `${S.latencia} ms` : "—");
  pon("k-rssi", calidadRssi(S.diag?.rssi));
  pon("k-up", S.diag && espEnLinea() ? duracion(S.diag.uptimeS + (Date.now() - S.diag.recibido) / 1000) : "—");
  pon("k-fw", S.diag?.fw ?? "—");
}

// ---------- Gráficas ----------
VISTAS.graficas = {
  titulo: "Gráficas",
  html: () => `<div class="panel-cab">
      <div class="pildoras" role="group" aria-label="Rango de tiempo">${RANGOS.map(([ms, t]) => `<button data-rango="${ms}" aria-pressed="${S.rango === ms}">${t}</button>`).join("")}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="interruptor"><input type="checkbox" id="sw-suave2" ${S.suavizar ? "checked" : ""}> Suavizar</label><button class="btn btn-borde btn-chico" id="b-marca" ${S.conectado ? "" : "disabled"}>Agregar marca</button><button class="btn btn-borde btn-chico" id="b-csv">Descargar CSV</button></div>
    </div>
    <div class="panel"><div class="panel-cab"><h2>Temperatura</h2><span class="tenue num" id="r-temp"></span></div><div class="graf alta" id="g-temp"></div></div>
    <div class="panel"><div class="panel-cab"><h2>Turbidez</h2><span class="tenue num" id="r-turb"></span></div><div class="graf alta" id="g-turb"></div></div>
    <div class="panel"><div class="panel-cab"><h2>Estado en el tiempo</h2><div class="leyenda"><span><i class="lt-APTO"></i>Apta</span><span><i class="lt-NO_APTO"></i>No apta</span><span><i class="lt-FALLA"></i>Falla</span><span><i class="lt-x"></i>Sin datos</span></div></div>
      <div class="linea-tiempo" id="lt-graf"></div><div class="lt-eje"><span id="lt-desde"></span><span>ahora</span></div></div>
    <p class="tenue" style="margin:0">Hasta 6 h se muestran las lecturas de cada segundo recibidas con esta página abierta; los rangos largos usan el promedio por minuto guardado en este navegador. «Suavizar» muestra la media de 5 lecturas; el ESP32 decide siempre con la lectura real. Las franjas marcan los tramos en no apta o falla.</p>`,
  montar() {
    $$("[data-rango]").forEach((b) => (b.onclick = () => { S.rango = +b.dataset.rango; guardar(CLAVE.rango, S.rango); $$("[data-rango]").forEach((x) => x.setAttribute("aria-pressed", x === b)); this.update(); }));
    $("#b-marca").onclick = agregarMarca;
    $("#sw-suave2").onchange = (e) => { S.suavizar = e.target.checked; guardar("pi2.suavizar", S.suavizar); this.update(); };
    $("#b-csv").onclick = () => {
      const pts = puntosRango(Date.now() - S.rango);
      descargarCsv(`lecturas_${fecha(Date.now()).replace("/", "-")}.csv`, [["fecha_hora", "temperatura_C", "turbidez_pct"], ...pts.map((p) => [fechaHora(p.t), num(p.temp, 2), num(p.turb, 1)])]);
    };
  },
  update() {
    const hasta = Date.now(), desde = hasta - S.rango, pts = puntosRango(desde);
    dibujar("g-temp", { puntos: pts, campo: "temp", desde, hasta, umbral: S.config?.tempMax, unidad: "°C", minY: 20, maxY: 30 });
    dibujar("g-turb", { puntos: pts, campo: "turb", desde, hasta, umbral: S.config?.turbMax, unidad: "%", minY: 0, maxY: 40 });
    lineaTiempo("lt-graf", desde, hasta);
    pon("lt-desde", RANGOS.find(([ms]) => ms === S.rango)?.[1] ? `hace ${RANGOS.find(([ms]) => ms === S.rango)[1]}` : "");
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

// ---------- Firmware (actualizar desde el panel) ----------
// GitHub Actions publica firmware/firmware.bin y firmware/version.json en este mismo sitio.
S.fwDisponible = null;     // {version, fecha, bytes}
S.actualizando = null;     // {objetivo, desde}
const ESPERA_ACTUALIZACION_MS = 4 * 60e3;

/** Compara "2.10" con "2.9" por partes numéricas. */
function compararVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
async function cargarFwDisponible() {
  try {
    const r = await fetch(`firmware/version.json?t=${Date.now()}`, { cache: "no-store" });
    S.fwDisponible = r.ok ? await r.json() : null;
  } catch { S.fwDisponible = null; }
  programarRender();
}
function bloqueFirmware() {
  return `<div class="panel" id="p-firmware"><div class="panel-cab"><h2>Firmware</h2><span class="tenue" id="f-estado"></span></div>
    <dl class="datos"><dt>Instalada en el ESP32</dt><dd id="f-inst">—</dd><dt>Publicada en GitHub</dt><dd id="f-disp">—</dd></dl>
    <button class="btn btn-primario" id="b-actualizar" disabled>Actualizar</button>
    <span class="tenue" id="f-ayuda">Al actualizar, el ESP32 cierra las válvulas, descarga la versión publicada (~1 MB) y se reinicia solo.</span></div>`;
}
function montarFirmware() {
  cargarFwDisponible();
  $("#b-actualizar").onclick = async () => {
    const v = S.fwDisponible?.version;
    if (!v || !(await confirmar(`¿Actualizar a la versión ${v}?`, "El ESP32 cierra las dos válvulas, descarga la versión nueva y se reinicia. Tarda 1 a 2 minutos; no lo apagues mientras tanto.", "Actualizar"))) return;
    const r = await comando("actualizar");
    if (r.ok) { S.actualizando = { objetivo: v, desde: Date.now() }; programarRender(); }
  };
}
function actualizarFirmware() {
  const inst = S.diag?.fw, disp = S.fwDisponible, b = $("#b-actualizar");
  if (!b) return;
  pon("f-inst", inst ? `v${inst}` : "—");
  pon("f-disp", disp ? `v${disp.version} · ${cuando(Date.parse(disp.fecha))}` : "Aún no hay versión publicada");
  const hayNueva = inst && disp && compararVersion(disp.version, inst) > 0;
  const soporta = inst && compararVersion(inst, "2.1") >= 0;    // "actualizar" existe desde la 2.1
  let estado = "";
  if (S.actualizando) estado = "Actualizando…";
  else if (!inst || !disp) estado = "";
  else if (!soporta) estado = "Esta versión se actualiza por cable";
  else estado = hayNueva ? "Hay una versión nueva" : "Al día";
  pon("f-estado", estado);
  b.textContent = S.actualizando ? "Actualizando…" : hayNueva ? `Actualizar a v${disp.version}` : disp ? `Reinstalar v${disp.version}` : "Actualizar";
  b.disabled = !!S.actualizando || !espEnLinea() || !disp || !soporta;
}
/** Seguimiento: termina cuando el ESP32 vuelve con la versión nueva, o falla. */
function revisarActualizacion() {
  const a = S.actualizando;
  if (!a) return;
  if (S.diag?.fw && compararVersion(S.diag.fw, a.objetivo) === 0 && S.diag.recibido > a.desde + 5000) {
    S.actualizando = null; aviso(`ESP32 actualizado a la versión ${a.objetivo}.`, "ok");
  } else if (Date.now() - a.desde > ESPERA_ACTUALIZACION_MS) {
    S.actualizando = null; aviso("El ESP32 no volvió con la versión nueva. Revisa el registro o el Monitor Serie.", "error");
  }
}

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
      <span class="tenue">Voltaje menor a 0,1 V: cable del sensor suelto. Termocupla sin lectura: revisar el conector del MAX6675.</span></div></div>
    ${bloqueFirmware()}`,
  montar() { $("#b-ping2").onclick = medirLatencia; montarFirmware(); },
  update() {
    actualizarConexionCorto(); actualizarFirmware();
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
  html: () => `${VISTAS.umbrales.html()}${VISTAS.diagnostico.html()}<div class="grilla-2"><button class="btn" id="b-tema2">${temaActual() === "claro" ? "Tema oscuro" : "Tema claro"}</button><button class="btn btn-borde" id="b-salir2">${S.sim ? "Salir de la simulación" : "Cerrar sesión"}</button></div>`,
  montar() { VISTAS.umbrales.montar.call(VISTAS.umbrales); VISTAS.diagnostico.montar(); $("#b-salir2").onclick = cerrarSesion; $("#b-tema2").onclick = cambiarTema; },
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
  expo: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  tema: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>',
  salir: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  diagnostico: '<path d="M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const NAV_PC = ["inicio", "graficas", "control", "umbrales", "registro", "diagnostico"];
const NAV_CEL = ["inicio", "graficas", "control", "registro", "ajustes"];
const svgIcono = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONO[k]}</svg>`;
const NOMBRE_NAV = { inicio: "Inicio", graficas: "Gráficas", control: "Control", umbrales: "Umbrales", registro: "Registro", diagnostico: "Diagnóstico", ajustes: "Ajustes" };

const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v10M5 21h22" stroke="var(--agua)" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M16 13v8" stroke="var(--agua)" stroke-width="4" fill="none"/><path d="M9 17l4 4-4 4zM23 17l-4 4 4 4z" fill="var(--texto)"/></svg>';
const temaActual = () => document.documentElement.dataset.tema || "oscuro";
function cambiarTema() {
  const t = temaActual() === "claro" ? "oscuro" : "claro";
  document.documentElement.dataset.tema = t;
  guardar("pi2.tema", t);
  $('meta[name="theme-color"]').content = t === "claro" ? "#E6ECEE" : "#13242B";
  navegar();
}
/** Pantalla completa para proyectar: oculta el menú y agranda el estado. */
function pantallaCompleta() {
  const raiz = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (raiz.classList.contains("expo")) { raiz.classList.remove("expo"); navegar(); }
  else (raiz.requestFullscreen?.() ?? Promise.reject()).catch(() => { raiz.classList.add("expo"); navegar(); });
}
document.addEventListener("fullscreenchange", () => { document.documentElement.classList.toggle("expo", !!document.fullscreenElement); if (vistaActual) navegar(); });

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
  $("#nav-lateral").innerHTML = `<div class="marca-app">${LOGO}<span>Efluentes PI2<small>Monitoreo y desvío</small></span></div>` + NAV_PC.map((k) => `<a class="nav-item" href="#${k}" ${k === v ? 'aria-current="page"' : ""}>${svgIcono(k)}${NOMBRE_NAV[k]}</a>`).join("") +
    `<div class="nav-pie"><button class="nav-item" id="b-expo">${svgIcono("expo")}Pantalla completa</button><button class="nav-item" id="b-tema">${svgIcono("tema")}${temaActual() === "claro" ? "Tema oscuro" : "Tema claro"}</button><button class="nav-item" id="b-salir">${svgIcono("salir")}${S.sim ? "Salir de la simulación" : "Cerrar sesión"}</button></div>`;
  $("#nav-inferior").innerHTML = NAV_CEL.map((k) => `<a href="#${k}" ${k === v ? 'aria-current="page"' : ""}>${svgIcono(k)}${NOMBRE_NAV[k]}</a>`).join("");
  $("#b-salir").onclick = cerrarSesion;
  $("#b-tema").onclick = cambiarTema;
  $("#b-expo").onclick = pantallaCompleta;
  liberarGraficas();
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
  $("#chips").innerHTML = (S.sim ? `<span class="chip sim">Simulación</span>` : "") +
    (document.documentElement.classList.contains("expo") ? `<button class="chip chip-btn" id="b-expo-salir">${svgIcono("expo")}Salir de pantalla completa</button>` : "") +
    chip(S.conectado, S.conectado ? "Broker" : "Broker: reconectando") +
    chip(online, online ? "ESP32 en línea" : S.actualizando ? "ESP32 actualizando" : S.espConexion === "desconectado" ? "ESP32 desconectado" : "ESP32 sin datos") +
    (S.latencia !== null && online ? chip(null, `${S.latencia} ms`) : "") +
    (S.config ? `<span class="chip solo-pc">${esc(S.config.rubros?.find((r) => r.id === S.config.rubro)?.nombre ?? S.config.rubro)}</span>` : "");

  document.body.classList.toggle("esp-offline", !online);
  $("#b-expo-salir") && ($("#b-expo-salir").onclick = pantallaCompleta);
  const av = $("#aviso-conexion"), ult = ultimoDato();
  av.classList.toggle("sim", !!S.sim);
  if (S.sim) { av.textContent = "Modo simulación: los datos se generan en este navegador para ensayar. No vienen del ESP32 ni se envían al broker."; av.classList.remove("oculto"); }
  else if (S.actualizando) {
    av.textContent = `Actualizando el ESP32 a la versión ${S.actualizando.objetivo}: válvulas cerradas, vuelve solo en 1 a 2 min. No lo apagues.`;
    av.classList.remove("oculto");
  } else if (!S.conectado) { av.textContent = "Este dispositivo no tiene conexión con el servidor. Reintentando cada 3 s; revisa su internet."; av.classList.remove("oculto"); }
  else if (!online) {
    av.textContent = ult
      ? `El ESP32 está desconectado desde ${cuando(ult)}. Lo que ves es el último dato que envió; los botones se activan cuando vuelva.`
      : "Esperando datos del ESP32. Revisa que esté encendido y conectado al hotspot.";
    av.classList.remove("oculto");
  } else av.classList.add("oculto");

  VISTAS[vistaActual].update.call(VISTAS[vistaActual]);
}

function mostrarApp() {
  cargarFwDisponible();
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
setInterval(() => { if (minutoActual && Math.floor(Date.now() / 60e3) * 60e3 !== minutoActual.t) cerrarMinuto(); revisarActualizacion(); render(); }, 1000);
setInterval(cargarFwDisponible, 5 * 60e3);
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

// ===================================================================
// 9. MODO SIMULACIÓN
// ===================================================================
// Genera en el navegador los mismos mensajes que publica el ESP32
// (lecturas, estado, config, estadísticas, diagnóstico, eventos) y
// responde a los mismos comandos. Sirve para ensayar la demo sin el
// prototipo. Nada se envía al broker ni se guarda en el historial real.
const SIM_RUBROS = [
  { id: "ptar", nombre: "PTAR doméstica", t: 35, u: 30 }, { id: "textil", nombre: "Textil", t: 35, u: 40 },
  { id: "alimentos", nombre: "Alimentos y bebidas", t: 35, u: 25 }, { id: "curtiembre", nombre: "Curtiembre", t: 35, u: 45 },
  { id: "mineria", nombre: "Minería", t: 30, u: 20 }, { id: "demo", nombre: "Demo / laboratorio", t: 30, u: 50 },
  { id: "personalizado", nombre: "Personalizado", t: 35, u: 40 },
];
const SIM = {
  activo: false, inicio: 0, temp: 23.8, tempObj: 24.5, turb: 9, turbObj: 7, fallaTemp: false, fallaTurb: false,
  estado: "INICIANDO", motivo: "", modo: "AUTO", valvula: "NINGUNA", desde: 0, valvDesde: 0, cambios: 0, silenciada: false,
  candidato: null, cuenta: 0, rubro: "ptar", vLimpia: 4.1, vSucia: 2.5, enviados: 0, recibidos: 0, n: 0,
  st: null,
};
const seg = () => Math.floor(Date.now() / 1000);
function simEmitir(sub, obj) { SIM.enviados++; alRecibir(CONFIG.topicoBase + sub, JSON.stringify(obj)); }
const simLimites = () => SIM_RUBROS.find((r) => r.id === SIM.rubro);
function simReiniciarStats() {
  SIM.st = { inicio: Date.now(), lecturas: 0, tiempoS: { inicio: 0, apta: 0, noApta: 0, falla: 0 }, vecesNoApta: 0, noAptaTurb: 0, noAptaTemp: 0, noAptaAmbos: 0, vecesFalla: 0, tempMin: null, tempMax: null, turbMin: null, turbMax: null };
}
function simEvento(tipo, detalle, origen = "ESP32 (sim)") {
  simEmitir("eventos", { t: seg(), tipo, detalle, temp: SIM.fallaTemp ? null : +SIM.temp.toFixed(1), turb: SIM.fallaTurb ? 0 : Math.round(SIM.turb), origen });
}
function simPublicarEstado() {
  simEmitir("estado", { t: seg(), estado: SIM.estado, motivo: SIM.motivo, modo: SIM.modo, valvula: SIM.valvula, desde: Math.floor(SIM.desde / 1000),
    valvulaDesde: SIM.valvDesde ? Math.floor(SIM.valvDesde / 1000) : null, cambiosValvula: SIM.cambios, silenciada: SIM.silenciada, reles: true, prueba: null });
}
function simPublicarConfig() {
  const L = simLimites();
  simEmitir("config", { rubro: SIM.rubro, tempMax: L.t, turbMax: L.u, histTemp: 1, histTurb: 5, lecturasCambio: 3, tiempoMinimoS: 5, intervaloS: 1,
    vLimpia: SIM.vLimpia, vSucia: SIM.vSucia, rubros: SIM_RUBROS, rangos: { tMin: 5, tMax: 90, uMin: 5, uMax: 95 } });
}
function simPublicarStats() {
  const s = SIM.st;
  simEmitir("estadisticas", { t: seg(), duracionS: Math.round((Date.now() - s.inicio) / 1000), ...s });
}
function simPublicarDiag() {
  simEmitir("diagnostico", { t: seg(), fw: "sim", uptimeS: Math.round((Date.now() - SIM.inicio) / 1000), heap: 182000 - Math.round(Math.random() * 3000), heapMin: 171000,
    rssi: -52 - Math.round(Math.random() * 6), ssid: "(simulación)", reinicio: "Encendido", reinicioAnormal: false, reconexiones: 0, enviados: SIM.enviados, recibidos: SIM.recibidos,
    ntp: true, watchdogS: 8, sensorTemp: SIM.fallaTemp ? "falla" : "ok", sensorTurb: SIM.fallaTurb ? "falla" : "ok", voltTurb: SIM.ultimoVolt ?? 0, lcd: "ok", releDer: 32, releIzq: 4 });
}
function simValvula(v) {
  if (v === SIM.valvula) return;
  SIM.valvula = v; SIM.valvDesde = Date.now(); SIM.cambios++;
  simEvento("Válvula", v === "DER" ? "Derecha abierta, izquierda cerrada" : v === "IZQ" ? "Izquierda abierta, derecha cerrada" : "Ambas cerradas");
}
function simCambiarEstado(nuevo, motivo, origen) {
  const ant = SIM.estado;
  if (nuevo === ant && motivo === SIM.motivo) return;
  SIM.estado = nuevo; SIM.motivo = motivo;
  if (nuevo !== ant) {
    SIM.desde = Date.now(); SIM.silenciada = false;
    if (nuevo === "NO_APTO") { SIM.st.vecesNoApta++; SIM.st[{ TURBIDEZ: "noAptaTurb", TEMPERATURA: "noAptaTemp", AMBOS: "noAptaAmbos" }[motivo]]++; }
    if (nuevo === "FALLA") SIM.st.vecesFalla++;
    simEvento("Estado", `${ant} a ${nuevo}${motivo ? ", " + motivo : ""}`, origen);
  }
  simValvula(nuevo === "APTO" ? "DER" : nuevo === "NO_APTO" ? "IZQ" : "NINGUNA");
  simPublicarEstado();
}
function simTick() {
  if (!SIM.activo) return;
  SIM.n++;
  // Respuesta de primer orden: los valores se acercan al objetivo de a pocos, con ruido de sensor
  SIM.temp += (SIM.tempObj - SIM.temp) * 0.1 + (Math.random() - 0.5) * 0.14;
  SIM.turb = Math.min(100, Math.max(0, SIM.turb + (SIM.turbObj - SIM.turb) * 0.16 + (Math.random() - 0.5) * 1.2));
  const temp = SIM.fallaTemp ? null : +SIM.temp.toFixed(2);
  const turb = SIM.fallaTurb ? 0 : +SIM.turb.toFixed(1);
  const volt = SIM.fallaTurb ? 0.03 : SIM.vLimpia - (SIM.turb / 100) * (SIM.vLimpia - SIM.vSucia);
  SIM.ultimoVolt = +volt.toFixed(3);
  simEmitir("lecturas", { t: seg(), temp, turb, volt: SIM.ultimoVolt });

  const s = SIM.st;
  s.lecturas++;
  s.tiempoS[{ APTO: "apta", NO_APTO: "noApta", FALLA: "falla" }[SIM.estado] ?? "inicio"]++;
  if (temp !== null) { s.tempMin = Math.min(s.tempMin ?? temp, temp); s.tempMax = Math.max(s.tempMax ?? temp, temp); }
  if (!SIM.fallaTurb) { s.turbMin = Math.min(s.turbMin ?? turb, turb); s.turbMax = Math.max(s.turbMax ?? turb, turb); }

  // Misma lógica que el firmware: 3 lecturas iguales, histéresis y 5 s mínimos entre apta y no apta
  if (SIM.modo === "AUTO" && SIM.n > 2) {
    let cand, mot = "";
    if (temp === null) { cand = "FALLA"; mot = "FALLA_TEMP"; }
    else if (SIM.fallaTurb) { cand = "FALLA"; mot = "FALLA_TURB"; }
    else {
      const L = simLimites(), enNoApta = SIM.estado === "NO_APTO";
      const altoT = temp > L.t - (enNoApta ? 1 : 0), altoU = turb > L.u - (enNoApta ? 5 : 0);
      cand = altoT || altoU ? "NO_APTO" : "APTO";
      mot = altoT && altoU ? "AMBOS" : altoT ? "TEMPERATURA" : altoU ? "TURBIDEZ" : "";
    }
    if (cand === SIM.candidato) SIM.cuenta++; else { SIM.candidato = cand; SIM.cuenta = 1; }
    const esperar = cand !== "FALLA" && (SIM.estado === "APTO" || SIM.estado === "NO_APTO") && cand !== SIM.estado && Date.now() - SIM.desde < 5000;
    if (SIM.cuenta >= 3 && !esperar) simCambiarEstado(cand, mot);
  }
  if (SIM.n % 5 === 0) simPublicarStats();
  if (SIM.n % 10 === 1) simPublicarDiag();
}
function simComando(cmd) {
  SIM.recibidos++;
  const c = cmd.trim().toLowerCase();
  const L = simLimites();
  const manual = () => { SIM.modo = "MANUAL"; };
  let r = { ok: true, detalle: "" };
  if (c === "ping") return { ok: true, detalle: "pong" };
  if (c === "a") { SIM.modo = "AUTO"; SIM.candidato = null; r.detalle = "Modo automático"; simPublicarEstado(); }
  else if (["1", "2", "3"].includes(c)) { manual(); const e = { 1: "APTO", 2: "NO_APTO", 3: "FALLA" }[c]; simCambiarEstado(e, "COMANDO", "comando"); r.detalle = `Forzado: ${TXT_ESTADO[e].toLowerCase()}`; }
  else if (["d", "i", "c"].includes(c)) { manual(); simValvula({ d: "DER", i: "IZQ", c: "NINGUNA" }[c]); simPublicarEstado(); r.detalle = { d: "Derecha abierta", i: "Izquierda abierta", c: "Válvulas cerradas" }[c]; }
  else if (["lv", "lr", "bz", "lcd", "auto"].includes(c)) { r.detalle = { lv: "Prueba LED verde", lr: "Prueba LED rojo", bz: "Prueba buzzer", lcd: "Prueba pantalla", auto: "Autoprueba completa" }[c] + " (simulada)"; simEvento("Prueba", r.detalle); }
  else if (c === "m") { SIM.silenciada = true; simPublicarEstado(); r.detalle = "Alarma silenciada"; }
  else if (c === "r") { simReiniciarStats(); simPublicarStats(); r.detalle = "Estadísticas reiniciadas"; }
  else if (/^[tu]\d+(\.\d+)?$/.test(c)) {
    const v = parseFloat(c.slice(1)), esT = c[0] === "t", [mn, mx] = esT ? [5, 90] : [5, 95];
    if (v < mn || v > mx) r = { ok: false, detalle: `Fuera de rango (${mn}–${mx})` };
    else { const p = SIM_RUBROS.find((x) => x.id === "personalizado"); if (SIM.rubro !== "personalizado") { p.t = L.t; p.u = L.u; } p[esT ? "t" : "u"] = v; SIM.rubro = "personalizado"; simPublicarConfig(); r.detalle = `${esT ? "Temperatura" : "Turbidez"} máxima: ${v}`; }
  }
  else if (c.startsWith("k") && SIM_RUBROS.some((x) => x.id === c.slice(1))) { SIM.rubro = c.slice(1); simPublicarConfig(); r.detalle = `Rubro: ${simLimites().nombre}`; }
  else if (c === "x") { SIM.rubro = "ptar"; simPublicarConfig(); r.detalle = "Valores de fábrica (PTAR)"; }
  else if (c === "cl" || c === "cs") {
    const v = SIM.ultimoVolt;
    if (c === "cl") SIM.vLimpia = v; else SIM.vSucia = v;
    if (Math.abs(SIM.vLimpia - SIM.vSucia) < 0.2) r = { ok: false, detalle: "Limpia y sucia demasiado parecidas (mín. 0,20 V)" };
    else { simPublicarConfig(); r.detalle = `${c === "cl" ? "Agua limpia" : "Muestra sucia"}: ${num(v, 3)} V`; }
  }
  else if (c === "reboot" || c === "actualizar") r = { ok: false, detalle: "No disponible en simulación" };
  else if (["s", "e", "p", "h"].includes(c)) r.detalle = "Respuesta en el Monitor Serie (simulado)";
  else r = { ok: false, detalle: `Comando desconocido: ${cmd}` };
  simEvento(r.ok ? "Comando" : "Comando rechazado", r.detalle, origen());
  return r;
}

const ESCENARIOS = {
  limpia: () => { SIM.turbObj = 6 + Math.random() * 3; SIM.tempObj = 24.5; },
  tierra: () => { SIM.turbObj = 64; },
  leve: () => { SIM.turbObj = Math.max(5, simLimites().u - 6); },
  caliente: () => { SIM.tempObj = simLimites().t + 6; },
  fria: () => { SIM.tempObj = 24.5; },
  falla_turb: () => { SIM.fallaTurb = !SIM.fallaTurb; },
  falla_temp: () => { SIM.fallaTemp = !SIM.fallaTemp; },
};
function bloqueSim() {
  return `<div class="panel sim-caja"><div class="panel-cab"><h2>Escenarios de simulación</h2><span class="tenue" id="sim-obj"></span></div>
    <p class="tenue" style="margin:0;font-size:13px">Cambian la muestra simulada. El panel decide igual que el firmware: 3 lecturas seguidas, histéresis y 5 s mínimos.</p>
    <div class="grilla-2">
      <button class="btn btn-chico" data-sim="limpia">Agua limpia</button><button class="btn btn-chico" data-sim="tierra">Agregar tierra</button>
      <button class="btn btn-chico" data-sim="leve">Cerca del límite</button><button class="btn btn-chico" data-sim="caliente">Agua caliente</button>
      <button class="btn btn-chico" data-sim="falla_turb" id="sim-ft">Falla de turbidez</button><button class="btn btn-chico" data-sim="falla_temp" id="sim-fc">Falla de temperatura</button>
    </div></div>`;
}
function actualizarSim() {
  if (!S.sim) return;
  pon("sim-obj", `objetivo ${num(SIM.tempObj, 1)} °C · ${num(SIM.turbObj, 0)} %`);
  $("#sim-ft")?.setAttribute("aria-pressed", SIM.fallaTurb);
  $("#sim-fc")?.setAttribute("aria-pressed", SIM.fallaTemp);
  $('[data-sim="caliente"]')?.setAttribute("aria-pressed", SIM.tempObj > 30);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sim]");
  if (!b || !S.sim) return;
  const k = b.dataset.sim;
  if (k === "caliente" && SIM.tempObj > 30) ESCENARIOS.fria(); else ESCENARIOS[k]();
  b.blur(); programarRender();
});

function iniciarSimulacion() {
  S.sim = true; SIM.activo = true; SIM.inicio = Date.now(); SIM.desde = Date.now();
  S.conectado = true; S.usuario = "simulación"; S.espConexion = "en_linea";
  S.minutos = []; S.eventos = []; S.raw = [];
  simReiniciarStats();
  simPublicarConfig(); simPublicarEstado(); simPublicarDiag();
  simEvento("Sistema", "Simulación iniciada");
  setInterval(simTick, 1000);
  mostrarApp();
}
$("#b-simular").addEventListener("click", iniciarSimulacion);
