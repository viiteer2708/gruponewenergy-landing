// Pruebas de bandeja-zip.js: ZIP sin comprimir, válido para Python y sin dependencias de Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { crearZip, crc32 } from '../../bandeja-zip.js';

const texto = (t) => new TextEncoder().encode(t);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Lector mínimo de ZIP, escrito aparte para comprobar el resultado sin fiarse de crearZip.
function leerZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'firma del fin del directorio central');
  assert.equal(v.getUint16(eocd + 20, true), 0, 'sin comentario');
  const n = v.getUint16(eocd + 10, true);
  assert.equal(v.getUint16(eocd + 8, true), n);
  const tamanoCentral = v.getUint32(eocd + 12, true);
  const inicioCentral = v.getUint32(eocd + 16, true);
  assert.equal(inicioCentral + tamanoCentral, eocd, 'el directorio central acaba donde empieza el final');
  const decodificador = new TextDecoder('utf-8', { fatal: true });
  const entradas = [];
  let p = inicioCentral;
  for (let i = 0; i < n; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'firma de entrada central');
    const longitudNombre = v.getUint16(p + 28, true);
    const entrada = {
      flags: v.getUint16(p + 8, true),
      metodo: v.getUint16(p + 10, true),
      hora: v.getUint16(p + 12, true),
      fecha: v.getUint16(p + 14, true),
      crc: v.getUint32(p + 16, true),
      comprimido: v.getUint32(p + 20, true),
      tamano: v.getUint32(p + 24, true),
      nombre: decodificador.decode(bytes.subarray(p + 46, p + 46 + longitudNombre)),
    };
    const desplazamiento = v.getUint32(p + 42, true);
    assert.equal(v.getUint32(desplazamiento, true), 0x04034b50, 'firma de cabecera local');
    const nombreLocal = v.getUint16(desplazamiento + 26, true);
    const extraLocal = v.getUint16(desplazamiento + 28, true);
    assert.equal(decodificador.decode(bytes.subarray(desplazamiento + 30, desplazamiento + 30 + nombreLocal)), entrada.nombre, 'mismo nombre en la cabecera local');
    assert.equal(v.getUint32(desplazamiento + 14, true), entrada.crc, 'mismo CRC en la cabecera local');
    assert.equal(v.getUint16(desplazamiento + 6, true), entrada.flags, 'mismos flags en la cabecera local');
    const inicioDatos = desplazamiento + 30 + nombreLocal + extraLocal;
    entrada.datos = bytes.subarray(inicioDatos, inicioDatos + entrada.tamano);
    entradas.push(entrada);
    p += 46 + longitudNombre + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  assert.equal(p, eocd, 'el directorio central no deja bytes sueltos');
  return entradas;
}

