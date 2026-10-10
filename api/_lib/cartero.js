// api/_lib/cartero.js · Envío de UN correo por Altavoz (POST {ALTAVOZ_URL}/api/v1/avisos), con simulación.
//
// Aquí solo se habla con Altavoz y se traduce su respuesta; guardar el resultado, reintentar y avisar
// es cosa de cola.js. Reglas:
//  - Altavoz solo admite UN destinatario por llamada y el remitente lo pone él (el de la clave
//    «formulario-tramitacion»: escaneos@gruponew.energy). Aquí no se manda ningún remitente.
//  - Un 2xx quiere decir «Amazon lo ha aceptado» y es lo único que cuenta como enviado; lo que
//    significa el resto lo decide estados.clasificarAltavoz (la tabla de §2.2 del diseño).
//  - Simulación (ALTAVOZ_SIMULAR=1): no se llama a nadie; el correo sale «enviado» con un id
//    `simulado-<ts>`. ALTAVOZ_SIMULAR_FALLO (solo en modo prueba) simula un fallo de Altavoz: `1` = caído (503) y
//    `adjuntos` = «rechazo por adjuntos» (422 sin `codigo`, como el de Altavoz, solo a los avisos que llevan adjuntos).
//  - Adjuntos (orden 6): `correo.adjuntos` = [{nombre, contenido: Buffer}]. Van en el JSON como
//    `adjuntos: [{nombre, contenido: <base64 estricto>}]`. Se comprueban los mismos topes que Altavoz (10 ficheros,
//    3.000.000 bytes reales entre todos, nombre de 1 a 200 con extensión admitida, nada vacío) y, si no valen, el
//    correo ni sale: 422 con `rechazo_adjuntos: true`. Un 413 (Vercel corta la petición) o un 422 SIN `codigo` de
//    Altavoz (api.md §5: las validaciones de los adjuntos no traen `codigo`) a un aviso que llevaba adjuntos
//    también marcan `rechazo_adjuntos: true`: la cola reintenta ENTONCES sin adjuntos, en el mismo intento.
//  - GUARDA: en modo prueba (TRAMITACION_PRUEBA=1) la simulación es OBLIGATORIA. Si alguien la apaga,
//    esto lanza un error claro ANTES de tocar la red: en pruebas nunca se intenta enviar de verdad.
//  - Nada de console.*: ni el contenido, ni las direcciones, ni la clave salen de este módulo.
import { ADJUNTOS_AVISO, MARCAS, altavozClave, altavozUrl, esPrueba, falloSimulado, simulando } from './config.js';
import { clasificarAltavoz } from './estados.js';
import { enUnaLinea } from './nombres.js';
import { esEmail } from './validadores.js';

export const TOPE_ENVIO_MS = 8_000;

/**
 * Tiempo que tiene un AVISO (el que lleva los documentos adjuntos) para descargar los ficheros del almacén y
 * entregarlos a Altavoz. Más que el de un correo sin adjuntos: la petición pesa hasta ~4 MB.
 */
export const TOPE_AVISO_MS = 15_000;

/**
 * Se intentó enviar de verdad estando en modo prueba. No es un fallo de Altavoz: es una
 * configuración peligrosa, y por eso la cola NO se la traga (la deja subir hasta el handler).
 */
export class ErrorSimulacion extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorSimulacion';
  }
}

const MARCAS_VALIDAS = Object.freeze(Object.values(MARCAS).map((m) => m.marca)); // ['GNEW', 'MEGA']
const MAX_ASUNTO = 200;
const MAX_TEXTO = 50_000;
const MAX_HTML = 250_000;

/** Las frases de defecto de los adjuntos empiezan así: la cola reconoce por ahí que el fallo es de los adjuntos. */
const PREFIJO_DEFECTO_ADJUNTOS = 'adjuntos: ';

/**
 * Comprueba los adjuntos como lo hace Altavoz (`leerAdjuntos`, api.md §5): una lista de hasta 10, cada uno con
 * `nombre` (1 a 200 caracteres una vez cambiados saltos de línea, tabuladores y comillas por espacios; con una extensión
 * admitida en mayúsculas o minúsculas) y `contenido` (bytes, no vacío), y 3.000.000 bytes REALES entre todos.
 * Sin adjuntos (o lista vacía) está bien. Devuelve '' si valen o una frase corta sin datos que empieza por «adjuntos: ».
 */
