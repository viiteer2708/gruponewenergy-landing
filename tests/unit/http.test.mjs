// Pruebas de api/_lib/http.js: leerJson (3 vías), responder, soloMetodo, cookies, IP y HTTPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { leerJson, responder, soloMetodo, cookiesDe, ipDe, esHttps } from '../../api/_lib/http.js';
import { LIMITES } from '../../api/_lib/config.js';

function respuestaFalsa() {
  return {
    statusCode: 200,
    cabeceras: {},
    cuerpo: undefined,
    headersSent: false,
    setHeader(nombre, valor) { this.cabeceras[nombre.toLowerCase()] = valor; },
    end(texto) { this.cuerpo = texto; this.headersSent = true; },
  };
}

const ERROR_PETICION = { ok: false, codigo: 'peticion', mensaje: 'No hemos podido leer lo que se ha enviado. Recarga la página e inténtalo de nuevo.', retryable: false };

// ---------------------------------------------------------------------------
// leerJson
// ---------------------------------------------------------------------------

test('leerJson con req.body ya parseado (Vercel): devuelve el mismo objeto', async () => {
  const body = { formulario: 'gnew', datos: { cups: 'ES…' } };
  const r = await leerJson({ body });
  assert.equal(r.ok, true);
  assert.equal(r.datos, body);
});

test('leerJson con JSON roto en Vercel (el getter req.body LANZA): 400 peticion, sin lanzar', async () => {
  const req = { get body() { throw new SyntaxError('Invalid JSON'); } };
  const r = await leerJson(req);
  assert.deepEqual(r, { ok: false, status: 400, cuerpo: ERROR_PETICION });
});

test('leerJson con req.body en texto o en Buffer: lo interpreta; si no es JSON, 400', async () => {
  assert.deepEqual((await leerJson({ body: '{"a":1}' })).datos, { a: 1 });
  assert.deepEqual((await leerJson({ body: Buffer.from('{"a":"ñ"}') })).datos, { a: 'ñ' });
  assert.deepEqual((await leerJson({ body: new TextEncoder().encode('{"b":2}') })).datos, { b: 2 });
  assert.deepEqual((await leerJson({ body: '﻿{"c":3}' })).datos, { c: 3 }, 'con BOM');
  for (const malo of ['{mal', '', '   ', 'undefined', Buffer.from('{"a":'), Buffer.from('')]) {
    const r = await leerJson({ body: malo });
    assert.equal(r.ok, false, JSON.stringify(String(malo)));
    assert.equal(r.status, 400);
    assert.equal(r.cuerpo.codigo, 'peticion');
  }
});

test('leerJson: si el JSON no es un objeto (número, lista, null, texto) también es 400', async () => {
  for (const body of ['5', '[1,2]', 'null', '"hola"', 'true', [1, 2], 7, true]) {
    const r = await leerJson({ body });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.status, 400);
  }
});

test('leerJson sin req.body, leyendo el flujo (servidor local): un JSON bueno', async () => {
  const req = Readable.from([Buffer.from('{"ref":"GNE-20261008-ABC123","archivos":[]}')]);
  const r = await leerJson(req);
  assert.deepEqual(r, { ok: true, datos: { ref: 'GNE-20261008-ABC123', archivos: [] } });
});

test('leerJson leyendo el flujo en trozos: una letra de 2 bytes partida entre trozos se recompone bien', async () => {
  const total = Buffer.from('{"nombre":"Peñíscola ñandú"}');
  const corte = total.indexOf(Buffer.from('ñ')) + 1; // justo en medio de la ñ
  const req = Readable.from([total.subarray(0, corte), total.subarray(corte, corte + 5), total.subarray(corte + 5)]);
  const r = await leerJson(req);
  assert.equal(r.ok, true);
  assert.equal(r.datos.nombre, 'Peñíscola ñandú');
  // También con trozos de texto en vez de Buffer
  const r2 = await leerJson(Readable.from(['{"a":', '"b"}']));
  assert.deepEqual(r2, { ok: true, datos: { a: 'b' } });
});

test('leerJson leyendo el flujo con JSON roto: 400 peticion, sin lanzar', async () => {
  const r = await leerJson(Readable.from(['{mal']));
  assert.deepEqual(r, { ok: false, status: 400, cuerpo: ERROR_PETICION });
});

