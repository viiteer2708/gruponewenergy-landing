// POST /api/bandeja/estado {ref, accion:'tramitar'|'reabrir'|'sin_abrir'} · Marca como tramitada, vuelve a pendiente o deja una
// pendiente «sin abrir» (para que la coja otro compañero: evento `marcada_sin_abrir`, sin tocar su estado). Un solo fichero para
// las tres acciones (el plan de Vercel limita el número de funciones): `sin_abrir` va a `marcarSinAbrir` y las otras dos a
// `cambiarEstado`. Los dos apuntan QUIÉN lo hace con `actorDe(sesion)` (su nombre o, sin él, su correo). Contrato y lógica:
// api/_lib/bandeja.js (diseño §2.3).
import { cambiarEstado, exigirJson, exigirSesion, marcarSinAbrir, respuestaDeError } from '../_lib/bandeja.js';
import { leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    if (!exigirJson(req, res)) return;
    const lectura = await leerJson(req);
    if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
    const r = lectura.datos?.accion === 'sin_abrir'
      ? await marcarSinAbrir(lectura.datos, sesion)
      : await cambiarEstado(lectura.datos, sesion);
    return responder(res, r.status, r.cuerpo);
  } catch (error) {
    const r = respuestaDeError(error, 'estado');
    return responder(res, r.status, r.cuerpo);
  }
}
