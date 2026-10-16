// Pruebas de api/_lib/validadores.js: formatos españoles y validarDatos.
//
// Los valores "reales" (CUPS, IBAN, DNI, NIE, CIF) están calculados con una
// implementación independiente en Python, no con el código que se prueba; los
// "falsos" son el mismo valor con un dígito o una letra de control cambiados,
// para probar el checksum y no solo el formato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  esDNI, esNIE, esCIF, esIdFiscal, esCUPS, esIBAN, esMovil, esCP, esEmail,
  TARIFAS_MEGA, tipoSuministroDe, FRASES, CAMPOS_OBLIGATORIOS, validarDatos,
} from '../../api/_lib/validadores.js';

const raiz = new URL('../../', import.meta.url);
const leer = (ruta) => readFileSync(new URL(ruta, raiz), 'utf8');
const sinTildes = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');

// ---------------------------------------------------------------------------
// Formatos: valores reales y falsos
// ---------------------------------------------------------------------------

test('CUPS: valen los reales (con terminación, en minúsculas, con espacios) y no los de checksum roto', () => {
  for (const bueno of ['ES0021000000001094AX', 'ES0031408000000000AF0F', 'ES0123456789012345GZ', 'ES0025000000009876QN1P',
    'es0021000000001094ax', 'ES 0021 0000 0000 1094 AX', ' ES0021000000001094AX ']) {
    assert.equal(esCUPS(bueno), true, bueno);
  }
  for (const malo of [
    'ES0021000000001094AY', // letra de control cambiada
    'ES0021000000001094XA', // letras de control intercambiadas
    'ES0021000000001095AX', // un dígito cambiado
    'ES0031408000000000AG0F',
    'ES0021000000001094',   // sin letras de control
    'ES002100000000109AX',  // 15 cifras
    'XX0021000000001094AX', // país distinto
    'ES0021000000001094AX123', // terminación de 3
    'ES0021000000001094A1', // control con cifra
    '', '   ', undefined, null, 12345,
  ]) {
    assert.equal(esCUPS(malo), false, String(malo));
  }
});

test('IBAN: valen los españoles con dígitos de control correctos; no los alterados ni los de otro país', () => {
  for (const bueno of ['ES9121000418450200051332', 'ES91 2100 0418 4502 0005 1332', 'es6000491500051234567892', 'ES8401821234567890123456']) {
    assert.equal(esIBAN(bueno), true, bueno);
  }
  for (const malo of [
    'ES9121000418450200051333', // último dígito cambiado
    'ES9021000418450200051332', // dígitos de control cambiados
    'ES91 2100 0418 4502 0005 133', // corto
    'ES912100041845020005133200', // largo
    'FR1420041010050500013M02606', // IBAN francés correcto, pero el formulario solo admite ES
    'ESXX21000418450200051332',
    '', undefined, null,
  ]) {
    assert.equal(esIBAN(malo), false, String(malo));
  }
});

test('DNI: letra de control correcta (con separadores y minúsculas); no una letra distinta ni longitudes raras', () => {
  for (const bueno of ['12345678Z', '00000001R', '12345678-z', '12.345.678 Z']) assert.equal(esDNI(bueno), true, bueno);
  for (const malo of ['12345678A', '12345678', '1234567Z', '123456789Z', 'X1234567L', '', null, undefined]) {
    assert.equal(esDNI(malo), false, String(malo));
  }
});

test('NIE: X, Y o Z con su letra de control; no un DNI ni una letra equivocada', () => {
  for (const bueno of ['X1234567L', 'Y0000001S', 'Z7654321H', 'x-1234567-l']) assert.equal(esNIE(bueno), true, bueno);
  for (const malo of ['X1234567A', 'W1234567L', '12345678Z', 'X123456L', '']) assert.equal(esNIE(malo), false, malo);
});

test('CIF: control en cifra, en letra o en cualquiera de las dos según la entidad', () => {
  // A y B (en 'ABEH') exigen cifra; K L M N P Q R S W exigen letra; el resto admite las dos
  for (const bueno of ['B12345674', 'A58585852', 'Q2826000H', 'N0012345E', 'G12345674', 'G1234567D']) {
    assert.equal(esCIF(bueno), true, bueno);
  }
  for (const malo of [
    'B12345675',   // cifra de control cambiada
    'A5858585B',   // A exige cifra y esto es letra
    'Q28260008',   // Q exige letra y esto es cifra
    'Q2826000A',   // letra equivocada
    'B1234567',    // corto
    'I12345674',   // I no es letra de entidad
    '',
  ]) {
    assert.equal(esCIF(malo), false, malo);
  }
});

