// Pruebas de api/_lib/estados.js: transiciones, esperas y clasificación de Altavoz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TRANSICIONES,
  transicionValida,
  ESTADOS_CORREO,
  MAX_INTENTOS,
  ESPERAS_MINUTOS,
  esperaMinutos,
  clasificarAltavoz,
} from '../../api/_lib/estados.js';

const sql = readFileSync(new URL('../../supabase/tramitacion.sql', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Tramitaciones
// ---------------------------------------------------------------------------

test('TRANSICIONES: las del diseño (subiendo → recibida/abandonada, recibida ⇄ tramitada, abandonada → subiendo, descartada fija)', () => {
  assert.deepEqual(Object.keys(TRANSICIONES).sort(), ['abandonada', 'descartada', 'recibida', 'subiendo', 'tramitada']);
  assert.deepEqual([...TRANSICIONES.subiendo].sort(), ['abandonada', 'recibida']);
  assert.deepEqual([...TRANSICIONES.recibida], ['tramitada']);
  assert.deepEqual([...TRANSICIONES.tramitada], ['recibida']);
  assert.deepEqual([...TRANSICIONES.abandonada], ['subiendo']);
  assert.deepEqual([...TRANSICIONES.descartada], []);
  assert.ok(Object.isFrozen(TRANSICIONES) && Object.isFrozen(TRANSICIONES.subiendo));
});

test('TRANSICIONES: los estados son exactamente los del check de tramitaciones.estado en el SQL', () => {
  const bloque = sql.match(/estado\s+text not null default 'subiendo'\s+check \(estado in \(([^)]*)\)\)/)?.[1];
  assert.ok(bloque, 'el SQL define los estados de la tramitación');
  const delSql = [...bloque.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(TRANSICIONES).sort(), delSql);
  // Y todo destino es un estado conocido
  for (const destinos of Object.values(TRANSICIONES)) for (const d of destinos) assert.ok(Object.hasOwn(TRANSICIONES, d), d);
});

test('transicionValida: las permitidas sí, las demás no (incluidos estados que no existen)', () => {
  assert.equal(transicionValida('subiendo', 'recibida'), true);
  assert.equal(transicionValida('subiendo', 'abandonada'), true);
  assert.equal(transicionValida('recibida', 'tramitada'), true);
  assert.equal(transicionValida('tramitada', 'recibida'), true);
  assert.equal(transicionValida('abandonada', 'subiendo'), true);
  assert.equal(transicionValida('recibida', 'subiendo'), false, 'una recibida no vuelve a subir');
  assert.equal(transicionValida('tramitada', 'subiendo'), false);
  assert.equal(transicionValida('subiendo', 'tramitada'), false, 'no se tramita lo que no ha llegado entero');
  assert.equal(transicionValida('descartada', 'recibida'), false);
  assert.equal(transicionValida('recibida', 'recibida'), false);
  assert.equal(transicionValida('inventado', 'recibida'), false);
  assert.equal(transicionValida('recibida', 'inventado'), false);
  assert.equal(transicionValida('constructor', 'x'), false);
  assert.equal(transicionValida(undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// Esperas
// ---------------------------------------------------------------------------

test('esperaMinutos: 1, 3, 10, 30, 60, 120, 240 tras cada fallo y, a partir del 8.º, null (agotado)', () => {
  assert.deepEqual([...ESPERAS_MINUTOS], [1, 3, 10, 30, 60, 120, 240]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(esperaMinutos), [1, 3, 10, 30, 60, 120, 240]);
  assert.equal(MAX_INTENTOS, 8);
  assert.equal(esperaMinutos(8), null);
  assert.equal(esperaMinutos(9), null);
  assert.equal(esperaMinutos(100), null);
  assert.equal(esperaMinutos(0), 0, 'sin fallos todavía no hay espera');
  assert.equal(esperaMinutos(-3), 0);
  assert.equal(esperaMinutos(undefined), 0);
  assert.equal(esperaMinutos(NaN), 0);
  assert.ok(Object.isFrozen(ESPERAS_MINUTOS));
});

test('ESTADOS_CORREO: son exactamente los del check de tramitacion_correos.estado en el SQL', () => {
  // Ojo: tramitacion_documentos también tiene un estado con default 'pendiente'; se acota a la tabla de correos
  const tablaCorreos = sql.match(/create table if not exists public\.tramitacion_correos \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(tablaCorreos, 'el SQL define la tabla de correos');
  const bloque = tablaCorreos.match(/estado\s+text not null default 'pendiente'\s+check \(estado in \(([^)]*)\)\)/)?.[1];
  assert.ok(bloque, 'el SQL define los estados del correo');
  const delSql = [...bloque.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...ESTADOS_CORREO].sort(), delSql);
});

// ---------------------------------------------------------------------------
// clasificarAltavoz: la tabla de §2.2
// ---------------------------------------------------------------------------

test('Altavoz caso 1/7: 2xx → enviado, sin alerta', () => {
  for (const status of [200, 201, 202, 204]) {
    assert.deepEqual(clasificarAltavoz({ status }), { estado: 'enviado', terminal: true, alerta: 'no', codigo: null, motivo: '' }, String(status));
  }
});

test('Altavoz caso 2/7: 409 destinatario_suprimido → suprimido (terminal), alerta inmediata', () => {
  const r = clasificarAltavoz({ status: 409, codigo: 'destinatario_suprimido' });
  assert.equal(r.estado, 'suprimido');
  assert.equal(r.terminal, true);
  assert.equal(r.alerta, 'inmediata');
  assert.equal(r.codigo, 'destinatario_suprimido');
  assert.match(r.motivo, /bloqueado/);
});

test('Altavoz caso 3/7: 409 modo_prueba → pendiente (se reintenta), y avisa si se atasca', () => {
  const r = clasificarAltavoz({ status: 409, codigo: 'modo_prueba' });
  assert.equal(r.estado, 'pendiente');
  assert.equal(r.terminal, false);
  assert.equal(r.alerta, 'si_atascado');
  assert.equal(r.codigo, 'modo_prueba');
  assert.match(r.motivo, /modo prueba/);
});

test('Altavoz caso 4/7: 401, 403 y 422 (con o sin codigo) → error_configuracion (terminal), alerta inmediata', () => {
  for (const status of [401, 403, 422]) {
    const r = clasificarAltavoz({ status });
    assert.equal(r.estado, 'error_configuracion', String(status));
    assert.equal(r.terminal, true);
    assert.equal(r.alerta, 'inmediata');
    assert.equal(r.codigo, `http_${status}`);
  }
  const sinRemitente = clasificarAltavoz({ status: 422, codigo: 'marca_sin_remitente' });
  assert.equal(sinRemitente.estado, 'error_configuracion');
  assert.equal(sinRemitente.codigo, 'marca_sin_remitente');
});

test('Altavoz caso 5/7: 502 envio_incierto → incierto (terminal para el robot), alerta inmediata', () => {
  const r = clasificarAltavoz({ status: 502, codigo: 'envio_incierto' });
  assert.equal(r.estado, 'incierto');
  assert.equal(r.terminal, true);
  assert.equal(r.alerta, 'inmediata');
  assert.equal(r.codigo, 'envio_incierto');
  assert.match(r.motivo, /comprobar/);
});

test('Altavoz caso 6/7: 502 rechazado, 503 (los tres códigos), 500, red y tiempo → pendiente con espera creciente', () => {
  const pasajeros = [
    { status: 502, codigo: 'envio_rechazado' },
    { status: 502 },
    { status: 503, codigo: 'no_comprobado' },
    { status: 503, codigo: 'envio_no_disponible' },
    { status: 503, codigo: 'envio_no_encendido' },
    { status: 503 },
    { status: 500, codigo: 'error_interno' },
    { status: 500 },
    { red: 'red' },
    { red: 'tiempo' },
    { red: true },
  ];
  for (const entrada of pasajeros) {
    const r = clasificarAltavoz(entrada);
    assert.equal(r.estado, 'pendiente', JSON.stringify(entrada));
    assert.equal(r.terminal, false, JSON.stringify(entrada));
    assert.equal(r.alerta, 'si_atascado', JSON.stringify(entrada));
    assert.ok(r.motivo.length > 0 && r.motivo.length < 100, 'frase corta');
  }
  assert.equal(clasificarAltavoz({ red: 'red' }).codigo, 'red');
  assert.equal(clasificarAltavoz({ red: true }).codigo, 'red');
  assert.equal(clasificarAltavoz({ red: 'tiempo' }).codigo, 'tiempo');
  assert.equal(clasificarAltavoz({ status: 503, codigo: 'no_comprobado' }).codigo, 'no_comprobado');
  assert.equal(clasificarAltavoz({ status: 500 }).codigo, 'http_500');
});

test('Altavoz caso 7/7: el 8.º intento fallido → agotado (terminal, alerta inmediata); antes de él, pendiente', () => {
  for (const entrada of [{ status: 503 }, { red: 'red' }, { red: 'tiempo' }, { status: 502, codigo: 'envio_rechazado' }, { status: 409, codigo: 'modo_prueba' }, { status: 500 }]) {
    for (const intentos of [1, 4, 7]) {
      assert.equal(clasificarAltavoz({ ...entrada, intentos }).estado, 'pendiente', `${JSON.stringify(entrada)} intento ${intentos}`);
    }
    for (const intentos of [8, 9, 20]) {
      const r = clasificarAltavoz({ ...entrada, intentos });
      assert.equal(r.estado, 'agotado', `${JSON.stringify(entrada)} intento ${intentos}`);
      assert.equal(r.terminal, true);
      assert.equal(r.alerta, 'inmediata');
      assert.match(r.motivo, /agotado los 8 intentos/);
    }
  }
  // Un éxito o un fallo ya terminal no cambian aunque sea el intento 8
  assert.equal(clasificarAltavoz({ status: 200, intentos: 8 }).estado, 'enviado');
  assert.equal(clasificarAltavoz({ status: 409, codigo: 'destinatario_suprimido', intentos: 8 }).estado, 'suprimido');
  assert.equal(clasificarAltavoz({ status: 401, intentos: 8 }).estado, 'error_configuracion');
  assert.equal(clasificarAltavoz({ status: 502, codigo: 'envio_incierto', intentos: 8 }).estado, 'incierto');
});

test('Altavoz, lo que la tabla no recoge: se reintenta (409 con otro código, 404, 413, 3xx, sin datos)', () => {
  for (const entrada of [{ status: 409, codigo: 'lista_bloqueada' }, { status: 409 }, { status: 404 }, { status: 413 }, { status: 301 }, { status: 400 }, {}, undefined, { status: 'raro' }]) {
    const r = clasificarAltavoz(entrada);
    assert.equal(r.estado, 'pendiente', JSON.stringify(entrada));
    assert.equal(r.terminal, false);
    assert.equal(r.alerta, 'si_atascado');
    assert.match(r.motivo, /inesperada/);
  }
  assert.equal(clasificarAltavoz({ status: 404 }).codigo, 'http_404');
  assert.equal(clasificarAltavoz({ status: 409, codigo: 'lista_bloqueada' }).codigo, 'lista_bloqueada');
  assert.equal(clasificarAltavoz({}).codigo, 'desconocido');
});

test('Altavoz: el status puede llegar como texto, y red gana a status', () => {
  assert.equal(clasificarAltavoz({ status: '200' }).estado, 'enviado');
  assert.equal(clasificarAltavoz({ status: '503' }).estado, 'pendiente');
  assert.equal(clasificarAltavoz({ status: 200, red: 'tiempo' }).estado, 'pendiente', 'si hubo fallo de red no hay respuesta que valga');
});

test('Altavoz: ninguna frase lleva datos personales ni detalles técnicos de más', () => {
  const entradas = [{ status: 200 }, { status: 409, codigo: 'destinatario_suprimido' }, { status: 409, codigo: 'modo_prueba' }, { status: 401 },
    { status: 502, codigo: 'envio_incierto' }, { status: 503 }, { red: 'red' }, { red: 'tiempo' }, { status: 404 }, { status: 503, intentos: 8 }];
  for (const e of entradas) {
    const { motivo } = clasificarAltavoz(e);
    assert.ok(!/@|https?:|Bearer|av_/i.test(motivo), motivo);
  }
});
