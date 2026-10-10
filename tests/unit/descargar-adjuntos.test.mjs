// Pruebas de cola.descargarAdjuntos (orden 6): bajar del almacén los documentos que van adjuntos, de 2 en 2 y con un plazo
// común, comprobar que pesan lo comprobado y repartir lo que falla en «en la bandeja». Sin red ni base: el descargador es falso.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';

import { CONCURRENCIA_DESCARGAS, descargarAdjuntos } from '../../api/_lib/cola.js';
import { seleccionarAdjuntos } from '../../api/_lib/correos.js';
import { ErrorSupabase } from '../../api/_lib/supabase.js';

const md5 = (d) => createHash('md5').update(d).digest('hex');
const doc = (orden, nombre, bytes) => ({ id: `id-${orden}`, orden, nombre, ruta: `pruebas/carpeta/${String(orden).padStart(2, '0')}.${nombre.split('.').pop()}`, estado: 'subido', tamano_declarado: bytes, tamano_comprobado: bytes });
const DOCS = Object.freeze([doc(1, 'a.pdf', 100), doc(2, 'b.jpg', 200), doc(3, 'c.png', 300), doc(4, 'd.pdf', 400), doc(5, 'e.jpg', 500), doc(0, 'firma.png', 283)]);
/** Contenido de cada documento: bytes al azar del tamaño que dice la base. */
const contenidos = new Map(DOCS.map((d) => [d.ruta, randomBytes(d.tamano_comprobado)]));