test('NIF/NIE/CIF: acepta cualquiera de los tres y rechaza todo lo demás', () => {
  for (const bueno of ['12345678Z', 'X1234567L', 'B12345674']) assert.equal(esIdFiscal(bueno), true, bueno);
  for (const malo of ['12345678A', 'X1234567A', 'B12345675', 'hola', '']) assert.equal(esIdFiscal(malo), false, malo);
});

test('Móvil: 9 cifras desde 6, 7, 8 o 9, con o sin +34 / 0034 / 34 y separadores', () => {
  for (const bueno of ['600123456', '700123456', '812345678', '912345678', '+34 600 123 456', '0034600123456',
    '34600123456', '(+34) 600-123-456', '600.123.456']) {
    assert.equal(esMovil(bueno), true, bueno);
  }
  for (const malo of ['500123456', '60012345', '6001234567', '+44600123456', '346001234', '+34 500 123 456', 'seiscientos', '', null, undefined]) {
    assert.equal(esMovil(malo), false, String(malo));
  }
});

test('Código postal: exactamente 5 cifras', () => {
  for (const bueno of ['28001', '01001', '52006', ' 08001 ']) assert.equal(esCP(bueno), true, bueno);
  for (const malo of ['2800', '280011', 'ABCDE', '28 001', '2800a', '', null, undefined]) assert.equal(esCP(malo), false, String(malo));
});

test('E-mail: sencillo pero sin coma, espacios, comillas ni «Nombre <email>» (Altavoz los rechaza en responder_a)', () => {
  for (const bueno of ['ana@ejemplo.es', 'ana.perez+tramites@sub.ejemplo.co.uk', "o'brien@ejemplo.com", 'A_B-C@Ejemplo.COM', ' ana@ejemplo.es ']) {
    assert.equal(esEmail(bueno), true, bueno);
  }
  for (const malo of ['ana@ejemplo', 'ana@@ejemplo.es', 'ana ejemplo@x.es', '@ejemplo.es', 'ana@.es', 'ana@ejemplo..es',
    'ana,luis@ejemplo.es', 'Ana <ana@ejemplo.es>', '"ana"@ejemplo.es', 'ana@ejemplo.es,luis@ejemplo.es', 'ana@-ejemplo.es',
    `${'a'.repeat(250)}@ejemplo.es`, '', null, undefined]) {
    assert.equal(esEmail(malo), false, String(malo));
  }
});

// ---------------------------------------------------------------------------
// Paridad con el html: mismas respuestas que los validadores de gnew.html y mega.html
// ---------------------------------------------------------------------------

function validadoresDelHtml(nombreFichero, marcaFinal) {
  const html = leer(nombreFichero);
  const ini = html.indexOf('const DNI_LETTERS');
  const fin = html.indexOf(marcaFinal);
  assert.ok(ini > 0 && fin > ini, `no encuentro el bloque de validadores en ${nombreFichero}`);
  const cuerpo = html.slice(ini, fin);
  // eslint-disable-next-line no-new-func
  return new Function(`${cuerpo}\nreturn { validDNI, validNIE, validCIF, validIdFiscal, validCUPS, validIBAN, validPhone };`)();
}

