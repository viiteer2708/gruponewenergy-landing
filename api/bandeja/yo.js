// GET /api/bandeja/yo · Quién tiene la sesión abierta: {ok:true, email, nombre} (`nombre` es null si esa persona aún no ha escrito el suyo).
// POST /api/bandeja/yo {nombre} · Pone o cambia ese nombre: vuelve a firmar la cookie de sesión con él (365 días nuevos) y responde
//   {ok:true, email, nombre} + Set-Cookie; 400 `nombre` con su frase en llano si no vale (de 2 a 40 letras, sin `@` ni cifras).
// Sin sesión válida, 401 `sesion` en los dos. NO es un acceso: el correo y su código siguen abriendo la puerta; el nombre solo dice
// QUIÉN abre, marca o tramita cada contrato (todo backoffice entra con el mismo correo), y la página lo pide la primera vez. Un solo
// fichero para las dos cosas (el plan de Vercel limita el número de funciones). Contrato y lógica: api/_lib/bandeja.js.
import { exigirJson, exigirSesion, ponerNombre, respuestaDeError } from '../_lib/bandeja.js';
import { esHttps, leerJson, responder, soloMetodo } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!soloMetodo(req, res, 'GET', 'POST')) return;
  try {
    const sesion = exigirSesion(req, res);
    if (!sesion) return;
    if (String(req.method).toUpperCase() === 'GET') return responder(res, 200, { ok: true, email: sesion.email, nombre: sesion.nombre });
    if (!exigirJson(req, res)) return;
    const lectura = await leerJson(req);
    if (!lectura.ok) return responder(res, lectura.status, lectura.cuerpo);
    const r = ponerNombre(lectura.datos, sesion, { https: esHttps(req) });
    return responder(res, r.status, r.cuerpo, r.cabeceras);
  } catch (error) {
    const r = respuestaDeError(error, 'yo');
    return responder(res, r.status, r.cuerpo);
  }
}
