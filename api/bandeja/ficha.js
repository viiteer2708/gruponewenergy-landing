// GET /api/bandeja/ficha?ref=[&abrir=1] · Una tramitación completa (IBAN incluido) con enlaces de descarga que valen 10 minutos.
// Con `abrir=1` (solo la carga de verdad de la página, no sus refrescos en silencio) apunta que esta persona ha abierto la ficha.
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { consultaDe, exigirSesion, ficha, respuestaDeError } from '../_lib/bandeja.js';
import { responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'GET')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    const consulta = consultaDe(req);
    // Un parámetro repetido (?ref=a&ref=b) llega como lista: vale el primero
    const primero = (v) => (Array.isArray(v) ? v[0] : v);
    const r = await ficha(primero(consulta.ref), { email: sesion.email, abrir: primero(consulta.abrir) === '1' });
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'ficha');
    return responder(res, r.status, r.cuerpo);
  }
}