function generador(semilla) { // mulberry32: determinista, sin flakiness
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus() {
  const base = ['ES0021000000001094AX', 'ES0031408000000000AF0F', 'ES0123456789012345GZ', 'ES0025000000009876QN1P',
    'ES9121000418450200051332', 'ES6000491500051234567892', 'ES8401821234567890123456',
    '12345678Z', '00000001R', 'X1234567L', 'Y0000001S', 'Z7654321H',
    'B12345674', 'A58585852', 'Q2826000H', 'N0012345E', 'G12345674', 'G1234567D',
    '600123456', '+34 600 123 456', '0034912345678', '34812345678'];
  const alfabeto = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const azar = generador(20261008);
  const salida = new Set(base);
  for (const v of base) {
    for (let i = 0; i < v.length; i++) {
      for (let k = 0; k < 6; k++) {
        salida.add(v.slice(0, i) + alfabeto[Math.floor(azar() * alfabeto.length)] + v.slice(i + 1)); // un carácter cambiado
      }
    }
    salida.add(v.slice(1));
    salida.add(v + '0');
    salida.add(v.toLowerCase());
    salida.add(v.replace(/(.{4})/g, '$1 '));
  }
  for (let n = 0; n < 1500; n++) {
    const largo = 5 + Math.floor(azar() * 22);
    let s = '';
    for (let i = 0; i < largo; i++) s += alfabeto[Math.floor(azar() * alfabeto.length)];
    salida.add(s);
    salida.add(`ES${s.replace(/\D/g, '').padEnd(22, '7').slice(0, 22)}`);
  }
  return [...salida];
}

for (const [fichero, marcaFinal] of [['gnew.html', '// ===== ERRORES INLINE ====='], ['mega.html', '// ===== TIPO SUMINISTRO AUTOMATICO =====']]) {
  test(`paridad: mis validadores dan lo mismo que los de ${fichero} en miles de valores (válidos, mutados y al azar)`, () => {
    const html = validadoresDelHtml(fichero, marcaFinal);
    const casos = corpus();
    assert.ok(casos.length > 2000, `corpus de ${casos.length}`);
    let validos = 0;
    for (const c of casos) {
      assert.equal(esDNI(c), html.validDNI(c), `DNI ${c}`);
      assert.equal(esNIE(c), html.validNIE(c), `NIE ${c}`);
      assert.equal(esCIF(c), html.validCIF(c), `CIF ${c}`);
      assert.equal(esIdFiscal(c), html.validIdFiscal(c), `ID fiscal ${c}`);
      assert.equal(esCUPS(c), html.validCUPS(c), `CUPS ${c}`);
      assert.equal(esIBAN(c), html.validIBAN(c), `IBAN ${c}`);
      assert.equal(esMovil(c), html.validPhone(c), `móvil ${c}`);
      if (esCUPS(c) || esIBAN(c) || esIdFiscal(c) || esMovil(c)) validos++;
    }
    assert.ok(validos > 20, `el corpus tiene que incluir valores válidos (hay ${validos})`);
  });
}

test('las frases coinciden con las de gnew.html (y con las de mega.html salvo las tildes)', () => {
  const gnew = leer('gnew.html');
  const mega = leer('mega.html');
  for (const clave of ['cups', 'idFiscal', 'dniFirmante', 'iban', 'movil', 'documentos', 'titularAnterior']) {
    const frase = FRASES[clave];
    assert.ok(gnew.includes(`'${frase}'`), `gnew.html no tiene la frase de ${clave}: ${frase}`);
    assert.ok(mega.includes(`'${sinTildes(frase)}'`), `mega.html no tiene (sin tildes) la frase de ${clave}`);
  }
});

// ---------------------------------------------------------------------------
// Campos obligatorios y tarifas de MEGA: contrastados con los html
// ---------------------------------------------------------------------------

function camposRequeridosDelHtml(fichero) {
  const html = leer(fichero);
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*?\bname="([^"]+)"[^>]*?\brequired\b[^>]*>/g)].map((m) => m[1]);
}

test('los campos obligatorios son exactamente los `required` de gnew.html y mega.html', () => {
  assert.deepEqual([...CAMPOS_OBLIGATORIOS.gnew].sort(), camposRequeridosDelHtml('gnew.html').sort());
  assert.deepEqual([...CAMPOS_OBLIGATORIOS.mega].sort(), camposRequeridosDelHtml('mega.html').sort());
  assert.ok(CAMPOS_OBLIGATORIOS.gnew.includes('compania') && !CAMPOS_OBLIGATORIOS.mega.includes('compania'));
  assert.ok(CAMPOS_OBLIGATORIOS.gnew.includes('terminos') && CAMPOS_OBLIGATORIOS.mega.includes('terminos'));
});

