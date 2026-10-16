// api/_lib/nombres.js · Nombres de archivo, tipos, carpetas del almacén, textos de una línea y el nombre de las personas
// de backoffice.
//
// El nombre ORIGINAL del archivo nunca forma parte de la clave del objeto en el
// almacén (ni de ninguna URL): la clave es <carpeta>/NN.ext y el nombre saneado
// vive solo en la base, para que lo vea backoffice.
import { randomBytes } from 'node:crypto';
import { FORMULARIOS, MARCAS } from './config.js';

// Los cinco tipos del bucket «tramitaciones» (allowed_mime_types del SQL): si una
// sola letra difiere, el almacén rechaza la subida directa del navegador.
const TIPOS_MIME = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

export const EXTENSIONES_PERMITIDAS = Object.freeze(Object.keys(TIPOS_MIME));
export const MAX_NOMBRE = 80;

/** Extensión en minúsculas y sin punto del último tramo de `nombre` ('' si no tiene). */
export function extensionDe(nombre) {
  const ultimo = String(nombre ?? '').split(/[\\/]/).pop().trim();
  const punto = ultimo.lastIndexOf('.');
  if (punto < 0 || punto === ultimo.length - 1) return '';
  return ultimo.slice(punto + 1).toLowerCase();
}

/**
 * Tipo MIME de una extensión ('pdf', '.PDF') o de un nombre de archivo ('Foto.JPG').
 * pdf, jpg/jpeg, png, doc y docx; cualquier otra cosa: null.
 */
export function mimeDe(entrada) {
  const texto = String(entrada ?? '').trim();
  const ext = (texto.includes('.') ? extensionDe(texto) : texto).toLowerCase();
  return Object.hasOwn(TIPOS_MIME, ext) ? TIPOS_MIME[ext] : null;
}

/**
 * Nombre de archivo apto para guardar y para mostrar: sin rutas ni «..», sin
 * \ / : * ? " < > |, sin tildes, sin caracteres de control, con la extensión en
 * minúsculas y como mucho `max` caracteres (se recorta el nombre, no la extensión).
 */
export function sanearNombre(nombre, max = MAX_NOMBRE) {
  let s = String(nombre ?? '');
  s = s.normalize('NFD').replace(/\p{M}/gu, ''); // tildes fuera (ñ → n, é → e)
  s = s.replace(/\p{Cf}/gu, ''); // invisibles (cambios de dirección de lectura, espacios de ancho cero…)
  s = s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' '); // control y saltos de línea → espacio
  s = s.split(/[\\/]/).pop(); // sin rutas: solo el último tramo
  s = s.replace(/[:*?"<>|]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\.{2,}/g, '.'); // sin «..»

  let ext = extensionDe(s);
  if (!/^[a-z0-9]{1,10}$/.test(ext)) ext = ''; // «Informe 2.1 final» no tiene extensión
  let base = ext ? s.slice(0, s.length - ext.length - 1) : s;
  const limpiar = (texto) => texto.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  base = limpiar(base);

  const hueco = Math.max(1, max - (ext ? ext.length + 1 : 0));
  base = limpiar(Array.from(base).slice(0, hueco).join(''));
  if (!base) base = 'documento';
  return ext ? `${base}.${ext}` : base;
}

const ALFABETO_BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'; // 32 símbolos: 256 es múltiplo de 32, sin sesgo

/** Texto aleatorio en base32 (minúsculas) de `longitud` caracteres, con aleatoriedad criptográfica. */
export function nonce(longitud = 10) {
  if (!Number.isInteger(longitud) || longitud < 1 || longitud > 64) throw new RangeError('Longitud de nonce no válida');
  let texto = '';
  for (const byte of randomBytes(longitud)) texto += ALFABETO_BASE32[byte & 31];
  return texto;
}

/** ¿Es una referencia de ese formulario? GNE-YYYYMMDD-XXXXXX (GNEW) o MEGA-YYYYMMDD-XXXXXX (MEGA). */
export function refValida(formulario, ref) {
  if (!FORMULARIOS.includes(formulario) || typeof ref !== 'string') return false;
  return new RegExp(`^${MARCAS[formulario].prefijoRef}-\\d{8}-[A-Z0-9]{4,10}$`).test(ref);
}

const FORMATO_ANIO_MES = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' });

function anioYMesMadrid(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) throw new RangeError('Fecha no válida');
  const partes = Object.fromEntries(FORMATO_ANIO_MES.formatToParts(d).map((p) => [p.type, p.value]));
  // Con es-ES, ICU entrega «1» (no «01») para enero aunque se pida 2-digit: se rellena a mano.
  return { anio: String(partes.year), mes: String(partes.month).padStart(2, '0') };
}

