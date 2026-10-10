#!/usr/bin/env node
// scripts/vigilante-tramitacion.mjs · El vigilante de Tramitación v2, en el VPS (diseño §2.7).
//
// Un cron lo lanza cada 5 minutos. En cada pasada:
//   1. llama a POST /api/tramitacion/vigilante (la web reintenta los correos pendientes, concilia, abandona lo viejo…
//      y devuelve el parte de lo que preocupa);
//   2. avisa a Victor por Telegram de lo NUEVO, UNA sola vez por incidencia, y le dice cuándo se ha resuelto;
//   3. toca el testigo para que latido-crons.sh sepa que el cron sigue vivo.
//
// Qué avisa (una vez por clave; con mensaje de «resuelto» cuando la clave desaparece del parte):
//   · correo:<id>:<estado>   un aviso o un acuse atascado (más de 10 min sin salir, o en un estado final: bloqueado,
//                            error de configuración, envío incierto, agotado). Si el mismo correo empeora (cambia
//                            de estado) es una clave nueva: se avisa de nuevo, sin decir que lo anterior «se resolvió».
//   · subida:<ref>           un envío con la documentación sin terminar de subir desde hace más de 1 h
//   · endpoint               la web no contesta al vigilante dos veces seguidas (HTTP distinto de 2xx o sin respuesta)
//
// Uso:  node scripts/vigilante-tramitacion.mjs [--dry] [--una-vez] [--ayuda]
//   --dry       llama a la web (que hace su trabajo de siempre), imprime el parte y lo que AVISARÍA, pero no avisa,
//               no guarda el estado ni toca el testigo. Lee el estado para decir qué es nuevo y qué ya estaba avisado.
//   --una-vez   pasada suelta: ignora el estado guardado (todo cuenta como nuevo), avisa y NO guarda el estado ni
//               toca el testigo. Con --dry --una-vez solo imprime.
//
// Configuración (el entorno manda sobre el fichero):
//   /root/.tramitacion-vigilante.env (0600), o el fichero que diga VIGILANTE_ENV, con
//     VIGILANTE_URL=https://…/api/tramitacion/vigilante   VIGILANTE_SECRETO=…        (obligatorias)
//     NOTIFICAR=/root/notifica-telegram.sh   ESTADO=/root/.tramitacion-vigilante-state.json
//     TESTIGO=/root/.tramitacion-vigilante-last                                         (opcionales; estos son los valores por defecto)
//   VIGILANTE_TOPE_MS (solo pruebas) cambia el tope de 55 s de la llamada.
//
// Reglas del script:
//  · Solo node:fs, node:child_process y fetch. No importa nada del repo (corre en el VPS desde una copia del repo).
//  · NUNCA imprime el secreto ni la URL: ni en el parte, ni en los errores, ni en lo que pasa a NOTIFICAR. Los fallos
//    de red se cuentan con una frase fija («no se ha podido conectar»), nunca con el mensaje de la excepción.
//  · Los mensajes de Telegram no llevan datos personales: solo referencias (GNE-…/MEGA-…), tipo de correo, tiempos y la
//    ficha de la bandeja. Del parte de la web solo se leen campos conocidos, con su forma comprobada.
//  · Si NOTIFICAR falla, esa incidencia NO se da por avisada y se vuelve a intentar en la pasada siguiente.
//  · Con la web caída no se manda ningún «resuelto» ni se purga nada: no se sabe qué sigue ahí.
//  · Códigos de salida: 0 pasada hecha · 1 la web no ha contestado bien · 2 mala configuración o uso.
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const FICHERO_ENV = '/root/.tramitacion-vigilante.env';
const POR_DEFECTO = Object.freeze({
  ESTADO: '/root/.tramitacion-vigilante-state.json',
  NOTIFICAR: '/root/notifica-telegram.sh',
  TESTIGO: '/root/.tramitacion-vigilante-last',
});
// 55 s: por encima de lo que puede tardar una pasada (51 s en el peor caso: no empieza envíos pasados 25 s, un aviso con
// adjuntos tiene 15 s, +4 s de reintento sin adjuntos, 2 s alrededor del envío y 5 s de consultas; ver api/_lib/vigilante.js)
// y por debajo de los 60 s de la función (maxDuration de vercel.json). Con 25 s, un aviso lento se habría visto aquí como
// «la web no responde».
const TOPE_LLAMADA_MS = 55_000;
const TOPE_AVISO_MS = 45_000;
const PURGA_MS = 24 * 60 * 60 * 1000; // lo que no se ve en 24 h se olvida
const FALLOS_PARA_AVISAR = 2;
const VERSION_ESTADO = 1;

