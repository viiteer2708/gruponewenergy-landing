// Pruebas de api/_lib/tramitacion.js: mapearDatos (lo que manda el formulario → columnas de `tramitaciones`).
// Sin internet ni base: mapearDatos es una función pura. iniciar y confirmar se prueban por HTTP en tests/api/10-tramitacion.
//
// Regla nueva (Victor, 15-oct-2026): todo lo que escribe el comercial se guarda EN MAYÚSCULAS (de esa fila salen la bandeja, el aviso
// a backoffice con su asunto y el acuse), menos los correos electrónicos, que van en minúsculas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapearDatos } from '../../api/_lib/tramitacion.js';
import { normalizarBusqueda } from '../../api/_lib/nombres.js';
import { TARIFAS_MEGA } from '../../api/_lib/validadores.js';

// Un envío de GNEW tal como lo teclea un comercial: minúsculas, tildes, eñes, espacios y comas.
const ENTRADA_GNEW = Object.freeze({
  quien_eres: 'ana lópez',
  email_comercial: 'ana.lopez@ejemplo.es',
  compania: 'endesa energía xxi',
  cups: 'es0021000000000001rk',
  oferta: 'fijo 12 meses',
  tarifa: '2.0td',
  p1: '4,6', p2: '4,6', p3: '', p4: '', p5: '', p6: '',
  titular: 'Juan Pérez Peña SL',
  cif_nif: 'b-12345678',
  nombre_firmante: 'maría núñez',
  dni_firmante: '12345678z',
  cuenta_bancaria: 'es91 2100 0418 4502 0005 1332',
  dir_suministro: 'calle mayor 5, 2.º b',
  codigo_postal: '12598',
  poblacion: 'Peñíscola',
  provincia: 'castellón',
  movil: '600 000 000',
  email_cliente: 'cliente@ejemplo.es',
  cambio_titular: 'Sí',
  titular_anterior: 'ñandú e hijos, s.l.',
  observaciones: 'línea uno\nlínea dos',
  terminos: true,
});

// El de MEGA no pregunta la compañía ni el tipo de suministro (se deduce de la tarifa).
const { compania: _compania, ...SIN_COMPANIA } = ENTRADA_GNEW;
const ENTRADA_MEGA = Object.freeze({ ...SIN_COMPANIA, tarifa: 'RL.1' });

// ---------------------------------------------------------------------------
// Mayúsculas
// ---------------------------------------------------------------------------

test('mapearDatos: lo que escribe el comercial se guarda EN MAYÚSCULAS, con sus tildes y la Ñ', () => {
  const f = mapearDatos('gnew', ENTRADA_GNEW);
  assert.deepEqual(
    {
      comercial_nombre: f.comercial_nombre,
      compania: f.compania,
      oferta: f.oferta,
      tarifa: f.tarifa,
      titular_nombre: f.titular_nombre,
      firmante_nombre: f.firmante_nombre,
      direccion: f.direccion,
      cp: f.cp,
      poblacion: f.poblacion,
      provincia: f.provincia,
      telefono: f.telefono,
      nuevo_titular: f.nuevo_titular,
      observaciones: f.observaciones,
    },
    {
      comercial_nombre: 'ANA LÓPEZ',
      compania: 'ENDESA ENERGÍA XXI',
      oferta: 'FIJO 12 MESES',
      tarifa: '2.0TD',
      titular_nombre: 'JUAN PÉREZ PEÑA SL',
      firmante_nombre: 'MARÍA NÚÑEZ',
      direccion: 'CALLE MAYOR 5, 2.º B',
      cp: '12598',
      poblacion: 'PEÑÍSCOLA',
      provincia: 'CASTELLÓN',
      telefono: '600 000 000',
      nuevo_titular: 'ÑANDÚ E HIJOS, S.L.',
      observaciones: 'LÍNEA UNO\nLÍNEA DOS',
    },
  );
});

