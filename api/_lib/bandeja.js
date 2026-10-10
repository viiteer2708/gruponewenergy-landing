// api/_lib/bandeja.js · Lógica de la bandeja de backoffice (diseño §2.3 «Bandeja» y §2.6).
//
// FLUJO EN LLANO. Backoffice pide un código con su correo (`pedirCodigo`), lo recibe por email y lo teclea
// (`entrar`): si es correcto, el servidor le da una cookie de sesión firmada. Con ella ve la lista (`listar`), la ficha
// de cada contrato con los enlaces de descarga (`ficha`), marca como tramitada o vuelve a pendiente (`cambiarEstado`) y
// reenvía un correo si hizo falta (`reenviarCorreo`).
//
// Las funciones devuelven {status, cuerpo, cabeceras?} y los handlers de api/bandeja/ solo lo escriben en la respuesta
// (igual que tramitacion.js con iniciar/confirmar). Reglas del módulo:
//  - Nadie sabe quién tiene acceso: un correo que no está en BANDEJA_EMAILS recibe EXACTAMENTE la misma respuesta que uno
//    que sí está, y las cuotas se cuentan antes de mirar la lista (si no, el 429 delataría a los autorizados).
//  - El código NUNCA se guarda: en la base solo queda su HMAC (sesion.hashCodigo). Solo en simulación (pruebas) el cuerpo
//    del correo queda en `cuerpo_texto`, para que las pruebas puedan leer el código.
//  - El código no va por cola.intentarEnvio: esa cola regenera el cuerpo desde la tramitación y el código no puede
//    regenerarse (no se guarda). Se envía una vez con el cartero y se anota el resultado en `tramitacion_correos`.
//  - Las cuotas guardan hashes (de la IP y del correo), nunca direcciones.
//  - Todo `mensaje` que ve una persona es una frase en llano. Ni datos personales ni URLs firmadas en los registros del
//    servidor: el único console.error de este módulo escribe frases fijas (textoSeguroDeError).
//  - Todo lo que lee o cambia una tramitación mira SOLO las del modo del servidor: `prueba=false` en producción y
//    `prueba=true` en el servidor de pruebas (esPrueba()).
import { enviarAviso } from './cartero.js';
import { correosDe, reenviar, registrarEvento, textoSeguroDeError } from './cola.js';
import {
  CODIGO_ACCESO, MARCAS, cuota, emailAutorizado, esPrueba, secretoBandeja, simulando,
} from './config.js';
import { ETIQUETA_CORREO, armarCodigo } from './correos.js';
import { transicionValida } from './estados.js';
import { cookiesDe, esHttps, responder } from './http.js';
import { normalizarBusqueda, refValida } from './nombres.js';
import {
  NOMBRE_COOKIE, cookieBorrada, cookieSesion, firmarSesion, generarCodigo, hashCodigo, hashIp, verificarSesion,
} from './sesion.js';
import {
  ErrorSupabase, actualizar, firmarDescargas, insertar, rpc, seleccionar,
} from './supabase.js';
import { esEmail } from './validadores.js';

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export const MENSAJES = Object.freeze({
  sesion: 'Tu sesión ha caducado o no es válida. Vuelve a entrar.',
  peticion: 'No hemos podido leer lo que se ha enviado. Recarga la página e inténtalo de nuevo.',
  formato: 'No hemos podido leer lo que se ha enviado. Recarga la página e inténtalo de nuevo.',
  emailNoValido: 'Escribe un correo electrónico válido.',
  codigoEnviado: 'Si tu correo tiene acceso, te hemos enviado un código de 6 cifras. Caduca en 10 minutos. Revisa también el spam.',
  codigoNoEnviado: 'No hemos podido enviarte el código. Inténtalo de nuevo en un minuto.',
  codigoMalo: 'El código no es correcto o ha caducado. Pide uno nuevo.',
  demasiadosCodigos: 'Has pedido demasiados códigos. Espera un rato antes de pedir otro.',
  demasiadosIntentos: 'Has probado demasiadas veces. Pide un código nuevo.',
  demasiadasEntradas: 'Demasiados intentos desde tu conexión. Espera unos minutos.',
  noExiste: 'No encontramos esta tramitación.',
  transicion: 'Esta tramitación ya no está como creías. Recarga la página para ver cómo está ahora.',
  sinCorreo: 'Este envío todavía no está completo, así que no hay correos que reenviar.',
  temporal: 'No hemos podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.',
  interno: 'Ha ocurrido un problema. Inténtalo de nuevo en un momento.',
});