const AYUDA = [
  'Vigilante de Tramitación v2 (lo lanza el cron cada 5 minutos).',
  '',
  'Uso: node scripts/vigilante-tramitacion.mjs [--dry] [--una-vez] [--ayuda]',
  '  --dry       imprime el parte y lo que avisaría, sin avisar, sin guardar el estado y sin tocar el testigo',
  '  --una-vez   pasada suelta: ignora el estado guardado, avisa y no guarda el estado ni toca el testigo',
  '',
  'Configuración: /root/.tramitacion-vigilante.env con VIGILANTE_URL y VIGILANTE_SECRETO',
  '(opcionales: NOTIFICAR, ESTADO, TESTIGO). Los valores del entorno mandan sobre el fichero.',
].join('\n');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const FORMATO_HORA = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** «2026-10-10 14:05:01», en hora de Madrid, para el registro. */
const horaTexto = (ms = Date.now()) => FORMATO_HORA.format(new Date(ms));

/** Minutos → «14 min», «1 h 20 min», «2 h», «3 días». */
function duracionTexto(minutos) {
  const m = Math.max(0, Math.floor(Number(minutos) || 0));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) {
    const horas = Math.floor(m / 60);
    const resto = m % 60;
    return resto === 0 ? `${horas} h` : `${horas} h ${resto} min`;
  }
  return `${Math.floor(m / (24 * 60))} días`;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/** KEY=VALUE por línea; ignora vacías y comentarios (#), admite «export» y comillas. Sin comentarios al final de línea. */
function leerFicheroEnv(ruta) {
  let texto;
  try {
    texto = readFileSync(ruta, 'utf8');
  } catch {
    return {};
  }
  const salida = {};
  for (const linea of texto.split(/\r?\n/)) {
    if (linea.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linea);
    if (!m) continue;
    let valor = m[2];
    if (valor.length >= 2 && ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'")))) {
      valor = valor.slice(1, -1);
    }
    salida[m[1]] = valor;
  }
  return salida;
}

/**
 * Configuración de la pasada: {url, secreto, notificar, estado, testigo, topeMs} o {error} con una frase que no
 * lleva ningún valor (ni la URL ni el secreto).
 */
