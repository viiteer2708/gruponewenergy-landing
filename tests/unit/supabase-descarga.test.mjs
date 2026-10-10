// Pruebas de descargarObjeto (api/_lib/supabase.js, orden 6): bajar un documento del almacén como bytes, con la clave de
// servicio, un tope de tiempo y un freno por tamaño. Contra un Storage FALSO en 127.0.0.1 (nada sale a internet).
// La prueba contra el almacén REAL está en tests/api/40-adjuntos.test.mjs.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { ErrorSupabase, descargarObjeto } from '../../api/_lib/supabase.js';

const md5 = (datos) => createHash('md5').update(datos).digest('hex');
// Todos los valores de byte posibles, varias veces: lo que un .text() estropearía (UTF-8 inválido, 0x00, 0xFF…)
const BINARIO = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(5000), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28])]);

const VARIABLES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let copia;
let servidor;
let recibidas;
let respuesta;

before(async () => {
  servidor = createServer((req, res) => {
    recibidas.push({ metodo: req.method, ruta: req.url, cabeceras: req.headers });
    const enviar = () => {
      res.statusCode = respuesta.status ?? 200;
      for (const [clave, valor] of Object.entries(respuesta.cabeceras ?? {})) res.setHeader(clave, valor);
      res.end(respuesta.cuerpo ?? Buffer.alloc(0));
    };
    if (respuesta.retardoMs) setTimeout(enviar, respuesta.retardoMs);
    else enviar();
  });
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
});
after(async () => {
  servidor.closeAllConnections();
  await new Promise((listo) => servidor.close(listo));
});
beforeEach(() => {
  copia = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
  process.env.SUPABASE_URL = `http://127.0.0.1:${servidor.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-servicio-de-prueba';
  recibidas = [];
  respuesta = { status: 200, cabeceras: { 'Content-Type': 'application/pdf' }, cuerpo: BINARIO };
});
afterEach(() => {
  for (const v of VARIABLES) {
    if (copia[v] === undefined) delete process.env[v];
    else process.env[v] = copia[v];
  }
});

describe('descargarObjeto', () => {
  it('GET /storage/v1/object/<bucket>/<ruta> con la clave de servicio, y devuelve los MISMOS bytes (un Buffer)', async () => {
    const datos = await descargarObjeto('pruebas/gnew/2026/10/GNE-20261010-ABC123-abcdefghij/01.pdf');
    assert.ok(Buffer.isBuffer(datos));
    assert.equal(datos.length, BINARIO.length);
    assert.equal(md5(datos), md5(BINARIO), 'sin pasar por texto: ni un byte cambia');
    assert.equal(recibidas.length, 1);
    const [llamada] = recibidas;
    assert.equal(llamada.metodo, 'GET');
    assert.equal(llamada.ruta, '/storage/v1/object/tramitaciones/pruebas/gnew/2026/10/GNE-20261010-ABC123-abcdefghij/01.pdf');
    assert.equal(llamada.cabeceras.authorization, 'Bearer clave-de-servicio-de-prueba');
    assert.equal(llamada.cabeceras.apikey, 'clave-de-servicio-de-prueba');
  });

  it('un objeto que no existe: Storage contesta 400 con el 404 dentro — ErrorSupabase con status, codigo y statusInterno, sin el cuerpo', async () => {
    respuesta = { status: 400, cabeceras: { 'Content-Type': 'application/json' }, cuerpo: JSON.stringify({ statusCode: '404', error: 'NoSuchKey', message: 'Object not found: pruebas/x/01.pdf' }) };
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf'), (error) => {
      assert.ok(error instanceof ErrorSupabase);
      assert.deepEqual([error.status, error.codigo, error.statusInterno], [400, 'NoSuchKey', 404]);
      assert.ok(!error.message.includes('pruebas/x'), 'el mensaje no lleva rutas ni cuerpos');
      return true;
    });
  });

  it('un 500 del almacén es un ErrorSupabase reintentable', async () => {
    respuesta = { status: 500, cabeceras: { 'Content-Type': 'text/plain' }, cuerpo: 'fallo interno' };
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf'), (error) => error instanceof ErrorSupabase && error.status === 500 && error.reintentable === true);
  });

  it('tope de tiempo: si no contesta a tiempo, ErrorSupabase con codigo «tiempo»', async () => {
    respuesta = { status: 200, cuerpo: BINARIO, retardoMs: 700 };
    const antes = Date.now();
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf', { tope: 150 }), (error) => error instanceof ErrorSupabase && error.codigo === 'tiempo' && error.status === 0);
    assert.ok(Date.now() - antes < 600, 'corta al tope, no espera a la respuesta');
  });

  it('maxBytes: si el objeto DICE pesar más (Content-Length), se corta con codigo «tamano» sin leerlo', async () => {
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf', { maxBytes: BINARIO.length - 1 }), (error) => error instanceof ErrorSupabase && error.codigo === 'tamano');
    // y justo en el tope pasa
    const datos = await descargarObjeto('pruebas/x/01.pdf', { maxBytes: BINARIO.length });
    assert.equal(datos.length, BINARIO.length);
    // sin maxBytes no hay freno
    assert.equal((await descargarObjeto('pruebas/x/01.pdf')).length, BINARIO.length);
  });

  it('no sigue redirecciones (la clave no viaja a otro sitio)', async () => {
    respuesta = { status: 302, cabeceras: { Location: 'http://127.0.0.1:1/otro' }, cuerpo: '' };
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf'), (error) => error instanceof ErrorSupabase && error.codigo === 'red');
    assert.equal(recibidas.length, 1);
  });

  it('rutas raras (con «..», vacías, con barras sobrantes) se rechazan antes de llamar a nadie', async () => {
    for (const mala of ['', '../secreto.pdf', 'a/../b.pdf', 'a//b.pdf', '/a/b.pdf', 'a/./b.pdf', undefined, 42]) {
      await assert.rejects(() => descargarObjeto(mala), RangeError, String(mala));
    }
    assert.equal(recibidas.length, 0);
  });

  it('sin SUPABASE_SERVICE_ROLE_KEY es un error de configuración que se deja subir tal cual (no un fallo de red)', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await assert.rejects(() => descargarObjeto('pruebas/x/01.pdf'), (error) => !(error instanceof ErrorSupabase) && /SUPABASE_SERVICE_ROLE_KEY/.test(error.message));
  });
});