test('las tarifas de MEGA son exactamente las opciones del <select> de mega.html', () => {
  const html = leer('mega.html');
  const bloque = html.match(/<select name="tarifa"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(bloque, 'no encuentro el select de tarifa');
  const opciones = [...bloque.matchAll(/<option>([^<]+)<\/option>/g)].map((m) => m[1].trim());
  assert.deepEqual([...TARIFAS_MEGA], opciones);
  assert.equal(TARIFAS_MEGA.length, 13);
});

test('tipoSuministroDe: RL.x es Gas, el resto de la lista es Luz, lo demás vacío (como el html)', () => {
  for (const t of ['2.0TD', '3.0TD', '6.1TD', '6.2TD', '6.3TD', '6.4TD']) assert.equal(tipoSuministroDe(t), 'Luz', t);
  for (const t of ['RL.1', 'RL.2', 'RL.3', 'RL.4', 'RL.5', 'RL.6', 'RL.7']) assert.equal(tipoSuministroDe(t), 'Gas', t);
  for (const t of ['', 'RL.8', '2.0td', 'Luz', null, undefined]) assert.equal(tipoSuministroDe(t), '', String(t));
  assert.equal(tipoSuministroDe(' RL.3 '), 'Gas', 'recorta espacios');
});

// ---------------------------------------------------------------------------
// validarDatos
// ---------------------------------------------------------------------------

const GNEW_OK = Object.freeze({
  quien_eres: 'Ana Pérez', email_comercial: 'ana.perez@ejemplo.es', compania: 'MEGA',
  cups: 'ES0021000000001094AX', oferta: 'Fijo 12 meses', tarifa: '2.0TD',
  p1: '4,6', p2: '4,6', p3: '', p4: '', p5: '', p6: '',
  titular: 'Juan García López', cif_nif: '12345678Z', nombre_firmante: '', dni_firmante: '',
  cuenta_bancaria: 'ES91 2100 0418 4502 0005 1332', dir_suministro: 'Calle Mayor 1, 2º B',
  codigo_postal: '28001', poblacion: 'Madrid', provincia: 'Madrid', movil: '600 123 456',
  email_cliente: 'cliente@ejemplo.es', cambio_titular: 'No', titular_anterior: '', observaciones: '',
  terminos: true,
});
const { compania: _c, ...SIN_COMPANIA } = GNEW_OK;
const MEGA_OK = Object.freeze({ ...SIN_COMPANIA, tarifa: 'RL.3', tipo_suministro: 'Gas' });

test('validarDatos GNEW: un envío completo y correcto no tiene errores', () => {
  assert.deepEqual(validarDatos('gnew', GNEW_OK), { campos: {} });
});

test('validarDatos GNEW: solo con los obligatorios también vale (lo demás es opcional)', () => {
  const minimo = Object.fromEntries(CAMPOS_OBLIGATORIOS.gnew.map((c) => [c, GNEW_OK[c]]));
  assert.deepEqual(validarDatos('gnew', minimo), { campos: {} });
});

test('validarDatos MEGA: envío correcto; la compañía no se pide y lo que mande el cliente se ignora', () => {
  assert.deepEqual(validarDatos('mega', MEGA_OK), { campos: {} });
  assert.deepEqual(validarDatos('mega', { ...MEGA_OK, compania: 'LO QUE SEA' }), { campos: {} });
  assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tipo_suministro: 'Cualquier cosa' }), { campos: {} }, 'el tipo de suministro lo deduce el servidor');
  assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tarifa: '2.0TD', tipo_suministro: '' }), { campos: {} });
});

test('validarDatos: sin nada (o con basura en lugar de un objeto) marca todos los obligatorios', () => {
  const esperadosGnew = CAMPOS_OBLIGATORIOS.gnew.slice().sort();
  const esperadosMega = CAMPOS_OBLIGATORIOS.mega.slice().sort();
  for (const vacio of [{}, null, undefined, [], 'texto', 42]) {
    assert.deepEqual(Object.keys(validarDatos('gnew', vacio).campos).sort(), esperadosGnew, `gnew con ${JSON.stringify(vacio)}`);
    assert.deepEqual(Object.keys(validarDatos('mega', vacio).campos).sort(), esperadosMega, `mega con ${JSON.stringify(vacio)}`);
  }
  assert.equal(validarDatos('gnew', {}).campos.quien_eres, FRASES.obligatorio);
  assert.equal(validarDatos('gnew', {}).campos.terminos, FRASES.terminos);
});

test('validarDatos: los campos que solo traen espacios cuentan como vacíos', () => {
  const r = validarDatos('gnew', { ...GNEW_OK, quien_eres: '   ', titular: '\t\n', provincia: ' ' });
  assert.deepEqual(r.campos, { quien_eres: FRASES.obligatorio, titular: FRASES.obligatorio, provincia: FRASES.obligatorio });
});

