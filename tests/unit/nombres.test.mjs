// Pruebas de api/_lib/nombres.js: nombres, tipos, carpetas y textos de una línea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXTENSIONES_PERMITIDAS,
  MAX_NOMBRE,
  sanearNombre,
  extensionDe,
  mimeDe,
  nonce,
  refValida,
  carpetaDe,
  rutaDe,
  normalizarBusqueda,
  enUnaLinea,
  recortar,
} from '../../api/_lib/nombres.js';

// ---------------------------------------------------------------------------
// extensionDe y mimeDe
// ---------------------------------------------------------------------------

test('extensionDe: minúsculas, sin punto, del último tramo; sin extensión → ""', () => {
  assert.equal(extensionDe('Factura.PDF'), 'pdf');
  assert.equal(extensionDe('foto.JPG'), 'jpg');
  assert.equal(extensionDe('archivo.tar.gz'), 'gz');
  assert.equal(extensionDe('.pdf'), 'pdf');
  assert.equal(extensionDe('sin_extension'), '');
  assert.equal(extensionDe('termina_en_punto.'), '');
  assert.equal(extensionDe('C:\\Users\\Ana\\DNI.PNG'), 'png');
  assert.equal(extensionDe('carpeta.con.puntos/archivo'), '', 'el punto de una carpeta no cuenta');
  assert.equal(extensionDe('  con espacios.docx  '), 'docx');
  assert.equal(extensionDe(undefined), '');
  assert.equal(extensionDe(null), '');
  assert.equal(extensionDe(42), '');
});

