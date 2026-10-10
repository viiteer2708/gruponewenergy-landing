// POST /api/bandeja/salir · Borra la cookie de sesión. No necesita sesión (salir dos veces no es un error).
// Como el resto de POST, solo admite `application/json` (el html manda «{}»). Lógica: api/_lib/bandeja.js.
import { exigirJson, respuestaDeError, salir } from '../_lib/bandeja.js';
import { esHttps, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  if (!exigirJson(req, res)) return;
  try {
    const r = salir({ https: esHttps(req) });
    return responder(res, r.status, r.cuerpo, r.cabeceras);
  } catch (error) {
    const r = respuestaDeError(error, 'salir');
    return responder(res, r.status, r.cuerpo);
  }
}
