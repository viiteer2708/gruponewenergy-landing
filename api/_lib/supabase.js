// api/_lib/supabase.js · Cliente mínimo de Supabase (base de datos y almacén), solo con fetch.
//
// Sin dependencias (nada de supabase-js): cada llamada es un fetch con las cabeceras `apikey` y
// `Authorization: Bearer <service_role>` que salen de config.js. Este módulo corre SOLO en el
// servidor: la clave service_role nunca llega al navegador. Al navegador le llegan las URLs
// firmadas del almacén, que llevan su propio token (vale 2 h) y no necesitan ninguna clave.
//
// Reglas del módulo:
//  - Tope de 10 s por llamada (se cambia con `tope`, en milisegundos).
//  - Los fallos son `ErrorSupabase`: llevan `status` y `codigo` cortos y NUNCA el cuerpo de la
//    respuesta, ni el de la petición, ni la URL (podrían llevar datos personales o tokens).
//  - Este fichero no escribe en ningún registro (nada de console.*).
//
// Dos cosas del almacén que conviene saber (medidas contra el Storage real el 9-oct-2026):
//  - Storage envuelve sus errores: contesta HTTP 400 y el código de verdad va DENTRO del cuerpo
//    (`statusCode:"413"`, `code:"EntityTooLarge"`; `"415"`/`InvalidMimeType`; `"409"`/`KeyAlreadyExists`).
//    Por eso el error guarda el `codigo` corto y, aparte, el `statusInterno`: el `status` HTTP solo engaña.
//  - El permiso de sobrescribir (`x-upsert`) viaja DENTRO del token de la URL firmada, no en la cabecera
//    del PUT: hay que pedirlo al firmar (crearUrlSubida lo hace siempre).
import { supabaseClave, supabaseUrl } from './config.js';

export const BUCKET = 'tramitaciones';
export const TOPE_MS = 10_000;

const CODIGO_VALIDO = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_RUTA = 512;

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Fallo al hablar con Supabase.
 *   status         código HTTP de la respuesta; 0 si no hubo respuesta
 *   codigo         'red' (sin conexión) · 'tiempo' (se pasó el tope) · 'respuesta' (contestó algo que no
 *                  se entiende) · o el `code` corto de PostgREST/Storage (23505, EntityTooLarge…) · o null
 *   statusInterno  el `statusCode` que Storage mete en el cuerpo (413, 415, 409…) o null
 * El mensaje es una frase fija sin datos: se puede escribir en un registro.
 */
export class ErrorSupabase extends Error {
  constructor(mensaje, { status = 0, codigo = null, statusInterno = null } = {}) {
    super(mensaje);
    this.name = 'ErrorSupabase';
    this.status = status;
    this.codigo = codigo;
    this.statusInterno = statusInterno;
  }

  /** ¿Tiene sentido volver a intentarlo? Sin respuesta, 408, 429 y los 5xx sí; el resto (4xx) no. */
  get reintentable() {
    const interno = this.statusInterno ?? 0;
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500 || interno >= 500;
  }
}

/** Saca el `code` corto y el `statusCode` de un cuerpo de error JSON; todo lo demás se descarta. */
function leerError(texto) {
  let cuerpo = null;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = null;
  }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { codigo: null, statusInterno: null };
  const codigo = [cuerpo.code, cuerpo.error].find((v) => typeof v === 'string' && CODIGO_VALIDO.test(v)) ?? null;
  const interno = Number(cuerpo.statusCode);
  return { codigo, statusInterno: Number.isInteger(interno) && interno >= 100 && interno <= 599 ? interno : null };
}

function leerJson(texto, operacion, status) {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErrorSupabase(`Supabase ha contestado algo ilegible (${operacion})`, { status, codigo: 'respuesta' });
  }
}

// ---------------------------------------------------------------------------
// Llamada base
// ---------------------------------------------------------------------------

/**
 * Un fetch con la clave de servicio, el tope y los errores ya traducidos. Devuelve
 * {status, cabeceras, texto, datos} cuando la respuesta es 2xx; en cualquier otro caso lanza ErrorSupabase.
 * Las cabeceras de autenticación van al final: quien llama no puede pisarlas.
 *   binario    el cuerpo de una respuesta 2xx se lee como bytes (`datos`: Buffer) y NO como texto: un archivo leído con
 *              .text() se corrompe. Los errores se leen siempre como texto (son JSON cortos).
 *   maxBytes   (solo con binario) si la respuesta DICE pesar más (Content-Length), se corta sin leerla y se lanza
 *              ErrorSupabase con codigo 'tamano'. Es un freno grueso; la comprobación exacta la hace quien llama.
 */