test('mapearDatos: «Peñíscola» → «PEÑÍSCOLA» (la Ñ y las tildes no se pierden ni se quitan)', () => {
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, poblacion: 'Peñíscola' }).poblacion, 'PEÑÍSCOLA');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, poblacion: 'a coruña' }).poblacion, 'A CORUÑA');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, provincia: 'málaga' }).provincia, 'MÁLAGA');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, titular: 'Pérez y Hnos. Ñoño, S.L.U.' }).titular_nombre, 'PÉREZ Y HNOS. ÑOÑO, S.L.U.');
});

test('mapearDatos: un texto de una línea sin saltos ni espacios de más, y DESPUÉS en mayúsculas', () => {
  const f = mapearDatos('gnew', { ...ENTRADA_GNEW, quien_eres: '  ana\nlópez\tgarcía  ', dir_suministro: 'calle\r\nmayor   5' });
  assert.equal(f.comercial_nombre, 'ANA LÓPEZ GARCÍA');
  assert.equal(f.direccion, 'CALLE MAYOR 5');
});

test('mapearDatos: las observaciones conservan los saltos de línea (y los \\r\\n pasan a \\n)', () => {
  const f = mapearDatos('gnew', { ...ENTRADA_GNEW, observaciones: 'línea 1\r\nlínea 2\n\núltima línea con <b>etiqueta</b> & más' });
  assert.equal(f.observaciones, 'LÍNEA 1\nLÍNEA 2\n\nÚLTIMA LÍNEA CON <B>ETIQUETA</B> & MÁS');
  assert.equal(f.observaciones.split('\n').length, 4, 'cuatro líneas, con la vacía de en medio');
});

test('mapearDatos: la compañía de GNEW (texto libre) va en mayúsculas', () => {
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, compania: 'Compañía de Prueba' }).compania, 'COMPAÑÍA DE PRUEBA');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, compania: ' naturgy ' }).compania, 'NATURGY');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, compania: undefined }).compania, '');
});

// ---------------------------------------------------------------------------
// Correos electrónicos: minúsculas
// ---------------------------------------------------------------------------

test('mapearDatos: los correos electrónicos siguen en minúsculas aunque lleguen en mayúsculas', () => {
  const f = mapearDatos('gnew', { ...ENTRADA_GNEW, email_comercial: '  Victor.Molins.10+Mayus@Gmail.COM ', email_cliente: 'CLIENTE@EJEMPLO.ES' });
  assert.equal(f.comercial_email, 'victor.molins.10+mayus@gmail.com');
  assert.equal(f.email_cliente, 'cliente@ejemplo.es');
  const m = mapearDatos('mega', { ...ENTRADA_MEGA, email_comercial: 'ANA.LOPEZ@EJEMPLO.ES', email_cliente: 'Cliente@Ejemplo.ES' });
  assert.deepEqual([m.comercial_email, m.email_cliente], ['ana.lopez@ejemplo.es', 'cliente@ejemplo.es']);
});

// ---------------------------------------------------------------------------
// MEGA
// ---------------------------------------------------------------------------

test('mapearDatos MEGA: la tarifa «RL.1» da tipo «GAS» y «2.0TD» da «LUZ» (en mayúsculas); la compañía es fija', () => {
  const gas = mapearDatos('mega', ENTRADA_MEGA);
  assert.deepEqual([gas.tarifa, gas.tipo_suministro, gas.compania], ['RL.1', 'GAS', 'MEGA ENERGIA']);
  const luz = mapearDatos('mega', { ...ENTRADA_MEGA, tarifa: '2.0TD' });
  assert.deepEqual([luz.tarifa, luz.tipo_suministro, luz.compania], ['2.0TD', 'LUZ', 'MEGA ENERGIA']);
  for (const tarifa of TARIFAS_MEGA) {
    assert.equal(mapearDatos('mega', { ...ENTRADA_MEGA, tarifa }).tipo_suministro, tarifa.startsWith('RL') ? 'GAS' : 'LUZ', tarifa);
  }
});

