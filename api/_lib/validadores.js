// api/_lib/validadores.js · Validación de los datos del formulario en el servidor.
//
// Los validadores de formato son los de gnew.html / mega.html (validDNI, validNIE,
// validCIF, validCUPS con checksum, validIBAN mod-97, validPhone con +34) pasados a
// funciones sin DOM. El navegador valida primero; esto es la segunda barrera, y NO
// puede ser más estricta que el html con datos reales de comerciales: lo que el html
// deja pasar, aquí pasa. Qué campos son obligatorios sale del atributo `required` de
// cada html (tests/unit/validadores.test.mjs lo compara con los ficheros reales).
import { FORMULARIOS } from './config.js';

// ---------------------------------------------------------------------------
// Validadores de formato
// ---------------------------------------------------------------------------

const LETRAS_DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';

const compactar = (v) => String(v ?? '').toUpperCase().replace(/[\s.-]/g, '');

/** DNI: 8 cifras y su letra de control (= validDNI del html). */
export function esDNI(v) {
  const m = compactar(v).match(/^(\d{8})([A-Z])$/);
  return !!m && LETRAS_DNI[parseInt(m[1], 10) % 23] === m[2];
}

/** NIE: X, Y o Z + 7 cifras + letra de control (= validNIE). */
export function esNIE(v) {
  const m = compactar(v).match(/^([XYZ])(\d{7})([A-Z])$/);
  if (!m) return false;
  const numero = parseInt({ X: '0', Y: '1', Z: '2' }[m[1]] + m[2], 10);
  return LETRAS_DNI[numero % 23] === m[3];
}

/** CIF: letra de entidad + 7 cifras + control (cifra, letra o cualquiera de las dos según la entidad) (= validCIF). */
export function esCIF(v) {
  const m = compactar(v).match(/^([ABCDEFGHJKLMNPQRSUVW])(\d{7})([A-J0-9])$/);
  if (!m) return false;
  const cifras = m[2].split('').map(Number);
  let suma = 0;
  for (let i = 0; i < cifras.length; i++) {
    if (i % 2 === 0) {
      const doble = cifras[i] * 2;
      suma += doble >= 10 ? doble - 9 : doble;
    } else {
      suma += cifras[i];
    }
  }
  const digito = (10 - (suma % 10)) % 10;
  const letra = 'JABCDEFGHI'[digito];
  if ('KLMNPQRSW'.includes(m[1])) return m[3] === letra;
  if ('ABEH'.includes(m[1])) return m[3] === String(digito);
  return m[3] === String(digito) || m[3] === letra;
}

/** NIF/NIE/CIF (= validIdFiscal). */
export function esIdFiscal(v) {
  return esDNI(v) || esNIE(v) || esCIF(v);
}

/** CUPS: ES + 16 cifras + 2 letras de control (checksum oficial mod 529) + terminación opcional de 2 (= validCUPS). */
export function esCUPS(v) {
  const c = String(v ?? '').toUpperCase().replace(/\s/g, '');
  if (!/^ES\d{16}[A-Z]{2}([A-Z0-9]{2})?$/.test(c)) return false;
  let resto = 0;
  for (const d of c.slice(2, 18)) resto = (resto * 10 + parseInt(d, 10)) % 529;
  return c.slice(18, 20) === LETRAS_DNI[Math.floor(resto / 23)] + LETRAS_DNI[resto % 23];
}

/** IBAN español: ES + 22 cifras y dígitos de control correctos, mod 97 (= validIBAN). */
export function esIBAN(v) {
  const c = String(v ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^ES\d{22}$/.test(c)) return false;
  const reordenado = c.slice(4) + c.slice(0, 4);
  const numerico = reordenado.replace(/[A-Z]/g, (letra) => String(letra.charCodeAt(0) - 55));
  let resto = 0;
  for (const d of numerico) resto = (resto * 10 + parseInt(d, 10)) % 97;
  return resto === 1;
}

/** Móvil (o fijo) español: 9 cifras empezando por 6, 7, 8 o 9; admite +34, 0034 o 34 delante (= validPhone). */
export function esMovil(v) {
  let c = String(v ?? '').replace(/[\s.()-]/g, '');
  c = c.replace(/^(\+34|0034|34)(?=[6789]\d{8}$)/, '');
  return /^[6789]\d{8}$/.test(c);
}

/** Código postal: 5 cifras (el `pattern="[0-9]{5}"` del html). */
export function esCP(v) {
  return /^\d{5}$/.test(String(v ?? '').trim());
}

// Email sencillo: los caracteres que admite un input type=email del navegador, una @ y un
// dominio con al menos un punto. No admite comas, espacios, comillas ni «Nombre <email>»,
// que es justo lo que Altavoz rechazaría en `responder_a`.
const RE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function esEmail(v) {
  const s = String(v ?? '').trim();
  return s.length <= 254 && RE_EMAIL.test(s);
}

