// Pruebas de api/_lib/correos.js: asuntos, aviso a backoffice, acuse al comercial y código de acceso.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ETIQUETA_CORREO,
  escapeHtml,
  fechaMadrid,
  urlFichaDe,
  asuntoDe,
  armarAviso,
  armarAcuse,
  armarCodigo,
} from '../../api/_lib/correos.js';

const IBAN = 'ES9121000418450200051332';
const NIF_TITULAR = '12345678Z';
const NIF_FIRMANTE = '00000001R';
const DESTINO = 'escaneos@gruponew.energy';
const URL_FICHA = 'https://tramitatucontrato.energy/bandeja/c/GNE-20261008-ABC123';

const FILA_GNEW = Object.freeze({
  id: '0b0e7f0e-0000-4000-8000-000000000001',
  ref: 'GNE-20261008-ABC123',
  formulario: 'gnew',
  estado: 'recibida',
  prueba: false,
  sospechosa: false,
  comercial_nombre: 'Ana Pérez',
  comercial_email: 'ana.perez@ejemplo.es',
  compania: 'NATURGY',
  cups: 'ES0021000000001094AX',
  oferta: 'Fijo 12 meses',
  tarifa: '2.0TD',
  tipo_suministro: null,
  potencias: { p1: '4.6', p2: '4.6', p3: '', p4: '', p5: '', p6: '' },
  titular_nombre: 'Juan García López',
  titular_nif: NIF_TITULAR,
  firmante_nombre: 'María López',
  firmante_nif: NIF_FIRMANTE,
  iban: IBAN,
  direccion: 'Calle Mayor 1, 2º B',
  cp: '28001',
  poblacion: 'Madrid',
  provincia: 'Madrid',
  telefono: '600123456',
  email_cliente: 'cliente@ejemplo.es',
  cambio_titular: false,
  nuevo_titular: null,
  observaciones: 'Llamar por la tarde',
  creada_en: '2026-10-08T15:20:00.123456+00:00',
  recibida_en: '2026-10-08T15:30:12.000+00:00', // 17:30 en Madrid (horario de verano)
});

const FILA_MEGA = Object.freeze({
  ...FILA_GNEW,
  ref: 'MEGA-20261008-XYZ789',
  formulario: 'mega',
  compania: 'MEGA ENERGIA',
  tarifa: 'RL.3',
  tipo_suministro: 'Gas',
});

const DOCUMENTOS = Object.freeze([
  { orden: 0, nombre: 'firma.png', tamano_declarado: 3200, tamano_comprobado: 3200, es_firma: true },
  { orden: 1, nombre: 'contrato.pdf', tamano_declarado: 5767168, tamano_comprobado: 5767168, es_firma: false },
  { orden: 2, nombre: 'DNI frontal.jpg', tamano_declarado: 412000, tamano_comprobado: null, es_firma: false },
  { orden: 3, nombre: 'factura.pdf', tamano_declarado: 800, tamano_comprobado: 800, es_firma: false },
]);

// ---------------------------------------------------------------------------
// Fechas, escapado y enlaces
// ---------------------------------------------------------------------------

test('fechaMadrid: hora de Madrid (verano e invierno), con ceros, sin «24:00» a medianoche', () => {
  assert.equal(fechaMadrid(new Date('2026-10-08T15:30:12Z')), '08/10/2026 a las 17:30');
  assert.equal(fechaMadrid('2026-10-08T22:30:00Z'), '09/10/2026 a las 00:30', 'pasa de día al ser Madrid');
  assert.equal(fechaMadrid('2026-10-08T22:00:00Z'), '09/10/2026 a las 00:00', 'medianoche es 00:00, no 24:00');
  assert.equal(fechaMadrid('2026-12-01T23:05:00Z'), '02/12/2026 a las 00:05', 'invierno: UTC+1');
  assert.equal(fechaMadrid('2027-01-05T09:03:00Z'), '05/01/2027 a las 10:03', 'enero y minutos con cero');
  assert.equal(fechaMadrid('2026-10-08T15:30:12.123456+00:00'), '08/10/2026 a las 17:30', 'formato de fecha de Postgres');
  assert.match(fechaMadrid('esto no es una fecha'), /^\d{2}\/\d{2}\/\d{4} a las \d{2}:\d{2}$/, 'una fecha rota no lanza');
  assert.match(fechaMadrid(), /^\d{2}\/\d{2}\/\d{4} a las \d{2}:\d{2}$/);
});

