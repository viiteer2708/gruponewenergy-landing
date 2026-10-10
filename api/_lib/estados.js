// api/_lib/estados.js · Máquinas de estado: tramitaciones y cola de correos (diseño §2.2).
//
// Aquí vive solo la lógica pura: qué transiciones valen, cuánto se espera entre
// reintentos y cómo se traduce lo que contesta Altavoz a un estado del correo.
// Quien habla con la base y con la red (cola.js, cartero.js) usa estas funciones.

// ---------------------------------------------------------------------------
// Tramitaciones
// ---------------------------------------------------------------------------

/**
 * Estados de `tramitaciones.estado` y a cuáles puede pasar cada uno:
 *   subiendo   → recibida   (confirmar: todo el material está en el almacén)
 *              → abandonada (el vigilante a las 24 h, o `iniciar` con ref_anterior)
 *   recibida   → tramitada  (backoffice: «Marcar como tramitada»)
 *   tramitada  → recibida   (backoffice: «Volver a pendiente»)
 *   abandonada → subiendo   (`iniciar` con esa misma referencia: se reanuda)
 *   descartada → (nada)     (honeypot: nace terminal)
 */
export const TRANSICIONES = Object.freeze({
  subiendo: Object.freeze(['recibida', 'abandonada']),
  recibida: Object.freeze(['tramitada']),
  tramitada: Object.freeze(['recibida']),
  abandonada: Object.freeze(['subiendo']),
  descartada: Object.freeze([]),
});

/** ¿Se puede pasar de `desde` a `hacia`? (estados desconocidos: no) */
export function transicionValida(desde, hacia) {
  return Object.hasOwn(TRANSICIONES, desde) && TRANSICIONES[desde].includes(hacia);
}

// ---------------------------------------------------------------------------
// Cola de correos
// ---------------------------------------------------------------------------

/** Estados de `tramitacion_correos.estado` (los del check del SQL). */
export const ESTADOS_CORREO = Object.freeze([
  'pendiente', 'enviando', 'enviado', 'agotado', 'suprimido', 'incierto', 'error_configuracion',
]);

/** Intentos totales de un correo: el 8.º fallo lo deja en `agotado`. */
export const MAX_INTENTOS = 8;

/** Espera (en minutos) tras el fallo número 1, 2, … 7. */
export const ESPERAS_MINUTOS = Object.freeze([1, 3, 10, 30, 60, 120, 240]);

/**
 * Minutos que hay que esperar hasta el siguiente intento, dado cuántos intentos
 * han fallado ya (`intento` = 1 tras el primer fallo). 0 si todavía no ha fallado
 * ninguno; null cuando ya no quedan intentos (a partir del 8.º fallo: `agotado`).
 */
export function esperaMinutos(intento) {
  if (!Number.isFinite(intento) || intento < 1) return 0;
  if (intento >= MAX_INTENTOS) return null;
  return ESPERAS_MINUTOS[Math.floor(intento) - 1];
}

/**
 * Traduce la respuesta de Altavoz (POST /api/v1/avisos) al estado del correo.
 *
 *   entrada: { status, codigo, red, intentos }
 *     status    código HTTP (si hubo respuesta)
 *     codigo    el `codigo` del cuerpo de error de Altavoz (destinatario_suprimido, modo_prueba…)
 *     red       si no hubo respuesta: 'red' (conexión caída) o 'tiempo' (superó el tope); true = 'red'
 *     intentos  cuántos intentos van, contando este (opcional; con MAX_INTENTOS fallidos → agotado)
 *
 *   salida: { estado, terminal, alerta, codigo, motivo }
 *     estado    uno de ESTADOS_CORREO que se guarda tras este intento
 *     terminal  true si el robot ya no lo reintenta (cualquier estado que no sea `pendiente`)
 *     alerta    'no' · 'inmediata' (avisa al instante) · 'si_atascado' (avisa si lleva más de 10 minutos)
 *     codigo    lo que se guarda en `codigo_respuesta`: el codigo de Altavoz, 'red', 'tiempo', 'http_NNN' o null si salió bien
 *     motivo    frase corta, sin datos personales, para `ultimo_error` ('' si salió bien)
 *
 * Tabla (diseño §2.2). Lo que la tabla no recoge (un 409 con otro código, 404, 413,
 * 3xx, cualquier otra cosa) se trata como `pendiente`: se reintenta, el vigilante avisa
 * a los 10 minutos y al 8.º fallo se da por agotado. Un correo nunca se pierde en silencio.
 *
 * Ojo con los AVISOS CON ADJUNTOS (orden 6): un 422 (sin `codigo`) o un 413 aquí no significan «configuración mal
 * puesta» ni «respuesta inesperada», sino «los adjuntos no valen / pesan demasiado». La cola (cola.intentarEnvio)
 * lo reconoce por `rechazo_adjuntos` y lo reintenta SIN adjuntos en el mismo intento; esta función solo clasifica
 * el resultado FINAL (el del reintento sin adjuntos, o el de un correo que nunca llevó adjuntos).
 */