async function pedir({ metodo, url, cabeceras = {}, cuerpo, tope, operacion, binario = false, maxBytes }) {
  const clave = supabaseClave(); // falta de variable = error de configuración, no de red: se deja subir tal cual
  const headers = { ...cabeceras, apikey: clave, Authorization: `Bearer ${clave}` };
  const limite = Number.isFinite(tope) && tope > 0 ? tope : TOPE_MS;

  let respuesta;
  let texto = '';
  let datos = null;
  let pesaDemasiado = false;
  try {
    // redirect:'error' → si alguna vez redirigen, no se manda la clave a otro sitio
    respuesta = await fetch(url, { method: metodo, headers, body: cuerpo, redirect: 'error', signal: AbortSignal.timeout(limite) });
    if (binario && respuesta.ok) {
      const dicho = Number(respuesta.headers.get('content-length'));
      if (Number.isFinite(maxBytes) && Number.isFinite(dicho) && dicho > maxBytes) {
        pesaDemasiado = true;
        await respuesta.body?.cancel();
      } else {
        datos = Buffer.from(await respuesta.arrayBuffer());
      }
    } else {
      texto = await respuesta.text();
    }
  } catch (error) {
    const agotado = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ErrorSupabase(
      agotado ? `Supabase no ha respondido a tiempo (${operacion})` : `No se ha podido hablar con Supabase (${operacion})`,
      { status: 0, codigo: agotado ? 'tiempo' : 'red' },
    );
  }

  if (pesaDemasiado) {
    throw new ErrorSupabase(`El almacén ha devuelto un objeto más grande de lo esperado (${operacion})`, { status: respuesta.status, codigo: 'tamano' });
  }
  if (!respuesta.ok) {
    const { codigo, statusInterno } = leerError(texto);
    throw new ErrorSupabase(
      `Supabase ha rechazado la operación (${operacion}): HTTP ${respuesta.status}${codigo ? `, ${codigo}` : ''}`,
      { status: respuesta.status, codigo, statusInterno },
    );
  }
  return { status: respuesta.status, cabeceras: respuesta.headers, texto, datos };
}

// ---------------------------------------------------------------------------
// Base de datos (PostgREST)
// ---------------------------------------------------------------------------

/** {a: 'eq.1', b: ['gt.2', 'lt.5']} → 'a=eq.1&b=gt.2&b=lt.5' (las listas repiten la clave; null/undefined se omiten). */
function parametros(query) {
  const p = new URLSearchParams();
  for (const [clave, valor] of Object.entries(query ?? {})) {
    if (valor === undefined || valor === null) continue;
    for (const v of Array.isArray(valor) ? valor : [valor]) p.append(clave, String(v));
  }
  return p.toString();
}

// Claves de la consulta que NO filtran filas: con solo estas, un PATCH o un DELETE tocaría toda la tabla.
const SIN_FILTRO = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

function exigirFiltro(query, operacion) {
  const hay = Object.entries(query ?? {}).some(([k, v]) => !SIN_FILTRO.has(k) && v !== undefined && v !== null && v !== '');
  if (!hay) throw new TypeError(`${operacion} sin filtro: se rechaza para no tocar toda la tabla`);
}

/**
 * Llamada cruda a PostgREST: `rest('GET', 'tramitaciones', {query: {ref: 'eq.GNE-…'}})`.
 *   ruta     tabla ('tramitaciones') o función ('rpc/tramitacion_cuota')
 *   query    parámetros de la URL: {select, order, limit, <columna>: 'eq.valor'…}
 *   cuerpo   se manda como JSON
 *   prefer   texto o lista para la cabecera Prefer ('return=representation', 'resolution=ignore-duplicates'…)
 * Devuelve {status, datos, cabeceras}; `datos` es el JSON de la respuesta (null si vino vacía).
 */
export async function rest(metodo, ruta, { query, cuerpo, prefer, cabeceras, tope } = {}) {
  const verbo = String(metodo ?? '').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(verbo)) throw new RangeError('Método de la base de datos no válido');
  if (typeof ruta !== 'string' || !/^(rpc\/)?[a-z_][a-z0-9_]*$/i.test(ruta)) throw new RangeError('Tabla o función no válida');

  const headers = { Accept: 'application/json', ...cabeceras };
  const preferencias = [].concat(prefer ?? []).filter(Boolean);
  if (preferencias.length) headers.Prefer = preferencias.join(', ');
  let body;
  if (cuerpo !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(cuerpo);
  }
  const texto = parametros(query);
  const operacion = `${verbo} ${ruta}`;
  const r = await pedir({
    metodo: verbo,
    url: `${supabaseUrl()}/rest/v1/${ruta}${texto ? `?${texto}` : ''}`,
    cabeceras: headers,
    cuerpo: body,
    tope,
    operacion,
  });
  return { status: r.status, datos: leerJson(r.texto, operacion, r.status), cabeceras: r.cabeceras };
}

