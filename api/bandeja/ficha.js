// GET /api/bandeja/ficha?ref= · Una tramitación completa (IBAN incluido) con enlaces de descarga que valen 10 minutos.
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { consultaDe, exigirSesion, ficha, respuestaDeError } from '../_lib/bandeja.js';
import { responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'GET')) return;
  try {
    if (!exigirSesion(req, res)) return;
    const ref = consultaDe(req).ref;
    const r = await ficha(Array.isArray(ref) ? ref[0] : ref);
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'ficha');
    return responder(res, r.status, r.cuerpo);
  }
}