export function clasificarAltavoz({ status, codigo, red, intentos } = {}) {
  const http = Number(status);
  const cod = typeof codigo === 'string' && codigo ? codigo : null;

  const salida = (estado, alerta, codigoRespuesta, motivo) => ({
    estado, terminal: estado !== 'pendiente', alerta, codigo: codigoRespuesta, motivo,
  });
  const pendiente = (codigoRespuesta, motivo, alerta = 'si_atascado') => {
    if (Number.isFinite(intentos) && intentos >= MAX_INTENTOS) {
      return salida('agotado', 'inmediata', codigoRespuesta, `Se han agotado los ${MAX_INTENTOS} intentos. Último fallo: ${motivo}`);
    }
    return salida('pendiente', alerta, codigoRespuesta, motivo);
  };

  // Sin respuesta: la conexión se cayó o se pasó el tope de tiempo
  if (red) {
    return red === 'tiempo'
      ? pendiente('tiempo', 'Altavoz ha tardado demasiado en responder')
      : pendiente('red', 'No se ha podido conectar con Altavoz');
  }

  // Salió bien
  if (http >= 200 && http < 300) return salida('enviado', 'no', null, '');

  // Destinatario bloqueado (rebote, queja, veto…): si es el aviso, el buzón de backoffice no recibe NADA
  if (http === 409 && cod === 'destinatario_suprimido') {
    return salida('suprimido', 'inmediata', cod, 'El destinatario está bloqueado en Altavoz');
  }
  // Altavoz en modo prueba: no se arregla solo, pero se sigue intentando por si lo quitan
  if (http === 409 && cod === 'modo_prueba') {
    return pendiente(cod, 'Altavoz está en modo prueba y no envía a direcciones reales');
  }
  // Clave, permiso o remitente mal configurados: reintentar no sirve
  if (http === 401 || http === 403 || http === 422) {
    return salida('error_configuracion', 'inmediata', cod ?? `http_${http}`, `Altavoz rechaza la configuración del envío (${http})`);
  }
  // Amazon no contestó con claridad: puede que el correo SÍ haya salido. Lo decide una persona.
  if (http === 502 && cod === 'envio_incierto') {
    return salida('incierto', 'inmediata', cod, 'No se sabe si el correo salió: hay que comprobarlo antes de repetir');
  }
  // Fallos pasajeros: se reintenta con espera creciente
  if (http === 502) return pendiente(cod ?? 'http_502', 'Altavoz no ha podido entregar el correo a Amazon');
  if (http === 503) return pendiente(cod ?? 'http_503', 'Altavoz no puede enviar ahora mismo');
  if (http === 500) return pendiente(cod ?? 'http_500', 'Altavoz ha fallado por dentro');

  // Cualquier otra cosa (409 con otro código, 404, 413, 3xx, sin status…): se reintenta
  return pendiente(cod ?? (Number.isFinite(http) && http > 0 ? `http_${http}` : 'desconocido'), 'Respuesta inesperada de Altavoz');
}
