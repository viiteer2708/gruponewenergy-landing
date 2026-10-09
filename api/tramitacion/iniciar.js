// POST /api/tramitacion/iniciar · Apunta el contrato en la base y devuelve una URL firmada por archivo.
// Contrato completo y lógica: api/_lib/tramitacion.js (diseño §2.3). Aquí solo se lee la petición y se escribe la respuesta.
import { ipDe, leerJson, responder, soloMetodo } from '../_lib/http.js';
import { iniciar, respuestaDeError } from '../_lib/tramitacion.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  const lectura = await leerJson(req);
  if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
  try {
    const navegador = req.headers?.['user-agent'];
    const r = await iniciar(lectura.datos, { ip: ipDe(req), navegador: typeof navegador === 'string' ? navegador : '' });
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'iniciar');
    return responder(res, r.status, r.cuerpo);
  }
}