const hayPython = (() => {
  try { execFileSync('python3', ['-I', '-c', 'import zipfile'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function validarConPython(bytes) {
  const carpeta = mkdtempSync(join(tmpdir(), 'zip-prueba-'));
  try {
    const ruta = join(carpeta, 'prueba.zip');
    writeFileSync(ruta, bytes);
    const prueba = execFileSync('python3', ['-I', '-m', 'zipfile', '-t', ruta], { encoding: 'utf8' });
    const detalle = execFileSync('python3', ['-I', '-c', [
      'import sys, zipfile, hashlib, json',
      'z = zipfile.ZipFile(sys.argv[1])',
      'print(json.dumps({"testzip": z.testzip(), "items": [{"name": i.filename, "utf8": bool(i.flag_bits & 0x800), "tipo": i.compress_type, "size": i.file_size, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}))',
    ].join('\n'), ruta], { encoding: 'utf8' });
    return { prueba, ...JSON.parse(detalle) };
  } finally {
    rmSync(carpeta, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

test('crc32: los valores de referencia de siempre', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(texto('123456789')), 0xCBF43926);
  assert.equal(crc32(texto('a')), 0xE8B7BE43);
  assert.equal(crc32(texto('The quick brown fox jumps over the lazy dog')), 0x414FA339);
  assert.equal(crc32(new Uint8Array(1000)), 0x060B1780, '1000 ceros');
  assert.equal(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff])), 0xFFFFFFFF, 'siempre sin signo');
});

test('crearZip: estructura correcta — firmas, método 0 (stored), CRC, tamaños y datos intactos', () => {
  const a = texto('hola');
  const b = new Uint8Array(70000).map((_, i) => i % 251);
  const zip = crearZip([{ nombre: 'a.txt', datos: a }, { nombre: 'b.pdf', datos: b }]);
  assert.ok(zip instanceof Uint8Array);
  assert.equal(zip.length, (30 + 5 + 4) + (30 + 5 + 70000) + (46 + 5) * 2 + 22);
  const entradas = leerZip(zip);
  assert.deepEqual(entradas.map((e) => e.nombre), ['a.txt', 'b.pdf']);
  for (const e of entradas) {
    assert.equal(e.metodo, 0, 'stored');
    assert.equal(e.comprimido, e.tamano, 'sin comprimir');
  }
  assert.equal(entradas[0].crc, crc32(a));
  assert.equal(entradas[0].crc, 0x6FA0F988, 'CRC-32 de «hola» (calculado con zlib de Python)');
  assert.equal(entradas[1].crc, crc32(b));
  assert.deepEqual(entradas[0].datos, a);
  assert.deepEqual(entradas[1].datos, b);
});

test('crearZip: nombres en UTF-8 con el bit 11 activado (ñ, tildes, japonés, emoji)', () => {
  const nombres = ['01-Contrato Peñíscola.pdf', 'ñandú-é.txt', '日本語.txt', 'foto 😀.jpg'];
  const zip = crearZip(nombres.map((nombre, i) => ({ nombre, datos: texto(`contenido ${i}`) })));
  const entradas = leerZip(zip);
  assert.deepEqual(entradas.map((e) => e.nombre), nombres);
  for (const e of entradas) assert.equal(e.flags & 0x0800, 0x0800, `bit 11 en ${e.nombre}`);
});

test('crearZip: nombres duplicados se prefijan con 2-, 3-… (sin distinguir mayúsculas)', () => {
  const zip = crearZip([
    { nombre: 'factura.pdf', datos: texto('1') },
    { nombre: 'factura.pdf', datos: texto('2') },
    { nombre: 'FACTURA.PDF', datos: texto('3') },
    { nombre: 'otra.pdf', datos: texto('4') },
    { nombre: 'factura.pdf', datos: texto('5') },
  ]);
  const entradas = leerZip(zip);
  assert.deepEqual(entradas.map((e) => e.nombre), ['factura.pdf', '2-factura.pdf', '3-FACTURA.PDF', 'otra.pdf', '4-factura.pdf']);
  assert.deepEqual(entradas.map((e) => new TextDecoder().decode(e.datos)), ['1', '2', '3', '4', '5'], 'cada uno conserva su contenido');
  // Si el nombre ya prefijado existe, sigue buscando uno libre
  const choque = leerZip(crearZip([{ nombre: 'a', datos: texto('x') }, { nombre: '2-a', datos: texto('y') }, { nombre: 'a', datos: texto('z') }]));
  assert.deepEqual(choque.map((e) => e.nombre), ['a', '2-a', '3-a']);
});

test('crearZip: nombres con rutas o raros se aplanan (nada de ../ ni nombres vacíos)', () => {
  const zip = crearZip([
    { nombre: '../../etc/passwd', datos: texto('1') },
    { nombre: 'C:\\Users\\Ana\\factura.pdf', datos: texto('2') },
    { nombre: '', datos: texto('3') },
    { nombre: '..', datos: texto('4') },
    { nombre: undefined, datos: texto('5') },
    { nombre: 'con\nsalto\u0000nulo.txt', datos: texto('6') },
  ]);
  const nombres = leerZip(zip).map((e) => e.nombre);
  assert.deepEqual(nombres, ['.._.._etc_passwd', 'C:_Users_Ana_factura.pdf', 'archivo', '2-archivo', '3-archivo', 'con salto nulo.txt']);
  for (const n of nombres) assert.ok(!n.includes('/') && !n.includes('\\') && n !== '..' && !/[\u0000-\u001f]/.test(n), n);
});

test('crearZip: lista vacía → un ZIP válido de 22 bytes', () => {
  const zip = crearZip([]);
  assert.equal(zip.length, 22);
  assert.equal(leerZip(zip).length, 0);
});

test('crearZip: un archivo vacío también vale', () => {
  const entradas = leerZip(crearZip([{ nombre: 'vacio.txt', datos: new Uint8Array(0) }]));
  assert.equal(entradas[0].tamano, 0);
  assert.equal(entradas[0].crc, 0);
});

test('crearZip: la fecha del ZIP es la indicada (formato MS-DOS) o, si no, la de ahora', () => {
  const fecha = new Date(2026, 9, 8, 17, 30, 12); // hora local, que es como se guarda en un ZIP
  const [e] = leerZip(crearZip([{ nombre: 'a', datos: texto('x') }], { fecha }));
  assert.equal(e.fecha, ((2026 - 1980) << 9) | (10 << 5) | 8);
  assert.equal(e.hora, (17 << 11) | (30 << 5) | (12 >> 1));
  const [antes] = leerZip(crearZip([{ nombre: 'a', datos: texto('x') }], { fecha: new Date(1970, 0, 1) }));
  assert.equal(antes.fecha >> 9, 0, 'el año se queda en 1980 como mínimo');
  const [ahora] = leerZip(crearZip([{ nombre: 'a', datos: texto('x') }]));
  assert.ok((ahora.fecha >> 9) + 1980 >= 2026);
  const [roto] = leerZip(crearZip([{ nombre: 'a', datos: texto('x') }], { fecha: new Date('no es fecha') }));
  assert.ok((roto.fecha >> 9) + 1980 >= 2026, 'una fecha rota se sustituye por la de ahora');
});

test('crearZip: acepta Uint8Array, vistas con desplazamiento, ArrayBuffer y Buffer de Node; rechaza lo demás', () => {
  const base = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  const zip = crearZip([
    { nombre: 'vista', datos: base.subarray(2, 5) },
    { nombre: 'buffer', datos: Buffer.from('abc') },
    { nombre: 'arraybuffer', datos: new Uint8Array([7, 8]).buffer },
  ]);
  const e = leerZip(zip);
  assert.deepEqual([...e[0].datos], [1, 2, 3], 'solo los bytes de la vista, no todo el buffer de debajo');
  assert.equal(new TextDecoder().decode(e[1].datos), 'abc');
  assert.deepEqual([...e[2].datos], [7, 8]);
  assert.throws(() => crearZip([{ nombre: 'x' }]), TypeError);
  assert.throws(() => crearZip([{ nombre: 'x', datos: 'texto' }]), TypeError);
  assert.throws(() => crearZip([null]), TypeError);
  assert.throws(() => crearZip('no es una lista'), TypeError);
  assert.throws(() => crearZip(undefined), TypeError);
});

test('crearZip: no modifica los datos de entrada', () => {
  const datos = new Uint8Array([1, 2, 3, 4]);
  const copia = Uint8Array.from(datos);
  crearZip([{ nombre: 'a', datos }]);
  assert.deepEqual(datos, copia);
});

test('Python valida el ZIP: python3 -m zipfile -t, nombres, bit UTF-8, método stored y contenido idéntico', { skip: !hayPython && 'no hay python3' }, () => {
  const entradas = [
    { nombre: 'a.txt', datos: texto('hola') },
    { nombre: 'b.pdf', datos: new Uint8Array(70000) },
    { nombre: '03-Peñíscola ñandú.pdf', datos: randomBytes(5.5 * 1024 * 1024) }, // como el PDF grande de las pruebas
    { nombre: '日本語.png', datos: randomBytes(1000) },
    { nombre: 'a.txt', datos: texto('repetido') },
  ];
  const resultado = validarConPython(crearZip(entradas));
  assert.match(resultado.prueba, /Done testing/);
  assert.equal(resultado.testzip, null, 'todos los CRC coinciden');
  assert.deepEqual(resultado.items.map((i) => i.name), ['a.txt', 'b.pdf', '03-Peñíscola ñandú.pdf', '日本語.png', '2-a.txt']);
  assert.ok(resultado.items.every((i) => i.utf8 && i.tipo === 0), 'UTF-8 y sin comprimir');
  assert.deepEqual(resultado.items.map((i) => i.size), entradas.map((e) => e.datos.length));
  assert.deepEqual(resultado.items.map((i) => i.sha), entradas.map((e) => sha256(e.datos)));
});

test('Python valida también el ZIP vacío y el de un solo archivo', { skip: !hayPython && 'no hay python3' }, () => {
  assert.equal(validarConPython(crearZip([])).items.length, 0);
  const uno = validarConPython(crearZip([{ nombre: 'solo.txt', datos: texto('x') }]));
  assert.deepEqual(uno.items.map((i) => i.name), ['solo.txt']);
  assert.equal(uno.testzip, null);
});

test('funciona sin Buffer, process ni require (como en el navegador): se ejecuta en un contexto vacío', () => {
  const fuente = readFileSync(new URL('../../bandeja-zip.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  // Contexto "de navegador": solo lo estándar de JavaScript + TextEncoder (que el navegador también trae)
  const contexto = vm.createContext({ TextEncoder });
  assert.equal(vm.runInContext('typeof Buffer + typeof process + typeof require + typeof module', contexto), 'undefinedundefinedundefinedundefined');
  vm.runInContext(`${fuente}\nglobalThis.__crearZip = crearZip; globalThis.__crc32 = crc32;`, contexto);
  const zip = vm.runInContext('__crearZip([{nombre: "ñ.txt", datos: new Uint8Array([104, 111, 108, 97])}, {nombre: "b", datos: new Uint8Array(10)}])', contexto);
  const entradas = leerZip(Uint8Array.from(zip)); // se pasa a un Uint8Array de este contexto para leerlo
  assert.deepEqual(entradas.map((e) => e.nombre), ['ñ.txt', 'b']);
  assert.equal(new TextDecoder().decode(entradas[0].datos), 'hola');
  assert.equal(vm.runInContext('__crc32(new Uint8Array([49,50,51,52,53,54,55,56,57]))', contexto), 0xCBF43926);
});

test('el código del módulo no usa nada de Node: ni import, ni require, ni Buffer, ni process, ni node:', () => {
  const fuente = readFileSync(new URL('../../bandeja-zip.js', import.meta.url), 'utf8');
  const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const prohibido of [/\bimport\b/, /\brequire\b/, /\bBuffer\b/, /\bprocess\b/, /node:/, /\bfs\b/, /\bzlib\b/, /__dirname/]) {
    assert.ok(!prohibido.test(sinComentarios), `aparece ${prohibido}`);
  }
  assert.ok(/export function crearZip\b/.test(sinComentarios), 'exporta crearZip');
});