const resp = (status, cuerpo, cabeceras) => ({ status, cuerpo, ...(cabeceras ? { cabeceras } : {}) });
const fallo = (status, codigo, mensaje, extra = {}) => resp(status, { ok: false, codigo, mensaje, retryable: false, ...extra });
const noExiste = () => fallo(404, 'no_encontrada', MENSAJES.noExiste);

/**
 * Traduce una excepción a la respuesta que ve el navegador (siempre en llano) y apunta en el registro del servidor
 * SOLO de qué tipo fue. Un fallo de Supabase (red, tiempo, rechazo) es `503 temporal`; cualquier otra cosa, `500 interno`.
 */
export function respuestaDeError(error, contexto) {
  console.error(`[bandeja/${contexto}] ${textoSeguroDeError(error)}`);
  if (error instanceof ErrorSupabase) return fallo(503, 'temporal', MENSAJES.temporal, { retryable: true });
  return fallo(500, 'interno', MENSAJES.interno, { retryable: true });
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const primero = (v) => (Array.isArray(v) ? v[0] : v);
const iso = (ms) => new Date(ms).toISOString();
const normalizarEmail = (v) => String(v ?? '').trim().toLowerCase();

/** Parámetros de la URL como objeto: `req.query` (Vercel y servidor local) o, si falta, los de `req.url`. */
export function consultaDe(req) {
  if (req?.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req?.url ?? '/', 'http://local').searchParams);
  } catch {
    return {};
  }
}

/** Cuenta una llamada contra la cuota y dice si sigue dentro del límite (la cuenta vive en la base). */
async function dentroDeCuota(nombre, valor) {
  const { clave, limite, ventanaSeg } = cuota(nombre, valor);
  const dentro = await rpc('tramitacion_cuota', { p_clave: clave, p_limite: limite, p_ventana_seg: ventanaSeg });
  return dentro !== false;
}

/** HMAC de un correo para las cuotas: la tabla de cuotas nunca lleva direcciones. */
const hashEmail = (email, secreto) => hashIp(`correo:${email}`, secreto);