export function defectoDeAdjuntos(adjuntos) {
  if (adjuntos === undefined || adjuntos === null) return '';
  const no = (frase) => `${PREFIJO_DEFECTO_ADJUNTOS}${frase}`;
  if (!Array.isArray(adjuntos)) return no('no van como lista');
  if (adjuntos.length > ADJUNTOS_AVISO.max) return no(`hay más de ${ADJUNTOS_AVISO.max}`);
  let total = 0;
  for (const a of adjuntos) {
    if (a === null || typeof a !== 'object') return no('uno no tiene la forma esperada');
    const nombre = String(a.nombre ?? '').replace(/[\r\n\t"]+/g, ' ').trim();
    if (nombre === '' || nombre.length > ADJUNTOS_AVISO.maxNombre) return no('el nombre de uno no vale');
    const punto = nombre.lastIndexOf('.');
    if (punto < 0 || !ADJUNTOS_AVISO.extensiones.includes(nombre.slice(punto + 1).toLowerCase())) return no('uno no es de un tipo admitido');
    if (!(a.contenido instanceof Uint8Array) || a.contenido.length === 0) return no('uno está vacío');
    total += a.contenido.length;
  }
  if (total > ADJUNTOS_AVISO.maxBytes) return no('pasan del máximo de bytes');
  return '';
}

/**
 * Comprueba lo mismo que comprobaría Altavoz (marca, un solo destinatario, asunto de 1 a 200 caracteres,
 * texto o html, «responder a» con un solo email, adjuntos). Devuelve '' si está bien o una frase corta sin datos.
 */
export function defectoDelCorreo(correo) {
  const c = correo ?? {};
  if (!MARCAS_VALIDAS.includes(String(c.marca ?? '').toUpperCase())) return 'marca desconocida';
  if (!esEmail(c.para)) return 'dirección de destino no válida';
  if (c.responder_a !== undefined && c.responder_a !== null && String(c.responder_a).trim() !== '' && !esEmail(c.responder_a)) {
    return 'dirección para responder no válida';
  }
  const asunto = enUnaLinea(c.asunto);
  if (asunto.length < 1 || Array.from(asunto).length > MAX_ASUNTO) return 'asunto vacío o demasiado largo';
  const texto = typeof c.texto === 'string' ? c.texto : '';
  const html = typeof c.html === 'string' ? c.html : '';
  if (!texto && !html) return 'el correo no tiene contenido';
  if (texto.length > MAX_TEXTO || html.length > MAX_HTML) return 'el contenido es demasiado largo';
  return defectoDeAdjuntos(c.adjuntos);
}

/** ¿Lleva el correo algún adjunto? */
const llevaAdjuntos = (correo) => Array.isArray(correo?.adjuntos) && correo.adjuntos.length > 0;

/**
 * El cuerpo JSON que espera Altavoz (sin campos vacíos). Los adjuntos van como {nombre, contenido} con el contenido
 * en base64 estándar y estricto (el de Buffer.toString('base64'): sin saltos de línea, con «=» de relleno).
 */
export function cuerpoDe(correo) {
  const cuerpo = {
    marca: String(correo.marca).toUpperCase(),
    para: String(correo.para).trim(),
    asunto: enUnaLinea(correo.asunto),
  };
  if (correo.texto) cuerpo.texto = correo.texto;
  if (correo.html) cuerpo.html = correo.html;
  if (correo.etiqueta) cuerpo.etiqueta = correo.etiqueta;
  if (correo.responder_a && String(correo.responder_a).trim()) cuerpo.responder_a = String(correo.responder_a).trim();
  if (llevaAdjuntos(correo)) {
    cuerpo.adjuntos = correo.adjuntos.map((a) => ({
      nombre: a.nombre,
      contenido: (Buffer.isBuffer(a.contenido) ? a.contenido : Buffer.from(a.contenido.buffer, a.contenido.byteOffset, a.contenido.byteLength)).toString('base64'),
    }));
  }
  return cuerpo;
}

function leerJson(texto) {
  try {
    const valor = texto ? JSON.parse(texto) : null;
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

/**
 * Envía un correo (o lo simula). Devuelve siempre un resultado, nunca lanza por un fallo de Altavoz:
 *   { estado, terminal, alerta, codigo, motivo, simulado, altavoz_id, http, rechazo_adjuntos }
 * donde las cinco primeras son las de estados.clasificarAltavoz:
 *   estado    enviado · pendiente · agotado · suprimido · incierto · error_configuracion
 *   simulado  true solo si el correo «salió» en simulación
 *   http      el código HTTP de Altavoz (null si no hubo respuesta o se simuló)
 *   rechazo_adjuntos  true si el correo llevaba adjuntos y NO ha salido por ellos (los topes no se cumplen, un 413 de
 *             Vercel o un 422 de Altavoz sin `codigo`): quien llama puede reintentar sin adjuntos
 * Parámetros:
 *   correo    { marca: 'GNEW'|'MEGA', para, asunto, texto?, html?, etiqueta?, responder_a?, adjuntos?: [{nombre, contenido: Buffer}] }
 *   tope      milisegundos máximos de espera a Altavoz (8 s por defecto)
 *   intentos  cuántos intentos van contando este (con 8 fallidos, el fallo pasa a `agotado`)
 * Lanza SOLO si se intenta enviar de verdad en modo prueba (la guarda de arriba): ErrorSimulacion.
 */
export async function enviarAviso(correo, { tope = TOPE_ENVIO_MS, intentos } = {}) {
  if (esPrueba() && !simulando()) {
    throw new ErrorSimulacion('Modo prueba sin simulación de Altavoz (ALTAVOZ_SIMULAR debe valer 1): no se envía ningún correo.');
  }

  const resultado = (clasificacion, extra = {}) => ({ simulado: false, altavoz_id: null, http: null, rechazo_adjuntos: false, ...clasificacion, ...extra });
  const conAdjuntos = llevaAdjuntos(correo);

  const defecto = defectoDelCorreo(correo);
  if (defecto) {
    // Altavoz respondería 422: se trata igual, sin llamarle (y en simulación, para que las pruebas lo vean)
    return resultado(
      { ...clasificarAltavoz({ status: 422, intentos }), motivo: `El correo no es válido: ${defecto}` },
      { http: 422, rechazo_adjuntos: defecto.startsWith(PREFIJO_DEFECTO_ADJUNTOS) },
    );
  }

  if (simulando()) {
    const fallo = falloSimulado();
    if (fallo === 'caido') {
      return resultado(clasificarAltavoz({ status: 503, codigo: 'envio_no_disponible', intentos }), { http: 503 });
    }
    if (fallo === 'adjuntos' && conAdjuntos) {
      // «Los adjuntos pasan de 3 MB entre todos…»: el 422 de Altavoz por los adjuntos, sin `codigo`
      return resultado(
        { ...clasificarAltavoz({ status: 422, intentos }), motivo: 'Altavoz rechaza los adjuntos (422)' },
        { http: 422, rechazo_adjuntos: true },
      );
    }
    return resultado(clasificarAltavoz({ status: 200, intentos }), { simulado: true, altavoz_id: `simulado-${Date.now()}`, http: 200 });
  }

  let url;
  let clave;
  try {
    url = `${altavozUrl()}/api/v1/avisos`;
    clave = altavozClave();
  } catch {
    // Falta ALTAVOZ_URL o ALTAVOZ_API_KEY: reintentar no lo arregla; lo ve una persona
    return resultado({
      estado: 'error_configuracion',
      terminal: true,
      alerta: 'inmediata',
      codigo: 'sin_configurar',
      motivo: 'Falta la configuración de Altavoz en el servidor',
    });
  }

  let respuesta;
  let texto;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cuerpoDe(correo)),
      redirect: 'error', // si alguna vez redirigen, no se manda la clave a otro sitio
      signal: AbortSignal.timeout(Number.isFinite(tope) && tope > 0 ? tope : TOPE_ENVIO_MS),
    });
    texto = await respuesta.text();
  } catch (error) {
    const agotado = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return resultado(clasificarAltavoz({ red: agotado ? 'tiempo' : 'red', intentos }));
  }

  const cuerpo = leerJson(texto);
  const clasificacion = clasificarAltavoz({ status: respuesta.status, codigo: cuerpo?.codigo, intentos });
  const id = clasificacion.estado === 'enviado' && typeof cuerpo?.id === 'string' ? cuerpo.id.slice(0, 200) : null;
  // Con adjuntos: un 413 (Vercel corta la petición de más de ~4,5 MB antes de que llegue) o un 422 sin `codigo` (las
  // validaciones de los adjuntos de Altavoz no traen `codigo`; el único 422 con él es `marca_sin_remitente`)
  const rechazoAdjuntos = conAdjuntos && (respuesta.status === 413 || (respuesta.status === 422 && !cuerpo?.codigo));
  return resultado(clasificacion, { altavoz_id: id, http: respuesta.status, rechazo_adjuntos: rechazoAdjuntos });
}