test('escapeHtml: & < > " \' y valores que no son texto', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;', 'no escapa a medias');
});

test('urlFichaDe: <sitio>/bandeja/c/<ref>, con o sin barra final', () => {
  assert.equal(urlFichaDe('https://tramitatucontrato.energy', 'GNE-20261008-ABC123'), URL_FICHA);
  assert.equal(urlFichaDe('https://tramitatucontrato.energy/', 'GNE-20261008-ABC123'), URL_FICHA);
  assert.equal(urlFichaDe('http://127.0.0.1:8765', 'MEGA-20261008-XYZ789'), 'http://127.0.0.1:8765/bandeja/c/MEGA-20261008-XYZ789');
  assert.equal(urlFichaDe('https://x.es', 'a b/c'), 'https://x.es/bandeja/c/a%20b%2Fc');
});

test('las etiquetas de Altavoz son las del diseño', () => {
  assert.deepEqual({ ...ETIQUETA_CORREO }, { aviso: 'tramitacion-aviso', acuse: 'tramitacion-acuse', codigo_acceso: 'bandeja-codigo' });
});

// ---------------------------------------------------------------------------
// Asunto
// ---------------------------------------------------------------------------

test('asuntoDe GNEW: Nuevo Contrato - compañía - titular - comercial - CUPS, sin la referencia', () => {
  const esperado = 'Nuevo Contrato - NATURGY - Juan García López - Ana Pérez - ES0021000000001094AX';
  assert.equal(asuntoDe('gnew', FILA_GNEW), esperado);
  // También con lo que manda el formulario (titular, quien_eres) en vez de la fila de la base
  assert.equal(asuntoDe('gnew', { compania: 'NATURGY', titular: 'Juan García López', quien_eres: 'Ana Pérez', cups: 'ES0021000000001094AX' }), esperado);
  assert.ok(!esperado.includes('GNE-'), 'sin referencia');
  assert.ok(!asuntoDe('gnew', FILA_GNEW).includes(FILA_GNEW.ref));
});

test('asuntoDe MEGA: Nuevo Contrato MEGA - titular - comercial - CUPS (sin compañía)', () => {
  assert.equal(asuntoDe('mega', FILA_MEGA), 'Nuevo Contrato MEGA - Juan García López - Ana Pérez - ES0021000000001094AX');
  assert.ok(!asuntoDe('mega', FILA_MEGA).includes('MEGA ENERGIA'));
  assert.ok(!asuntoDe('mega', FILA_MEGA).includes(FILA_MEGA.ref));
});

test('asuntoDe: las partes que faltan se omiten sin dejar guiones dobles ni guiones sueltos', () => {
  const sinCompania = asuntoDe('gnew', { ...FILA_GNEW, compania: '' });
  assert.equal(sinCompania, 'Nuevo Contrato - Juan García López - Ana Pérez - ES0021000000001094AX');
  assert.equal(asuntoDe('gnew', { ...FILA_GNEW, titular_nombre: null }), 'Nuevo Contrato - NATURGY - Ana Pérez - ES0021000000001094AX');
  assert.equal(asuntoDe('gnew', { ...FILA_GNEW, cups: undefined }), 'Nuevo Contrato - NATURGY - Juan García López - Ana Pérez');
  assert.equal(asuntoDe('gnew', { ...FILA_GNEW, comercial_nombre: '   ' }), 'Nuevo Contrato - NATURGY - Juan García López - ES0021000000001094AX');
  assert.equal(asuntoDe('gnew', { cups: 'ES0021000000001094AX' }), 'Nuevo Contrato - ES0021000000001094AX');
  assert.equal(asuntoDe('gnew', {}), 'Nuevo Contrato');
  assert.equal(asuntoDe('gnew'), 'Nuevo Contrato');
  assert.equal(asuntoDe('mega', {}), 'Nuevo Contrato MEGA');
  assert.equal(asuntoDe('mega', { ...FILA_MEGA, titular_nombre: '' }), 'Nuevo Contrato MEGA - Ana Pérez - ES0021000000001094AX');
  for (const datos of [{ ...FILA_GNEW, compania: '' }, { ...FILA_GNEW, titular_nombre: '' }, { ...FILA_GNEW, cups: '' }, {}]) {
    const asunto = asuntoDe('gnew', datos);
    assert.ok(!asunto.includes(' -  - ') && !asunto.includes(' - - ') && !asunto.endsWith('-') && !asunto.endsWith(' '), asunto);
  }
});