test('mapearDatos MEGA: la compañía que diga el cliente se ignora y el tipo de suministro lo deduce el servidor', () => {
  const f = mapearDatos('mega', { ...ENTRADA_MEGA, compania: 'Lo que diga un cliente tramposo', tipo_suministro: 'Luz' });
  assert.equal(f.compania, 'MEGA ENERGIA');
  assert.equal(f.tipo_suministro, 'GAS', 'RL.1 es gas, diga lo que diga el cliente');
});

test('mapearDatos MEGA: el tipo de suministro se deduce con la tarifa TAL CUAL llega, antes de pasarla a mayúsculas', () => {
  // validarDatos rechaza estas tarifas (no son las del desplegable), así que no llegan en un envío real; aquí se fija el orden:
  // si mapearDatos pasara la tarifa a mayúsculas ANTES de deducir el tipo, «2.0td» daría «LUZ».
  for (const tarifa of ['2.0td', 'rl.1', 'Rl.3']) {
    const f = mapearDatos('mega', { ...ENTRADA_MEGA, tarifa });
    assert.equal(f.tarifa, tarifa.toUpperCase(), `${tarifa}: la tarifa sí se guarda en mayúsculas`);
    assert.equal(f.tipo_suministro, null, `${tarifa}: no está en la lista tal cual, no hay tipo`);
  }
  assert.equal(mapearDatos('mega', { ...ENTRADA_MEGA, tarifa: '9.9XX' }).tipo_suministro, null, 'una tarifa que no es de la lista no tiene tipo');
  assert.equal(mapearDatos('mega', { ...ENTRADA_MEGA, tarifa: '  RL.2  ' }).tipo_suministro, 'GAS', 'recortada sí vale');
});

test('mapearDatos GNEW: el tipo de suministro no se guarda (solo existe en MEGA), venga lo que venga', () => {
  assert.equal(mapearDatos('gnew', ENTRADA_GNEW).tipo_suministro, null);
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, tarifa: 'RL.1', tipo_suministro: 'Gas' }).tipo_suministro, null);
});

// ---------------------------------------------------------------------------
// Cambio de titular (Victor, 16-oct-2026): se guardan los datos del titular ANTERIOR, en la columna `nuevo_titular` (nombre histórico, sin SQL)
// ---------------------------------------------------------------------------

test('mapearDatos: con cambio de titular «Sí», la columna `nuevo_titular` guarda el titular ANTERIOR en MAYÚSCULAS (con sus tildes y la Ñ)', () => {
  for (const si of ['Si', 'Sí', 'si', 'SÍ']) {
    const f = mapearDatos('gnew', { ...ENTRADA_GNEW, cambio_titular: si, titular_anterior: 'ñandú e hijos, s.l., b-12345674, calle nueva 3' });
    assert.equal(f.cambio_titular, true, si);
    assert.equal(f.nuevo_titular, 'ÑANDÚ E HIJOS, S.L., B-12345674, CALLE NUEVA 3', si);
  }
  // el titular NUEVO (el del contrato) no se mezcla con él
  const f = mapearDatos('mega', { ...ENTRADA_MEGA, titular: 'Titular Nuevo SL', titular_anterior: 'Antiguo Dueño SA' });
  assert.deepEqual([f.titular_nombre, f.nuevo_titular], ['TITULAR NUEVO SL', 'ANTIGUO DUEÑO SA']);
  // una sola línea, sin espacios de más, recortado a 500 y DESPUÉS en mayúsculas (como el resto)
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, titular_anterior: '  ana\nlópez\tgarcía  ' }).nuevo_titular, 'ANA LÓPEZ GARCÍA');
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, titular_anterior: 'ñ'.repeat(600) }).nuevo_titular, 'Ñ'.repeat(500));
});

