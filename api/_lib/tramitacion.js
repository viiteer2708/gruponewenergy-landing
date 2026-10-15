// api/_lib/tramitacion.js · Lógica de `iniciar` y `confirmar` (diseño §2.3).
//
// FLUJO EN LLANO. El navegador (1) manda los datos del contrato y la lista de archivos a `iniciar`; el servidor
// los apunta en la base y devuelve una URL firmada por archivo; (2) el navegador sube cada archivo DIRECTAMENTE
// al almacén (Vercel corta a 4,5 MB); (3) llama a `confirmar`, y solo cuando el servidor ve en el almacén todos los
// archivos con el tamaño declarado, la tramitación pasa a `recibida` y se crean el aviso y el acuse.
// Desde ese instante el contrato está a salvo aunque el correo tarde (cola.js + vigilante).
//
// Todo es IDEMPOTENTE: repetir `iniciar` o `confirmar` con la misma referencia nunca duplica filas ni correos.
//
// Funciones: iniciar() y confirmar() devuelven {status, cuerpo} (los handlers solo lo escriben en la respuesta).
//            comprobarAlmacen() y mapearDatos() también se exportan para las pruebas.
// Reglas:
//  - Lo que ve una persona (los `mensaje`) es siempre en llano: nunca un mensaje técnico.
//  - Ni datos personales, ni cuerpos, ni URLs firmadas en ningún registro: el único console.error de este
//    módulo está en respuestaDeError y escribe frases fijas (ver textoSeguroDeError en cola.js).
import { despachar, registrarEvento, textoSeguroDeError } from './cola.js';
import { LIMITES, MARCAS, cuota, esPrueba, secretoBandeja, tokenValido } from './config.js';
import {
  carpetaDe, enUnaLinea, extensionDe, mimeDe, nonce, normalizarBusqueda, recortar, refValida, rutaDe, sanearNombre,
} from './nombres.js';
import { hashIp } from './sesion.js';
import {
  ErrorSupabase, actualizar, crearUrlSubida, insertar, listarCarpeta, rpc, seleccionar, subirObjeto,
} from './supabase.js';
import { FRASES, tipoSuministroDe, validarDatos } from './validadores.js';

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

const MENSAJES = Object.freeze({
  peticion: 'No hemos podido leer lo que se ha enviado. Recarga la página e inténtalo de nuevo.',
  noAutorizado: 'No se ha podido enviar el formulario. Recarga la página e inténtalo de nuevo.',
  datos: 'Revisa los campos marcados en el formulario.',
  limites: `La documentación supera el máximo: ${LIMITES.maxArchivos} archivos, ${LIMITES.maxBytesArchivo / MIB} MB por archivo y ${LIMITES.maxBytesContrato / MIB} MB en total`,
  demasiados: 'Se han recibido demasiados envíos desde tu conexión. Espera unos minutos.',
  listaDistinta: 'Los documentos de este envío han cambiado. Vamos a preparar un envío nuevo.',
  faltanArchivos: 'Todavía faltan documentos por llegar. Seguimos subiéndolos.',
  desconocida: 'No encontramos este envío. Vamos a prepararlo de nuevo.',
  temporal: 'No hemos podido guardar el envío ahora mismo. Inténtalo de nuevo en un momento.',
  interno: 'Ha ocurrido un problema al guardar el envío. Inténtalo de nuevo en un momento.',
  archivoNoValido: 'Hay un documento que no se ha podido preparar. Quítalo y vuelve a adjuntarlo.',
  archivoVacio: 'Hay un documento vacío. Quítalo y vuelve a adjuntarlo.',
  tipoNoAdmitido: 'Solo se admiten documentos PDF, JPG, PNG, DOC o DOCX.',
  firmaNoValida: 'La firma no es válida. Bórrala y vuelve a firmar.',
});