test('asuntoDe: cada parte se recorta (compañía 40, titular 60, comercial 60, CUPS 25)', () => {
  const asunto = asuntoDe('gnew', { compania: 'C'.repeat(100), titular_nombre: 'T'.repeat(100), comercial_nombre: 'M'.repeat(100), cups: 'U'.repeat(10) });
  assert.equal(asunto, `Nuevo Contrato - ${'C'.repeat(40)} - ${'T'.repeat(100).slice(0, 60)} - ${'M'.repeat(60)} - ${'U'.repeat(10)}`);
  const mega = asuntoDe('mega', { titular_nombre: 'T'.repeat(100), comercial_nombre: 'M'.repeat(100), cups: 'U'.repeat(40) });
  assert.equal(mega, `Nuevo Contrato MEGA - ${'T'.repeat(60)} - ${'M'.repeat(60)} - ${'U'.repeat(25)}`);
});

test('asuntoDe: con todo al límite el asunto se recorta a 200 y sigue siendo una línea', () => {
  const asunto = asuntoDe('gnew', { compania: 'C'.repeat(100), titular_nombre: 'T'.repeat(100), comercial_nombre: 'M'.repeat(100), cups: 'U'.repeat(100) });
  assert.equal(asunto.length, 200);
  assert.equal(asunto, `Nuevo Contrato - ${'C'.repeat(40)} - ${'T'.repeat(60)} - ${'M'.repeat(60)} - ${'U'.repeat(14)}`);
  assert.ok(!asunto.includes('\n'));
  assert.ok(asuntoDe('mega', { titular_nombre: 'T'.repeat(500), comercial_nombre: 'M'.repeat(500), cups: 'U'.repeat(500) }).length <= 200);
});

test('asuntoDe: un salto de línea o un tabulador en un nombre no rompe el asunto (una sola línea)', () => {
  const asunto = asuntoDe('gnew', { ...FILA_GNEW, titular_nombre: 'Juan\r\nBcc: victima@ejemplo.es\tGarcía', comercial_nombre: 'Ana\nPérez' });
  assert.ok(!/[\r\n\t]/.test(asunto), JSON.stringify(asunto));
  assert.ok(asunto.includes('Juan Bcc: victima@ejemplo.es García'));
  assert.ok(asunto.includes('Ana Pérez'));
});

test('asuntoDe: formulario desconocido lanza', () => {
  assert.throws(() => asuntoDe('otro', FILA_GNEW), TypeError);
  assert.throws(() => asuntoDe(undefined, FILA_GNEW), TypeError);
});

// ---------------------------------------------------------------------------
// Aviso a backoffice
// ---------------------------------------------------------------------------

const AVISO = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCUMENTOS, urlFicha: URL_FICHA, destino: DESTINO });

test('aviso: devuelve {asunto, html, texto}; el asunto es el de asuntoDe y no lleva la referencia', () => {
  assert.deepEqual(Object.keys(AVISO).sort(), ['asunto', 'html', 'texto']);
  assert.equal(AVISO.asunto, asuntoDe('gnew', FILA_GNEW));
  assert.ok(!AVISO.asunto.includes(FILA_GNEW.ref));
});