/** La referencia solo vale si es de GNEW o de MEGA (prefijo GNE-/MEGA-); si no, null. */
function formularioDeRef(ref) {
  if (refValida('gnew', ref)) return 'gnew';
  if (refValida('mega', ref)) return 'mega';
  return null;
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

/**
 * Comprueba la cookie de sesión. Devuelve {email} si es auténtica, no ha caducado y el correo SIGUE estando en
 * BANDEJA_EMAILS (se mira en cada petición: quitar a alguien de la lista le cierra la puerta al momento). Si no,
 * responde `401 {codigo:'sesion'}` (y borra la cookie rota, si había una) y devuelve null: el handler debe hacer `return`.
 * Lanza solo si la configuración está mal (BANDEJA_SECRETO / BANDEJA_EMAILS): eso es un 500, no un 401.
 */
export function exigirSesion(req, res) {
  const valor = cookiesDe(req)[NOMBRE_COOKIE];
  const sesion = valor ? verificarSesion(valor, secretoBandeja()) : null;
  if (sesion && emailAutorizado(sesion.email)) return { email: sesion.email };
  const cabeceras = valor ? { 'Set-Cookie': cookieBorrada({ secure: esHttps(req) }) } : {};
  responder(res, 401, { ok: false, codigo: 'sesion', mensaje: MENSAJES.sesion, retryable: false }, cabeceras);
  return null;
}

/**
 * Las peticiones que llevan cuerpo solo valen como `application/json`. Con la cookie SameSite=Lax cierra el CSRF, y
 * un formulario ajeno (que solo puede mandar text/plain o form-urlencoded) nunca llega hasta aquí. Si no es JSON,
 * responde 415 y devuelve false: el handler debe hacer `return`.
 */
export function exigirJson(req, res) {
  const tipo = String(primero(req?.headers?.['content-type']) ?? '').split(';')[0].trim().toLowerCase();
  if (tipo === 'application/json') return true;
  responder(res, 415, { ok: false, codigo: 'peticion', mensaje: MENSAJES.formato, retryable: false });
  return false;
}

// ---------------------------------------------------------------------------
// Pedir el código
// ---------------------------------------------------------------------------

/** Deja un código inutilizable (para el que no llegó a salir por correo). Si no se puede, caduca solo. */
async function quemarAcceso(id) {
  try {
    await actualizar('tramitacion_accesos', { id: `eq.${id}` }, { usado_en: iso(Date.now()) }, { devolver: false });
  } catch {
    // caduca a los 10 minutos
  }
}

/**
 * POST /api/bandeja/codigo {email}. Devuelve {status, cuerpo}:
 *   200 {ok, mensaje}                SIEMPRE la misma, esté o no el correo en la lista (y solo se envía si está)
 *   400 peticion · 400 email         el cuerpo no es lo esperado / no parece un correo
 *   429 demasiados                   cuota por IP (10/h) o por correo (5/h)
 *   503 correo                       Altavoz no ha podido enviar el código
 * El código (6 cifras) sale por Altavoz con marca GNEW, etiqueta `bandeja-codigo` y solo texto. En la base queda su
 * HMAC en `tramitacion_accesos` y una fila `codigo_acceso` en `tramitacion_correos` con cómo salió el correo.
 */
export async function pedirCodigo(entrada, { ip = '' } = {}) {
  const e = esObjeto(entrada) ? entrada : {};
  if (typeof e.email !== 'string') return fallo(400, 'peticion', MENSAJES.peticion);
  const email = normalizarEmail(e.email);
  if (!esEmail(email)) return fallo(400, 'email', MENSAJES.emailNoValido);

  const secreto = secretoBandeja();
  const ipHash = hashIp(ip, secreto);
  // Las dos cuotas se cuentan ANTES de mirar la lista: así el 429 sale igual para cualquier correo
  if (!(await dentroDeCuota('codigoIp', ipHash))) return fallo(429, 'demasiados', MENSAJES.demasiadosCodigos);
  if (!(await dentroDeCuota('codigoEmail', hashEmail(email, secreto)))) return fallo(429, 'demasiados', MENSAJES.demasiadosCodigos);

  const respuestaUnica = () => resp(200, { ok: true, mensaje: MENSAJES.codigoEnviado });
  if (!emailAutorizado(email)) return respuestaUnica(); // misma respuesta, ningún correo

  const codigo = generarCodigo();
  const acceso = (await insertar('tramitacion_accesos', {
    email,
    codigo_hash: hashCodigo(email, codigo, secreto),
    caduca_en: iso(Date.now() + CODIGO_ACCESO.caducaMin * 60_000),
    ip_hash: ipHash,
  }))[0];

  const contenido = armarCodigo(codigo);
  const marca = MARCAS.gnew.marca;
  let resultado;
  try {
    resultado = await enviarAviso({
      marca, para: email, asunto: contenido.asunto, texto: contenido.texto, etiqueta: ETIQUETA_CORREO.codigo_acceso,
    });
  } catch (error) {
    await quemarAcceso(acceso.id); // p. ej. la guarda de «modo prueba sin simulación»: no se queda un código vivo
    throw error;
  }

  const enviado = resultado.estado === 'enviado';
  try {
    await insertar('tramitacion_correos', {
      tramitacion_id: null,
      tipo: 'codigo_acceso',
      marca,
      para: email,
      responder_a: null,
      asunto: contenido.asunto,
      etiqueta: ETIQUETA_CORREO.codigo_acceso,
      // Un código no se reintenta: lo que no salió queda en un estado final (un fallo pasajero cuenta como agotado)
      estado: enviado ? 'enviado' : (resultado.estado === 'pendiente' ? 'agotado' : resultado.estado),
      codigo_respuesta: enviado ? null : (resultado.codigo ?? null),
      intentos: 1,
      ultimo_error: enviado ? null : (resultado.motivo || null),
      altavoz_id: enviado ? resultado.altavoz_id : null,
      simulado: simulando(), // en simulación nada sale de verdad, ni siquiera lo que «falla»: así la limpieza de pruebas lo encuentra
      cuerpo_texto: enviado && resultado.simulado === true ? contenido.texto : null, // SOLO en simulación (las pruebas leen el código de aquí)
      enviado_en: enviado ? iso(Date.now()) : null,
    }, { devolver: false });
  } catch (error) {
    console.error(`[bandeja/codigo] no se ha podido anotar el correo del código: ${textoSeguroDeError(error)}`); // el apunte es solo de ayuda
  }

  if (!enviado) {
    await quemarAcceso(acceso.id);
    return fallo(503, 'correo', MENSAJES.codigoNoEnviado, { retryable: true });
  }

  // El código nuevo anula los anteriores (si esto fallara, siguen siendo válidos hasta que caduquen)
  try {
    await actualizar(
      'tramitacion_accesos',
      { email: `eq.${email}`, usado_en: 'is.null', id: `neq.${acceso.id}` },
      { usado_en: iso(Date.now()) },
      { devolver: false },
    );
  } catch {
    // no pasa nada
  }
  return respuestaUnica();
}

// ---------------------------------------------------------------------------
// Entrar con el código
// ---------------------------------------------------------------------------

/**
 * POST /api/bandeja/entrar {email, codigo}. Devuelve {status, cuerpo, cabeceras}:
 *   200 {ok} + Set-Cookie           el código era correcto: se gasta (un solo uso) y empieza la sesión
 *   401 codigo                      incorrecto, caducado, ya usado o de un correo sin acceso (la misma frase para todo)
 *   429 demasiados                  cuota por IP (20/h) o 5 intentos fallidos sobre el código vigente (se quema)
 * El código se gasta con UN solo PATCH condicionado (`usado_en is null`, sin caducar, menos de 5 intentos): si dos
 * peticiones llegan a la vez con el mismo código, solo una entra.
 */
export async function entrar(entrada, { ip = '', https = false } = {}) {
  const e = esObjeto(entrada) ? entrada : {};
  if (typeof e.email !== 'string' || typeof e.codigo !== 'string') return fallo(400, 'peticion', MENSAJES.peticion);
  const email = normalizarEmail(e.email);
  const codigo = e.codigo.replace(/\s+/g, '');

  const secreto = secretoBandeja();
  if (!(await dentroDeCuota('entrarIp', hashIp(ip, secreto)))) return fallo(429, 'demasiados', MENSAJES.demasiadasEntradas);
  if (!emailAutorizado(email) || !/^\d{6}$/.test(codigo)) return fallo(401, 'codigo', MENSAJES.codigoMalo);

  const ahora = iso(Date.now());
  const gastados = await actualizar('tramitacion_accesos', {
    email: `eq.${email}`,
    codigo_hash: `eq.${hashCodigo(email, codigo, secreto)}`,
    usado_en: 'is.null',
    caduca_en: `gt.${ahora}`,
    intentos: `lt.${CODIGO_ACCESO.maxIntentos}`,
  }, { usado_en: ahora });
  if (gastados.length > 0) {
    return resp(200, { ok: true }, { 'Set-Cookie': cookieSesion(firmarSesion(email, secreto), { secure: https }) });
  }

  // No era el código: se apunta el fallo en el código vigente (el último, sin gastar y sin caducar)
  const [vigente] = await seleccionar('tramitacion_accesos', {
    select: 'id,intentos',
    email: `eq.${email}`,
    usado_en: 'is.null',
    caduca_en: `gt.${ahora}`,
    order: 'creado_en.desc',
    limit: 1,
  });
  if (!vigente) return fallo(401, 'codigo', MENSAJES.codigoMalo);
  if (vigente.intentos >= CODIGO_ACCESO.maxIntentos) return fallo(429, 'demasiados', MENSAJES.demasiadosIntentos);
  const intentos = vigente.intentos + 1;
  // Optimista: solo suma si nadie lo ha cambiado entre medias (si otra petición se adelantó, ya sumó la suya)
  await actualizar(
    'tramitacion_accesos',
    { id: `eq.${vigente.id}`, intentos: `eq.${vigente.intentos}`, usado_en: 'is.null' },
    { intentos },
    { devolver: false },
  );
  return intentos >= CODIGO_ACCESO.maxIntentos
    ? fallo(429, 'demasiados', MENSAJES.demasiadosIntentos) // el 5.º fallo quema el código
    : fallo(401, 'codigo', MENSAJES.codigoMalo);
}

/** POST /api/bandeja/salir: borra la cookie de sesión. */
export function salir({ https = false } = {}) {
  return resp(200, { ok: true }, { 'Set-Cookie': cookieBorrada({ secure: https }) });
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

export const PAGINA = 30;

// Qué estados hay detrás de cada chip. «Todas» deja fuera las descartadas (los envíos que ha parado el filtro antibots
// viven aparte, bajo «Descartadas»).
const ESTADOS_DE_LA_LISTA = Object.freeze({
  pendientes: ['recibida'],
  tramitadas: ['tramitada'],
  incompletas: ['subiendo', 'abandonada'],
  descartadas: ['descartada'],
  todas: ['recibida', 'tramitada', 'subiendo', 'abandonada'],
});

const COLUMNAS_LISTA = 'ref,formulario,estado,compania,titular_nombre,cups,comercial_nombre,tarifa,creada_en,recibida_en,tramitacion_documentos(count)';

// El cursor es la `creada_en` del último elemento tal como la devolvió la base (con microsegundos): se reutiliza el texto
// original, no una fecha de JavaScript (que solo llega al milisegundo y podría saltarse filas).
const RE_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const cursorValido = (v) => typeof v === 'string' && RE_CURSOR.test(v) && Number.isFinite(Date.parse(v));

/** Palabras de la búsqueda: sin tildes, en minúsculas, solo [a-z0-9 @.-], 60 caracteres como mucho y 6 palabras. */
function palabrasDe(q) {
  const limpio = normalizarBusqueda(q).replace(/[^a-z0-9 @.-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return limpio ? limpio.split(' ').slice(0, 6) : [];
}

/**
 * GET /api/bandeja/lista?estado=&q=&antes=. Devuelve {status, cuerpo}:
 *   200 {ok, items:[{ref, formulario, estado, compania, titular_nombre, cups, comercial_nombre, tarifa, creada_en,
 *        recibida_en, n_documentos}], siguiente}      30 por página, de más reciente a más antigua
 *   400 peticion                                        `estado` desconocido o `antes` que no es una fecha
 * `siguiente` es el valor de `antes` para pedir la página siguiente (null si no hay más). `q` busca, palabra a palabra
 * (todas deben aparecer), en titular, CUPS, referencia, comercial y compañía.
 */
export async function listar(consulta = {}) {
  const clave = primero(consulta.estado) ?? 'pendientes';
  if (typeof clave !== 'string' || !Object.hasOwn(ESTADOS_DE_LA_LISTA, clave)) return fallo(400, 'peticion', MENSAJES.peticion);
  const antes = primero(consulta.antes);
  if (antes !== undefined && antes !== '' && !cursorValido(antes)) return fallo(400, 'peticion', MENSAJES.peticion);

  const estados = ESTADOS_DE_LA_LISTA[clave];
  const query = {
    select: COLUMNAS_LISTA,
    prueba: `eq.${esPrueba()}`,
    estado: estados.length === 1 ? `eq.${estados[0]}` : `in.(${estados.join(',')})`,
    order: 'creada_en.desc',
    limit: PAGINA + 1, // una de más para saber si hay otra página
  };
  if (antes) query.creada_en = `lt.${antes}`;
  const palabras = palabrasDe(primero(consulta.q) ?? '');
  if (palabras.length > 0) query.busqueda = palabras.map((p) => `ilike.*${p}*`);

  const filas = await seleccionar('tramitaciones', query);
  const items = filas.slice(0, PAGINA).map((f) => ({
    ref: f.ref,
    formulario: f.formulario,
    estado: f.estado,
    compania: f.compania,
    titular_nombre: f.titular_nombre,
    cups: f.cups,
    comercial_nombre: f.comercial_nombre,
    tarifa: f.tarifa,
    creada_en: f.creada_en,
    recibida_en: f.recibida_en,
    n_documentos: Number(f.tramitacion_documentos?.[0]?.count ?? 0),
  }));
  const siguiente = filas.length > PAGINA ? items[items.length - 1].creada_en : null;
  return resp(200, { ok: true, items, siguiente });
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------

/** Lo que valen los enlaces de descarga firmados: 10 minutos. */
export const SEGUNDOS_ENLACE = 600;
const MAX_EVENTOS = 50;

// Lo que la ficha enseña de la tramitación. NO sale el id, la carpeta del almacén, el hash de la IP, el navegador ni el
// texto de búsqueda. El IBAN sale completo: la ficha es para backoffice y solo se ve con sesión.
const CAMPOS_FICHA = Object.freeze([
  'ref', 'formulario', 'estado', 'sospechosa',
  'comercial_nombre', 'comercial_email',
  'compania', 'cups', 'oferta', 'tarifa', 'tipo_suministro', 'potencias',
  'titular_nombre', 'titular_nif', 'firmante_nombre', 'firmante_nif', 'iban',
  'direccion', 'cp', 'poblacion', 'provincia',
  'telefono', 'email_cliente',
  'cambio_titular', 'nuevo_titular', 'observaciones',
  'creada_en', 'recibida_en', 'tramitada_en', 'tramitada_por', 'actualizada_en',
]);

/** Busca una tramitación por referencia, solo del modo del servidor. null si no existe o la referencia no es válida. */
async function buscarPorRef(ref, select) {
  if (!formularioDeRef(ref)) return null;
  const filas = await seleccionar('tramitaciones', { select, ref: `eq.${ref}`, prueba: `eq.${esPrueba()}`, limit: 1 });
  return filas[0] ?? null;
}

/**
 * GET /api/bandeja/ficha?ref=. Devuelve {status, cuerpo}:
 *   200 {ok, tramitacion, documentos:[{orden, nombre, tamano, tipo_mime, es_firma, subido, url}], correos:[{tipo, estado,
 *        intentos, enviado_en, codigo_respuesta}], eventos:[{tipo, actor, detalle, creado_en}] (los últimos 50, de más
 *        antiguo a más nuevo), enlaces_caducan_en}
 *   404 no_encontrada                    no existe, la referencia no vale, o es de otro modo (prueba / producción)
 * Cada `url` es una firma de descarga (10 minutos) y no lleva el nombre original del archivo: la clave del objeto es
 * <carpeta>/NN.ext y el nombre que ve backoffice vive solo aquí, en `nombre`. Si el almacén no firma, la ficha sale igual
 * con `url: null`.
 */
export async function ficha(ref) {
  const fila = await buscarPorRef(ref, '*,tramitacion_documentos(*)');
  if (!fila) return noExiste();

  const documentos = [...(fila.tramitacion_documentos ?? [])].sort((a, b) => a.orden - b.orden);
  const firmables = documentos.filter((d) => d.estado === 'subido');
  const urls = new Map();
  if (firmables.length > 0) { // firmarDescargas([]) lanza: una descartada no tiene documentos
    try {
      for (const f of await firmarDescargas(firmables.map((d) => d.ruta), SEGUNDOS_ENLACE)) {
        if (f.url) urls.set(f.ruta, f.url);
      }
    } catch (error) {
      console.error(`[bandeja/ficha] no se han podido firmar los enlaces: ${textoSeguroDeError(error)}`);
    }
  }

  const [correos, eventos] = await Promise.all([
    correosDe(fila.id),
    seleccionar('tramitacion_eventos', { select: 'tipo,actor,detalle,creado_en', tramitacion_id: `eq.${fila.id}`, order: 'id.desc', limit: MAX_EVENTOS }),
  ]);

  return resp(200, {
    ok: true,
    tramitacion: Object.fromEntries(CAMPOS_FICHA.map((campo) => [campo, fila[campo] ?? null])),
    documentos: documentos.map((d) => ({
      orden: d.orden,
      nombre: d.nombre,
      tamano: Number(d.tamano_comprobado ?? d.tamano_declarado),
      tipo_mime: d.tipo_mime,
      es_firma: d.es_firma === true,
      subido: d.estado === 'subido',
      url: urls.get(d.ruta) ?? null,
    })),
    correos: correos.map((c) => ({
      tipo: c.tipo,
      estado: c.estado,
      intentos: c.intentos,
      enviado_en: c.enviado_en,
      codigo_respuesta: c.codigo_respuesta,
    })),
    eventos: eventos.reverse(),
    enlaces_caducan_en: urls.size > 0 ? iso(Date.now() + SEGUNDOS_ENLACE * 1000) : null,
  });
}

// ---------------------------------------------------------------------------
// Cambiar el estado
// ---------------------------------------------------------------------------

const ACCIONES = Object.freeze({
  tramitar: Object.freeze({ desde: 'recibida', hacia: 'tramitada', evento: 'tramitada' }),
  reabrir: Object.freeze({ desde: 'tramitada', hacia: 'recibida', evento: 'reabierta' }),
});

/**
 * POST /api/bandeja/estado {ref, accion:'tramitar'|'reabrir'}. `email` es el de la sesión. Devuelve {status, cuerpo}:
 *   200 {ok, estado, tramitada_por, tramitada_en}
 *   400 peticion · 404 no_encontrada · 409 transicion (no estaba en el estado de partida, o alguien se adelantó)
 * Tramitar guarda quién y cuándo; «Volver a pendiente» los borra. En los dos casos queda un evento con el correo de
 * backoffice como autor.
 */
export async function cambiarEstado(entrada, email) {
  const e = esObjeto(entrada) ? entrada : {};
  const accion = typeof e.accion === 'string' && Object.hasOwn(ACCIONES, e.accion) ? ACCIONES[e.accion] : null;
  if (!accion || typeof e.ref !== 'string') return fallo(400, 'peticion', MENSAJES.peticion);

  const actual = await buscarPorRef(e.ref, 'id,estado');
  if (!actual) return noExiste();
  if (actual.estado !== accion.desde || !transicionValida(actual.estado, accion.hacia)) return fallo(409, 'transicion', MENSAJES.transicion);

  const cambios = accion.hacia === 'tramitada'
    ? { estado: 'tramitada', tramitada_en: iso(Date.now()), tramitada_por: email }
    : { estado: 'recibida', tramitada_en: null, tramitada_por: null };
  // Condicionado al estado de partida: si otra persona la cambió justo antes, no se pisa
  const filas = await actualizar('tramitaciones', { id: `eq.${actual.id}`, estado: `eq.${accion.desde}`, prueba: `eq.${esPrueba()}` }, cambios);
  if (filas.length === 0) return fallo(409, 'transicion', MENSAJES.transicion);

  await registrarEvento(actual.id, accion.evento, email, {});
  return resp(200, { ok: true, estado: filas[0].estado, tramitada_por: filas[0].tramitada_por, tramitada_en: filas[0].tramitada_en });
}

// ---------------------------------------------------------------------------
// Volver a enviar un correo
// ---------------------------------------------------------------------------

/**
 * POST /api/bandeja/reenviar {ref, tipo:'aviso'|'acuse'}. `email` es el de la sesión. Devuelve {status, cuerpo}:
 *   200 {ok, estado}                    cómo ha quedado el correo tras el intento (`enviado`, `pendiente`…)
 *   200 {ok, estado:'enviando', ocupado:true}   otro proceso lo está enviando ahora mismo: no se toca
 *   400 peticion · 404 no_encontrada · 409 estado (la tramitación aún no está completa)
 * La cola hace el trabajo (cola.reenviar): deja el correo `pendiente` con los intentos a cero, lo intenta al momento y
 * apunta el evento `aviso_reenviado` / `acuse_reenviado`.
 */
export async function reenviarCorreo(entrada, email) {
  const e = esObjeto(entrada) ? entrada : {};
  if (typeof e.ref !== 'string' || !['aviso', 'acuse'].includes(e.tipo)) return fallo(400, 'peticion', MENSAJES.peticion);

  const actual = await buscarPorRef(e.ref, 'id,estado');
  if (!actual) return noExiste();
  // Antes de estar recibida no hay correos, y reenviar los crearía de golpe (el comercial aún está subiendo)
  if (actual.estado !== 'recibida' && actual.estado !== 'tramitada') return fallo(409, 'estado', MENSAJES.sinCorreo);

  const r = await reenviar(actual.id, e.tipo, { actor: email });
  if (!r.ok) return noExiste();
  if (r.ocupado) return resp(200, { ok: true, estado: 'enviando', ocupado: true });
  return resp(200, { ok: true, estado: r.estado });
}
