// bandeja-zip.js · ZIP «stored» (sin comprimir) en el navegador, sin dependencias.
//
// La bandeja lo usa para «Descargar todo (ZIP)»: los documentos ya son PDF y JPG (no se
// comprimen más), así que basta con guardarlos tal cual dentro del ZIP. Módulo ESM puro:
// sin Buffer, sin process, sin ningún import, para que funcione igual en el navegador y en Node.
//
//   import { crearZip } from '/bandeja-zip.js';
//   const bytes = crearZip([{ nombre: '01-contrato.pdf', datos: new Uint8Array(...) }]);
//   new Blob([bytes], { type: 'application/zip' })

const POLINOMIO = 0xEDB88320;

// Tabla del CRC-32 (la de siempre: polinomio reflejado 0xEDB88320).
const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? POLINOMIO ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

/** CRC-32 de unos bytes, como número sin signo. */
export function crc32(datos) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function aBytes(datos) {
  if (ArrayBuffer.isView(datos)) return new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
  if (datos instanceof ArrayBuffer) return new Uint8Array(datos);
  throw new TypeError('Cada archivo del ZIP necesita «datos» como Uint8Array');
}

// Un nombre dentro del ZIP no puede traer rutas (nada de «../»), caracteres de control ni quedarse vacío.
function nombreSeguro(nombre) {
  let limpio = String(nombre ?? '').replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (limpio === '' || limpio === '.' || limpio === '..') limpio = 'archivo';
  return limpio;
}

// Si el nombre ya está cogido (sin distinguir mayúsculas: Windows y Mac no las distinguen), se le pone
// delante «2-», «3-»… hasta que sea único: dos «factura.pdf» salen como «factura.pdf» y «2-factura.pdf».
function nombreUnico(nombre, usados) {
  let candidato = nombre;
  for (let n = 2; usados.has(candidato.toLowerCase()); n++) candidato = `${n}-${nombre}`;
  usados.add(candidato.toLowerCase());
  return candidato;
}

// Fecha y hora en el formato de MS-DOS que usa el ZIP (años 1980-2107, segundos de dos en dos).
function fechaDos(fecha) {
  const d = fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha : new Date();
  const anio = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    dosFecha: ((anio - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    dosHora: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

const LOCAL = 30; // bytes fijos de una cabecera local
const CENTRAL = 46; // bytes fijos de una entrada del directorio central
const FINAL = 22; // bytes del registro de fin del directorio central
const FLAG_UTF8 = 0x0800; // bit 11: los nombres están en UTF-8

/**
 * Crea un ZIP sin comprimir (método 0) a partir de `entradas` = [{nombre, datos: Uint8Array}].
 * Devuelve un Uint8Array con el ZIP completo. Los nombres van en UTF-8 (bit 11 activado), con el
 * CRC-32 de cada archivo; los nombres repetidos se distinguen con «2-», «3-»…; los nombres con
 * rutas se aplanan. `opciones.fecha` fija la fecha de los archivos (por defecto, ahora).
 * Pensado para unos pocos archivos de hasta decenas de MB: no usa ZIP64 y lanza si no cabe.
 */
export function crearZip(entradas, opciones = {}) {
  if (!Array.isArray(entradas)) throw new TypeError('crearZip espera una lista de {nombre, datos}');
  if (entradas.length > 0xFFFF) throw new RangeError('Demasiados archivos para un ZIP');
  const { dosFecha, dosHora } = fechaDos(opciones.fecha);
  const codificador = new TextEncoder();
  const usados = new Set();

  let tamanoLocales = 0;
  let tamanoCentral = 0;
  const archivos = entradas.map((entrada) => {
    const datos = aBytes(entrada?.datos);
    const nombre = codificador.encode(nombreUnico(nombreSeguro(entrada?.nombre), usados));
    if (nombre.length > 0xFFFF) throw new RangeError('Nombre de archivo demasiado largo');
    if (datos.length > 0xFFFFFFFF) throw new RangeError('Archivo demasiado grande para un ZIP sin ZIP64');
    tamanoLocales += LOCAL + nombre.length + datos.length;
    tamanoCentral += CENTRAL + nombre.length;
    return { nombre, datos, crc: crc32(datos) };
  });

  const total = tamanoLocales + tamanoCentral + FINAL;
  if (total > 0xFFFFFFFF) throw new RangeError('El ZIP es demasiado grande');
  const zip = new Uint8Array(total);
  const vista = new DataView(zip.buffer);
  let pos = 0;

  // 1) Cada archivo: cabecera local + datos
  for (const a of archivos) {
    a.desplazamiento = pos;
    vista.setUint32(pos, 0x04034b50, true); // firma de cabecera local
    vista.setUint16(pos + 4, 20, true); // versión necesaria (2.0)
    vista.setUint16(pos + 6, FLAG_UTF8, true);
    vista.setUint16(pos + 8, 0, true); // método 0 = stored
    vista.setUint16(pos + 10, dosHora, true);
    vista.setUint16(pos + 12, dosFecha, true);
    vista.setUint32(pos + 14, a.crc, true);
    vista.setUint32(pos + 18, a.datos.length, true); // tamaño comprimido
    vista.setUint32(pos + 22, a.datos.length, true); // tamaño original
    vista.setUint16(pos + 26, a.nombre.length, true);
    vista.setUint16(pos + 28, 0, true); // sin campo extra
    zip.set(a.nombre, pos + LOCAL);
    zip.set(a.datos, pos + LOCAL + a.nombre.length);
    pos += LOCAL + a.nombre.length + a.datos.length;
  }

  // 2) Directorio central
  const inicioCentral = pos;
  for (const a of archivos) {
    vista.setUint32(pos, 0x02014b50, true); // firma de entrada del directorio central
    vista.setUint16(pos + 4, 20, true); // versión con la que se creó
    vista.setUint16(pos + 6, 20, true); // versión necesaria
    vista.setUint16(pos + 8, FLAG_UTF8, true);
    vista.setUint16(pos + 10, 0, true);
    vista.setUint16(pos + 12, dosHora, true);
    vista.setUint16(pos + 14, dosFecha, true);
    vista.setUint32(pos + 16, a.crc, true);
    vista.setUint32(pos + 20, a.datos.length, true);
    vista.setUint32(pos + 24, a.datos.length, true);
    vista.setUint16(pos + 28, a.nombre.length, true);
    vista.setUint16(pos + 30, 0, true); // campo extra
    vista.setUint16(pos + 32, 0, true); // comentario
    vista.setUint16(pos + 34, 0, true); // disco de inicio
    vista.setUint16(pos + 36, 0, true); // atributos internos
    vista.setUint32(pos + 38, 0, true); // atributos externos
    vista.setUint32(pos + 42, a.desplazamiento, true);
    zip.set(a.nombre, pos + CENTRAL);
    pos += CENTRAL + a.nombre.length;
  }

  // 3) Fin del directorio central
  vista.setUint32(pos, 0x06054b50, true);
  vista.setUint16(pos + 4, 0, true); // número de disco
  vista.setUint16(pos + 6, 0, true); // disco del directorio central
  vista.setUint16(pos + 8, archivos.length, true);
  vista.setUint16(pos + 10, archivos.length, true);
  vista.setUint32(pos + 12, pos - inicioCentral, true);
  vista.setUint32(pos + 16, inicioCentral, true);
  vista.setUint16(pos + 20, 0, true); // sin comentario
  return zip;
}