test('mapearDatos: con cambio de titular «No» (o sin elegir) la columna `nuevo_titular` es null, aunque llegue texto en el campo oculto', () => {
  for (const no of ['No', 'no', 'NO', '', undefined, null, 'quizá']) {
    for (const campo of ['titular_anterior', 'nuevo_titular']) {
      const f = mapearDatos('gnew', { ...ENTRADA_GNEW, cambio_titular: no, titular_anterior: undefined, [campo]: 'texto que sobra' });
      assert.equal(f.cambio_titular, false, JSON.stringify(no));
      assert.equal(f.nuevo_titular, null, `${JSON.stringify(no)} · ${campo}`);
    }
  }
  assert.equal(mapearDatos('mega', { ...ENTRADA_MEGA, cambio_titular: 'No', titular_anterior: '' }).nuevo_titular, null, 'lo que manda el formulario nuevo con «No»');
});

test('mapearDatos: una página vieja (abierta antes del 16-oct-2026) manda el dato como `nuevo_titular`: vale como sinónimo; gana el primero que traiga texto', () => {
  const vieja = { ...ENTRADA_GNEW, titular_anterior: undefined, nuevo_titular: 'luis gómez, 11111111h' };
  assert.equal(mapearDatos('gnew', vieja).nuevo_titular, 'LUIS GÓMEZ, 11111111H');
  assert.equal(mapearDatos('gnew', { ...vieja, titular_anterior: '' }).nuevo_titular, 'LUIS GÓMEZ, 11111111H', 'el nuevo campo vacío no tapa al viejo');
  assert.equal(mapearDatos('gnew', { ...vieja, titular_anterior: '   ' }).nuevo_titular, 'LUIS GÓMEZ, 11111111H', 'ni uno en blanco');
  assert.equal(mapearDatos('gnew', { ...vieja, titular_anterior: 'ana pérez' }).nuevo_titular, 'ANA PÉREZ', 'con los dos, manda el nuevo');
  assert.equal(mapearDatos('gnew', { ...vieja, nuevo_titular: '' }).nuevo_titular, null, 'sin texto en ninguno, null');
});

// ---------------------------------------------------------------------------
// Opcionales vacíos: null (no «»)
// ---------------------------------------------------------------------------

test('mapearDatos: los opcionales vacíos, en blanco o ausentes siguen siendo null', () => {
  // (claves de ENTRADA: lo que manda el formulario; `esperados` son las COLUMNAS: el titular anterior vive en `nuevo_titular`, nombre histórico)
  const opcionales = ['oferta', 'tarifa', 'nombre_firmante', 'dni_firmante', 'titular_anterior', 'observaciones'];
  const esperados = { oferta: null, tarifa: null, firmante_nombre: null, firmante_nif: null, nuevo_titular: null, observaciones: null, tipo_suministro: null };
  const sacar = (f) => Object.fromEntries(Object.keys(esperados).map((k) => [k, f[k]]));
  for (const valor of ['', '   ', ' \n\t ', undefined, null]) {
    const datos = { ...ENTRADA_MEGA, ...Object.fromEntries(opcionales.map((k) => [k, valor])) };
    assert.deepEqual(sacar(mapearDatos('mega', datos)), esperados, `MEGA con ${JSON.stringify(valor)}`);
    assert.deepEqual(sacar(mapearDatos('gnew', { ...ENTRADA_GNEW, ...Object.fromEntries(opcionales.map((k) => [k, valor])) })), esperados, `GNEW con ${JSON.stringify(valor)}`);
  }
});

test('mapearDatos: sin datos (o con algo que no es un objeto) los textos obligatorios salen «» y los opcionales null, sin romper', () => {
  for (const nada of [undefined, null, [], 'texto', 42, {}]) {
    for (const formulario of ['gnew', 'mega']) {
      const f = mapearDatos(formulario, nada);
      for (const campo of ['comercial_nombre', 'comercial_email', 'cups', 'titular_nombre', 'titular_nif', 'iban', 'direccion', 'cp', 'poblacion', 'provincia', 'telefono', 'email_cliente']) {
        assert.equal(f[campo], '', `${formulario} · ${JSON.stringify(nada)} · ${campo}`);
      }
      assert.equal(f.compania, formulario === 'mega' ? 'MEGA ENERGIA' : '');
      for (const campo of ['oferta', 'tarifa', 'tipo_suministro', 'firmante_nombre', 'firmante_nif', 'nuevo_titular', 'observaciones']) {
        assert.equal(f[campo], null, `${formulario} · ${JSON.stringify(nada)} · ${campo}`);
      }
      assert.deepEqual(f.potencias, {});
      assert.equal(f.cambio_titular, false);
    }
  }
});

