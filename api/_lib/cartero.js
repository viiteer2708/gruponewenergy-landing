// api/_lib/cartero.js · Envío de UN correo por Altavoz (POST {ALTAVOZ_URL}/api/v1/avisos), con simulación.
//
// Aquí solo se habla con Altavoz y se traduce su respuesta; guardar el resultado, reintentar y avisar
// es cosa de cola.js. Reglas:
//  - Altavoz solo admite UN destinatario por llamada y el remitente lo pone él (el de la clave
//    «formulario-tramitacion»: escaneos@gruponew.energy). Aquí no se manda ningún remitente.
//  - Un 2xx quiere decir «Amazon lo ha aceptado» y es lo único que cuenta como enviado; lo que
//    significa el resto lo decide estados.clasificarAltavoz (la tabla de §2.2 del diseño).
//  - Simulación (ALTAVOZ_SIMULAR=1): no se llama a nadie; el correo sale «enviado» con un id
//    `simulado-<ts>`. ALTAVOZ_SIMULAR_FALLO=1 (solo en modo prueba) simula Altavoz caído (503).
//  - GUARDA: en modo prueba (TRAMITACION_PRUEBA=1) la simulación es OBLIGATORIA. Si alguien la apaga,
//    esto lanza un error claro ANTES de tocar la red: en pruebas nunca se intenta enviar de verdad.
//  - Nada de console.*: ni el contenido, ni las direcciones, ni la clave salen de este módulo.
import { MARCAS, altavozClave, altavozUrl, esPrueba, simularFallo, simulando } from './config.js';
import { clasificarAltavoz } from './estados.js';
import { enUnaLinea } from './nombres.js';
import { esEmail } from './validadores.js';

export const TOPE_ENVIO_MS = 8_000;

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

/**
 * Comprueba lo mismo que comprobaría Altavoz (marca, un solo destinatario, asunto de 1 a 200 caracteres,
 * texto o html, «responder a» con un solo email). Devuelve '' si está bien o una frase corta sin datos.
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
  return '';
}

/** El cuerpo JSON que espera Altavoz (sin campos vacíos). */
function cuerpoDe(correo) {
  const cuerpo = {
    marca: String(correo.marca).toUpperCase(),
    para: String(correo.para).trim(),
    asunto: enUnaLinea(correo.asunto),
  };
  if (correo.texto) cuerpo.texto = correo.texto;
  if (correo.html) cuerpo.html = correo.html;
  if (correo.etiqueta) cuerpo.etiqueta = correo.etiqueta;
  if (correo.responder_a && String(correo.responder_a).trim()) cuerpo.responder_a = String(correo.responder_a).trim();
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
 *   { estado, terminal, alerta, codigo, motivo, simulado, altavoz_id, http }
 * donde las cinco primeras son las de estados.clasificarAltavoz:
 *   estado    enviado · pendiente · agotado · suprimido · incierto · error_configuracion
 *   simulado  true solo si el correo «salió» en simulación
 *   http      el código HTTP de Altavoz (null si no hubo respuesta o se simuló)
 * Parámetros:
 *   correo    { marca: 'GNEW'|'MEGA', para, asunto, texto?, html?, etiqueta?, responder_a? }
 *   tope      milisegundos máximos de espera a Altavoz (8 s por defecto)
 *   intentos  cuántos intentos van contando este (con 8 fallidos, el fallo pasa a `agotado`)
 * Lanza SOLO si se intenta enviar de verdad en modo prueba (la guarda de arriba): ErrorSimulacion.
 */
export async function enviarAviso(correo, { tope = TOPE_ENVIO_MS, intentos } = {}) {
  if (esPrueba() && !simulando()) {
    throw new ErrorSimulacion('Modo prueba sin simulación de Altavoz (ALTAVOZ_SIMULAR debe valer 1): no se envía ningún correo.');
  }

  const resultado = (clasificacion, extra = {}) => ({ simulado: false, altavoz_id: null, http: null, ...clasificacion, ...extra });

  const defecto = defectoDelCorreo(correo);
  if (defecto) {
    // Altavoz respondería 422: se trata igual, sin llamarle (y en simulación, para que las pruebas lo vean)
    return resultado(
      { ...clasificarAltavoz({ status: 422, intentos }), motivo: `El correo no es válido: ${defecto}` },
      { http: 422 },
    );
  }

  if (simulando()) {
    if (simularFallo()) {
      return resultado(clasificarAltavoz({ status: 503, codigo: 'envio_no_disponible', intentos }), { http: 503 });
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
  return resultado(clasificacion, { altavoz_id: id, http: respuesta.status });
}
