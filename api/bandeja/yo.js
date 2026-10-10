// GET /api/bandeja/yo · Quién tiene la sesión abierta: {ok:true, email}. Sin sesión válida, 401 `sesion`.
import { exigirSesion, respuestaDeError } from '../_lib/bandeja.js';
import { responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'GET')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    return responder(res, 200, { ok: true, email: sesion.email });
  } catch (error) {
    const r = respuestaDeError(error, 'yo');
    return responder(res, r.status, r.cuerpo);
  }
}
