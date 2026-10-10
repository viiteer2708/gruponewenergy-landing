// GET /api/bandeja/lista?estado=&q=&antes= · Las tramitaciones, 30 por página, de más reciente a más antigua.
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { consultaDe, exigirSesion, listar, respuestaDeError } from '../_lib/bandeja.js';
import { responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'GET')) return;
  try {
    if (!exigirSesion(req, res)) return;
    const r = await listar(consultaDe(req));
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'lista');
    return responder(res, r.status, r.cuerpo);
  }
}