function leerConfiguracion(env = process.env) {
  const delFichero = leerFicheroEnv(String(env.VIGILANTE_ENV ?? '').trim() || FICHERO_ENV);
  const dato = (nombre) => {
    const delEntorno = String(env[nombre] ?? '').trim();
    return delEntorno || String(delFichero[nombre] ?? '').trim();
  };

  const url = dato('VIGILANTE_URL');
  const secreto = dato('VIGILANTE_SECRETO');
  if (!url || !secreto) return { error: 'Falta la configuración: hacen falta VIGILANTE_URL y VIGILANTE_SECRETO (en el fichero de configuración o en el entorno).' };
  if (!/^[\x21-\x7e]+$/.test(secreto)) return { error: 'VIGILANTE_SECRETO no es válido (sin espacios ni caracteres raros).' };

  let direccion;
  try {
    direccion = new URL(url);
  } catch {
    return { error: 'VIGILANTE_URL no es una dirección válida.' };
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(direccion.hostname);
  if (direccion.protocol !== 'https:' && !(direccion.protocol === 'http:' && local)) {
    return { error: 'VIGILANTE_URL tiene que empezar por https:// (el secreto no viaja sin cifrar).' };
  }

  const tope = Number(dato('VIGILANTE_TOPE_MS'));
  return {
    url,
    secreto,
    notificar: dato('NOTIFICAR') || POR_DEFECTO.NOTIFICAR,
    estado: dato('ESTADO') || POR_DEFECTO.ESTADO,
    testigo: dato('TESTIGO') || POR_DEFECTO.TESTIGO,
    topeMs: Number.isInteger(tope) && tope >= 100 && tope <= 120_000 ? tope : TOPE_LLAMADA_MS,
  };
}

// ---------------------------------------------------------------------------
// La llamada a la web
// ---------------------------------------------------------------------------

const RE_REF = /^[A-Z]{3,4}-\d{8}-[A-Z0-9]{4,10}$/;
const ESTADOS_CORREO = ['pendiente', 'enviando', 'agotado', 'suprimido', 'incierto', 'error_configuracion'];

const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_CODIGO = /^[A-Za-z0-9_.-]{1,40}$/; // los códigos de Altavoz son palabras_con_guiones_bajos; cualquier otra cosa no se lee
const entero = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/**
 * Se queda solo con los campos conocidos del parte y comprueba su forma: lo que no encaja se descarta (nunca llega a un
 * mensaje de Telegram). Devuelve {contadores, atascados, subidas}.
 */
function normalizarParte(cuerpo) {
  const atascados = (Array.isArray(cuerpo.atascados) ? cuerpo.atascados : [])
    .filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && RE_ID.test(a.id)
      && typeof a.ref === 'string' && RE_REF.test(a.ref) && ESTADOS_CORREO.includes(a.estado))
    .map((a) => ({
      id: a.id,
      tipo: a.tipo === 'acuse' ? 'acuse' : 'aviso',
      ref: a.ref,
      estado: a.estado,
      intentos: entero(a.intentos),
      codigo: typeof a.codigo_respuesta === 'string' && RE_CODIGO.test(a.codigo_respuesta) ? a.codigo_respuesta : '',
      minutos: entero(a.minutos),
      ficha: typeof a.ficha === 'string' && /^https?:\/\/[^\s]{1,300}$/.test(a.ficha) ? a.ficha : '',
    }));
  const subidas = (Array.isArray(cuerpo.subidas_a_medias) ? cuerpo.subidas_a_medias : [])
    .filter((s) => s && typeof s === 'object' && typeof s.ref === 'string' && RE_REF.test(s.ref))
    .map((s) => ({ ref: s.ref, minutos: entero(s.minutos) }));
  return {
    contadores: {
      conciliadas: entero(cuerpo.conciliadas),
      liberados: entero(cuerpo.liberados),
      reintentados: entero(cuerpo.reintentados),
      enviados: entero(cuerpo.enviados),
      abandonadas: entero(cuerpo.abandonadas),
      pendientes: entero(cuerpo.pendientes_total),
    },
    atascados,
    subidas,
  };
}

/** POST a la web con el secreto en la cabecera. Devuelve {ok:true, parte} o {ok:false, motivo} (frase fija, sin la URL). */
async function llamar(config) {
  try {
    const respuesta = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.secreto}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      redirect: 'error', // si alguna vez redirigen, el secreto no viaja a otro sitio
      signal: AbortSignal.timeout(config.topeMs),
    });
    const crudo = await respuesta.text();
    if (!respuesta.ok) return { ok: false, motivo: `la web ha contestado HTTP ${respuesta.status}` };
    let cuerpo = null;
    try {
      cuerpo = JSON.parse(crudo);
    } catch {
      cuerpo = null;
    }
    if (!cuerpo || typeof cuerpo !== 'object' || cuerpo.ok !== true) return { ok: false, motivo: 'la respuesta de la web no es válida' };
    return { ok: true, parte: normalizarParte(cuerpo) };
  } catch (error) {
    const agotado = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ok: false, motivo: agotado ? 'la web no ha contestado a tiempo' : 'no se ha podido conectar con la web' };
  }
}

