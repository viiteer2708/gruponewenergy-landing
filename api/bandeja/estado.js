// POST /api/bandeja/estado {ref, accion:'tramitar'|'reabrir'} · Marca como tramitada o vuelve a pendiente.
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { cambiarEstado, exigirJson, exigirSesion, respuestaDeError } from '../_lib/bandeja.js';
import { leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    if (!exigirJson(req, res)) return;
    const lectura = await leerJson(req);
    if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
    const r = await cambiarEstado(lectura.datos, sesion.email);
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'estado');
    return responder(res, r.status, r.cuerpo);
  }
}