test('validarDatos: cada formato malo da exactamente la frase del html', () => {
  const malos = {
    cups: ['ES0021000000001095AX', FRASES.cups],
    cif_nif: ['12345678A', FRASES.idFiscal],
    dni_firmante: ['B12345674', FRASES.dniFirmante], // un CIF no vale como DNI del firmante
    cuenta_bancaria: ['ES9121000418450200051333', FRASES.iban],
    movil: ['500123456', FRASES.movil],
    email_comercial: ['ana@ejemplo', FRASES.email],
    email_cliente: ['cliente.ejemplo.es', FRASES.email],
    codigo_postal: ['2800', FRASES.codigoPostal],
  };
  for (const [campo, [valor, frase]] of Object.entries(malos)) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, [campo]: valor }).campos, { [campo]: frase }, campo);
    assert.deepEqual(validarDatos('mega', { ...MEGA_OK, [campo]: valor }).campos, { [campo]: frase }, `mega ${campo}`);
  }
  // Varios fallos a la vez: uno por campo
  const varios = validarDatos('gnew', { ...GNEW_OK, cups: 'x', movil: 'y', codigo_postal: 'z' });
  assert.deepEqual(Object.keys(varios.campos).sort(), ['codigo_postal', 'cups', 'movil']);
});

test('validarDatos: el DNI del firmante es opcional y admite DNI o NIE; el NIF del titular admite DNI, NIE o CIF', () => {
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, dni_firmante: '' }).campos, {});
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, dni_firmante: '00000001R' }).campos, {});
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, dni_firmante: 'X1234567L' }).campos, {});
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, dni_firmante: '12345678A' }).campos, { dni_firmante: FRASES.dniFirmante });
  for (const nif of ['12345678Z', 'X1234567L', 'B12345674', 'q2826000h']) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cif_nif: nif }).campos, {}, nif);
  }
});

test('validarDatos: los términos tienen que venir marcados (true); cualquier otra cosa no vale', () => {
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, terminos: true }).campos, {});
  for (const no of [false, undefined, null, 'true', 'on', 1, 0, '']) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, terminos: no }).campos, { terminos: FRASES.terminos }, JSON.stringify(no));
    assert.deepEqual(validarDatos('mega', { ...MEGA_OK, terminos: no }).campos, { terminos: FRASES.terminos });
  }
});

test('validarDatos MEGA: la tarifa tiene que ser una de las 13 de la lista (exacta); GNEW la deja libre', () => {
  for (const t of TARIFAS_MEGA) assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tarifa: t }).campos, {}, t);
  assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tarifa: ' RL.3 ' }).campos, {}, 'recorta espacios');
  for (const t of ['RL.8', '2.0td', '2.0 TD', 'Luz', '4.0TD', '0']) {
    assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tarifa: t }).campos, { tarifa: FRASES.tarifaMega }, t);
  }
  assert.deepEqual(validarDatos('mega', { ...MEGA_OK, tarifa: '' }).campos, { tarifa: FRASES.obligatorio });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, tarifa: 'Peaje 2.0TD indexada' }).campos, {}, 'en GNEW es texto libre');
});

test('validarDatos: cambio de titular solo admite No, Si, Sí o vacío (con «Sí» hace falta el titular anterior: ver el test siguiente)', () => {
  for (const ok of ['No', 'NO', 'no', '', undefined, null]) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: ok }).campos, {}, JSON.stringify(ok));
  }
  for (const si of ['Si', 'Sí', 'si', 'SÍ', ' Si ']) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: si, titular_anterior: 'María López, 87654321X, Calle Sol 3' }).campos, {}, JSON.stringify(si));
  }
  for (const mal of ['Quizás', 'true', 1, true, {}]) {
    assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: mal }).campos, { cambio_titular: FRASES.cambioTitular }, JSON.stringify(mal));
  }
});