// ---------------------------------------------------------------------------
// Los mensajes (en llano, sin datos personales)
// ---------------------------------------------------------------------------

const CAUSAS = Object.freeze({
  modo_prueba: 'Altavoz está en modo prueba',
  envio_no_disponible: 'Altavoz no puede enviar ahora mismo',
  envio_no_encendido: 'Altavoz no puede enviar ahora mismo',
  no_comprobado: 'Altavoz no puede enviar ahora mismo',
  envio_rechazado: 'Altavoz no ha podido entregarlo a Amazon',
  preparacion: 'no se ha podido preparar el correo',
  cerrojo: 'el envío se quedó a medias',
});

const causaTexto = (codigo) => CAUSAS[codigo] ?? 'Altavoz no responde';
const intentosTexto = (n) => (n === 0 ? 'todavía sin intentar' : (n === 1 ? '1 intento' : `${n} intentos`));
const nombreCorreo = (tipo) => (tipo === 'acuse' ? 'ACUSE' : 'AVISO');

/** El aviso de un correo atascado, según en qué estado esté. */
function textoCorreoAtascado(a) {
  const que = `el ${nombreCorreo(a.tipo)} de ${a.ref}`;
  const ficha = a.ficha ? ` Ficha: ${a.ficha}` : '';
  switch (a.estado) {
    case 'suprimido':
      return `🔴 Tramitación: ${que} no se ha podido enviar: ${a.tipo === 'acuse'
        ? 'la dirección del comercial está bloqueada en Altavoz'
        : 'el buzón de tramitación está bloqueado en Altavoz y no recibe ningún aviso'}. Revísalo en la bandeja.${ficha}`;
    case 'error_configuracion':
      return `🔴 Tramitación: ${que} no se ha podido enviar: Altavoz rechaza la configuración del envío (clave, permiso o remitente). Revísalo en la bandeja.${ficha}`;
    case 'incierto':
      return `🔴 Tramitación: ${que} puede haber salido o no: Altavoz no lo confirma. Compruébalo antes de repetirlo; en la bandeja está «Volver a enviar».${ficha}`;
    case 'agotado':
      return `🔴 Tramitación: ${que} no se ha podido enviar tras ${a.intentos} intentos. Revísalo en la bandeja.${ficha}`;
    default:
      return `🔴 Tramitación: ${que} lleva ${duracionTexto(a.minutos)} sin salir (${intentosTexto(a.intentos)}; ${causaTexto(a.codigo)}).${ficha}`;
  }
}

const textoSubidaAMedias = (s) => `🟡 Tramitación: el envío ${s.ref} lleva ${duracionTexto(s.minutos)} con la documentación sin terminar de subir.`;
const textoEndpointCaido = (veces) => `🔴 Tramitación: el vigilante no consigue hablar con la web (${veces} veces seguidas). Los correos pendientes no se están reintentando.`;
const TEXTO_ENDPOINT_RECUPERADO = '✅ Tramitación: la web vuelve a responder al vigilante.';

/** El mensaje de «resuelto» de una alerta guardada. */
function textoResuelto(alerta) {
  if (alerta.tipo === 'subida') return `✅ Tramitación: el envío ${alerta.ref} ya no está a medias.`;
  return `✅ Tramitación: el ${nombreCorreo(alerta.correo)} de ${alerta.ref} ya ha salido.`;
}

// ---------------------------------------------------------------------------
// Estado entre pasadas
// ---------------------------------------------------------------------------

const estadoVacio = () => ({ version: VERSION_ESTADO, fallos: 0, alertas: {} });