test('mimeDe: los cinco tipos exactos del bucket; cualquier otra cosa → null', () => {
  assert.equal(mimeDe('pdf'), 'application/pdf');
  assert.equal(mimeDe('jpg'), 'image/jpeg');
  assert.equal(mimeDe('jpeg'), 'image/jpeg');
  assert.equal(mimeDe('png'), 'image/png');
  assert.equal(mimeDe('doc'), 'application/msword');
  assert.equal(mimeDe('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // También con punto, en mayúsculas o con el nombre entero
  assert.equal(mimeDe('.PDF'), 'application/pdf');
  assert.equal(mimeDe('Foto.JPG'), 'image/jpeg');
  assert.equal(mimeDe('contrato final.Docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // Lo que no se admite
  for (const otra of ['exe', 'gif', 'svg', 'txt', 'zip', 'html', 'xls', 'heic', '', undefined, null, 'constructor', '__proto__', 'toString', 'archivo.exe']) {
    assert.equal(mimeDe(otra), null, `mimeDe(${JSON.stringify(otra)})`);
  }
});

test('mimeDe: coincide letra por letra con allowed_mime_types del bucket del SQL', () => {
  const sql = readFileSync(new URL('../../supabase/tramitacion.sql', import.meta.url), 'utf8');
  const bloque = sql.match(/allowed_mime_types\)\s*values[\s\S]*?array\[([\s\S]*?)\]\)/i)?.[1];
  assert.ok(bloque, 'el SQL define los tipos permitidos del bucket');
  const delBucket = [...bloque.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const nuestros = [...new Set(EXTENSIONES_PERMITIDAS.map((e) => mimeDe(e)))].sort();
  assert.deepEqual(nuestros, delBucket);
  assert.equal(delBucket.length, 5);
});

// ---------------------------------------------------------------------------
// sanearNombre
// ---------------------------------------------------------------------------

test('sanearNombre: nombres normales se quedan como están (solo la extensión en minúsculas)', () => {
  assert.equal(sanearNombre('contrato.pdf'), 'contrato.pdf');
  assert.equal(sanearNombre('Factura Enero.PDF'), 'Factura Enero.pdf');
  assert.equal(sanearNombre('DNI frontal.JPG'), 'DNI frontal.jpg');
  assert.equal(sanearNombre('foto (1).jpeg'), 'foto (1).jpeg');
  assert.equal(sanearNombre('sin_extension'), 'sin_extension');
});

test('sanearNombre: sin tildes (ñ, á, ü, ç) pero sin perder letras', () => {
  assert.equal(sanearNombre('Contrato Peñíscola.pdf'), 'Contrato Peniscola.pdf');
  assert.equal(sanearNombre('Ñandú y cigüeña.PNG'), 'Nandu y ciguena.png');
  assert.equal(sanearNombre('Declaración de Ángel Núñez.docx'), 'Declaracion de Angel Nunez.docx');
  assert.equal(sanearNombre('françois.pdf'), 'francois.pdf');
});

test('sanearNombre: sin rutas ni «..» (no se puede salir de la carpeta)', () => {
  assert.equal(sanearNombre('../../etc/passwd'), 'passwd');
  assert.equal(sanearNombre('..\\..\\windows\\system32\\config.pdf'), 'config.pdf');
  assert.equal(sanearNombre('C:\\Users\\Ana\\Documentos\\factura.PDF'), 'factura.pdf');
  assert.equal(sanearNombre('/var/tmp/subida.png'), 'subida.png');
  assert.equal(sanearNombre('..'), 'documento');
  assert.equal(sanearNombre('...'), 'documento');
  assert.equal(sanearNombre('a..b.pdf'), 'a.b.pdf');
  assert.equal(sanearNombre('foto...final.jpg'), 'foto.final.jpg');
  assert.equal(sanearNombre('.hidden.pdf'), 'hidden.pdf');
  assert.equal(sanearNombre('carpeta/'), 'documento');
  for (const peligroso of ['../x.pdf', 'a/../../b.pdf', '..%2f..%2fb.pdf', '....//x']) {
    const limpio = sanearNombre(peligroso);
    assert.ok(!limpio.includes('..') && !limpio.includes('/') && !limpio.includes('\\'), `${peligroso} → ${limpio}`);
  }
});

test('sanearNombre: fuera \\ / : * ? " < > | y los caracteres de control', () => {
  assert.equal(sanearNombre('a:b*c?d"e<f>g|h.pdf'), 'a_b_c_d_e_f_g_h.pdf');
  for (const prohibido of [':', '*', '?', '"', '<', '>', '|']) {
    assert.equal(sanearNombre(`a${prohibido}b.pdf`), 'a_b.pdf', `carácter ${prohibido}`);
  }
  assert.equal(sanearNombre('a/b.pdf'), 'b.pdf', 'la barra separa rutas: solo queda el último tramo');
  assert.equal(sanearNombre('a\\b.pdf'), 'b.pdf', 'la barra invertida también');
  assert.equal(sanearNombre('linea1\nlinea2\r\n.pdf'), 'linea1 linea2.pdf');
  assert.equal(sanearNombre('con\ttab\u0000nulo.png'), 'con tab nulo.png');
  assert.equal(sanearNombre('inversion\u202Efdp.exe'), 'inversionfdp.exe', 'sin marcas invisibles de dirección de lectura');
  assert.equal(sanearNombre('ancho\u200Bcero.pdf'), 'anchocero.pdf', 'ni espacios de ancho cero');
  assert.equal(sanearNombre('  espacios   de   más  .jpg'), 'espacios de mas.jpg');
});

test('sanearNombre: máximo 80 caracteres y la extensión se conserva (en minúsculas)', () => {
  const largo = `${'a'.repeat(200)}.PDF`;
  const limpio = sanearNombre(largo);
  assert.ok(limpio.length <= MAX_NOMBRE, `longitud ${limpio.length}`);
  assert.equal(limpio.length, 80);
  assert.ok(limpio.endsWith('.pdf'));
  assert.equal(MAX_NOMBRE, 80);
  // Sin extensión también se corta
  assert.equal(sanearNombre('b'.repeat(120)).length, 80);
  // Otro máximo
  assert.equal(sanearNombre('contrato-largo.docx', 12), 'contrat.docx', 'con otro máximo: 7 de nombre + .docx = 12');
  // Los emojis no se parten por la mitad
  const emojis = `${'😀'.repeat(100)}.png`;
  const conEmojis = sanearNombre(emojis);
  assert.equal(Array.from(conEmojis).length, 80);
  assert.ok(conEmojis.endsWith('.png'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(conEmojis), 'sin medio emoji');
});

test('sanearNombre: casos vacíos o solo extensión → «documento»', () => {
  assert.equal(sanearNombre(''), 'documento');
  assert.equal(sanearNombre('   '), 'documento');
  assert.equal(sanearNombre(undefined), 'documento');
  assert.equal(sanearNombre(null), 'documento');
  assert.equal(sanearNombre('.pdf'), 'documento.pdf');
  assert.equal(sanearNombre('.PNG'), 'documento.png');
  assert.equal(sanearNombre('///'), 'documento');
  assert.equal(sanearNombre('foto.'), 'foto');
});

test('sanearNombre: un «punto» dentro del nombre no se confunde con una extensión', () => {
  assert.equal(sanearNombre('Informe 2.1 final'), 'Informe 2.1 final');
  assert.equal(sanearNombre('v1.2.3 contrato.PDF'), 'v1.2.3 contrato.pdf');
});

// ---------------------------------------------------------------------------
// nonce, refValida, carpetaDe, rutaDe
// ---------------------------------------------------------------------------

test('nonce: 10 caracteres base32 en minúsculas, distintos cada vez', () => {
  const vistos = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = nonce(10);
    assert.match(n, /^[a-z2-7]{10}$/);
    vistos.add(n);
  }
  assert.equal(vistos.size, 2000, 'con 50 bits de azar no debería repetirse ninguno en 2000');
  assert.equal(nonce().length, 10, 'por defecto 10');
  assert.equal(nonce(24).length, 24);
  assert.throws(() => nonce(0), RangeError);
  assert.throws(() => nonce(65), RangeError);
  assert.throws(() => nonce(1.5), RangeError);
});

test('nonce: usa todo el alfabeto (sin símbolos que nunca salen)', () => {
  const letras = new Set();
  for (let i = 0; i < 400; i++) for (const c of nonce(20)) letras.add(c);
  assert.equal(letras.size, 32);
});

test('refValida: GNE-YYYYMMDD-XXXXXX para GNEW y MEGA-… para MEGA, y nada más', () => {
  assert.equal(refValida('gnew', 'GNE-20261008-ABC123'), true);
  assert.equal(refValida('gnew', 'GNE-20261008-K7M2PQ'), true);
  assert.equal(refValida('mega', 'MEGA-20261008-ABC123'), true);
  assert.equal(refValida('mega', 'GNE-20261008-ABC123'), false, 'prefijo de otro formulario');
  assert.equal(refValida('gnew', 'MEGA-20261008-ABC123'), false);
  for (const mala of ['', 'GNE-2026-ABC123', 'GNE-20261008-abc123', 'GNE-20261008-AB', 'GNE-20261008-ABCDEFGHIJK', '../GNE-20261008-ABC123',
    'GNE-20261008-ABC123/x', 'GNE-20261008-ABC123\n', 'gne-20261008-ABC123', undefined, null, 42]) {
    assert.equal(refValida('gnew', mala), false, JSON.stringify(mala));
  }
  assert.equal(refValida('otro', 'GNE-20261008-ABC123'), false);
});

test('carpetaDe: [pruebas/]<formulario>/<yyyy>/<mm>/<ref>-<nonce>', () => {
  const fecha = new Date('2026-10-08T10:30:00Z');
  assert.equal(
    carpetaDe({ prueba: false, formulario: 'gnew', ref: 'GNE-20261008-ABC123', fecha, nonce: 'k3m5p7q2xa' }),
    'gnew/2026/10/GNE-20261008-ABC123-k3m5p7q2xa',
  );
  assert.equal(
    carpetaDe({ prueba: true, formulario: 'mega', ref: 'MEGA-20261008-ABC123', fecha, nonce: 'k3m5p7q2xa' }),
    'pruebas/mega/2026/10/MEGA-20261008-ABC123-k3m5p7q2xa',
  );
});

test('carpetaDe: el mes es el de Madrid, no el de UTC (31-oct 23:30 UTC ya es 1-nov en Madrid)', () => {
  const ref = 'GNE-20261031-ABC123';
  assert.equal(
    carpetaDe({ formulario: 'gnew', ref, fecha: new Date('2026-10-31T22:30:00Z'), nonce: 'aaaaaaaaaa' }),
    'gnew/2026/10/GNE-20261031-ABC123-aaaaaaaaaa', 'a las 23:30 de Madrid (CET) sigue siendo octubre (el cambio de hora es el 25-oct)',
  );
  assert.equal(
    carpetaDe({ formulario: 'gnew', ref, fecha: new Date('2026-10-31T23:30:00Z'), nonce: 'aaaaaaaaaa' }),
    'gnew/2026/11/GNE-20261031-ABC123-aaaaaaaaaa', 'a las 00:30 del 1-nov en Madrid ya es noviembre',
  );
  assert.equal(
    carpetaDe({ formulario: 'gnew', ref: 'GNE-20261231-ABC123', fecha: '2026-12-31T23:30:00Z', nonce: 'aaaaaaaaaa' }),
    'gnew/2027/01/GNE-20261231-ABC123-aaaaaaaaaa', 'el año también cambia (y acepta fechas en texto)',
  );
});

test('carpetaDe: sin fecha ni nonce usa la hora actual y un nonce nuevo; no admite referencias ni formularios dudosos', () => {
  const c = carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123' });
  assert.match(c, /^gnew\/\d{4}\/\d{2}\/GNE-20261008-ABC123-[a-z2-7]{10}$/);
  assert.notEqual(c, carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123' }), 'dos carpetas de la misma referencia son distintas');
  assert.throws(() => carpetaDe({ formulario: 'gnew', ref: '../../GNE-20261008-ABC123' }), /Referencia/);
  assert.throws(() => carpetaDe({ formulario: 'gnew', ref: 'MEGA-20261008-ABC123' }), /Referencia/);
  assert.throws(() => carpetaDe({ formulario: 'otro', ref: 'GNE-20261008-ABC123' }), /Formulario/);
  assert.throws(() => carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123', nonce: '../x' }), /Nonce/);
  assert.throws(() => carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123', nonce: 'ab' }), /Nonce/);
  assert.throws(() => carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123', fecha: 'no es fecha' }), RangeError);
  assert.throws(() => carpetaDe(), /Formulario/);
});

test('rutaDe: <carpeta>/NN.ext con dos cifras (00 = firma) y solo extensiones permitidas', () => {
  const carpeta = 'gnew/2026/10/GNE-20261008-ABC123-k3m5p7q2xa';
  assert.equal(rutaDe(carpeta, 0, 'png'), `${carpeta}/00.png`);
  assert.equal(rutaDe(carpeta, 1, 'pdf'), `${carpeta}/01.pdf`);
  assert.equal(rutaDe(carpeta, 15, 'JPG'), `${carpeta}/15.jpg`);
  assert.equal(rutaDe(carpeta, 99, '.docx'), `${carpeta}/99.docx`);
  assert.throws(() => rutaDe(carpeta, -1, 'pdf'), RangeError);
  assert.throws(() => rutaDe(carpeta, 100, 'pdf'), RangeError);
  assert.throws(() => rutaDe(carpeta, 1.5, 'pdf'), RangeError);
  assert.throws(() => rutaDe(carpeta, '1', 'pdf'), RangeError);
  assert.throws(() => rutaDe(carpeta, 1, 'exe'), /Extensión/);
  assert.throws(() => rutaDe(carpeta, 1, ''), /Extensión/);
  assert.throws(() => rutaDe(carpeta, 1, 'pdf/../x'), /Extensión/);
  assert.throws(() => rutaDe('', 1, 'pdf'), /carpeta/i);
});

test('la ruta del almacén nunca lleva el nombre original del archivo', () => {
  const carpeta = carpetaDe({ formulario: 'gnew', ref: 'GNE-20261008-ABC123', nonce: 'k3m5p7q2xa' });
  const original = 'DNI Juan Pérez García.PDF';
  const ruta = rutaDe(carpeta, 2, extensionDe(sanearNombre(original)));
  assert.equal(ruta, `${carpeta}/02.pdf`);
  assert.ok(!/juan|perez|dni/i.test(ruta));
});

// ---------------------------------------------------------------------------
// normalizarBusqueda, enUnaLinea, recortar
// ---------------------------------------------------------------------------

test('normalizarBusqueda: sin tildes, en minúsculas y con los espacios compactados', () => {
  assert.equal(normalizarBusqueda('  José   Peñalver  GARCÍA '), 'jose penalver garcia');
  assert.equal(normalizarBusqueda('ES0021000000001094AX'), 'es0021000000001094ax');
  assert.equal(normalizarBusqueda('Ñ\tÁ\nÉ'), 'n a e');
  assert.equal(normalizarBusqueda(undefined), '');
  assert.equal(normalizarBusqueda(null), '');
  assert.equal(normalizarBusqueda('GNE-20261008-ABC123'), 'gne-20261008-abc123');
  // No quita otros signos: eso es cosa de quien arma la consulta
  assert.equal(normalizarBusqueda('Ana@Ejemplo.es'), 'ana@ejemplo.es');
});

test('enUnaLinea: saltos de línea, tabuladores y control pasan a un solo espacio', () => {
  assert.equal(enUnaLinea('Juan\nPérez\r\nGarcía'), 'Juan Pérez García');
  assert.equal(enUnaLinea('  a \t\t b\u0000c  '), 'a b c');
  assert.equal(enUnaLinea('línea1\u2028línea2\u2029línea3'), 'línea1 línea2 línea3');
  assert.equal(enUnaLinea('\n\n'), '');
  assert.equal(enUnaLinea(undefined), '');
  assert.equal(enUnaLinea(12345), '12345');
});

test('recortar: corta por caracteres (no por unidades UTF-16), sin dejar espacio al final', () => {
  assert.equal(recortar('abcdef', 3), 'abc');
  assert.equal(recortar('abc', 3), 'abc');
  assert.equal(recortar('abc', 10), 'abc');
  assert.equal(recortar('abc def', 4), 'abc', 'quita el espacio que queda al final');
  assert.equal(recortar('abc', 0), '');
  assert.equal(recortar(undefined, 5), '');
  assert.equal(recortar('😀😀😀😀', 2), '😀😀');
  assert.equal(Array.from(recortar('añ😀bc', 3)).length, 3);
  assert.equal(recortar('sin límite', NaN), 'sin límite');
  assert.equal(recortar('sin límite', undefined), 'sin límite');
});