/** Filas de una tabla: `seleccionar('tramitaciones', {select: 'id,estado', ref: 'eq.GNE-…', limit: 1})` → lista (vacía si no hay). */
export async function seleccionar(tabla, query = {}, { tope } = {}) {
  const r = await rest('GET', tabla, { query, tope });
  return r.datos ?? [];
}

/**
 * Inserta una fila o una lista de filas. Devuelve las filas insertadas (o null con `devolver:false`).
 *   onConflict   columna (o lista) de la restricción única, para `duplicados`
 *   duplicados   'ignorar' → si ya existe no hace nada y NO la devuelve (hay que releerla) · 'fusionar' → la actualiza
 */
export async function insertar(tabla, filas, { onConflict, duplicados, devolver = true, tope } = {}) {
  if (filas === null || typeof filas !== 'object') throw new TypeError('Nada que insertar');
  if (Array.isArray(filas) && filas.length === 0) return devolver ? [] : null;
  const prefer = [devolver ? 'return=representation' : 'return=minimal'];
  if (duplicados === 'ignorar') prefer.push('resolution=ignore-duplicates');
  else if (duplicados === 'fusionar') prefer.push('resolution=merge-duplicates');
  else if (duplicados !== undefined) throw new RangeError('Opción «duplicados» no válida');
  const query = onConflict ? { on_conflict: [].concat(onConflict).join(',') } : undefined;
  const r = await rest('POST', tabla, { query, cuerpo: filas, prefer, tope });
  return devolver ? (r.datos ?? []) : null;
}

/**
 * Actualiza las filas que cumplan el filtro y devuelve las que ha tocado (lista vacía = ninguna:
 * así se hace el cerrojo optimista `actualizar('c', {id: 'eq.1', estado: 'eq.pendiente'}, {…})`).
 * Sin ningún filtro lanza TypeError: nunca actualiza toda la tabla.
 */
export async function actualizar(tabla, query, cambios, { devolver = true, tope } = {}) {
  exigirFiltro(query, 'actualizar');
  if (cambios === null || typeof cambios !== 'object' || Array.isArray(cambios)) throw new TypeError('Cambios no válidos');
  const r = await rest('PATCH', tabla, { query, cuerpo: cambios, prefer: devolver ? 'return=representation' : 'return=minimal', tope });
  return devolver ? (r.datos ?? []) : null;
}

/** Borra las filas que cumplan el filtro (devuelve las borradas con `devolver:true`). Sin filtro lanza TypeError. */
export async function borrar(tabla, query, { devolver = false, tope } = {}) {
  exigirFiltro(query, 'borrar');
  const r = await rest('DELETE', tabla, { query, prefer: devolver ? 'return=representation' : 'return=minimal', tope });
  return devolver ? (r.datos ?? []) : null;
}

/** Llama a una función SQL: `rpc('tramitacion_cuota', {p_clave, p_limite, p_ventana_seg})` → lo que devuelva (true/false, filas…). */
export async function rpc(funcion, argumentos = {}, { tope } = {}) {
  if (typeof funcion !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(funcion)) throw new RangeError('Función no válida');
  const r = await rest('POST', `rpc/${funcion}`, { cuerpo: argumentos ?? {}, tope });
  return r.datos;
}

// ---------------------------------------------------------------------------
// Almacén (Storage): bucket privado «tramitaciones»
// ---------------------------------------------------------------------------

const baseAlmacen = () => `${supabaseUrl()}/storage/v1`;

/** Valida una ruta de objeto (sin barras sobrantes, ni «.», ni «..») y la codifica trozo a trozo para la URL. */
function codificarRuta(ruta) {
  if (typeof ruta !== 'string' || ruta.length === 0 || ruta.length > MAX_RUTA) throw new RangeError('Ruta del almacén no válida');
  const trozos = ruta.split('/');
  if (trozos.some((t) => t === '' || t === '.' || t === '..')) throw new RangeError('Ruta del almacén no válida');
  return trozos.map(encodeURIComponent).join('/');
}

