// POST /api/bandeja/reenviar {ref, tipo:'aviso'|'acuse'} · «Volver a enviar» un correo y probarlo al momento.
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3); el trabajo lo hace la cola (cola.reenviar), con `actorDe(sesion)` (el nombre de
// quien lo pide o, sin él, su correo) como autor de los eventos.
import { exigirJson, exigirSesion, reenviarCorreo, respuestaDeError } from '../_lib/bandeja.js';
import { leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    if (!exigirJson(req, res)) return;
    const lectura = await leerJson(req);
    if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
    const r = await reenviarCorreo(lectura.datos, sesion);
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'reenviar');
    return responder(res, r.status, r.cuerpo);
  }
}