test('leerJson leyendo el flujo: vacío, o cortado a mitad por la red, es 400', async () => {
  assert.deepEqual((await leerJson(Readable.from([]))).cuerpo, ERROR_PETICION);
  assert.deepEqual((await leerJson(Readable.from([Buffer.from('')]))).cuerpo, ERROR_PETICION);
  const cortada = new Readable({
    read() {
      this.push(Buffer.from('{"a":'));
      this.destroy(new Error('aborted'));
    },
  });
  const r = await leerJson(cortada);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('leerJson leyendo el flujo: más de 3 MB es 413 (justo 3 MB todavía vale); con otro tope también', async () => {
  assert.equal(LIMITES.maxBytesJson, 3 * 1024 * 1024);
  const justo = Buffer.from(`{"x":"${'a'.repeat(LIMITES.maxBytesJson - 8)}"}`);
  assert.equal(justo.length, LIMITES.maxBytesJson);
  const ok = await leerJson(Readable.from([justo]));
  assert.equal(ok.ok, true, 'exactamente 3 MB vale');
  const demasiado = await leerJson(Readable.from([Buffer.concat([justo, Buffer.from(' ')])]));
  assert.equal(demasiado.ok, false);
  assert.equal(demasiado.status, 413);
  assert.equal(demasiado.cuerpo.codigo, 'peticion');
  assert.equal(demasiado.cuerpo.retryable, false);
  // Varios trozos que juntos pasan del tope
  const enTrozos = await leerJson(Readable.from([Buffer.from('{"a":"1234'), Buffer.from('567890"}')]), { maxBytes: 12 });
  assert.equal(enTrozos.status, 413);
  assert.equal((await leerJson(Readable.from([Buffer.from('{"a":1}')]), { maxBytes: 7 })).ok, true);
});

test('leerJson: una petición sin body y que no es un flujo (rara) es 400', async () => {
  assert.equal((await leerJson({})).status, 400);
  assert.equal((await leerJson({ body: null })).status, 400);
  assert.equal((await leerJson(undefined)).status, 400);
});

test('leerJson: ningún mensaje de error lleva detalle técnico', async () => {
  const mensajes = [
    (await leerJson({ get body() { throw new Error('Unexpected token < in JSON at position 0'); } })).cuerpo.mensaje,
    (await leerJson(Readable.from([Buffer.alloc(LIMITES.maxBytesJson + 1)]))).cuerpo.mensaje,
  ];
  for (const m of mensajes) assert.ok(!/JSON|token|position|stack|Error|undefined/i.test(m), m);
});

// ---------------------------------------------------------------------------
// responder y soloMetodo
// ---------------------------------------------------------------------------

test('responder: JSON, código, no-store y cabeceras extra (varias Set-Cookie)', () => {
  const res = respuestaFalsa();
  responder(res, 201, { ok: true, nombre: 'Peñíscola' }, { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'], 'X-Prueba': 'sí' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.cabeceras['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.cabeceras['cache-control'], 'no-store');
  assert.deepEqual(res.cabeceras['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(res.cabeceras['x-prueba'], 'sí');
  assert.deepEqual(JSON.parse(res.cuerpo), { ok: true, nombre: 'Peñíscola' });
});

test('responder: sin cuerpo manda {} y no responde dos veces', () => {
  const res = respuestaFalsa();
  responder(res, 204, undefined);
  assert.equal(res.cuerpo, '{}');
  responder(res, 500, { ok: false });
  assert.equal(res.statusCode, 204, 'la segunda llamada no hace nada');
  assert.equal(res.cuerpo, '{}');
});

test('soloMetodo: deja pasar el método permitido (sin mayúsculas/minúsculas) y no toca la respuesta', () => {
  const res = respuestaFalsa();
  assert.equal(soloMetodo({ method: 'POST' }, res, 'POST'), true);
  assert.equal(soloMetodo({ method: 'post' }, res, 'POST'), true);
  assert.equal(soloMetodo({ method: 'GET' }, res, 'GET', 'HEAD'), true);
  assert.equal(res.headersSent, false);
});

test('soloMetodo: otro método → 405 con Allow y un cuerpo en llano, y devuelve false', () => {
  for (const metodo of ['GET', 'PUT', 'DELETE', 'OPTIONS', undefined]) {
    const res = respuestaFalsa();
    assert.equal(soloMetodo({ method: metodo }, res, 'POST'), false, String(metodo));
    assert.equal(res.statusCode, 405);
    assert.equal(res.cabeceras.allow, 'POST');
    const cuerpo = JSON.parse(res.cuerpo);
    assert.equal(cuerpo.ok, false);
    assert.equal(cuerpo.codigo, 'metodo');
    assert.equal(cuerpo.retryable, false);
  }
  const res = respuestaFalsa();
  soloMetodo({ method: 'POST' }, res, 'GET', 'HEAD');
  assert.equal(res.cabeceras.allow, 'GET, HEAD');
});

// ---------------------------------------------------------------------------
// cookiesDe, ipDe, esHttps
// ---------------------------------------------------------------------------

test('cookiesDe: varias cookies, valores con comillas o codificados, y la primera repetida gana', () => {
  const req = { headers: { cookie: 'bandeja_sesion=abc.def-_1; otra="con comillas"; cod=a%20b%C3%B1; vacia=; bandeja_sesion=SEGUNDA' } };
  assert.deepEqual(cookiesDe(req), { bandeja_sesion: 'abc.def-_1', otra: 'con comillas', cod: 'a bñ', vacia: '' });
});

test('cookiesDe: sin cabecera, mal formada o con nombres peligrosos → no revienta', () => {
  assert.deepEqual(cookiesDe({ headers: {} }), {});
  assert.deepEqual(cookiesDe({}), {});
  assert.deepEqual(cookiesDe(undefined), {});
  assert.deepEqual(cookiesDe({ headers: { cookie: 'sinigual; =vacio; x=%E0%A4%A' } }), { x: '%E0%A4%A' }, 'un % roto se deja tal cual');
  const sucio = cookiesDe({ headers: { cookie: '__proto__=hola; a=1' } });
  assert.deepEqual(sucio, { a: '1' });
  assert.equal(Object.getPrototypeOf(sucio), Object.prototype);
});

test('cookiesDe: si no hay cabecera pero la petición trae req.cookies (servidor local), las usa', () => {
  assert.deepEqual(cookiesDe({ cookies: { bandeja_sesion: 'xyz', numero: 5, __proto__: null } }), { bandeja_sesion: 'xyz' });
});

test('ipDe: x-real-ip primero, luego el primer valor de x-forwarded-for, luego el socket', () => {
  assert.equal(ipDe({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }), '203.0.113.7');
  assert.equal(ipDe({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }), '198.51.100.9');
  assert.equal(ipDe({ headers: { 'x-forwarded-for': '  198.51.100.9  ' } }), '198.51.100.9');
  assert.equal(ipDe({ headers: { 'x-forwarded-for': ['198.51.100.9, 1.1.1.1', '2.2.2.2'] } }), '198.51.100.9');
  assert.equal(ipDe({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(ipDe({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '127.0.0.1');
  assert.equal(ipDe({ headers: { 'x-real-ip': '2001:db8::1' } }), '2001:db8::1');
});

test('ipDe: si no hay nada, o lo que viene no parece una IP, devuelve cadena vacía', () => {
  assert.equal(ipDe({ headers: {} }), '');
  assert.equal(ipDe({}), '');
  assert.equal(ipDe(undefined), '');
  assert.equal(ipDe({ headers: { 'x-real-ip': 'no soy una ip; DROP TABLE' } }), '');
  assert.equal(ipDe({ headers: { 'x-forwarded-for': '<script>' } }), '');
});

test('esHttps: lo dice x-forwarded-proto (primer valor); sin él, el socket', () => {
  assert.equal(esHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(esHttps({ headers: { 'x-forwarded-proto': 'HTTPS, http' } }), true);
  assert.equal(esHttps({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(esHttps({ headers: { 'x-forwarded-proto': 'http, https' } }), false);
  assert.equal(esHttps({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(esHttps({ headers: {}, socket: {} }), false);
  assert.equal(esHttps({}), false);
  assert.equal(esHttps(undefined), false);
});
