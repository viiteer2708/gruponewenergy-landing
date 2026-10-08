// api/_lib/sesion.js · Sesión de la bandeja, códigos de acceso y hashes.
//
// Todo con node:crypto (HMAC-SHA256 y timingSafeEqual). Las funciones reciben el
// secreto como parámetro: así son puras y se prueban sin variables de entorno
// (los handlers le pasan config.secretoBandeja()). Nunca se guarda un código ni
// una IP en claro: solo su HMAC.
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const NOMBRE_COOKIE = 'bandeja_sesion';
export const DURACION_SESION_SEG = 30 * 24 * 60 * 60; // 30 días

function exigirSecreto(secreto) {
  if (typeof secreto !== 'string' || secreto.length < 16) {
    throw new Error('Falta el secreto para firmar (BANDEJA_SECRETO)');
  }
}

function mac(secreto, texto) {
  return createHmac('sha256', secreto).update(texto).digest();
}

/**
 * Compara dos textos en tiempo constante. Se comparan sus SHA-256 (siempre 32
 * bytes), así timingSafeEqual nunca lanza por longitudes distintas y la
 * longitud tampoco se filtra por el tiempo. Cualquier cosa que no sea texto: false.
 */
export function igualesSeguro(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Cookie de sesión: base64url({e: email, iat, exp}) + '.' + base64url(HMAC-SHA256).
 * iat y exp van en segundos. `ahora` (ms) solo se cambia en las pruebas.
 */
export function firmarSesion(email, secreto, { ahora = Date.now(), duracionSeg = DURACION_SESION_SEG } = {}) {
  exigirSecreto(secreto);
  const correo = String(email ?? '').trim().toLowerCase();
  if (!correo) throw new Error('Falta el email de la sesión');
  const iat = Math.floor(ahora / 1000);
  const carga = Buffer.from(JSON.stringify({ e: correo, iat, exp: iat + duracionSeg })).toString('base64url');
  return `${carga}.${mac(secreto, carga).toString('base64url')}`;
}

/**
 * Devuelve {email, iat, exp} si la cookie es auténtica y no ha caducado; si no, null.
 * Una cookie manipulada, mal formada, caducada o firmada con otro secreto no
 * lanza: es simplemente «sin sesión». Lo único que lanza es un secreto mal
 * configurado (vacío o corto).
 */
export function verificarSesion(valor, secreto, { ahora = Date.now() } = {}) {
  exigirSecreto(secreto); // un secreto mal puesto es un fallo de configuración: sí debe verse
  try {
    if (typeof valor !== 'string' || valor.length > 2048) return null;
    const partes = valor.split('.');
    if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
    const [carga, firma] = partes;
    // Se compara el TEXTO de la firma (no sus bytes decodificados): base64url
    // admite variantes del último carácter que decodifican igual.
    if (!igualesSeguro(firma, mac(secreto, carga).toString('base64url'))) return null;
    const datos = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;
    const { e, iat, exp } = datos;
    if (typeof e !== 'string' || !e) return null;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (exp <= Math.floor(ahora / 1000)) return null;
    return { email: e, iat, exp };
  } catch {
    return null;
  }
}

// El valor de la cookie solo puede llevar caracteres seguros (base64url y el
// punto): así nunca se cuela una cabecera ni un atributo extra.
const VALOR_COOKIE = /^[A-Za-z0-9_.-]+$/;

/** Cabecera Set-Cookie de la sesión: HttpOnly, SameSite=Lax, Path=/, 30 días; Secure si se pide. */
export function cookieSesion(valor, { secure = false, maxAgeSeg = DURACION_SESION_SEG } = {}) {
  if (typeof valor !== 'string' || !VALOR_COOKIE.test(valor)) throw new Error('Valor de cookie no válido');
  return `${NOMBRE_COOKIE}=${valor}; Max-Age=${Math.floor(maxAgeSeg)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Cabecera Set-Cookie que borra la sesión (salir). */
export function cookieBorrada({ secure = false } = {}) {
  return `${NOMBRE_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Código de acceso de 6 cifras (con ceros por delante), con aleatoriedad criptográfica. */
export function generarCodigo() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Lo que se guarda del código: HMAC-SHA256(secreto, email + código), en hexadecimal.
 * El email se normaliza (minúsculas, sin espacios) para que dé igual cómo lo teclee.
 */
export function hashCodigo(email, codigo, secreto) {
  exigirSecreto(secreto);
  const correo = String(email ?? '').trim().toLowerCase();
  return mac(secreto, `codigo\n${correo}\n${String(codigo ?? '').trim()}`).toString('hex');
}

/** HMAC de la IP (32 caracteres hex). Nunca se guarda la IP: solo esto. */
export function hashIp(ip, secreto) {
  exigirSecreto(secreto);
  return mac(secreto, `ip\n${String(ip ?? '').trim()}`).toString('hex').slice(0, 32);
}
