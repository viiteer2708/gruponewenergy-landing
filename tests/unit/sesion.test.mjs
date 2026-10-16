// Pruebas de api/_lib/sesion.js: sesión firmada, códigos de acceso y hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  NOMBRE_COOKIE,
  DURACION_SESION_SEG,
  firmarSesion,
  verificarSesion,
  cookieSesion,
  cookieBorrada,
  generarCodigo,
  hashCodigo,
  hashIp,
  igualesSeguro,
} from '../../api/_lib/sesion.js';

const SECRETO = 'secreto-de-prueba-que-tiene-mas-de-32-caracteres';
const OTRO_SECRETO = 'otro-secreto-de-prueba-tambien-largo-de-verdad';
const AHORA = Date.UTC(2026, 9, 8, 12, 0, 0); // 8-oct-2026 12:00 UTC

function cambiarUnCaracter(texto, posicion) {
  const c = texto[posicion];
  const nuevo = c === 'A' ? 'B' : 'A';
  return texto.slice(0, posicion) + nuevo + texto.slice(posicion + 1);
}

test('sesión: ida y vuelta con el email normalizado y 365 días de vida', () => {
  const cookie = firmarSesion('  Backoffice@Ejemplo.COM ', SECRETO, { ahora: AHORA });
  const sesion = verificarSesion(cookie, SECRETO, { ahora: AHORA + 1000 });
  assert.ok(sesion, 'una cookie recién firmada debe valer');
  assert.equal(sesion.email, 'backoffice@ejemplo.com');
  assert.equal(sesion.iat, Math.floor(AHORA / 1000));
  assert.equal(sesion.exp - sesion.iat, 365 * 24 * 60 * 60);
  assert.equal(DURACION_SESION_SEG, 365 * 24 * 60 * 60);
});

test('sesión: sin nombre la carga es la de siempre (sin `n`) y verificarSesion da `nombre: null`', () => {
  const cookie = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  const carga = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(carga), ['e', 'iat', 'exp'], 'Sin nombre, la carga no cambia: es la de las sesiones que ya tiene backoffice');
  const sesion = verificarSesion(cookie, SECRETO, { ahora: AHORA });
  assert.deepEqual(Object.keys(sesion), ['email', 'nombre', 'iat', 'exp']);
  assert.equal(sesion.nombre, null);
  // pedirlo vacío o nulo es lo mismo que no pedirlo: misma cookie, byte a byte
  for (const sinNombre of [undefined, null, '', '   ']) {
    assert.equal(firmarSesion('a@b.es', SECRETO, { ahora: AHORA, nombre: sinNombre }), cookie, `nombre ${JSON.stringify(sinNombre)}`);
  }
});