/** URL absoluta a partir de la que devuelve Storage (relativa: «/object/sign/…?token=…»). Solo del propio proyecto. */
function urlAbsoluta(url, operacion, status) {
  const absoluta = /^https?:\/\//i.test(url) ? url : `${baseAlmacen()}${url.startsWith('/') ? '' : '/'}${url}`;
  if (!absoluta.startsWith(`${baseAlmacen()}/`)) {
    throw new ErrorSupabase(`El almacén ha devuelto una URL que no es del proyecto (${operacion})`, { status, codigo: 'respuesta' });
  }
  return absoluta;
}

const JSON_CABECERA = Object.freeze({ 'Content-Type': 'application/json' });

/**
 * URL firmada para que el NAVEGADOR suba un archivo directamente al almacén, sin clave:
 *   PUT <url>   con `Content-Type: <tipo permitido del bucket>`   (el cuerpo es el archivo tal cual)
 * Vale 2 h y se puede usar varias veces (cada PUT sobrescribe, porque se firma con x-upsert).
 * Devuelve la URL absoluta (SUPABASE_URL + '/storage/v1' + la url relativa con ?token=… que da Storage).
 */
export async function crearUrlSubida(ruta, { tope } = {}) {
  const operacion = 'firmar subida';
  const r = await pedir({
    metodo: 'POST',
    url: `${baseAlmacen()}/object/upload/sign/${BUCKET}/${codificarRuta(ruta)}`,
    cabeceras: { 'x-upsert': 'true' },
    tope,
    operacion,
  });
  const url = leerJson(r.texto, operacion, r.status)?.url;
  if (typeof url !== 'string' || !url.includes('token=')) {
    throw new ErrorSupabase('El almacén no ha devuelto una URL de subida válida', { status: r.status, codigo: 'respuesta' });
  }
  return urlAbsoluta(url, operacion, r.status);
}

/**
 * Sube un archivo desde el servidor (la firma del comercial). `datos` es un Buffer o Uint8Array;
 * `mime` uno de los tipos permitidos del bucket. Sobrescribe si ya existía. Devuelve {ruta, clave}.
 */
export async function subirObjeto(ruta, datos, mime, { tope } = {}) {
  if (!(datos instanceof Uint8Array)) throw new TypeError('Los datos del objeto deben ser un Buffer o Uint8Array');
  if (typeof mime !== 'string' || !mime) throw new TypeError('Falta el tipo del objeto');
  const operacion = 'subir objeto';
  const r = await pedir({
    metodo: 'POST',
    url: `${baseAlmacen()}/object/${BUCKET}/${codificarRuta(ruta)}`,
    cabeceras: { 'Content-Type': mime, 'x-upsert': 'true' },
    cuerpo: datos,
    tope,
    operacion,
  });
  return { ruta, clave: leerJson(r.texto, operacion, r.status)?.Key ?? null };
}

/**
 * Descarga un objeto del bucket privado desde el servidor (con la clave de servicio) y lo devuelve como Buffer: así
 * se leen los documentos para adjuntarlos al aviso. Un objeto que no existe es un ErrorSupabase (Storage contesta
 * HTTP 400 con `statusInterno` 404). `maxBytes` corta antes de leer si el objeto dice pesar más; el tamaño EXACTO
 * lo comprueba quien llama contra `tamano_comprobado`. Tope de 10 s por defecto (`tope` en milisegundos).
 */
export async function descargarObjeto(ruta, { tope, maxBytes } = {}) {
  const r = await pedir({
    metodo: 'GET',
    url: `${baseAlmacen()}/object/${BUCKET}/${codificarRuta(ruta)}`,
    tope,
    operacion: 'descargar objeto',
    binario: true,
    maxBytes,
  });
  return r.datos;
}

/** Quita barras de los lados y valida el prefijo de una carpeta. */
function normalizarCarpeta(carpeta) {
  const limpia = String(carpeta ?? '').replace(/^\/+|\/+$/g, '');
  codificarRuta(limpia); // solo para validar
  return limpia;
}

const PAGINA = 100;
const MAX_PAGINAS = 20;

/**
 * Objetos que hay dentro de una carpeta (no recursivo): `[{nombre, tamano, mime}]` con el nombre
 * RELATIVO a la carpeta ('01.pdf'), el tamaño real en bytes (`metadata.size`) y el tipo guardado,
 * ordenados por nombre. Una carpeta que no existe o está vacía da una lista vacía.
 * `incluirCarpetas:true` añade también las subcarpetas (que en Storage no son más que prefijos):
 * vienen como {nombre, tamano:null, mime:null, carpeta:true}. Sirve para recorrer un árbol al limpiar.
 */