const resp = (status, cuerpo) => ({ status, cuerpo });
const fallo = (status, codigo, mensaje, extra = {}) => resp(status, { ok: false, codigo, mensaje, retryable: false, ...extra });
const desconocida = () => fallo(404, 'desconocida', MENSAJES.desconocida, { retryable: true });
const temporal = () => fallo(503, 'temporal', MENSAJES.temporal, { retryable: true });

/**
 * Traduce una excepción a la respuesta que ve el navegador (siempre en llano) y apunta en el registro del
 * servidor SOLO de qué tipo fue. Un fallo de Supabase (red, tiempo, rechazo) es `503 temporal` y se reintenta;
 * cualquier otra cosa es `500 interno`. Devuelve {status, cuerpo}.
 */
export function respuestaDeError(error, contexto) {
  console.error(`[tramitacion/${contexto}] ${textoSeguroDeError(error)}`);
  if (error instanceof ErrorSupabase) return temporal();
  return fallo(500, 'interno', MENSAJES.interno, { retryable: true });
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// toWellFormed(): un carácter Unicode suelto («\ud800») no se puede guardar en Postgres y daría un 503 innecesario; pasa a «\ufffd»
const cadena = (v) => (typeof v === 'string' ? v.toWellFormed() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const linea = (v, max = 300) => recortar(enUnaLinea(cadena(v)), max);
const multilinea = (v, max) => recortar(
  cadena(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ').trim(),
  max,
);
const vacioANull = (s) => (s === '' ? null : s);
// Lo que escribe el comercial se guarda EN MAYÚSCULAS (decisión de Victor, 15-oct-2026: en el CRM todo va en mayúsculas). `toUpperCase()`
// conserva las tildes y la Ñ («Peñíscola» → «PEÑÍSCOLA»). Se pasa a mayúsculas DESPUÉS de recortar, y siempre DENTRO de `vacioANull`
// (nunca fuera: `vacioANull` puede devolver null): un campo vacío sigue siendo null.
const lineaMayus = (v, max) => linea(v, max).toUpperCase();
const multilineaMayus = (v, max) => multilinea(v, max).toUpperCase();
const compactarId = (v) => linea(v, 30).toUpperCase().replace(/[\s.-]/g, '');
const iso = (ms) => new Date(ms).toISOString();

/** Cuenta una llamada contra la cuota y dice si sigue dentro del límite (la cuenta vive en la base). */
async function dentroDeCuota(nombre, valor) {
  const { clave, limite, ventanaSeg } = cuota(nombre, valor);
  const dentro = await rpc('tramitacion_cuota', { p_clave: clave, p_limite: limite, p_ventana_seg: ventanaSeg });
  return dentro !== false;
}

/** Referencia nueva (solo para los envíos de bots sin una referencia válida). */
function refNueva(formulario) {
  const dia = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${MARCAS[formulario].prefijoRef}-${dia}-${nonce(6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Datos del formulario → columnas de `tramitaciones`
// ---------------------------------------------------------------------------

/**
 * Pasa lo que manda el formulario (los `name` de los inputs) a las columnas de la tabla. Es tolerante a
 * propósito: con datos ausentes o raros devuelve '' en los textos obligatorios (los envíos de bots llegan así
 * hasta la fila `descartada`, que tiene columnas NOT NULL). La validación estricta es validarDatos().
 *   · textos de una línea sin saltos ni caracteres de control; cada uno recortado a su máximo
 *   · TODO lo que escribe el comercial se guarda EN MAYÚSCULAS, con sus tildes y la Ñ («Peñíscola» → «PEÑÍSCOLA»): nombre del
 *     comercial, compañía, oferta, tarifa, titular, firmante, dirección, población, provincia, código postal, teléfono, nuevo
 *     titular y observaciones (que conservan sus saltos de línea). Se pasa a mayúsculas DESPUÉS de recortar y los opcionales
 *     vacíos siguen siendo null. Decisión de Victor del 15-oct-2026 (en el CRM se escribe todo en mayúsculas). De esta fila
 *     salen la bandeja, el aviso a backoffice (con su asunto) y el acuse al comercial: por eso el cambio vive SOLO aquí
 *   · EXCEPCIÓN: los correos electrónicos (comercial_email y email_cliente) van en minúsculas; el acuse se manda a comercial_email
 *   · CUPS, NIF/NIE/CIF e IBAN compactados y en mayúsculas
 *   · potencias: solo las rellenas, con coma → punto, tal como se tecleó
 *   · MEGA: compañía fija y tipo de suministro deducido de la tarifa TAL CUAL llega (antes de pasarla a mayúsculas) y guardado
 *     en mayúsculas (LUZ / GAS)
 */
export function mapearDatos(formulario, datos) {
  const d = esObjeto(datos) ? datos : {};
  const potencias = {};
  for (const clave of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    const valor = linea(d[clave], 20).replace(/,/g, '.');
    if (valor) potencias[clave] = valor;
  }
  const tarifa = linea(d.tarifa, 100); // tal cual llega: tipoSuministroDe la mira así (la lista de tarifas de MEGA está en mayúsculas)
  return {
    comercial_nombre: lineaMayus(d.quien_eres, 200),
    comercial_email: linea(d.email_comercial, 254).toLowerCase(),
    compania: formulario === 'mega' ? MARCAS.mega.compania : lineaMayus(d.compania, 100),
    cups: linea(d.cups, 40).toUpperCase().replace(/\s/g, ''),
    oferta: vacioANull(lineaMayus(d.oferta, 200)),
    tarifa: vacioANull(tarifa.toUpperCase()),
    tipo_suministro: formulario === 'mega' ? vacioANull(tipoSuministroDe(tarifa).toUpperCase()) : null,
    potencias,
    titular_nombre: lineaMayus(d.titular, 250),
    titular_nif: compactarId(d.cif_nif),
    firmante_nombre: vacioANull(lineaMayus(d.nombre_firmante, 200)),
    firmante_nif: vacioANull(compactarId(d.dni_firmante)),
    iban: linea(d.cuenta_bancaria, 50).toUpperCase().replace(/\s/g, ''),
    direccion: lineaMayus(d.dir_suministro, 300),
    cp: lineaMayus(d.codigo_postal, 10),
    poblacion: lineaMayus(d.poblacion, 100),
    provincia: lineaMayus(d.provincia, 100),
    telefono: lineaMayus(d.movil, 30),
    email_cliente: linea(d.email_cliente, 254).toLowerCase(),
    cambio_titular: ['si', 'sí'].includes(linea(d.cambio_titular, 10).toLowerCase()),
    nuevo_titular: vacioANull(lineaMayus(d.nuevo_titular, 500)),
    observaciones: vacioANull(multilineaMayus(d.observaciones, 4000)),
  };
}

/** Texto en el que busca la bandeja: titular, CUPS, referencia, comercial y compañía, sin tildes y en minúsculas. */
const busquedaDe = (datos, ref) => normalizarBusqueda([datos.titular_nombre, datos.cups, ref, datos.comercial_nombre, datos.compania].join(' '));

/** Orden estable de las claves, para comparar valores JSON (los jsonb vuelven con otro orden de claves). */
function estable(valor) {
  if (Array.isArray(valor)) return valor.map(estable);
  if (esObjeto(valor)) return Object.fromEntries(Object.keys(valor).sort().map((k) => [k, estable(valor[k])]));
  return valor;
}
const mismoValor = (a, b) => JSON.stringify(estable(a ?? null)) === JSON.stringify(estable(b ?? null));

// ---------------------------------------------------------------------------
// Archivos y firma
// ---------------------------------------------------------------------------

/**
 * Valida y normaliza la lista de archivos que manda el navegador. Devuelve
 *   {archivos: [{orden, nombre, ext, mime, tamano, tamano_original, comprimido}]}          si es válida
 *   {error: 'limites'}                                                                      si pasa de 15 archivos / 25 MiB por archivo / 60 MiB en total
 *   {error: 'campo', frase}                                                                  si hay algo que corregir (se muestra en «documentación»)
 * Los topes son los del almacén (file_size_limit = 26.214.400 B = 25 MiB): nunca se acepta aquí algo que el almacén rechazaría.
 */
function analizarArchivos(archivos) {
  const lista = Array.isArray(archivos) ? archivos : [];
  if (lista.length === 0) return { error: 'campo', frase: FRASES.documentos };
  if (lista.length > LIMITES.maxArchivos) return { error: 'limites' };

  const salida = [];
  const ordenes = new Set();
  let total = 0;
  for (const a of lista) {
    if (!esObjeto(a)) return { error: 'campo', frase: MENSAJES.archivoNoValido };
    const { orden, tamano } = a;
    if (!Number.isInteger(orden) || orden < 1 || orden > 99 || ordenes.has(orden)) return { error: 'campo', frase: MENSAJES.archivoNoValido };
    if (typeof a.nombre !== 'string' || !a.nombre.trim() || !Number.isSafeInteger(tamano)) return { error: 'campo', frase: MENSAJES.archivoNoValido };
    if (tamano < 1) return { error: 'campo', frase: MENSAJES.archivoVacio };
    if (tamano > LIMITES.maxBytesArchivo) return { error: 'limites' };
    total += tamano;
    if (total > LIMITES.maxBytesContrato) return { error: 'limites' };

    const nombre = sanearNombre(a.nombre);
    const ext = extensionDe(nombre);
    const mime = mimeDe(ext);
    if (!mime) return { error: 'campo', frase: MENSAJES.tipoNoAdmitido };

    ordenes.add(orden);
    const original = Number.isSafeInteger(a.tamano_original) && a.tamano_original > tamano ? a.tamano_original : null;
    salida.push({ orden, nombre, ext, mime, tamano, tamano_original: original, comprimido: original !== null });
  }
  return { archivos: salida.sort((x, y) => x.orden - y.orden) };
}

const PREFIJO_FIRMA = 'data:image/png;base64,';
const CABECERA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** La firma es opcional ('' = sin firma). Con firma: un PNG en data URL, de hasta 2 M de caracteres. {ok, datos: Buffer|null} */
function analizarFirma(firma) {
  if (firma === undefined || firma === null || firma === '') return { ok: true, datos: null };
  if (typeof firma !== 'string' || firma.length > LIMITES.maxCaracteresFirma || !firma.startsWith(PREFIJO_FIRMA)) return { ok: false };
  const base64 = firma.slice(PREFIJO_FIRMA.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { ok: false };
  const datos = Buffer.from(base64, 'base64');
  if (datos.length < CABECERA_PNG.length || !datos.subarray(0, CABECERA_PNG.length).equals(CABECERA_PNG)) return { ok: false };
  return { ok: true, datos };
}

// ---------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------

/**
 * Compara cada documento con lo que HAY en el almacén (un solo listado de la carpeta): un objeto con el
 * nombre `NN.ext` y el tamaño declarado. Devuelve una entrada por documento y en el mismo orden:
 *   {doc, ok, motivo, tamano}   motivo: null · 'no_subido' (no está) · 'tamano_distinto' (está, pero pesa otra cosa)
 *   tamano: lo que mide en el almacén (null si no está)
 */
export async function comprobarAlmacen(carpeta, documentos) {
  const objetos = new Map((await listarCarpeta(carpeta)).map((o) => [o.nombre, o]));
  return documentos.map((doc) => {
    const objeto = objetos.get(doc.ruta.slice(carpeta.length + 1));
    if (!objeto) return { doc, ok: false, motivo: 'no_subido', tamano: null };
    if (objeto.tamano !== Number(doc.tamano_declarado)) return { doc, ok: false, motivo: 'tamano_distinto', tamano: objeto.tamano };
    return { doc, ok: true, motivo: null, tamano: objeto.tamano };
  });
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const documentosDe = (id) => seleccionar('tramitacion_documentos', { tramitacion_id: `eq.${id}`, order: 'orden.asc' });

/** La tramitación y sus documentos (por orden) a partir de la referencia, o null. */
async function cargarPorRef(formulario, ref) {
  const filas = await seleccionar('tramitaciones', {
    select: '*,tramitacion_documentos(*)', ref: `eq.${ref}`, formulario: `eq.${formulario}`, limit: 1,
  });
  if (filas.length === 0) return null;
  const { tramitacion_documentos: documentos, ...tramitacion } = filas[0];
  return { tramitacion, documentos: [...(documentos ?? [])].sort((a, b) => a.orden - b.orden) };
}

/** ¿Es la misma lista (orden, nombre saneado, tamaño) la que hay en la base que la que llega? */
function mismaLista(docsBase, archivos) {
  if (docsBase.length !== archivos.length) return false;
  const ordenados = [...docsBase].sort((a, b) => a.orden - b.orden);
  return archivos.every((a, i) => ordenados[i].orden === a.orden && ordenados[i].nombre === a.nombre && Number(ordenados[i].tamano_declarado) === a.tamano);
}

const estaCerrada = (estado) => estado === 'recibida' || estado === 'tramitada';

// ---------------------------------------------------------------------------
// iniciar
// ---------------------------------------------------------------------------

/** Un bot ha rellenado el campo trampa: éxito falso (como siempre), pero la fila queda `descartada` por si fuera un falso positivo. */
async function descartar(formulario, entrada, { ipHash, navegador }) {
  const ref = refValida(formulario, entrada.ref) ? entrada.ref : refNueva(formulario);
  const datos = mapearDatos(formulario, entrada.datos);
  const nuevas = await insertar('tramitaciones', {
    ref,
    formulario,
    estado: 'descartada',
    prueba: esPrueba(),
    sospechosa: true,
    carpeta: carpetaDe({ prueba: esPrueba(), formulario, ref, nonce: nonce(10) }),
    ...datos,
    busqueda: busquedaDe(datos, ref),
    ip_hash: ipHash,
    navegador: navegador ? recortar(enUnaLinea(navegador), 200) : null,
  }, { onConflict: 'ref', duplicados: 'ignorar' });
  if (nuevas[0]) await registrarEvento(nuevas[0].id, 'descartada', 'sistema', { motivo: 'honeypot' });
  return resp(200, { ok: true, ref, estado: 'recibida', listo: true });
}

/** `ref_anterior`: el comercial cambió la lista de archivos; su envío anterior (si sigue subiendo y es suyo) queda «Incompleta». */
async function abandonarAnterior(formulario, refAnterior, nuevaRef, emailComercial) {
  const filas = await actualizar('tramitaciones', {
    ref: `eq.${refAnterior}`,
    formulario: `eq.${formulario}`,
    estado: 'eq.subiendo',
    comercial_email: `eq.${emailComercial}`, // «no de otra persona»
    prueba: `eq.${esPrueba()}`,
  }, { estado: 'abandonada' });
  if (filas[0]) await registrarEvento(filas[0].id, 'abandonada', 'comercial', { motivo: 'lista_cambiada', nueva_ref: nuevaRef });
}

/**
 * POST /api/tramitacion/iniciar. Devuelve {status, cuerpo}:
 *   200 {ok, ref, estado:'subiendo', listo:false, subidas:[{orden, nombre, url, tipo_mime, ya_subido}]}
 *   200 {ok, ref, estado:'recibida'|'tramitada', listo:true}        (ya estaba cerrada, o era un bot)
 *   400 datos (campos) · 400 peticion · 401 no_autorizado · 409 lista_distinta · 413 limites · 429 demasiados · 503 temporal
 * Lanza ErrorSupabase si la base falla (el handler lo convierte en 503).
 */
export async function iniciar(entrada, { ip = '', navegador = '' } = {}) {
  const e = esObjeto(entrada) ? entrada : {};
  const formulario = e.formulario;

  // 1. Token (frena a los bots tontos)
  if (!tokenValido(formulario, e.token)) return fallo(401, 'no_autorizado', MENSAJES.noAutorizado);

  // 2. Cuota por IP (la IP nunca se guarda: solo su HMAC)
  const ipHash = hashIp(ip, secretoBandeja());
  if (!(await dentroDeCuota('iniciar', ipHash))) return fallo(429, 'demasiados', MENSAJES.demasiados);

  // 3. Honeypot
  if (typeof e.hp === 'string' && e.hp.trim() !== '') return descartar(formulario, e, { ipHash, navegador });

  // 4. Validación de servidor
  if (!refValida(formulario, e.ref)) return fallo(400, 'peticion', MENSAJES.peticion);
  const ref = e.ref;
  const refAnterior = refValida(formulario, e.ref_anterior) && e.ref_anterior !== ref ? e.ref_anterior : null;

  const campos = { ...validarDatos(formulario, e.datos).campos };
  const lista = analizarArchivos(e.archivos);
  if (lista.error === 'limites') return fallo(413, 'limites', MENSAJES.limites);
  if (lista.error) campos.documentacion = lista.frase;
  const firma = analizarFirma(e.firma);
  if (!firma.ok) campos.firma = MENSAJES.firmaNoValida;
  if (Object.keys(campos).length > 0) return fallo(400, 'datos', MENSAJES.datos, { campos });

  const datos = mapearDatos(formulario, e.datos);
  const { archivos } = lista;
  const firmaPng = firma.datos;

  // 5. La lista cambió: el envío anterior queda «Incompleta»
  if (refAnterior) await abandonarAnterior(formulario, refAnterior, ref, datos.comercial_email);

  // 6. La fila: se intenta insertar; si la referencia ya existía, no se hace nada y se relee
  const nuevas = await insertar('tramitaciones', {
    ref,
    formulario,
    estado: 'subiendo',
    prueba: esPrueba(),
    sospechosa: false,
    carpeta: carpetaDe({ prueba: esPrueba(), formulario, ref, fecha: new Date(), nonce: nonce(10) }),
    ...datos,
    busqueda: busquedaDe(datos, ref),
    ip_hash: ipHash,
    navegador: navegador ? recortar(enUnaLinea(navegador), 200) : null,
  }, { onConflict: 'ref', duplicados: 'ignorar' });
  const esNueva = nuevas.length > 0;
  const existente = esNueva ? null : await cargarPorRef(formulario, ref);
  let actual = nuevas[0] ?? existente?.tramitacion ?? null;
  if (!actual) return temporal(); // existía y desapareció entre las dos llamadas: que el navegador lo repita
  if (esNueva) {
    await registrarEvento(actual.id, 'creada', 'comercial', { n_documentos: archivos.length + (firmaPng ? 1 : 0), con_firma: firmaPng !== null });
  }

  // 7. Según cómo estuviera
  if (estaCerrada(actual.estado)) return resp(200, { ok: true, ref, estado: actual.estado, listo: true });
  if (actual.estado === 'descartada') return resp(200, { ok: true, ref, estado: 'recibida', listo: true });

  let docs = esNueva ? [] : existente.documentos;
  const yaHabia = docs.filter((d) => d.orden >= 1);
  if (yaHabia.length > 0 && !mismaLista(yaHabia, archivos)) return fallo(409, 'lista_distinta', MENSAJES.listaDistinta);

  if (!esNueva) {
    // Se compara la lista ANTES de tocar nada: un 409 no deja la fila cambiada
    const nuevosValores = { ...datos, busqueda: busquedaDe(datos, ref) };
    const cambiados = Object.keys(nuevosValores).filter((k) => !mismoValor(actual[k], nuevosValores[k]));
    let filas = null;
    if (actual.estado === 'abandonada') {
      filas = await actualizar('tramitaciones', { id: `eq.${actual.id}`, estado: 'eq.abandonada' }, { estado: 'subiendo', ...nuevosValores });
      if (filas[0]) await registrarEvento(actual.id, 'reanudada', 'comercial', {});
    } else if (cambiados.length > 0) {
      filas = await actualizar('tramitaciones', { id: `eq.${actual.id}`, estado: 'eq.subiendo' }, nuevosValores);
      if (filas[0]) await registrarEvento(actual.id, 'datos_actualizados', 'comercial', { campos: cambiados.filter((k) => k !== 'busqueda') });
    }
    if (filas && filas.length === 0) {
      // Otra petición con la misma referencia la cambió entre medias: se mira cómo ha quedado
      const releida = await cargarPorRef(formulario, ref);
      if (!releida) return temporal();
      if (estaCerrada(releida.tramitacion.estado)) return resp(200, { ok: true, ref, estado: releida.tramitacion.estado, listo: true });
      if (releida.tramitacion.estado !== 'subiendo') return temporal();
      actual = releida.tramitacion;
    } else if (filas?.[0]) {
      actual = filas[0];
    }
  }

  // 8. Documentos (idempotente: dos peticiones a la vez dejan una sola lista)
  if (yaHabia.length === 0) {
    await insertar('tramitacion_documentos', archivos.map((a) => ({
      tramitacion_id: actual.id,
      orden: a.orden,
      nombre: a.nombre,
      ruta: rutaDe(actual.carpeta, a.orden, a.ext),
      tipo_mime: a.mime,
      tamano_declarado: a.tamano,
      tamano_original: a.tamano_original,
      comprimido: a.comprimido,
      es_firma: false,
      estado: 'pendiente',
    })), { onConflict: ['tramitacion_id', 'orden'], duplicados: 'ignorar', devolver: false });
    docs = await documentosDe(actual.id);
    if (!mismaLista(docs.filter((d) => d.orden >= 1), archivos)) return fallo(409, 'lista_distinta', MENSAJES.listaDistinta);
  }

  // 9. Qué hay ya en el almacén (una fila nueva no puede tener nada: la carpeta lleva un nonce recién creado)
  const comprobaciones = esNueva
    ? docs.map((doc) => ({ doc, ok: false, motivo: 'no_subido', tamano: null }))
    : await comprobarAlmacen(actual.carpeta, docs);

  // 10. La firma la sube el servidor (es un PNG pequeño); si ya está guardada con ese tamaño, no se repite
  if (firmaPng) {
    const doc0 = docs.find((d) => d.orden === 0);
    const guardada = doc0 !== undefined
      && Number(doc0.tamano_declarado) === firmaPng.length
      && comprobaciones.find((c) => c.doc.id === doc0.id)?.ok === true;
    if (!guardada) {
      const ruta = rutaDe(actual.carpeta, 0, 'png');
      await subirObjeto(ruta, firmaPng, 'image/png');
      await insertar('tramitacion_documentos', {
        tramitacion_id: actual.id,
        orden: 0,
        nombre: 'firma.png',
        ruta,
        tipo_mime: 'image/png',
        tamano_declarado: firmaPng.length,
        tamano_comprobado: firmaPng.length,
        tamano_original: null,
        comprimido: false,
        es_firma: true,
        estado: 'subido',
        subido_en: iso(Date.now()),
      }, { onConflict: ['tramitacion_id', 'orden'], duplicados: 'fusionar', devolver: false });
      await registrarEvento(actual.id, 'firma_guardada', 'comercial', {});
    }
  }

  // 11. Una URL firmada por cada archivo que falta (los que ya están completos no llevan URL)
  const subidas = await Promise.all(docs.filter((d) => d.orden >= 1).map(async (doc) => {
    const yaSubido = comprobaciones.find((c) => c.doc.id === doc.id)?.ok === true;
    return {
      orden: doc.orden,
      nombre: doc.nombre,
      url: yaSubido ? null : await crearUrlSubida(doc.ruta),
      tipo_mime: doc.tipo_mime,
      ya_subido: yaSubido,
    };
  }));
  return resp(200, { ok: true, ref, estado: 'subiendo', listo: false, subidas });
}

// ---------------------------------------------------------------------------
// confirmar
// ---------------------------------------------------------------------------

/**
 * POST /api/tramitacion/confirmar. Devuelve {status, cuerpo}:
 *   200 {ok, listo:true, ref, estado}
 *   409 faltan_archivos {retryable:true, faltan:[{orden, nombre, motivo:'no_subido'|'tamano_distinto'}]}
 *   404 desconocida (el navegador vuelve a `iniciar`) · 401 no_autorizado · 429 demasiados · 400 peticion · 503 temporal
 * ORDEN: cargar → si ya está cerrada, igualmente crear/intentar los correos y dar éxito (sana un corte justo tras
 * el cambio de estado) → comprobar el almacén → marcar los documentos → PATCH a `recibida` (solo si seguía
 * `subiendo`) → evento → aviso y acuse. El éxito no espera a que los correos salgan.
 */
export async function confirmar(entrada, { ip = '' } = {}) {
  const inicio = Date.now();
  const e = esObjeto(entrada) ? entrada : {};
  const formulario = e.formulario;

  if (!tokenValido(formulario, e.token)) return fallo(401, 'no_autorizado', MENSAJES.noAutorizado);
  if (!(await dentroDeCuota('confirmar', hashIp(ip, secretoBandeja())))) return fallo(429, 'demasiados', MENSAJES.demasiados);
  if (!refValida(formulario, e.ref)) return fallo(400, 'peticion', MENSAJES.peticion);
  const ref = e.ref;

  const cargada = await cargarPorRef(formulario, ref);
  if (!cargada) return desconocida();
  const { tramitacion, documentos } = cargada;

  if (tramitacion.estado === 'descartada') return resp(200, { ok: true, listo: true, ref, estado: 'recibida' }); // éxito falso de un bot
  if (tramitacion.estado === 'abandonada') return desconocida(); // solo `iniciar` la reanuda
  if (estaCerrada(tramitacion.estado)) {
    await despachar(tramitacion, documentos, { inicio });
    return resp(200, { ok: true, listo: true, ref, estado: tramitacion.estado });
  }

  // subiendo
  if (!documentos.some((d) => d.orden >= 1)) return desconocida(); // la creación se quedó a medias: `iniciar` la completa
  const comprobaciones = await comprobarAlmacen(tramitacion.carpeta, documentos);
  const faltan = comprobaciones.filter((c) => !c.ok).map((c) => ({ orden: c.doc.orden, nombre: c.doc.nombre, motivo: c.motivo }));
  if (faltan.length > 0) return fallo(409, 'faltan_archivos', MENSAJES.faltanArchivos, { retryable: true, faltan });

  const ahora = iso(Date.now());
  await Promise.all(comprobaciones.map((c) => actualizar(
    'tramitacion_documentos',
    { id: `eq.${c.doc.id}` },
    { estado: 'subido', tamano_comprobado: c.tamano, subido_en: c.doc.subido_en ?? ahora },
    { devolver: false },
  )));
  const docsListos = comprobaciones.map((c) => ({ ...c.doc, estado: 'subido', tamano_comprobado: c.tamano, subido_en: c.doc.subido_en ?? ahora }));

  const filas = await actualizar('tramitaciones', { id: `eq.${tramitacion.id}`, estado: 'eq.subiendo' }, { estado: 'recibida', recibida_en: ahora });
  if (filas.length === 0) {
    // Otra petición la cerró (o la abandonó) justo antes: se mira cómo ha quedado
    const releida = await cargarPorRef(formulario, ref);
    if (!releida) return desconocida();
    if (!estaCerrada(releida.tramitacion.estado)) return temporal();
    await despachar(releida.tramitacion, releida.documentos, { inicio });
    return resp(200, { ok: true, listo: true, ref, estado: releida.tramitacion.estado });
  }

  await registrarEvento(tramitacion.id, 'recibida', 'comercial', {
    n_documentos: docsListos.length,
    bytes: docsListos.reduce((suma, d) => suma + Number(d.tamano_comprobado), 0),
  });
  await despachar(filas[0], docsListos, { inicio });
  return resp(200, { ok: true, listo: true, ref, estado: 'recibida' });
}