// ---------------------------------------------------------------------------
// MEGA: tarifas del <select> y tipo de suministro
// ---------------------------------------------------------------------------

/** Las opciones del <select name="tarifa"> de mega.html: 6 de luz y 7 de gas (RL.x). */
export const TARIFAS_MEGA = Object.freeze([
  '2.0TD', '3.0TD', '6.1TD', '6.2TD', '6.3TD', '6.4TD',
  'RL.1', 'RL.2', 'RL.3', 'RL.4', 'RL.5', 'RL.6', 'RL.7',
]);

/** Tipo de suministro que se deduce de la tarifa de MEGA: RL.x → 'Gas', el resto de la lista → 'Luz'; si no es de la lista, ''. */
export function tipoSuministroDe(tarifa) {
  const t = String(tarifa ?? '').trim();
  if (!TARIFAS_MEGA.includes(t)) return '';
  return t.startsWith('RL') ? 'Gas' : 'Luz';
}

// ---------------------------------------------------------------------------
// Frases (las que ve el comercial: en llano y sin detalle técnico)
// ---------------------------------------------------------------------------

export const FRASES = Object.freeze({
  // Las mismas que gnew.html / mega.html
  cups: 'CUPS no válido: ES + 16 dígitos (+ terminación opcional, ej. 0F)',
  idFiscal: 'NIF/NIE/CIF no válido: revisa los dígitos y la letra de control',
  dniFirmante: 'DNI/NIE del firmante no válido',
  iban: 'IBAN no válido: ES + 22 dígitos con dígitos de control correctos',
  movil: 'Móvil no válido: 9 dígitos empezando por 6, 7, 8 o 9',
  documentos: 'Adjunta al menos un documento (contrato escaneado, DNI, factura...)',
  // Las que el html deja a la validación nativa del navegador (campo vacío, email, código postal, casilla…)
  obligatorio: 'Este campo es obligatorio',
  email: 'E-mail no válido: revisa que esté bien escrito (ej. nombre@correo.com)',
  codigoPostal: 'Código postal no válido: 5 cifras (ej. 28001)',
  tarifaMega: 'Selecciona una tarifa de la lista',
  cambioTitular: 'Elige Sí o No',
  // (16-oct-2026) Con «Sí» en «¿Cambio de titular?» se piden los datos del titular ANTERIOR: el nuevo ya lo rellena el comercial arriba
  titularAnterior: 'Indica los datos del titular anterior.',
  terminos: 'Debes aceptar el aviso legal y la política de privacidad para enviar el contrato',
  invalido: 'El valor no es válido',
  largo: (max) => `Es demasiado largo (máximo ${max} caracteres)`,
});

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

/**
 * Campos con `required` en cada html (más la casilla de términos). Es la lista que
 * usa validarDatos; la prueba de validadores la contrasta con gnew.html y mega.html.
 * (El titular anterior NO está aquí: solo es obligatorio con «Sí» en el cambio de titular
 * y los html no lo marcan con `required`; validarDatos lo comprueba aparte.)
 */
export const CAMPOS_OBLIGATORIOS = Object.freeze({
  gnew: Object.freeze([
    'quien_eres', 'email_comercial', 'compania', 'cups', 'oferta', 'tarifa',
    'titular', 'cif_nif', 'cuenta_bancaria', 'dir_suministro', 'codigo_postal', 'poblacion', 'provincia',
    'movil', 'email_cliente', 'terminos',
  ]),
  mega: Object.freeze([
    'quien_eres', 'email_comercial', 'cups', 'oferta', 'tarifa',
    'titular', 'cif_nif', 'cuenta_bancaria', 'dir_suministro', 'codigo_postal', 'poblacion', 'provincia',
    'movil', 'email_cliente', 'terminos',
  ]),
});

// Longitud máxima de cada campo de texto. Los html no ponen tope; aquí es generoso y
// sirve para que ningún envío haga reventar el correo (Altavoz admite 250.000 caracteres
// de HTML) ni la base. Un comercial real no se acerca a ninguno.
const MAXIMOS = Object.freeze({
  quien_eres: 200, email_comercial: 254, compania: 100, cups: 40, oferta: 200, tarifa: 100,
  p1: 20, p2: 20, p3: 20, p4: 20, p5: 20, p6: 20,
  titular: 250, cif_nif: 30, nombre_firmante: 200, dni_firmante: 30, cuenta_bancaria: 50,
  dir_suministro: 300, codigo_postal: 10, poblacion: 100, provincia: 100,
  movil: 30, email_cliente: 254, titular_anterior: 500, nuevo_titular: 500, observaciones: 4000,
});