describe('descargarAdjuntos', () => {
  it('baja todo, devuelve los ficheros en el orden de los adjuntos (documentos 1..N y la firma al final) con los mismos bytes', async () => {
    const pedidos = [];
    const descargar = async (ruta, opciones) => {
      pedidos.push({ ruta, ...opciones });
      return contenidos.get(ruta);
    };
    const r = await descargarAdjuntos(seleccionarAdjuntos(DOCS), { tope: 5000, descargar });
    assert.deepEqual(r.ficheros.map((f) => f.nombre), ['a.pdf', 'b.jpg', 'c.png', 'd.pdf', 'e.jpg', 'firma.png']);
    r.ficheros.forEach((f, i) => assert.equal(md5(f.contenido), md5(contenidos.get(r.seleccion.adjuntos[i].doc.ruta))));
    assert.deepEqual(r.seleccion.fuera, []);
    assert.deepEqual(r.fallos, []);
    assert.equal(pedidos.length, 6);
    assert.ok(pedidos.every((p) => p.tope > 0 && p.tope <= 5000), 'cada descarga lleva su tope (lo que queda del plazo común)');
    const peso = Object.fromEntries(DOCS.map((d) => [d.ruta, d.tamano_comprobado]));
    assert.ok(pedidos.every((p) => p.maxBytes === peso[p.ruta]), 'y el peso que debe tener, para cortar antes de leer algo mayor');
  });

  it('nunca hay más de 2 descargas a la vez (el almacén responde 429 cuando va justo de conexiones)', async () => {
    assert.equal(CONCURRENCIA_DESCARGAS, 2);
    let ahora = 0;
    let maximo = 0;
    const descargar = async (ruta) => {
      ahora += 1;
      maximo = Math.max(maximo, ahora);
      await esperar(20);
      ahora -= 1;
      return contenidos.get(ruta);
    };
    const r = await descargarAdjuntos(seleccionarAdjuntos(DOCS), { tope: 5000, descargar });
    assert.equal(r.ficheros.length, 6);
    assert.equal(maximo, 2);
    // con otra concurrencia se respeta la que se pida
    maximo = 0;
    await descargarAdjuntos(seleccionarAdjuntos(DOCS), { tope: 5000, concurrencia: 1, descargar });
    assert.equal(maximo, 1);
  });

  it('lo que falla pasa a «en la bandeja» (motivo «descarga») con su causa, y el resto sigue adjunto', async () => {
    const descargar = async (ruta) => {
      if (ruta.endsWith('02.jpg')) throw new ErrorSupabase('No existe', { status: 400, codigo: 'NoSuchKey', statusInterno: 404 });
      if (ruta.endsWith('03.png')) throw new ErrorSupabase('Tarda', { status: 0, codigo: 'tiempo' });
      if (ruta.endsWith('04.pdf')) throw new ErrorSupabase('Sin red', { status: 0, codigo: 'red' });
      if (ruta.endsWith('05.jpg')) return Buffer.concat([contenidos.get(ruta), Buffer.from([0])]); // pesa un byte de más
      return contenidos.get(ruta);
    };
    const r = await descargarAdjuntos(seleccionarAdjuntos(DOCS), { tope: 5000, descargar });
    assert.deepEqual(r.seleccion.adjuntos.map((a) => a.nombre), ['a.pdf', 'firma.png']);
    assert.deepEqual(r.ficheros.map((f) => f.nombre), ['a.pdf', 'firma.png']);
    assert.deepEqual(r.seleccion.fuera.map((f) => [f.nombre, f.motivo]), [['b.jpg', 'descarga'], ['c.png', 'descarga'], ['d.pdf', 'descarga'], ['e.jpg', 'descarga']], 'en el orden de siempre');
    assert.deepEqual(r.fallos, [{ orden: 2, causa: 'no_existe' }, { orden: 3, causa: 'tiempo' }, { orden: 4, causa: 'red' }, { orden: 5, causa: 'tamano' }]);
    assert.ok(!JSON.stringify(r.fallos).includes('a.pdf') && !JSON.stringify(r.fallos).includes('pruebas/'), 'sin nombres ni rutas');
  });

  it('un fallo que no es del almacén (un error cualquiera, o devolver algo que no es un Buffer) cuenta como «otro» / «tamano»', async () => {
    const r = await descargarAdjuntos(seleccionarAdjuntos([doc(1, 'a.pdf', 10), doc(2, 'b.pdf', 10)]), {
      tope: 5000,
      descargar: async (ruta) => {
        if (ruta.endsWith('01.pdf')) throw new TypeError('algo raro');
        return 'esto no es un Buffer';
      },
    });
    assert.deepEqual(r.fallos, [{ orden: 1, causa: 'otro' }, { orden: 2, causa: 'tamano' }]);
    assert.deepEqual(r.ficheros, []);
    assert.deepEqual(r.seleccion.adjuntos, []);
    assert.equal(r.seleccion.fuera.length, 2);
  });

  it('el plazo es común: si lo que queda no llega, el resto falla con «tiempo» sin ni pedirse', async () => {
    const pedidos = [];
    const descargar = async (ruta, { tope }) => {
      pedidos.push(ruta);
      await esperar(Math.min(tope, 300)); // cada una gasta 300 ms (o lo que quede)
      return contenidos.get(ruta);
    };
    // 6 documentos, 1 a la vez, 400 ms de plazo: caben 2 (300 + 100 que quedan para la 2.ª…) y las demás ni se piden
    const r = await descargarAdjuntos(seleccionarAdjuntos(DOCS), { tope: 400, concurrencia: 1, descargar });
    assert.ok(r.ficheros.length >= 1 && r.ficheros.length < 6, `solo algunas llegan a tiempo (${r.ficheros.length})`);
    assert.ok(pedidos.length < 6, `no se piden los que ya no llegan (${pedidos.length} de 6)`);
    assert.ok(r.fallos.length > 0 && r.fallos.every((f) => f.causa === 'tiempo'));
    assert.equal(r.ficheros.length + r.seleccion.fuera.length, 6, 'ninguno se pierde: o va adjunto o queda en la bandeja');
  });

  it('sin adjuntos que bajar devuelve lo mismo que le dieron y no llama a nadie', async () => {
    let llamadas = 0;
    const seleccion = seleccionarAdjuntos(DOCS, { maxAdjuntos: 0 });
    const r = await descargarAdjuntos(seleccion, { tope: 1000, descargar: async () => { llamadas += 1; } });
    assert.equal(llamadas, 0);
    assert.deepEqual(r.ficheros, []);
    assert.deepEqual(r.fallos, []);
    assert.deepEqual(r.seleccion.fuera.map((f) => f.nombre), ['a.pdf', 'b.jpg', 'c.png', 'd.pdf', 'e.jpg', 'firma.png']);
  });
});