test('aviso: lleva el IBAN COMPLETO, el NIF y todos los datos del contrato (en el HTML y en el texto)', () => {
  for (const salida of [AVISO.html, AVISO.texto]) {
    assert.ok(salida.includes(IBAN), 'IBAN completo');
    assert.ok(salida.includes(NIF_TITULAR), 'NIF del titular');
    assert.ok(salida.includes(NIF_FIRMANTE), 'DNI del firmante');
    for (const dato of ['GNE-20261008-ABC123', 'Ana Pérez', 'ana.perez@ejemplo.es', 'NATURGY', 'ES0021000000001094AX', 'Fijo 12 meses', '2.0TD',
      'Juan García López', 'María López', 'Calle Mayor 1, 2º B', '28001', 'Madrid', '600123456', 'cliente@ejemplo.es', 'Llamar por la tarde']) {
      assert.ok(salida.includes(dato), `falta «${dato}»`);
    }
    assert.ok(salida.includes('P1: 4.6 kW | P2: 4.6 kW'), 'potencias como en los correos de siempre');
    assert.ok(!salida.includes('P3'), 'las potencias vacías no salen');
  }
});

test('aviso: cabecera de GNEW (#094D38) con fecha de Madrid y referencia; el de MEGA va en #0D9488', () => {
  assert.ok(AVISO.html.includes('#094D38'));
  assert.ok(!AVISO.html.includes('#0D9488'));
  assert.ok(AVISO.html.includes('Nuevo contrato para tramitar'));
  assert.ok(AVISO.html.includes('08/10/2026 a las 17:30 — Ref: GNE-20261008-ABC123'));
  assert.ok(AVISO.texto.startsWith('NUEVO CONTRATO PARA TRAMITAR\n08/10/2026 a las 17:30 — Ref: GNE-20261008-ABC123'));
  const mega = armarAviso({ tramitacion: FILA_MEGA, documentos: DOCUMENTOS, urlFicha: urlFichaDe('https://tramitatucontrato.energy', FILA_MEGA.ref), destino: DESTINO });
  assert.ok(mega.html.includes('#0D9488'));
  assert.ok(!mega.html.includes('#094D38'));
  assert.equal(mega.asunto, 'Nuevo Contrato MEGA - Juan García López - Ana Pérez - ES0021000000001094AX');
  assert.ok(mega.html.includes('Tipo Suministro') && mega.html.includes('Gas'));
});

test('aviso: botón «Ver y descargar la documentación» que apunta a la ficha de la bandeja', () => {
  assert.ok(AVISO.html.includes('Ver y descargar la documentación'));
  assert.match(AVISO.html, new RegExp(`<a href="${URL_FICHA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>\\s*Ver y descargar la documentación</a>`));
  assert.ok(AVISO.texto.includes(`Ver y descargar la documentación: ${URL_FICHA}`));
  // Sin enlace válido no hay botón (nunca un enlace roto ni peligroso)
  for (const malo of [undefined, '', 'javascript:alert(1)', 'ftp://x.es', '/bandeja/c/x', 'https://x.es/" onclick="evil()', 'https://x.es/a b']) {
    const sin = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCUMENTOS, urlFicha: malo, destino: DESTINO });
    assert.ok(!sin.html.includes('Ver y descargar la documentación'), String(malo));
    assert.ok(!sin.html.includes('onclick='), String(malo));
    assert.ok(!sin.html.includes('javascript:'), String(malo));
  }
});