// Campos de texto en el orden en que aparecen en los html. `nuevo_titular` es el nombre que tenía el campo del cambio de titular
// ANTES del 16-oct-2026 (hoy `titular_anterior`): se sigue aceptando porque un comercial con la página vieja abierta lo seguirá mandando.
const CAMPOS_TEXTO = Object.freeze([
  'quien_eres', 'email_comercial', 'compania', 'cups', 'oferta', 'tarifa',
  'p1', 'p2', 'p3', 'p4', 'p5', 'p6',
  'titular', 'cif_nif', 'nombre_firmante', 'dni_firmante', 'cuenta_bancaria',
  'dir_suministro', 'codigo_postal', 'poblacion', 'provincia',
  'movil', 'email_cliente', 'titular_anterior', 'nuevo_titular', 'observaciones',
]);

const tieneTexto = (v) => typeof v === 'string' && v.trim() !== '';

// Comprobación de formato por campo (si el campo trae algo).
const FORMATOS = Object.freeze({
  email_comercial: [esEmail, FRASES.email],
  cups: [esCUPS, FRASES.cups],
  cif_nif: [esIdFiscal, FRASES.idFiscal],
  dni_firmante: [(v) => esDNI(v) || esNIE(v), FRASES.dniFirmante], // opcional; solo DNI o NIE (no CIF), como el html
  cuenta_bancaria: [esIBAN, FRASES.iban],
  codigo_postal: [esCP, FRASES.codigoPostal],
  movil: [esMovil, FRASES.movil],
  email_cliente: [esEmail, FRASES.email],
});

/**
 * Valida `datos` (el objeto que manda el navegador) según el formulario ('gnew' | 'mega').
 * Devuelve {campos}: un objeto vacío si todo está bien, o {nombre_del_campo: 'frase en llano'}
 * con un error por campo (las claves son los `name` de los inputs del html).
 *
 * Qué NO hace: no mira los archivos (están fuera de `datos`: la frase FRASES.documentos
 * es para quien los valide), ni el token ni el honeypot. En MEGA la tarifa tiene que ser una
 * de TARIFAS_MEGA y el tipo de suministro no se pide al cliente: se deduce con tipoSuministroDe.
 */
export function validarDatos(formulario, datos) {
  if (!FORMULARIOS.includes(formulario)) throw new TypeError('Formulario no válido');
  const d = datos !== null && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  const obligatorios = new Set(CAMPOS_OBLIGATORIOS[formulario]);
  const campos = {};
  const error = (campo, frase) => {
    if (!Object.hasOwn(campos, campo)) campos[campo] = frase;
  };

  for (const campo of CAMPOS_TEXTO) {
    if (campo === 'compania' && formulario === 'mega') continue; // MEGA no la pregunta
    const crudo = d[campo];
    if (crudo !== undefined && crudo !== null && typeof crudo !== 'string') {
      error(campo, FRASES.invalido);
      continue;
    }
    const valor = typeof crudo === 'string' ? crudo.trim() : '';
    if (!valor) {
      if (obligatorios.has(campo)) error(campo, FRASES.obligatorio);
      continue;
    }
    if (Array.from(valor).length > MAXIMOS[campo]) {
      error(campo, FRASES.largo(MAXIMOS[campo]));
      continue;
    }
    if (campo === 'tarifa' && formulario === 'mega') {
      if (!TARIFAS_MEGA.includes(valor)) error(campo, FRASES.tarifaMega);
      continue;
    }
    const formato = FORMATOS[campo];
    if (formato && !formato[0](valor)) error(campo, formato[1]);
  }

  // Cambio de titular: el <select> solo da «No» o «Si» (o vacío si un prefill no coincidió con ninguna opción).
  const cambio = d.cambio_titular;
  let conCambio = false;
  if (cambio !== undefined && cambio !== null) {
    const normal = typeof cambio === 'string' ? cambio.trim().toLowerCase() : null;
    if (normal === null || !['', 'no', 'si', 'sí'].includes(normal)) error('cambio_titular', FRASES.cambioTitular);
    else conCambio = normal === 'si' || normal === 'sí';
  }
  // Con «Sí» hay que decir quién era el titular ANTERIOR (16-oct-2026; el nuevo ya lo rellena el comercial en «Datos del Titular»).
  // Vale texto en `titular_anterior` o, de una página vieja, en `nuevo_titular`. Con «No» no se exige nada. (Si el campo trae algo que no
  // es texto o es demasiado largo, ya tiene su error: `error` no lo pisa.)
  if (conCambio && !tieneTexto(d.titular_anterior) && !tieneTexto(d.nuevo_titular)) error('titular_anterior', FRASES.titularAnterior);

  if (d.terminos !== true) error('terminos', FRASES.terminos);

  return { campos };
}