test('validarDatos: con cambio de titular «Sí» los datos del titular ANTERIOR son obligatorios (también si llegan como `nuevo_titular`, de una página vieja); con «No» no se exige', () => {
  assert.equal(FRASES.titularAnterior, 'Indica los datos del titular anterior.');
  for (const formulario of ['gnew', 'mega']) {
    const base = formulario === 'gnew' ? GNEW_OK : MEGA_OK;
    // «Sí» y nada escrito (vacío, solo espacios, ausente, null): error en llano en el campo `titular_anterior`
    for (const vacio of ['', '   ', '\t\n', undefined, null]) {
      for (const si of ['Si', 'Sí']) {
        const r = validarDatos(formulario, { ...base, cambio_titular: si, titular_anterior: vacio });
        assert.deepEqual(r.campos, { titular_anterior: FRASES.titularAnterior }, `${formulario} · ${si} · ${JSON.stringify(vacio)}`);
      }
    }
    const sinCampo = { ...base, cambio_titular: 'Si' };
    delete sinCampo.titular_anterior;
    assert.deepEqual(validarDatos(formulario, sinCampo).campos, { titular_anterior: FRASES.titularAnterior }, `${formulario}: sin la clave`);
    // «Sí» con el titular anterior: vale (con tildes, ñ y símbolos), y también recortado
    for (const texto of ['María López, 87654321X, Calle Sol 3', 'ñandú e hijos, s.l.', '  X  ']) {
      assert.deepEqual(validarDatos(formulario, { ...base, cambio_titular: 'Si', titular_anterior: texto }).campos, {}, `${formulario} · ${texto}`);
    }
    // Una página vieja (abierta antes del 16-oct-2026) manda el dato como `nuevo_titular`: se acepta como sinónimo
    const vieja = { ...base, cambio_titular: 'Si', nuevo_titular: 'María López, 87654321X, Calle Sol 3' };
    delete vieja.titular_anterior;
    assert.deepEqual(validarDatos(formulario, vieja).campos, {}, `${formulario}: página vieja con nuevo_titular`);
    assert.deepEqual(validarDatos(formulario, { ...vieja, titular_anterior: '' }).campos, {}, `${formulario}: vale el que traiga texto de los dos`);
    // La página vieja con «Sí» y el campo vacío tampoco pasa (antes sí pasaba: ahora es obligatorio)
    assert.deepEqual(validarDatos(formulario, { ...vieja, nuevo_titular: '' }).campos, { titular_anterior: FRASES.titularAnterior }, `${formulario}: página vieja sin texto`);
    // Con «No» (o sin elegir) no se exige nada, venga o no texto en el campo
    for (const no of ['No', 'no', '', undefined, null]) {
      assert.deepEqual(validarDatos(formulario, { ...base, cambio_titular: no, titular_anterior: '' }).campos, {}, `${formulario} · ${JSON.stringify(no)} · vacío`);
      assert.deepEqual(validarDatos(formulario, { ...base, cambio_titular: no, titular_anterior: 'texto que sobra' }).campos, {}, `${formulario} · ${JSON.stringify(no)} · con texto`);
    }
  }
});

test('validarDatos: el titular anterior tiene su tope (500) y no admite lo que no es texto; el error propio no se pisa con el de «obligatorio»', () => {
  const largo = (n) => 'x'.repeat(n);
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: 'Si', titular_anterior: largo(500) }).campos, {});
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: 'Si', titular_anterior: largo(501) }).campos, { titular_anterior: 'Es demasiado largo (máximo 500 caracteres)' });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: 'Si', titular_anterior: 42 }).campos, { titular_anterior: FRASES.invalido });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cambio_titular: 'Si', titular_anterior: ['a'] }).campos, { titular_anterior: FRASES.invalido });
  // El sinónimo viejo tiene el mismo tope y se queja con SU nombre (la página vieja solo conoce ese campo)
  const vieja = { ...GNEW_OK, cambio_titular: 'Si' };
  delete vieja.titular_anterior;
  assert.deepEqual(validarDatos('gnew', { ...vieja, nuevo_titular: largo(500) }).campos, {});
  assert.deepEqual(validarDatos('gnew', { ...vieja, nuevo_titular: largo(501) }).campos, { nuevo_titular: 'Es demasiado largo (máximo 500 caracteres)' });
});