test('sesión: con nombre va en la carga como `n`, firmado, y verificarSesion lo devuelve junto al resto', () => {
  const cookie = firmarSesion('  Backoffice@Ejemplo.COM ', SECRETO, { ahora: AHORA, nombre: 'LAURA GARCÍA' });
  const carga = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(carga, { e: 'backoffice@ejemplo.com', iat: Math.floor(AHORA / 1000), exp: Math.floor(AHORA / 1000) + 365 * 24 * 60 * 60, n: 'LAURA GARCÍA' });
  assert.match(cookie, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Con tildes y Ñ la cookie sigue siendo solo base64url');
  const sesion = verificarSesion(cookie, SECRETO, { ahora: AHORA + 1000 });
  assert.deepEqual(sesion, { email: 'backoffice@ejemplo.com', nombre: 'LAURA GARCÍA', iat: Math.floor(AHORA / 1000), exp: Math.floor(AHORA / 1000) + 365 * 24 * 60 * 60 });
  assert.equal(verificarSesion(cookie, SECRETO, { ahora: AHORA + 366 * 24 * 3600 * 1000 }), null, 'Con nombre caduca igual (365 días)');
  assert.equal(verificarSesion(cookie, OTRO_SECRETO, { ahora: AHORA }), null, 'Con otro secreto tampoco vale');
  assert.ok(cookie.length < 400, `La cookie no engorda (${cookie.length} caracteres)`);
  const larga = firmarSesion('ana.lopez.garcia.de.la.cruz.y.sanchez@empresa-con-un-nombre-largo.example.com', SECRETO, { ahora: AHORA, nombre: 'Ñ'.repeat(40) });
  assert.ok(larga.length < 1000 && verificarSesion(larga, SECRETO, { ahora: AHORA }).nombre === 'Ñ'.repeat(40), 'Ni con 40 letras de 2 bytes y un correo largo');
});

test('sesión: una cookie de ANTES del nombre (firmada a mano, sin `n`) sigue valiendo y da `nombre: null`', () => {
  const iat = Math.floor(AHORA / 1000);
  const carga = Buffer.from(JSON.stringify({ e: 'antigua@b.es', iat, exp: iat + 365 * 24 * 60 * 60 })).toString('base64url');
  const antigua = `${carga}.${createHmac('sha256', SECRETO).update(carga).digest('base64url')}`;
  assert.deepEqual(verificarSesion(antigua, SECRETO, { ahora: AHORA + 1000 }), { email: 'antigua@b.es', nombre: null, iat, exp: iat + 365 * 24 * 60 * 60 });
});

test('sesión: un `n` que no es texto (o está vacío) cuenta como «sin nombre»: la cookie sigue valiendo', () => {
  const iat = Math.floor(AHORA / 1000);
  const firmar = (objeto) => {
    const carga = Buffer.from(JSON.stringify(objeto)).toString('base64url');
    return `${carga}.${createHmac('sha256', SECRETO).update(carga).digest('base64url')}`;
  };
  for (const n of [5, null, true, [], ['ANA'], {}, '', '   ']) {
    const sesion = verificarSesion(firmar({ e: 'a@b.es', iat, exp: iat + 100, n }), SECRETO, { ahora: AHORA });
    assert.ok(sesion, `n = ${JSON.stringify(n)}: la sesión vale`);
    assert.equal(sesion.nombre, null, `n = ${JSON.stringify(n)}`);
    assert.equal(sesion.email, 'a@b.es');
  }
});

test('sesión: cambiar el nombre de una cookie ya firmada la invalida (no se puede «ponerse» el nombre de otro)', () => {
  const de_ana = firmarSesion('x@b.es', SECRETO, { ahora: AHORA, nombre: 'ANA' });
  const de_luis = firmarSesion('x@b.es', SECRETO, { ahora: AHORA, nombre: 'LUIS' });
  assert.equal(verificarSesion(`${de_luis.split('.')[0]}.${de_ana.split('.')[1]}`, SECRETO, { ahora: AHORA }), null, 'La carga de Luis con la firma de Ana');
  const sinNombre = firmarSesion('x@b.es', SECRETO, { ahora: AHORA });
  assert.equal(verificarSesion(`${de_ana.split('.')[0]}.${sinNombre.split('.')[1]}`, SECRETO, { ahora: AHORA }), null, 'La carga con nombre y la firma de la que no lo tiene');
});

test('sesión: un nombre que no es texto lanza al firmar (un fallo de quien llama, no «sin sesión»)', () => {
  for (const malo of [5, true, ['ANA'], {}, 12n]) assert.throws(() => firmarSesion('a@b.es', SECRETO, { ahora: AHORA, nombre: malo }), /nombre/i, JSON.stringify(String(malo)));
});

test('sesión: la cookie solo lleva caracteres seguros y dos partes', () => {
  const cookie = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  assert.match(cookie, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('sesión: una cookie manipulada se rechaza (cambiar la carga o la firma)', () => {
  const cookie = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  const [carga, firma] = cookie.split('.');
  assert.ok(verificarSesion(cookie, SECRETO, { ahora: AHORA }), 'la buena vale');
  // Carga cambiada (otro email, misma firma)
  assert.equal(verificarSesion(`${cambiarUnCaracter(carga, 5)}.${firma}`, SECRETO, { ahora: AHORA }), null);
  // Firma cambiada en medio
  assert.equal(verificarSesion(`${carga}.${cambiarUnCaracter(firma, 10)}`, SECRETO, { ahora: AHORA }), null);
  // Firma con una variante del último carácter (decodifica igual en base64url): también se rechaza
  const ultimo = firma[firma.length - 1];
  const variante = ultimo === 'A' ? 'B' : 'A';
  assert.equal(verificarSesion(`${carga}.${firma.slice(0, -1)}${variante}`, SECRETO, { ahora: AHORA }), null);
  // Cola añadida, partes de más, sin firma
  assert.equal(verificarSesion(`${cookie}x`, SECRETO, { ahora: AHORA }), null);
  assert.equal(verificarSesion(`${cookie}.extra`, SECRETO, { ahora: AHORA }), null);
  assert.equal(verificarSesion(carga, SECRETO, { ahora: AHORA }), null);
  assert.equal(verificarSesion(`${carga}.`, SECRETO, { ahora: AHORA }), null);
});

test('sesión: la carga de una sesión con la firma de otra se rechaza', () => {
  const de_ana = firmarSesion('ana@b.es', SECRETO, { ahora: AHORA });
  const de_luis = firmarSesion('luis@b.es', SECRETO, { ahora: AHORA });
  const mezcla = `${de_ana.split('.')[0]}.${de_luis.split('.')[1]}`;
  assert.equal(verificarSesion(mezcla, SECRETO, { ahora: AHORA }), null);
});

test('sesión: una cookie caducada se rechaza (justo en el límite también)', () => {
  const cookie = firmarSesion('a@b.es', SECRETO, { ahora: AHORA, duracionSeg: 60 });
  assert.ok(verificarSesion(cookie, SECRETO, { ahora: AHORA + 59_000 }), 'a los 59 s sigue valiendo');
  assert.equal(verificarSesion(cookie, SECRETO, { ahora: AHORA + 60_000 }), null, 'a los 60 s ya no');
  assert.equal(verificarSesion(cookie, SECRETO, { ahora: AHORA + 31 * 24 * 3600 * 1000 }), null);
  const unAno = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  assert.ok(verificarSesion(unAno, SECRETO, { ahora: AHORA + 364 * 24 * 3600 * 1000 }), 'a los 364 días sigue valiendo');
  assert.equal(verificarSesion(unAno, SECRETO, { ahora: AHORA + 366 * 24 * 3600 * 1000 }), null);
});

test('sesión: firmada con otro secreto no vale', () => {
  const cookie = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  assert.equal(verificarSesion(cookie, OTRO_SECRETO, { ahora: AHORA }), null);
});

test('sesión: basura y cargas con forma rara (aunque estén bien firmadas) se rechazan', () => {
  for (const basura of [undefined, null, '', 'a', '.', 'a.b', 123, {}, [], 'x'.repeat(5000)]) {
    assert.equal(verificarSesion(basura, SECRETO, { ahora: AHORA }), null, `basura: ${String(basura).slice(0, 20)}`);
  }
  // Cargas bien firmadas pero con contenido que no sirve
  const firmar = (objeto) => {
    const carga = Buffer.from(typeof objeto === 'string' ? objeto : JSON.stringify(objeto)).toString('base64url');
    return `${carga}.${createHmac('sha256', SECRETO).update(carga).digest('base64url')}`;
  };
  const iat = Math.floor(AHORA / 1000);
  assert.ok(verificarSesion(firmar({ e: 'a@b.es', iat, exp: iat + 100 }), SECRETO, { ahora: AHORA }), 'la plantilla buena vale');
  assert.equal(verificarSesion(firmar({ iat, exp: iat + 100 }), SECRETO, { ahora: AHORA }), null, 'sin email');
  assert.equal(verificarSesion(firmar({ e: '', iat, exp: iat + 100 }), SECRETO, { ahora: AHORA }), null, 'email vacío');
  assert.equal(verificarSesion(firmar({ e: 5, iat, exp: iat + 100 }), SECRETO, { ahora: AHORA }), null, 'email no es texto');
  assert.equal(verificarSesion(firmar({ e: 'a@b.es', iat }), SECRETO, { ahora: AHORA }), null, 'sin caducidad');
  assert.equal(verificarSesion(firmar({ e: 'a@b.es', iat, exp: 'nunca' }), SECRETO, { ahora: AHORA }), null, 'caducidad no numérica');
  assert.equal(verificarSesion(firmar('"solo texto"'), SECRETO, { ahora: AHORA }), null, 'JSON que no es objeto');
  assert.equal(verificarSesion(firmar('[1,2]'), SECRETO, { ahora: AHORA }), null, 'JSON que es lista');
  assert.equal(verificarSesion(firmar('esto no es json'), SECRETO, { ahora: AHORA }), null, 'no es JSON');
});

test('sesión: un secreto mal configurado sí lanza (no se confunde con «sin sesión»)', () => {
  assert.throws(() => firmarSesion('a@b.es', '', { ahora: AHORA }), /secreto/i);
  assert.throws(() => firmarSesion('a@b.es', 'corto', { ahora: AHORA }), /secreto/i);
  assert.throws(() => verificarSesion('x.y', undefined, { ahora: AHORA }), /secreto/i);
  assert.throws(() => firmarSesion('', SECRETO, { ahora: AHORA }), /email/i);
});

test('cookie: HttpOnly, SameSite=Lax, Path=/, Max-Age de 365 días y Secure opcional', () => {
  const valor = firmarSesion('a@b.es', SECRETO, { ahora: AHORA });
  const sinSecure = cookieSesion(valor);
  assert.ok(sinSecure.startsWith(`${NOMBRE_COOKIE}=${valor};`));
  assert.equal(NOMBRE_COOKIE, 'bandeja_sesion');
  assert.match(sinSecure, /; Max-Age=31536000(;|$)/);
  assert.match(sinSecure, /; Path=\/(;|$)/);
  assert.match(sinSecure, /; HttpOnly(;|$)/);
  assert.match(sinSecure, /; SameSite=Lax(;|$)/);
  assert.doesNotMatch(sinSecure, /Secure/);
  const conSecure = cookieSesion(valor, { secure: true });
  assert.match(conSecure, /; Secure$/);
});

test('cookie: un valor con caracteres peligrosos no se acepta', () => {
  for (const malo of ['a;b', 'a b', 'a\r\nSet-Cookie: x=1', 'a,b', '', 'ñ', null, undefined]) {
    assert.throws(() => cookieSesion(malo), /cookie/i, `valor: ${JSON.stringify(malo)}`);
  }
});

test('cookie: borrar la sesión pone Max-Age=0 y conserva los atributos de seguridad', () => {
  const borrar = cookieBorrada();
  assert.ok(borrar.startsWith(`${NOMBRE_COOKIE}=;`));
  assert.match(borrar, /Max-Age=0/);
  assert.match(borrar, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(borrar, /HttpOnly/);
  assert.match(borrar, /SameSite=Lax/);
  assert.match(cookieBorrada({ secure: true }), /; Secure$/);
});

test('código: siempre 6 cifras (con ceros por delante) y no se repite siempre el mismo', () => {
  const vistos = new Set();
  let conCeroInicial = 0;
  for (let i = 0; i < 2000; i++) {
    const codigo = generarCodigo();
    assert.match(codigo, /^\d{6}$/);
    vistos.add(codigo);
    if (codigo.startsWith('0')) conCeroInicial++;
  }
  assert.ok(vistos.size > 1500, `debería haber variedad, hay ${vistos.size} distintos`);
  assert.ok(conCeroInicial > 0, 'con 2000 códigos tiene que salir alguno que empiece por 0 (relleno con ceros)');
});

test('hashCodigo: estable, hexadecimal, y distinto si cambia email, código o secreto', () => {
  const base = hashCodigo('ana@b.es', '123456', SECRETO);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(hashCodigo('ana@b.es', '123456', SECRETO), base);
  assert.equal(hashCodigo('  ANA@b.es ', ' 123456 ', SECRETO), base, 'el email y el código se normalizan');
  assert.notEqual(hashCodigo('luis@b.es', '123456', SECRETO), base);
  assert.notEqual(hashCodigo('ana@b.es', '123457', SECRETO), base);
  assert.notEqual(hashCodigo('ana@b.es', '123456', OTRO_SECRETO), base);
  assert.ok(!base.includes('123456'));
  assert.throws(() => hashCodigo('ana@b.es', '123456', ''), /secreto/i);
});

test('hashIp: 32 caracteres hex, estable, distinto por IP y por secreto, y sin la IP dentro', () => {
  const h = hashIp('203.0.113.7', SECRETO);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(hashIp('203.0.113.7', SECRETO), h);
  assert.notEqual(hashIp('203.0.113.8', SECRETO), h);
  assert.notEqual(hashIp('203.0.113.7', OTRO_SECRETO), h);
  assert.ok(!h.includes('203'));
  assert.throws(() => hashIp('203.0.113.7', 'corto'), /secreto/i);
});

test('igualesSeguro: iguales sí, distintos no, longitudes distintas no lanzan, lo que no es texto no', () => {
  assert.equal(igualesSeguro('abc', 'abc'), true);
  assert.equal(igualesSeguro('', ''), true);
  assert.equal(igualesSeguro('abc', 'abd'), false);
  assert.equal(igualesSeguro('abc', 'abcd'), false);
  assert.equal(igualesSeguro('abcd', 'abc'), false);
  assert.equal(igualesSeguro('abc', ''), false);
  assert.equal(igualesSeguro('ñandú', 'ñandú'), true);
  assert.equal(igualesSeguro(undefined, 'abc'), false);
  assert.equal(igualesSeguro('abc', null), false);
  assert.equal(igualesSeguro(123, 123), false);
  assert.equal(igualesSeguro(Buffer.from('abc'), 'abc'), false);
});

test('igualesSeguro: compara de verdad todo el texto (miles de pares distintos, ninguno da «iguales»)', () => {
  for (let i = 0; i < 5000; i++) {
    assert.equal(igualesSeguro(`codigo-${i}`, `codigo-${i + 1}`), false, `par ${i}`);
    assert.equal(igualesSeguro(`codigo-${i}`, `codigo-${i}`), true);
  }
  // Textos largos que solo se diferencian en el último carácter
  const largo = 'x'.repeat(10_000);
  assert.equal(igualesSeguro(largo, `${largo}y`), false);
  assert.equal(igualesSeguro(`${largo}a`, `${largo}b`), false);
});