/** {estado, ilegible}. Un fichero que falta es normal (primera pasada); uno que no se entiende empieza de cero. */
function leerEstado(ruta) {
  let crudo;
  try {
    crudo = readFileSync(ruta, 'utf8');
  } catch (error) {
    return { estado: estadoVacio(), ilegible: error?.code !== 'ENOENT' };
  }
  try {
    const dato = JSON.parse(crudo);
    if (!dato || typeof dato !== 'object' || dato.version !== VERSION_ESTADO || !dato.alertas || typeof dato.alertas !== 'object' || Array.isArray(dato.alertas)) {
      return { estado: estadoVacio(), ilegible: true };
    }
    return { estado: { version: VERSION_ESTADO, fallos: entero(dato.fallos), alertas: { ...dato.alertas } }, ilegible: false };
  } catch {
    return { estado: estadoVacio(), ilegible: true };
  }
}

/** Escritura atómica (fichero temporal + renombrar) y con permisos 0600. Devuelve true si se ha guardado. */
function guardarEstado(ruta, estado) {
  const temporal = `${ruta}.tmp-${process.pid}`;
  try {
    writeFileSync(temporal, `${JSON.stringify(estado, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporal, ruta);
    return true;
  } catch {
    return false;
  }
}

/** Toca el testigo (latido-crons.sh mira su fecha de modificación). */
function tocarTestigo(ruta, ahora) {
  try {
    writeFileSync(ruta, `${new Date(ahora).toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Avisar por Telegram
// ---------------------------------------------------------------------------

/** Ejecuta NOTIFICAR "<texto>" (sin shell). Su salida se descarta: el script de Telegram maneja credenciales. */
function avisar(rutaNotificar, mensaje) {
  try {
    execFileSync(rutaNotificar, [mensaje], { stdio: 'ignore', timeout: TOPE_AVISO_MS });
    return { ok: true };
  } catch (error) {
    let motivo = 'no se ha podido ejecutar';
    if (error?.code === 'ETIMEDOUT') motivo = 'ha tardado demasiado';
    else if (Number.isInteger(error?.status)) motivo = `ha terminado con el código ${error.status}`;
    return { ok: false, motivo };
  }
}

// ---------------------------------------------------------------------------
// La pasada
// ---------------------------------------------------------------------------

/**
 * Pasada completa. Devuelve {codigo, lineas}: el código de salida y las líneas del parte. `opciones`: {dry, unaVez}.
 * Los avisos se hacen aquí; el estado y el testigo, según las opciones.
 */
async function pasar(config, { dry = false, unaVez = false } = {}) {
  const lineas = [];
  const salida = (texto) => lineas.push(texto);
  const ahora = Date.now();
  const persistir = !dry && !unaVez;

  // Estado de la pasada anterior (con --una-vez no se mira: todo cuenta como nuevo)
  let estado;
  if (unaVez) {
    estado = estadoVacio();
  } else {
    const leido = leerEstado(config.estado);
    estado = leido.estado;
    if (leido.ilegible) salida('  Aviso: el fichero de estado no se podía leer; se empieza de cero.');
  }

  // Avisa (o, con --dry, cuenta lo que avisaría). Devuelve true si la incidencia puede darse por avisada.
  // Si un aviso falla, no se insiste con los demás en esta pasada: con Telegram caído, cada intento puede tardar decenas
  // de segundos y las pasadas acabarían solapándose con la siguiente del cron (y repitiendo avisos al volver).
  const contador = { nuevos: 0, repetidos: 0, resueltos: 0, sinAvisar: 0 };
  let avisosCaidos = false;
  const acciones = []; // lo que se ha avisado (o se avisaría), para imprimirlo debajo de la cabecera del parte
  const comunicar = (mensaje) => {
    if (dry) {
      acciones.push(`    AVISARÍA: ${mensaje}`);
      return true;
    }
    if (avisosCaidos) {
      acciones.push(`    SIN AVISAR (el aviso anterior ha fallado en esta pasada; se reintenta en la siguiente): ${mensaje}`);
      return false;
    }
    const r = avisar(config.notificar, mensaje);
    if (!r.ok) avisosCaidos = true;
    acciones.push(r.ok ? `    AVISADO: ${mensaje}` : `    NO SE HA PODIDO AVISAR (${r.motivo}); se reintenta en la pasada siguiente: ${mensaje}`);
    return r.ok;
  };

  const respuesta = await llamar(config);

  // ---- La web no contesta bien ----
  if (!respuesta.ok) {
    estado.fallos += 1;
    salida(`${horaTexto(ahora)} · FALLO ${estado.fallos}: ${respuesta.motivo}.`);
    const existente = estado.alertas.endpoint;
    if (existente) {
      existente.visto = new Date(ahora).toISOString(); // mientras dure la caída no se olvida
      contador.repetidos += 1;
    } else if (estado.fallos >= FALLOS_PARA_AVISAR) {
      if (comunicar(textoEndpointCaido(estado.fallos))) {
        estado.alertas.endpoint = { tipo: 'endpoint', desde: new Date(ahora).toISOString(), visto: new Date(ahora).toISOString() };
        contador.nuevos += 1;
      } else {
        contador.sinAvisar += 1;
      }
    }
    lineas.push(...acciones);
    if (persistir && !guardarEstado(config.estado, estado)) salida('  Aviso: no se ha podido guardar el fichero de estado.');
    if (persistir && !tocarTestigo(config.testigo, ahora)) salida('  Aviso: no se ha podido tocar el testigo.');
    return { codigo: 1, lineas, contador };
  }

  // ---- La web ha contestado ----
  const { contadores, atascados, subidas } = respuesta.parte;
  const ahoraIso = new Date(ahora).toISOString();
  estado.fallos = 0;

  // Lo que no se ha visto en 24 h se olvida, sin avisar de nada. Solo con la web contestando: si no contesta, no se sabe
  // qué sigue ahí y no se toca nada (por eso esto va después del camino de fallo).
  let purgadas = 0;
  for (const [clave, alerta] of Object.entries(estado.alertas)) {
    const visto = Date.parse(alerta?.visto ?? alerta?.desde ?? '');
    if (!Number.isFinite(visto) || ahora - visto > PURGA_MS) {
      delete estado.alertas[clave];
      purgadas += 1;
    }
  }

  if (estado.alertas.endpoint) {
    if (comunicar(TEXTO_ENDPOINT_RECUPERADO)) {
      delete estado.alertas.endpoint;
      contador.resueltos += 1;
    } else {
      contador.sinAvisar += 1;
    }
  }

  // Lo que hay ahora: clave → {alerta que se guarda, mensaje}
  const actuales = new Map();
  for (const a of atascados) {
    actuales.set(`correo:${a.id}:${a.estado}`, {
      alerta: { tipo: 'correo', id: a.id, ref: a.ref, correo: a.tipo },
      mensaje: textoCorreoAtascado(a),
      resumen: `${nombreCorreo(a.tipo)} ${a.ref} · ${a.estado} · ${intentosTexto(a.intentos)} · ${duracionTexto(a.minutos)}${a.codigo ? ` · código ${a.codigo}` : ''}`,
    });
  }
  for (const s of subidas) {
    actuales.set(`subida:${s.ref}`, {
      alerta: { tipo: 'subida', ref: s.ref },
      mensaje: textoSubidaAMedias(s),
      resumen: `subida a medias ${s.ref} · ${duracionTexto(s.minutos)} sin terminar`,
    });
  }

  // Nuevas (se avisa) y ya conocidas (no se repite)
  const detalle = [];
  for (const [clave, { alerta, mensaje, resumen }] of actuales) {
    const previa = estado.alertas[clave];
    if (previa) {
      previa.visto = ahoraIso;
      contador.repetidos += 1;
      detalle.push(`  · ${resumen} → ya avisado`);
      continue;
    }
    detalle.push(`  · ${resumen} → NUEVO`);
    if (comunicar(mensaje)) {
      estado.alertas[clave] = { ...alerta, desde: ahoraIso, visto: ahoraIso };
      contador.nuevos += 1;
    } else {
      contador.sinAvisar += 1;
    }
  }

  // Desaparecidas: resueltas (se avisa) o, si el mismo correo sigue atascado en otro estado, escaladas (no se dice nada)
  const idsAtascados = new Set(atascados.map((a) => a.id));
  for (const [clave, alerta] of Object.entries(estado.alertas)) {
    if (alerta.tipo === 'endpoint' || actuales.has(clave)) continue;
    if (alerta.tipo === 'correo' && idsAtascados.has(alerta.id)) {
      delete estado.alertas[clave];
      continue;
    }
    if (comunicar(textoResuelto(alerta))) {
      delete estado.alertas[clave];
      contador.resueltos += 1;
    } else {
      contador.sinAvisar += 1;
    }
  }

  // El parte. Si no hay nada que contar, una sola línea (el registro del cron crece una por pasada)
  const c = contadores;
  const tranquilo = atascados.length + subidas.length + contador.nuevos + contador.resueltos + contador.sinAvisar + purgadas === 0;
  salida(
    `${horaTexto(ahora)} · pasada correcta · conciliadas ${c.conciliadas} · cerrojos liberados ${c.liberados} · reintentados ${c.reintentados}`
    + ` · enviados ${c.enviados} · abandonadas ${c.abandonadas} · pendientes ${c.pendientes}`
    + ` · atascados ${atascados.length} · subidas a medias ${subidas.length}${tranquilo ? ' · sin incidencias' : ''}`,
  );
  lineas.push(...detalle, ...acciones);
  if (purgadas > 0) salida(`  Estado: ${purgadas} entradas sin ver en 24 h olvidadas.`);
  if (!tranquilo || dry) {
    salida(`  Avisos: nuevos ${contador.nuevos} · ya avisados ${contador.repetidos} · resueltos ${contador.resueltos}${contador.sinAvisar ? ` · sin poder avisar ${contador.sinAvisar}` : ''}${dry ? ' (simulacro: no se ha avisado)' : ''}`);
  }

  if (persistir) {
    if (!guardarEstado(config.estado, estado)) salida('  Aviso: no se ha podido guardar el fichero de estado.');
    if (!tocarTestigo(config.testigo, ahora)) salida('  Aviso: no se ha podido tocar el testigo.');
  }
  return { codigo: 0, lineas, contador };
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function principal(argv) {
  const opciones = { dry: false, unaVez: false };
  for (const argumento of argv) {
    if (argumento === '--dry') opciones.dry = true;
    else if (argumento === '--una-vez') opciones.unaVez = true;
    else if (argumento === '--ayuda' || argumento === '-h' || argumento === '--help') {
      console.log(AYUDA);
      return 0;
    } else {
      console.error(`Opción desconocida: ${argumento.slice(0, 40)}\n\n${AYUDA}`);
      return 2;
    }
  }

  const config = leerConfiguracion();
  if (config.error) {
    console.error(`${horaTexto()} · ${config.error}`);
    return 2;
  }
  if (opciones.dry) console.log('SIMULACRO (--dry): se llama a la web, pero no se avisa ni se guarda nada.');
  if (opciones.unaVez) console.log('PASADA SUELTA (--una-vez): se ignora el estado guardado y no se guarda nada.');

  const resultado = await pasar(config, opciones);
  for (const linea of resultado.lineas) console.log(linea);
  return resultado.codigo;
}

principal(process.argv.slice(2)).then(
  (codigo) => { process.exitCode = codigo; },
  () => {
    // Nunca se vuelca la excepción: podría arrastrar la URL
    console.error(`${horaTexto()} · El vigilante ha fallado por un error inesperado.`);
    process.exitCode = 1;
  },
);
