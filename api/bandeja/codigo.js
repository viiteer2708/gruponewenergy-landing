// POST /api/bandeja/codigo {email} · Manda un código de 6 cifras al correo, si tiene acceso a la bandeja.
// Responde SIEMPRE lo mismo (esté o no en la lista). Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { exigirJson, pedirCodigo, respuestaDeError } from '../_lib/bandeja.js';
import { ipDe, leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  if (!exigirJson(req, res)) return;
  const lectura = await leerJson(req);
  if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
  try {
    const r = await pedirCodigo(lectura.datos, { ip: ipDe(req) });
    return responder(res, r.status, r.cuerpo, r.cabeceras);
  } catch (error) {
    const r = respuestaDeError(error, 'codigo');
    return responder(res, r.status, r.cuerpo);
  }
}
