// POST /api/bandeja/entrar {email, codigo} · Cambia el código por una sesión (cookie `bandeja_sesion`).
// Contrato y lógica: api/_lib/bandeja.js (diseño §2.3).
import { entrar, exigirJson, respuestaDeError } from '../_lib/bandeja.js';
import { esHttps, ipDe, leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'POST')) return;
  if (!exigirJson(req, res)) return;
  const lectura = await leerJson(req);
  if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
  try {
    const r = await entrar(lectura.datos, { ip: ipDe(req), https: esHttps(req) });
    return responder(res, r.status, r.cuerpo, r.cabeceras);
  } catch (error) {
    const r = respuestaDeError(error, 'entrar');
    return responder(res, r.status, r.cuerpo);
  }
}