export async function listarCarpeta(carpeta, { incluirCarpetas = false, tope } = {}) {
  const prefijo = normalizarCarpeta(carpeta);
  const operacion = 'listar carpeta';
  const salida = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const r = await pedir({
      metodo: 'POST',
      url: `${baseAlmacen()}/object/list/${BUCKET}`,
      cabeceras: JSON_CABECERA,
      cuerpo: JSON.stringify({ prefix: prefijo, limit: PAGINA, offset: pagina * PAGINA, sortBy: { column: 'name', order: 'asc' } }),
      tope,
      operacion,
    });
    const filas = leerJson(r.texto, operacion, r.status);
    if (!Array.isArray(filas)) throw new ErrorSupabase('El almacén ha devuelto un listado que no se entiende', { status: r.status, codigo: 'respuesta' });
    for (const o of filas) {
      if (!o || typeof o.name !== 'string') continue;
      if (!o.id) { // las carpetas llegan sin id y con metadata nula
        if (incluirCarpetas) salida.push({ nombre: o.name, tamano: null, mime: null, carpeta: true });
        continue;
      }
      const tamano = Number(o.metadata?.size);
      salida.push({ nombre: o.name, tamano: Number.isFinite(tamano) ? tamano : null, mime: o.metadata?.mimetype ?? null });
    }
    if (filas.length < PAGINA) break;
  }
  return salida;
}

/**
 * Firma de descarga, por lote, de una lista de rutas (`seg` segundos, 600 por defecto).
 * Devuelve una entrada por ruta y en el mismo orden: `{ruta, url, error}` con la URL ABSOLUTA
 * (lista para un GET desde el navegador, sin clave) o `url:null` y un `error` corto si esa ruta
 * no existe. Un objeto que falta no hace fallar al resto.
 */
export async function firmarDescargas(rutas, seg = 600, { tope } = {}) {
  if (!Array.isArray(rutas) || rutas.length === 0 || rutas.length > 200) throw new RangeError('Lista de rutas no válida');
  rutas.forEach(codificarRuta); // solo valida
  if (!Number.isInteger(seg) || seg < 1 || seg > 7 * 24 * 3600) throw new RangeError('Duración de la firma no válida');
  const operacion = 'firmar descargas';
  const r = await pedir({
    metodo: 'POST',
    url: `${baseAlmacen()}/object/sign/${BUCKET}`,
    cabeceras: JSON_CABECERA,
    cuerpo: JSON.stringify({ expiresIn: seg, paths: rutas }),
    tope,
    operacion,
  });
  const filas = leerJson(r.texto, operacion, r.status);
  if (!Array.isArray(filas)) throw new ErrorSupabase('El almacén ha devuelto firmas que no se entienden', { status: r.status, codigo: 'respuesta' });
  const porRuta = new Map(filas.filter((f) => f && typeof f.path === 'string').map((f) => [f.path, f]));
  return rutas.map((ruta) => {
    const f = porRuta.get(ruta);
    if (f && typeof f.signedURL === 'string' && f.signedURL) return { ruta, url: urlAbsoluta(f.signedURL, operacion, r.status), error: null };
    const motivo = typeof f?.error === 'string' && f.error ? f.error.slice(0, 120) : 'El almacén no ha firmado este objeto';
    return { ruta, url: null, error: motivo };
  });
}

/**
 * Borra objetos por su ruta EXACTA (hasta 1000 de una vez): pasar el nombre de una carpeta no borra nada
 * (medido contra el Storage real el 9-oct-2026). Lo que no existe se ignora.
 * Devuelve las rutas que el almacén dice haber borrado.
 */
export async function borrarObjetos(rutas, { tope } = {}) {
  if (!Array.isArray(rutas)) throw new TypeError('Hace falta una lista de rutas');
  if (rutas.length === 0) return [];
  if (rutas.length > 1000) throw new RangeError('Demasiados objetos a la vez');
  rutas.forEach(codificarRuta); // solo valida la forma de cada ruta (sin «..», sin huecos)
  const operacion = 'borrar objetos';
  const r = await pedir({
    metodo: 'DELETE',
    url: `${baseAlmacen()}/object/${BUCKET}`,
    cabeceras: JSON_CABECERA,
    cuerpo: JSON.stringify({ prefixes: rutas }),
    tope,
    operacion,
  });
  const filas = leerJson(r.texto, operacion, r.status);
  return Array.isArray(filas) ? filas.map((o) => o?.name).filter((n) => typeof n === 'string') : [];
}
