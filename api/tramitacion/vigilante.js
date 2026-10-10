// POST /api/tramitacion/vigilante · Pasada del vigilante: lo llama el cron del VPS cada 5 minutos
// (scripts/vigilante-tramitacion.mjs) con `Authorization: Bearer <VIGILANTE_SECRETO>`.
// Qué hace y qué devuelve: api/_lib/vigilante.js (diseño §2.3). Aquí solo se comprueba quién llama.
//
//   · otro método que POST        → 405
//   · sin Bearer, o Bearer distinto → 401 (la comparación es en tiempo constante; no se toca la base antes de saber quién es)
//   · VIGILANTE_SECRETO sin poner o demasiado corto → 500 (nunca se deja pasar a nadie por un fallo de configuración)
// El cuerpo de la petición se ignora por completo: no hay nada que leer y un JSON roto no puede estropear la pasada.
import { secretoVigilante } from '../_lib/config.js';
import { responder, soloMetodo } from '../_lib/http.js';
import { igualesSeguro } from '../_lib/sesion.js';
import { ejecutarPasada, respuestaDeError } from '../_lib/vigilante.js';

/** El token de «Authorization: Bearer <token>», o null si la cabecera falta o tiene otra forma. */
function tokenDe(req) {
  const crudo = req?.headers?.authorization;
  const valor = Array.isArray(crudo) ? crudo[0] : crudo;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(valor ?? ''));
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  try {
    const token = tokenDe(req);
    if (token === null || !igualesSeguro(token, secretoVigilante())) {
      return responder(
        res,
        401,
        { ok: false, codigo: 'no_autorizado', mensaje: 'No autorizado.', retryable: false },
        { 'WWW-Authenticate': 'Bearer' },
      );
    }
    return responder(res, 200, { ok: true, ...(await ejecutarPasada()) });
  } catch (error) {
    const r = respuestaDeError(error);
    return responder(res, r.status, r.cuerpo);
  }
}