test('gnew.html y mega.html piden el titular ANTERIOR (no el nuevo): etiqueta con asterisco, campo `titular_anterior` sin `required`, su frase y nada que diga «nuevo titular»', () => {
  for (const fichero of ['gnew.html', 'mega.html']) {
    const html = leer(fichero);
    assert.ok(html.includes('<label>Datos del titular anterior <span class="required">*</span></label>'), `${fichero}: la etiqueta con el asterisco rojo de siempre`);
    // (mega.html escribe sus textos sin tildes, como siempre)
    const placeholder = fichero === 'gnew.html' ? 'Nombre, NIF, dirección...' : 'Nombre, NIF, direccion...';
    assert.ok(html.includes(`<input type="text" name="titular_anterior" placeholder="${placeholder}">`), `${fichero}: el campo, con el mismo placeholder de antes y SIN required`);
    assert.ok(html.includes('id="titularAnteriorField"') && html.includes("getElementById('titularAnteriorField')"), `${fichero}: el contenedor renombrado con coherencia`);
    assert.ok(!html.includes('name="nuevo_titular"') && !html.includes('nuevoTitularField') && !/datos del nuevo titular/i.test(html), `${fichero}: no queda rastro del campo «nuevo titular»`);
    // Obligatorio solo con «Sí»: se comprueba al enviar, con el mismo tipo de error en línea que los demás campos
    assert.ok(html.includes("form.cambio_titular.value === 'Si' && !form.titular_anterior.value.trim()"), `${fichero}: la validación del cliente`);
    assert.ok(html.includes("fieldErrors.push([form.titular_anterior, 'Indica los datos del titular anterior.'])"), `${fichero}: su frase en llano`);
    // Con «No» no viaja lo escrito
    assert.ok(html.includes("titular_anterior: form.cambio_titular.value === 'Si' && form.titular_anterior ? form.titular_anterior.value : ''"), `${fichero}: con «No» se manda vacío`);
    // El respaldo de Apps Script (Code.gs, sin tocar) sigue recibiendo `nuevo_titular`, con el prefijo, y nunca `titular_anterior`
    assert.ok(html.includes("formData.nuevo_titular = anterior ? 'TITULAR ANTERIOR: ' + anterior : '';"), `${fichero}: el respaldo manda «TITULAR ANTERIOR: …» en nuevo_titular`);
    assert.ok(html.includes("if (k !== 'terminos' && k !== 'titular_anterior') formData[k] = p.datos[k];"), `${fichero}: el respaldo no manda la clave nueva`);
  }
});

test('validarDatos: valores que no son texto (números, listas, objetos) se rechazan en llano', () => {
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, titular: 42 }).campos, { titular: FRASES.invalido });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, observaciones: ['a'] }).campos, { observaciones: FRASES.invalido });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, p1: { kw: 4.6 } }).campos, { p1: FRASES.invalido });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, cups: 123 }).campos, { cups: FRASES.invalido });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, titular: null }).campos, { titular: FRASES.obligatorio });
});

test('validarDatos: topes de longitud generosos (nadie real los alcanza) con frase en llano', () => {
  const largo = (n) => 'x'.repeat(n);
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, observaciones: largo(4000) }).campos, {}, '4000 caracteres valen');
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, observaciones: largo(4001) }).campos, { observaciones: 'Es demasiado largo (máximo 4000 caracteres)' });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, titular: largo(251) }).campos, { titular: 'Es demasiado largo (máximo 250 caracteres)' });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, dir_suministro: largo(301) }).campos, { dir_suministro: 'Es demasiado largo (máximo 300 caracteres)' });
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, p1: largo(21) }).campos, { p1: 'Es demasiado largo (máximo 20 caracteres)' });
  // Los emojis cuentan como un carácter (no se parte por unidades UTF-16)
  assert.deepEqual(validarDatos('gnew', { ...GNEW_OK, observaciones: '😀'.repeat(4000) }).campos, {});
});

test('validarDatos: nombres y direcciones reales con tildes, ñ y símbolos pasan sin problema', () => {
  const r = validarDatos('gnew', {
    ...GNEW_OK,
    quien_eres: 'María José Muñoz-Núñez',
    titular: 'Bodegas Peñín, S.L.',
    dir_suministro: 'C/ Cañón del Río, 12 - 3º Dcha. (Urb. «Las Águilas»)',
    poblacion: 'Alcalá de Henares',
    observaciones: 'Llamar por la tarde.\nTitular: 50 % de descuento "pactado" & firmado <ok>',
  });
  assert.deepEqual(r, { campos: {} });
});

test('validarDatos: un formulario desconocido es un error de programación (lanza)', () => {
  assert.throws(() => validarDatos('otro', GNEW_OK), TypeError);
  assert.throws(() => validarDatos(undefined, GNEW_OK), TypeError);
  assert.throws(() => validarDatos('constructor', GNEW_OK), TypeError);
});

test('validarDatos: no modifica lo que recibe', () => {
  const entrada = structuredClone(GNEW_OK);
  validarDatos('gnew', entrada);
  assert.deepEqual(entrada, GNEW_OK);
});
