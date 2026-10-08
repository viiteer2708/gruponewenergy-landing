// api/_lib/http.js · Utilidades HTTP de las funciones: leer el JSON, responder, cookies, IP.
//
// Todo con la API de Node (setHeader, statusCode, end) y no con los ayudantes de Vercel
// (res.status().json()), para que lo mismo valga en Vercel y en el servidor local de pruebas.
import { LIMITES } from './config.js';

const MENSAJE_PETICION = 'No hemos podido leer lo que se ha enviado. Recarga la página e inténtalo de nuevo.';

function errorPeticion(status, mensaje = MENSAJE_PETICION) {
  return { ok: false, status, cuerpo: { ok: false, codigo: 'peticion', mensaje, retryable: false } };
}

// Todos nuestros endpoints esperan un objeto JSON: un número, una lista o «null» no sirven.
function comoObjeto(valor) {
  if (valor !== null && typeof valor === 'object' && !Array.isArray(valor)) return { ok: true, datos: valor };
  return errorPeticion(400);
}

function analizar(texto) {
  try {
    return comoObjeto(JSON.parse(texto.replace(/^﻿/, '')));
  } catch {
    return errorPeticion(400);
  }
}

/**
 * Lee el cuerpo JSON de la petición. Nunca lanza: devuelve
 *   {ok: true, datos}                       con el objeto, o
 *   {ok: false, status, cuerpo}             con el error ya armado (400 `peticion`; 413 si pasa de 3 MB):
 *                                            se responde con responder(res, r.status, r.cuerpo).
 *
 * Vercel (y el servidor local) ya traen el cuerpo leído en `req.body`; con un JSON roto ese
 * getter LANZA, por eso va dentro de un try/catch. Si `req.body` no está definido se lee el
 * flujo de la petición, con tope de `maxBytes` (3 MB por defecto: la firma va dentro).
 */
export async function leerJson(req, { maxBytes = LIMITES.maxBytesJson } = {}) {
  let cuerpo;
  try {
    cuerpo = req.body;
  } catch {
    return errorPeticion(400); // Vercel: JSON ilegible
  }

  if (cuerpo !== undefined && cuerpo !== null) {
    if (typeof cuerpo === 'string') return analizar(cuerpo);
    if (cuerpo instanceof Uint8Array) return analizar(Buffer.from(cuerpo).toString('utf8'));
    return comoObjeto(cuerpo); // ya parseado
  }

  if (typeof req?.[Symbol.asyncIterator] !== 'function') return errorPeticion(400);
  const trozos = [];
  let total = 0;
  try {
    for await (const trozo of req) {
      const buffer = Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo);
      total += buffer.length;
      if (total > maxBytes) return errorPeticion(413, 'Lo que has enviado es demasiado grande.');
      trozos.push(buffer);
    }
  } catch {
    return errorPeticion(400); // la conexión se cortó a mitad
  }
  return analizar(Buffer.concat(trozos).toString('utf8'));
}

/**
 * Responde en JSON con `Cache-Control: no-store`. `cabeceras` añade más ({'Set-Cookie': [...]}).
 * Si la respuesta ya se envió, no hace nada.
 */
export function responder(res, status, cuerpo, cabeceras = {}) {
  if (res.headersSent) return;
  const texto = JSON.stringify(cuerpo ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [nombre, valor] of Object.entries(cabeceras)) res.setHeader(nombre, valor);
  res.end(texto);
}

/**
 * Solo deja pasar los métodos indicados (`soloMetodo(req, res, 'POST')`). Con otro, responde
 * 405 con la cabecera Allow y devuelve false: el handler debe hacer `return`.
 */
export function soloMetodo(req, res, ...permitidos) {
  const metodo = String(req?.method ?? '').toUpperCase();
  const lista = permitidos.map((m) => String(m).toUpperCase());
  if (lista.includes(metodo)) return true;
  responder(res, 405, { ok: false, codigo: 'metodo', mensaje: 'Esta dirección no admite esa operación.', retryable: false }, { Allow: lista.join(', ') });
  return false;
}

/** Cookies de la petición como objeto {nombre: valor}. Si un nombre se repite, gana la primera. */
export function cookiesDe(req) {
  const salida = {};
  const cabecera = req?.headers?.cookie;
  if (typeof cabecera === 'string') {
    for (const par of cabecera.split(';')) {
      const igual = par.indexOf('=');
      if (igual < 0) continue;
      const nombre = par.slice(0, igual).trim();
      if (!nombre || nombre === '__proto__' || Object.hasOwn(salida, nombre)) continue;
      let valor = par.slice(igual + 1).trim();
      if (valor.length >= 2 && valor.startsWith('"') && valor.endsWith('"')) valor = valor.slice(1, -1);
      try {
        valor = decodeURIComponent(valor);
      } catch {
        // se deja tal cual
      }
      salida[nombre] = valor;
    }
  } else if (req?.cookies && typeof req.cookies === 'object') {
    for (const [nombre, valor] of Object.entries(req.cookies)) {
      if (nombre !== '__proto__' && typeof valor === 'string') salida[nombre] = valor;
    }
  }
  return salida;
}

const primero = (valor) => (Array.isArray(valor) ? valor[0] : valor);

/**
 * IP del cliente: `x-real-ip` si viene; si no, la primera de `x-forwarded-for`; si no, la del
 * socket (servidor local). Devuelve '' si no hay nada con aspecto de IP.
 */
export function ipDe(req) {
  const cabeceras = req?.headers ?? {};
  const real = primero(cabeceras['x-real-ip']);
  const reenviada = String(primero(cabeceras['x-forwarded-for']) ?? '').split(',')[0];
  const ip = String(real || reenviada || req?.socket?.remoteAddress || '').trim().replace(/^::ffff:/i, '');
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : '';
}

/** ¿Llegó por HTTPS? (detrás de Vercel, lo dice `x-forwarded-proto`). Sirve para decidir si la cookie lleva `Secure`. */
export function esHttps(req) {
  const proto = primero(req?.headers?.['x-forwarded-proto']);
  if (proto) return String(proto).split(',')[0].trim().toLowerCase() === 'https';
  return Boolean(req?.socket?.encrypted);
}