test('aviso: lista de documentos con nombre y tamaño, en orden, con el recuento', () => {
  assert.ok(AVISO.html.includes('Documentación (4)'));
  const posiciones = ['firma.png', 'contrato.pdf', 'DNI frontal.jpg', 'factura.pdf'].map((n) => AVISO.html.indexOf(n));
  assert.ok(posiciones.every((p) => p > 0) && posiciones.every((p, i) => i === 0 || p > posiciones[i - 1]), 'salen por orden');
  for (const tamano of ['3 KB', '5,50 MB', '402 KB', '800 B']) assert.ok(AVISO.html.includes(tamano), tamano);
  assert.ok(AVISO.texto.includes('Documentación (4):\n- firma.png (3 KB)\n- contrato.pdf (5,50 MB)\n- DNI frontal.jpg (402 KB)\n- factura.pdf (800 B)'));
  // Aunque lleguen desordenados
  const revuelto = armarAviso({ tramitacion: FILA_GNEW, documentos: [DOCUMENTOS[3], DOCUMENTOS[1], DOCUMENTOS[0], DOCUMENTOS[2]], urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(revuelto.texto.indexOf('firma.png') < revuelto.texto.indexOf('contrato.pdf'));
  // Sin documentos no hay sección vacía
  const sinDocs = armarAviso({ tramitacion: FILA_GNEW, documentos: [], urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(!sinDocs.html.includes('Documentación (') && !sinDocs.texto.includes('Documentación ('));
});

test('aviso: pie con el email del comercial y el buzón de tramitación', () => {
  assert.ok(AVISO.html.includes('Al responder a este correo, la respuesta le llega directamente al comercial (ana.perez@ejemplo.es).'));
  assert.ok(AVISO.html.includes(`enviar cualquier documento adicional a ${DESTINO} citando la referencia.`));
  assert.ok(AVISO.html.includes('Aviso automático de tramitatucontrato.energy.'));
  assert.ok(AVISO.texto.includes(`enviar cualquier documento adicional a ${DESTINO} citando la referencia.`));
});

test('aviso: cambio de titular Sí/No, y la franja de antibots solo si la fila es sospechosa', () => {
  assert.match(AVISO.html, /Cambio Titular<\/td>[^]*?>No<\/td>/);
  assert.ok(!AVISO.html.includes('Nuevo Titular'));
  const cambio = armarAviso({ tramitacion: { ...FILA_GNEW, cambio_titular: true, nuevo_titular: 'Luis Gómez, 11111111H' }, documentos: [], urlFicha: URL_FICHA, destino: DESTINO });
  assert.match(cambio.html, /Cambio Titular<\/td>[^]*?>Sí<\/td>/);
  assert.ok(cambio.html.includes('Nuevo Titular') && cambio.html.includes('Luis Gómez, 11111111H'));
  assert.ok(!AVISO.html.includes('filtro antibots') && !AVISO.texto.toLowerCase().includes('antibots'));
  const sospechosa = armarAviso({ tramitacion: { ...FILA_GNEW, sospechosa: true }, documentos: [], urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(sospechosa.html.includes('Este envío ha activado el filtro antibots: revísalo con cuidado'));
  assert.ok(sospechosa.texto.includes('ESTE ENVÍO HA ACTIVADO EL FILTRO ANTIBOTS: REVÍSALO CON CUIDADO'));
});

test('aviso: TODO lo que viene del formulario se escapa — un <script> no llega vivo al HTML', () => {
  const veneno = '<script>alert(1)</script>';
  const fila = {
    ...FILA_GNEW,
    comercial_nombre: veneno,
    comercial_email: `a"onmouseover="x@ejemplo.es`,
    compania: veneno,
    cups: veneno,
    oferta: veneno,
    tarifa: veneno,
    potencias: { p1: veneno },
    titular_nombre: `${veneno} & "Hijos" <b>`,
    direccion: veneno,
    poblacion: `<img src=x onerror=alert(1)>`,
    observaciones: `${veneno}\n<iframe src="https://malo.es"></iframe>`,
    nuevo_titular: veneno,
  };
  const docs = [{ orden: 1, nombre: `${veneno}.pdf`, tamano_declarado: 10 }];
  const { html, texto, asunto } = armarAviso({ tramitacion: fila, documentos: docs, urlFicha: URL_FICHA, destino: veneno });
  assert.ok(!html.includes('<script>') && !html.includes('</script>'), 'sin <script> vivo');
  assert.ok(!html.includes('<img ') && !html.includes('<iframe') && !html.includes('<b>'), 'sin etiquetas vivas');
  assert.ok(!html.includes('"onmouseover='), 'una comilla de verdad no puede abrir un atributo nuevo');
  assert.ok(html.includes('a&quot;onmouseover=&quot;x@ejemplo.es'), 'la comilla del email llega escapada');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'el texto del script se ve, pero escapado');
  assert.ok(html.includes('&quot;Hijos&quot; &lt;b&gt;'), 'comillas y etiquetas del titular escapadas');
  assert.ok(html.includes('&amp;'), 'el & se escapa');
  assert.ok(html.includes('<br>'), 'los saltos de línea de las observaciones se ven como <br>');
  // El texto plano no se escapa (si no, saldría «&amp;» a la vista) pero tampoco lleva HTML nuestro
  assert.ok(texto.includes('& "Hijos" <b>'));
  assert.ok(!texto.includes('&amp;') && !texto.includes('&lt;'));
  assert.ok(!/[\r\n]/.test(asunto), 'una línea');
});

test('aviso: con una fila mínima (solo lo obligatorio) no salen «undefined», «null» ni «[object Object]»', () => {
  const minima = {
    ref: 'GNE-20261008-ABC123', formulario: 'gnew', comercial_nombre: 'Ana', comercial_email: 'ana@ejemplo.es', compania: 'X', cups: 'ES0021000000001094AX',
    titular_nombre: 'T', titular_nif: '12345678Z', iban: IBAN, direccion: 'D', cp: '28001', poblacion: 'P', provincia: 'Q', telefono: '600123456', email_cliente: 'c@ejemplo.es',
  };
  const aviso = armarAviso({ tramitacion: minima, documentos: undefined, urlFicha: URL_FICHA, destino: DESTINO });
  const acuse = armarAcuse({ tramitacion: minima, documentos: null, destino: DESTINO });
  for (const salida of [aviso.html, aviso.texto, aviso.asunto, acuse.html, acuse.texto, acuse.asunto]) {
    assert.ok(!/undefined|null|\[object Object\]|NaN/.test(salida), salida.slice(0, 200));
  }
});

test('aviso: el texto plano no lleva etiquetas HTML nuestras', () => {
  assert.ok(!/<(table|div|td|tr|h2|h3|ul|li|a|strong|body|html)\b/i.test(AVISO.texto));
});

test('aviso: sin tramitación o con formulario desconocido, lanza', () => {
  assert.throws(() => armarAviso(), TypeError);
  assert.throws(() => armarAviso({}), TypeError);
  assert.throws(() => armarAviso({ tramitacion: { ...FILA_GNEW, formulario: 'otro' } }), TypeError);
  assert.throws(() => armarAviso({ tramitacion: { ...FILA_GNEW, formulario: 'constructor' } }), TypeError);
});

// ---------------------------------------------------------------------------
// Acuse al comercial
// ---------------------------------------------------------------------------

const ACUSE = armarAcuse({ tramitacion: FILA_GNEW, documentos: DOCUMENTOS, destino: DESTINO });

test('acuse: asunto «Recibido: » + el del aviso (recortado a 200) y sin la referencia', () => {
  assert.equal(ACUSE.asunto, `Recibido: ${AVISO.asunto}`);
  assert.deepEqual(Object.keys(ACUSE).sort(), ['asunto', 'html', 'texto']);
  const largo = armarAcuse({
    tramitacion: { ...FILA_GNEW, compania: 'C'.repeat(100), titular_nombre: 'T'.repeat(100), comercial_nombre: 'M'.repeat(100), cups: 'U'.repeat(100) },
    destino: DESTINO,
  });
  assert.equal(largo.asunto.length, 200);
  assert.ok(largo.asunto.startsWith('Recibido: Nuevo Contrato - '));
  assert.ok(!ACUSE.asunto.includes(FILA_GNEW.ref));
});

test('acuse: NO lleva IBAN, ni DNI/NIF, ni teléfono, ni enlace a la bandeja (ni en el HTML ni en el texto)', () => {
  for (const salida of [ACUSE.html, ACUSE.texto, ACUSE.asunto]) {
    assert.ok(!salida.includes(IBAN), 'IBAN completo');
    assert.ok(!salida.includes('ES91'), 'ni el principio del IBAN');
    assert.ok(!salida.includes('2100 0418') && !salida.includes('21000418'), 'ni trozos del IBAN');
    assert.ok(!salida.includes(NIF_TITULAR), 'NIF del titular');
    assert.ok(!salida.includes(NIF_FIRMANTE), 'DNI del firmante');
    assert.ok(!salida.includes('600123456'), 'teléfono del cliente');
    assert.ok(!salida.includes('cliente@ejemplo.es'), 'email del cliente');
    assert.ok(!/bandeja/i.test(salida), 'enlace a la bandeja');
    assert.ok(!/https?:\/\//.test(salida), 'ningún enlace web');
  }
});

test('acuse: saludo con el nombre, resumen, documentos recibidos y a dónde escribir si falta algo', () => {
  for (const salida of [ACUSE.html, ACUSE.texto]) {
    assert.ok(salida.includes('Hola Ana Pérez, hemos recibido tu contrato y la documentación. Ya está en manos del equipo de tramitación.'));
    for (const dato of ['GNE-20261008-ABC123', '08/10/2026 a las 17:30', 'NATURGY', 'ES0021000000001094AX', 'Juan García López', 'Fijo 12 meses', '2.0TD']) {
      assert.ok(salida.includes(dato), `falta «${dato}»`);
    }
    for (const nombre of ['firma.png', 'contrato.pdf', 'DNI frontal.jpg', 'factura.pdf']) assert.ok(salida.includes(nombre), nombre);
    assert.ok(salida.includes('¿Falta algo o quieres añadir documentación?'));
    assert.ok(salida.includes(DESTINO));
    assert.ok(salida.includes('indicando siempre la referencia'));
  }
  assert.ok(ACUSE.html.includes('Documentación recibida (4)'));
  assert.ok(ACUSE.html.includes('Contrato recibido'));
  assert.ok(ACUSE.html.includes(`<a href="mailto:${DESTINO}"`));
  assert.ok(ACUSE.html.includes('#094D38'));
  assert.ok(ACUSE.html.includes('(Grupo New Energy)'));
  assert.ok(!ACUSE.html.includes('5,50 MB'), 'el acuse lista los nombres, no los tamaños');
});

test('acuse MEGA: cabecera #0D9488 y firma de Mega Energía', () => {
  const mega = armarAcuse({ tramitacion: FILA_MEGA, documentos: DOCUMENTOS, destino: DESTINO });
  assert.ok(mega.html.includes('#0D9488') && !mega.html.includes('#094D38'));
  assert.ok(mega.html.includes('(Mega Energía)'));
  assert.equal(mega.asunto, 'Recibido: Nuevo Contrato MEGA - Juan García López - Ana Pérez - ES0021000000001094AX');
  assert.ok(!mega.html.includes(IBAN) && !mega.texto.includes(IBAN));
});

test('acuse: escapa lo que viene del formulario y no se rompe sin nombre ni buzón', () => {
  const veneno = '<script>alert(1)</script>';
  const a = armarAcuse({
    tramitacion: { ...FILA_GNEW, comercial_nombre: veneno, titular_nombre: veneno, oferta: veneno },
    documentos: [{ orden: 1, nombre: `${veneno}.pdf` }],
    destino: `a"b@x.es`,
  });
  assert.ok(!a.html.includes('<script>') && !a.html.includes('</script>'));
  assert.ok(a.html.includes('&lt;script&gt;'));
  assert.ok(!a.html.includes('mailto:a"b'), 'el buzón también se escapa dentro del atributo');
  const sinNada = armarAcuse({ tramitacion: { ...FILA_GNEW, comercial_nombre: '' }, documentos: [], destino: '' });
  assert.ok(sinNada.html.includes('Hola, hemos recibido tu contrato'));
  assert.ok(sinNada.html.includes('el equipo de tramitación'));
  assert.ok(!sinNada.html.includes('Documentación recibida ('));
});

// ---------------------------------------------------------------------------
// Código de acceso
// ---------------------------------------------------------------------------

test('código: solo texto, con el código, 10 minutos y «ignora este correo»; el código no va en el asunto', () => {
  const c = armarCodigo('123456');
  assert.deepEqual(Object.keys(c).sort(), ['asunto', 'html', 'texto']);
  assert.equal(c.html, null);
  assert.equal(c.texto, 'Tu código para entrar en la bandeja de tramitación es 123456. Caduca en 10 minutos. Si no lo has pedido tú, ignora este correo.');
  assert.ok(!c.asunto.includes('123456'));
  assert.ok(c.asunto.length > 0 && c.asunto.length <= 200);
  assert.equal(armarCodigo(' 000042 ').texto.includes('es 000042.'), true, 'conserva los ceros del principio');
});

test('código: solo 6 cifras; cualquier otra cosa lanza', () => {
  for (const malo of ['12345', '1234567', 'abcdef', '12 345', '', undefined, null, '123456\n<b>']) {
    assert.throws(() => armarCodigo(malo), TypeError, String(malo));
  }
  assert.equal(armarCodigo(123456).texto.includes('123456'), true, 'un número entero con 6 cifras también vale');
});