// ---------------------------------------------------------------------------
// Lo que ya iba bien no cambia
// ---------------------------------------------------------------------------

test('mapearDatos: CUPS, NIF e IBAN compactos y en mayúsculas; potencias con punto y solo las rellenas; cambio_titular booleano', () => {
  const f = mapearDatos('gnew', ENTRADA_GNEW);
  assert.equal(f.cups, 'ES0021000000000001RK');
  assert.equal(f.titular_nif, 'B12345678');
  assert.equal(f.firmante_nif, '12345678Z');
  assert.equal(f.iban, 'ES9121000418450200051332');
  assert.deepEqual(f.potencias, { p1: '4.6', p2: '4.6' }, 'coma → punto y solo las rellenas (las potencias no cambian)');
  assert.equal(f.cambio_titular, true);
  assert.equal(typeof f.cambio_titular, 'boolean');
  for (const [cambio, esperado] of [['Si', true], ['SÍ', true], ['sí', true], ['No', false], ['no', false], ['', false], [undefined, false], ['quizá', false]]) {
    const r = mapearDatos('gnew', { ...ENTRADA_GNEW, cambio_titular: cambio }).cambio_titular;
    assert.equal(r, esperado, `cambio_titular ${JSON.stringify(cambio)}`);
    assert.equal(typeof r, 'boolean');
  }
});

test('mapearDatos: los topes de longitud se aplican igual (se recorta y luego se pasa a mayúsculas)', () => {
  const largo = 'ñ'.repeat(400);
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, titular: largo }).titular_nombre, 'Ñ'.repeat(250));
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, dir_suministro: largo }).direccion, 'Ñ'.repeat(300));
  assert.equal(mapearDatos('gnew', { ...ENTRADA_GNEW, observaciones: 'á'.repeat(5000) }).observaciones, 'Á'.repeat(4000));
});

test('mapearDatos: lo guardado en mayúsculas se busca igual (la búsqueda normaliza a minúsculas y sin tildes)', () => {
  const f = mapearDatos('gnew', ENTRADA_GNEW);
  assert.equal(normalizarBusqueda(f.titular_nombre), normalizarBusqueda('Juan Pérez Peña SL'));
  assert.equal(normalizarBusqueda(f.titular_nombre), 'juan perez pena sl');
  assert.equal(normalizarBusqueda(f.poblacion), 'peniscola');
  assert.equal(normalizarBusqueda(f.comercial_nombre), normalizarBusqueda('ana lópez'));
});

test('mapearDatos: es determinista y no toca lo que recibe (iniciar compara lo guardado con esto: una diferencia falsa apuntaría «datos actualizados»)', () => {
  const copia = structuredClone(ENTRADA_GNEW);
  const a = mapearDatos('gnew', ENTRADA_GNEW);
  const b = mapearDatos('gnew', ENTRADA_GNEW);
  assert.deepEqual(a, b);
  assert.deepEqual(ENTRADA_GNEW, copia, 'la entrada queda como estaba');
  // y los mismos datos ya en mayúsculas dan lo mismo que tecleados en minúsculas
  const enMayusculas = Object.fromEntries(Object.entries(ENTRADA_GNEW).map(([k, v]) => [k, typeof v === 'string' && !k.startsWith('email') ? v.toUpperCase() : v]));
  assert.deepEqual(mapearDatos('gnew', enMayusculas), a);
});