/**
 * Carpeta de un envío en el almacén: [pruebas/]<formulario>/<yyyy>/<mm>/<ref>-<nonce>.
 * El año y el mes son los de Madrid (como las fechas de los correos). El nonce hace
 * la carpeta imposible de adivinar; si no se pasa, se genera uno.
 * Lanza si el formulario o la referencia no son válidos: nunca se arma una ruta con
 * lo que escriba el cliente sin comprobarlo.
 */
export function carpetaDe({ prueba = false, formulario, ref, fecha = new Date(), nonce: sufijo = nonce() } = {}) {
  if (!FORMULARIOS.includes(formulario)) throw new Error('Formulario no válido');
  if (!refValida(formulario, ref)) throw new Error('Referencia no válida');
  if (typeof sufijo !== 'string' || !/^[a-z2-7]{6,32}$/.test(sufijo)) throw new Error('Nonce no válido');
  const { anio, mes } = anioYMesMadrid(fecha);
  return `${prueba ? 'pruebas/' : ''}${formulario}/${anio}/${mes}/${ref}-${sufijo}`;
}

/** Clave de un documento: <carpeta>/NN.ext (00 = firma). Solo extensiones permitidas. */
export function rutaDe(carpeta, orden, ext) {
  if (typeof carpeta !== 'string' || !carpeta) throw new Error('Falta la carpeta');
  if (!Number.isInteger(orden) || orden < 0 || orden > 99) throw new RangeError('Orden de documento fuera de 0-99');
  const extension = String(ext ?? '').toLowerCase().replace(/^\./, '');
  if (!mimeDe(extension)) throw new Error('Extensión no permitida');
  return `${carpeta}/${String(orden).padStart(2, '0')}.${extension}`;
}

/** Texto para buscar: sin tildes, en minúsculas y con los espacios compactados. */
export function normalizarBusqueda(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto en una sola línea: saltos de línea, tabuladores y caracteres de control pasan a un espacio. */
export function enUnaLinea(texto) {
  return String(texto ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recorta a `max` caracteres (sin partir un emoji por la mitad) y quita el espacio final que pueda quedar. */
export function recortar(texto, max) {
  const s = String(texto ?? '');
  if (!Number.isFinite(max) || max < 0) return s;
  const caracteres = Array.from(s);
  if (caracteres.length <= max) return s;
  return caracteres.slice(0, max).join('').trimEnd();
}

/** Cuántos caracteres puede tener el nombre de una persona de backoffice (se cuentan DESPUÉS de pasarlo a mayúsculas: «ß» pasa a «SS»). */
export const NOMBRE_PERSONA = Object.freeze({ min: 2, max: 40 });

// Lo que se mira como mucho de lo que llega: un texto más largo que esto no es un nombre y ni se procesa
const MAX_ENTRADA_NOMBRE = 400;

/**
 * El nombre con el que una persona de backoffice firma lo que hace en la bandeja (abrir una ficha, marcarla, tramitarla, volver a
 * enviar un correo). NO es un acceso: es una etiqueta para saber QUIÉN fue (todo backoffice entra con el mismo correo).
 * Devuelve el nombre ya limpio o `null` si no vale. Lo limpia así: pasa a forma NFC (una «é» escrita como «e» + acento vale), el
 * apóstrofo tipográfico ’ (el que ponen los móviles) pasa a ', los espacios y saltos se juntan en un solo espacio, se recortan los
 * de los lados y todo va en MAYÚSCULAS (`toUpperCase`: conserva tildes y Ñ). Vale si queda de 2 a 40 caracteres, EMPIEZA por una
 * letra (`\p{L}`) y solo lleva letras, espacios, guion, apóstrofo y punto: nunca `@`, cifras ni emojis. Lo que no es texto no vale.
 */
export function normalizarNombrePersona(valor) {
  if (typeof valor !== 'string' || valor.length > MAX_ENTRADA_NOMBRE) return null;
  const nombre = valor.normalize('NFC').replace(/\u2019/g, "'").replace(/\s+/g, ' ').trim().toUpperCase();
  const largo = Array.from(nombre).length;
  if (largo < NOMBRE_PERSONA.min || largo > NOMBRE_PERSONA.max) return null;
  return /^\p{L}[\p{L} '.-]*$/u.test(nombre) ? nombre : null;
}
