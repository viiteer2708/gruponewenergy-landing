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
  nombreDeAdjunto,
  nombresUnicos,
  seleccionarAdjuntos,
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

test('aviso: botón «Abrir en la bandeja» que apunta a la ficha, SIEMPRE (con o sin adjuntos)', () => {
  const ENLACE = URL_FICHA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  assert.ok(AVISO.html.includes('Abrir en la bandeja'));
  assert.match(AVISO.html, new RegExp(`<a href="${ENLACE}"[^>]*>\\s*Abrir en la bandeja</a>`));
  assert.ok(AVISO.texto.includes(`Abrir en la bandeja: ${URL_FICHA}`));
  assert.ok(!AVISO.html.includes('Ver y descargar la documentación') && !AVISO.texto.includes('Ver y descargar la documentación'), 'el texto antiguo ya no está');
  // También cuando todo va adjunto, cuando nada va adjunto y cuando no hay documentos
  for (const seleccion of [seleccionarAdjuntos(DOCS_SUBIDOS_PEQUENOS), seleccionarAdjuntos(DOCS_SUBIDOS_PEQUENOS, { maxAdjuntos: 0 }), { adjuntos: [], fuera: [] }]) {
    const aviso = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCS_SUBIDOS_PEQUENOS, seleccion, urlFicha: URL_FICHA, destino: DESTINO });
    assert.match(aviso.html, new RegExp(`<a href="${ENLACE}"[^>]*>\\s*Abrir en la bandeja</a>`));
    assert.ok(aviso.texto.includes(`Abrir en la bandeja: ${URL_FICHA}`));
  }
  // Sin enlace válido no hay botón (nunca un enlace roto ni peligroso)
  for (const malo of [undefined, '', 'javascript:alert(1)', 'ftp://x.es', '/bandeja/c/x', 'https://x.es/" onclick="evil()', 'https://x.es/a b']) {
    const sin = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCUMENTOS, urlFicha: malo, destino: DESTINO });
    assert.ok(!sin.html.includes('Abrir en la bandeja'), String(malo));
    assert.ok(!sin.html.includes('onclick='), String(malo));
    assert.ok(!sin.html.includes('javascript:'), String(malo));
  }
});

// Documentos ya subidos (lo que llega al aviso desde la base): la firma (orden 0), un contrato que NO cabe y dos pequeños
const DOCS_SUBIDOS = Object.freeze(DOCUMENTOS.map((d) => Object.freeze({ ...d, estado: 'subido', tamano_comprobado: d.tamano_comprobado ?? d.tamano_declarado })));
const DOCS_SUBIDOS_PEQUENOS = Object.freeze(DOCS_SUBIDOS.filter((d) => d.nombre !== 'contrato.pdf'));

test('aviso con adjuntos: «Documentación adjunta a este correo (n)» con nombre y tamaño de cada adjunto, la firma al final', () => {
  const seleccion = seleccionarAdjuntos(DOCS_SUBIDOS_PEQUENOS);
  const aviso = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCS_SUBIDOS_PEQUENOS, seleccion, urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(aviso.html.includes('Documentación adjunta a este correo (3)'));
  const posiciones = ['DNI frontal.jpg', 'factura.pdf', 'firma.png'].map((n) => aviso.html.indexOf(n));
  assert.ok(posiciones.every((p) => p > 0) && posiciones.every((p, i) => i === 0 || p > posiciones[i - 1]), 'primero los documentos por su orden y la firma la última');
  for (const tamano of ['402 KB', '800 B', '3 KB']) assert.ok(aviso.html.includes(tamano), tamano);
  assert.ok(aviso.texto.includes('Documentación adjunta a este correo (3):\n- DNI frontal.jpg (402 KB)\n- factura.pdf (800 B)\n- firma.png (3 KB)'));
  // todo cabe: no hay aviso de «no caben»
  assert.ok(!aviso.html.includes('No caben como adjunto') && !aviso.texto.includes('No caben como adjunto'));
  assert.ok(!aviso.html.includes('Documentación ('), 'el título antiguo ya no está');
  // el recuento y las listas salen de la selección, no de los documentos que lleguen
  const revuelto = armarAviso({ tramitacion: FILA_GNEW, documentos: [...DOCS_SUBIDOS_PEQUENOS].reverse(), seleccion, urlFicha: URL_FICHA, destino: DESTINO });
  assert.equal(revuelto.html, aviso.html);
  assert.equal(revuelto.texto, aviso.texto);
});

test('aviso con adjuntos: lo que no cabe sale en «No caben como adjunto y están en la bandeja: …» (HTML y texto)', () => {
  const seleccion = seleccionarAdjuntos(DOCS_SUBIDOS);
  assert.deepEqual(seleccion.fuera.map((f) => f.nombre), ['contrato.pdf']);
  const aviso = armarAviso({ tramitacion: FILA_GNEW, documentos: DOCS_SUBIDOS, seleccion, urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(aviso.html.includes('Documentación adjunta a este correo (3)'));
  assert.match(aviso.html, /<strong>No caben como adjunto y están en la bandeja:<\/strong> contrato\.pdf \(5,50 MB\)\./);
  assert.ok(aviso.texto.includes('No caben como adjunto y están en la bandeja: contrato.pdf (5,50 MB).'));
  // el contrato grande no aparece entre los adjuntos
  const bloqueAdjuntos = aviso.texto.slice(aviso.texto.indexOf('Documentación adjunta'), aviso.texto.indexOf('No caben'));
  assert.ok(!bloqueAdjuntos.includes('contrato.pdf'));
  // varios, separados por comas y con su tamaño
  const dos = armarAviso({
    tramitacion: FILA_GNEW,
    documentos: DOCS_SUBIDOS,
    seleccion: seleccionarAdjuntos(DOCS_SUBIDOS, { maxAdjuntos: 1 }),
    urlFicha: URL_FICHA,
    destino: DESTINO,
  });
  assert.ok(dos.texto.includes('Documentación adjunta a este correo (1):\n- DNI frontal.jpg (402 KB)\n'));
  assert.ok(dos.texto.includes('No caben como adjunto y están en la bandeja: contrato.pdf (5,50 MB), factura.pdf (800 B), firma.png (3 KB).'));
});

test('aviso sin selección (o sin adjuntos): nada adjunto y TODOS los documentos «en la bandeja»; sin documentos no hay avisos', () => {
  // AVISO se armó sin `seleccion`: es lo que hace crearCorreos para el asunto
  assert.ok(!AVISO.html.includes('Documentación adjunta') && !AVISO.texto.includes('Documentación adjunta'), 'sin adjuntos no hay un «(0)» vacío');
  assert.ok(AVISO.html.includes('No caben como adjunto y están en la bandeja:'));
  for (const nombre of ['contrato.pdf', 'DNI frontal.jpg', 'factura.pdf', 'firma.png']) assert.ok(AVISO.texto.includes(nombre), nombre);
  assert.ok(AVISO.texto.includes('contrato.pdf (5,50 MB), DNI frontal.jpg (402 KB), factura.pdf (800 B), firma.png (3 KB).'), 'documentos por su orden y la firma la última');
  // sin documentos: ni sección de adjuntos ni aviso de «no caben»
  const sinDocs = armarAviso({ tramitacion: FILA_GNEW, documentos: [], urlFicha: URL_FICHA, destino: DESTINO });
  for (const salida of [sinDocs.html, sinDocs.texto]) {
    assert.ok(!salida.includes('Documentación adjunta') && !salida.includes('No caben como adjunto') && !salida.includes('Documentación ('));
  }
  const vacia = armarAviso({ tramitacion: FILA_GNEW, seleccion: { adjuntos: [], fuera: [] }, urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(!vacia.html.includes('No caben como adjunto'));
});

test('aviso con adjuntos: los nombres se escapan en el HTML (un <script> en un nombre no llega vivo) y no en el texto', () => {
  const docs = [
    { orden: 1, nombre: '<script>alert(1)</script>.pdf', estado: 'subido', tamano_declarado: 100, tamano_comprobado: 100 },
    { orden: 2, nombre: 'a&b "c".png', estado: 'subido', tamano_declarado: 5_000_000, tamano_comprobado: 5_000_000 },
  ];
  const aviso = armarAviso({ tramitacion: FILA_GNEW, documentos: docs, seleccion: seleccionarAdjuntos(docs), urlFicha: URL_FICHA, destino: DESTINO });
  assert.ok(!aviso.html.includes('<script>alert(1)</script>'));
  assert.ok(aviso.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;.pdf'));
  // el segundo no cabe (5 MB): sale en «no caben», con las comillas hechas espacio (como Altavoz) y el & escapado
  assert.ok(aviso.html.includes('<strong>No caben como adjunto y están en la bandeja:</strong> a&amp;b c .png (4,77 MB).'), aviso.html.slice(aviso.html.indexOf('No caben') - 20, aviso.html.indexOf('No caben') + 120));
  assert.ok(aviso.texto.includes('<script>alert(1)</script>.pdf (100 B)'), 'el texto plano no se escapa');
  assert.ok(aviso.texto.includes('No caben como adjunto y están en la bandeja: a&b c .png (4,77 MB).'));
});

test('nombreDeAdjunto: saltos de línea, tabuladores y comillas pasan a espacio (como Altavoz); vacío → «documento»', () => {
  assert.equal(nombreDeAdjunto('dni.jpg'), 'dni.jpg');
  assert.equal(nombreDeAdjunto('  dni\r\nfrontal\t"1".jpg '), 'dni frontal 1 .jpg');
  assert.equal(nombreDeAdjunto(''), 'documento');
  assert.equal(nombreDeAdjunto(undefined), 'documento');
  assert.equal(nombreDeAdjunto('   '), 'documento');
});

test('nombresUnicos: dni.jpg, dni (2).jpg, dni (3).jpg — sin perder la extensión y sin distinguir mayúsculas', () => {
  assert.deepEqual(nombresUnicos(['dni.jpg', 'dni.jpg', 'dni.jpg']), ['dni.jpg', 'dni (2).jpg', 'dni (3).jpg']);
  assert.deepEqual(nombresUnicos(['dni.jpg', 'DNI.JPG', 'Dni.jpg']), ['dni.jpg', 'DNI (2).JPG', 'Dni (3).jpg']);
  assert.deepEqual(nombresUnicos(['a.pdf', 'b.pdf', 'a.pdf', 'a (2).pdf']), ['a.pdf', 'b.pdf', 'a (2).pdf', 'a (2) (2).pdf'], 'si «a (2).pdf» ya existe, el siguiente no lo pisa');
  assert.deepEqual(nombresUnicos(['factura', 'factura']), ['factura', 'factura (2)'], 'sin extensión también');
  assert.deepEqual(nombresUnicos(['x.pdf', 'y.pdf']), ['x.pdf', 'y.pdf'], 'los que ya son distintos no se tocan');
  assert.deepEqual(nombresUnicos([]), []);
  assert.deepEqual(nombresUnicos(undefined), []);
  // un nombre larguísimo sigue cabiendo en los 200 caracteres de Altavoz, con su extensión
  const largo = `${'a'.repeat(198)}.pdf`.slice(-200);
  const [primero, segundo] = nombresUnicos([largo, largo]);
  assert.equal(primero, largo);
  assert.ok(Array.from(segundo).length <= 200 && segundo.endsWith(' (2).pdf'), segundo);
});

// ---------------------------------------------------------------------------
// Qué documentos van adjuntos
// ---------------------------------------------------------------------------

const doc = (orden, nombre, bytes, extra = {}) => ({ orden, nombre, estado: 'subido', tamano_declarado: bytes, tamano_comprobado: bytes, ...extra });
const nombresDe = (lista) => lista.map((x) => x.nombre);

test('seleccionarAdjuntos: primero los de orden 1..N por su orden y la firma (orden 0) al final, aunque lleguen revueltos', () => {
  const { adjuntos, fuera } = seleccionarAdjuntos([doc(0, 'firma.png', 283), doc(3, 'c.png', 30), doc(1, 'a.pdf', 10), doc(2, 'b.jpg', 20)]);
  assert.deepEqual(nombresDe(adjuntos), ['a.pdf', 'b.jpg', 'c.png', 'firma.png']);
  assert.deepEqual(adjuntos.map((a) => a.bytes), [10, 20, 30, 283]);
  assert.deepEqual(adjuntos.map((a) => a.pos), [0, 1, 2, 3]);
  assert.deepEqual(fuera, []);
  assert.deepEqual(seleccionarAdjuntos(undefined), { adjuntos: [], fuera: [] });
  assert.deepEqual(seleccionarAdjuntos([]), { adjuntos: [], fuera: [] });
});

test('seleccionarAdjuntos: 3.000.000 bytes reales entre todos — exactamente 3.000.000 cabe; un byte más, no', () => {
  const justo = seleccionarAdjuntos([doc(1, 'a.pdf', 1_500_000), doc(2, 'b.pdf', 1_500_000)]);
  assert.deepEqual(nombresDe(justo.adjuntos), ['a.pdf', 'b.pdf']);
  const pasado = seleccionarAdjuntos([doc(1, 'a.pdf', 1_500_000), doc(2, 'b.pdf', 1_500_000), doc(3, 'c.pdf', 1)]);
  assert.deepEqual(nombresDe(pasado.adjuntos), ['a.pdf', 'b.pdf']);
  assert.deepEqual(pasado.fuera.map((f) => [f.nombre, f.motivo, f.bytes]), [['c.pdf', 'cupo', 1]]);
  const unico = seleccionarAdjuntos([doc(1, 'enorme.pdf', 3_000_001)]);
  assert.deepEqual(unico.adjuntos, []);
  assert.equal(unico.fuera[0].motivo, 'cupo');
  assert.deepEqual(nombresDe(seleccionarAdjuntos([doc(1, 'tope.pdf', 3_000_000)]).adjuntos), ['tope.pdf']);
});

test('seleccionarAdjuntos: uno que no cabe se salta y los siguientes se miran igualmente (el grande no bloquea a los pequeños)', () => {
  // 5,5 MB + dos pequeños + la firma
  const { adjuntos, fuera } = seleccionarAdjuntos([doc(1, 'grande.pdf', 5_767_168), doc(2, 'dni.jpg', 368), doc(3, 'factura.png', 283), doc(0, 'firma.png', 283)]);
  assert.deepEqual(nombresDe(adjuntos), ['dni.jpg', 'factura.png', 'firma.png']);
  assert.deepEqual(fuera.map((f) => [f.nombre, f.motivo]), [['grande.pdf', 'cupo']]);
  // uno a medias: 2.000.000 entra, 1.500.000 ya no, 900.000 sí, 200.000 ya no, la firma sí
  const medias = seleccionarAdjuntos([doc(1, 'a.pdf', 2_000_000), doc(2, 'b.pdf', 1_500_000), doc(3, 'c.pdf', 900_000), doc(4, 'd.pdf', 200_000), doc(0, 'firma.png', 283)]);
  assert.deepEqual(nombresDe(medias.adjuntos), ['a.pdf', 'c.pdf', 'firma.png']);
  assert.deepEqual(nombresDe(medias.fuera), ['b.pdf', 'd.pdf']);
});

test('seleccionarAdjuntos: como mucho 10 adjuntos EN TOTAL, la firma incluida (con 12 documentos + firma, entran los 10 primeros)', () => {
  const doce = Array.from({ length: 12 }, (_, i) => doc(i + 1, `doc${String(i + 1).padStart(2, '0')}.jpg`, 1000));
  const { adjuntos, fuera } = seleccionarAdjuntos([...doce, doc(0, 'firma.png', 283)]);
  assert.equal(adjuntos.length, 10);
  assert.deepEqual(nombresDe(adjuntos), doce.slice(0, 10).map((d) => d.nombre));
  assert.deepEqual(nombresDe(fuera), ['doc11.jpg', 'doc12.jpg', 'firma.png'], 'el resto y la firma se quedan en la bandeja');
  assert.ok(fuera.every((f) => f.motivo === 'cupo'));
  // 9 documentos + firma = 10: todos
  const nueve = seleccionarAdjuntos([...doce.slice(0, 9), doc(0, 'firma.png', 283)]);
  assert.equal(nueve.adjuntos.length, 10);
  assert.equal(nueve.adjuntos.at(-1).nombre, 'firma.png');
  // 10 documentos + firma: la firma no cabe
  const diez = seleccionarAdjuntos([...doce.slice(0, 10), doc(0, 'firma.png', 283)]);
  assert.equal(diez.adjuntos.length, 10);
  assert.deepEqual(nombresDe(diez.fuera), ['firma.png']);
});

test('seleccionarAdjuntos: solo los documentos `subido` y con su tamaño comprobado; el tipo y el tamaño de la base mandan', () => {
  const { adjuntos, fuera } = seleccionarAdjuntos([
    doc(1, 'bien.pdf', 100),
    doc(2, 'pendiente.pdf', 100, { estado: 'pendiente' }),
    doc(3, 'sin-tamano.pdf', 100, { tamano_comprobado: null }),
    doc(4, 'vacio.pdf', 0, { tamano_comprobado: 0 }),
    doc(5, 'notas.txt', 100),
    doc(6, 'otro.docx', 100),
  ]);
  assert.deepEqual(nombresDe(adjuntos), ['bien.pdf', 'otro.docx']);
  assert.deepEqual(fuera.map((f) => [f.nombre, f.motivo]), [['pendiente.pdf', 'no_subido'], ['sin-tamano.pdf', 'no_subido'], ['vacio.pdf', 'no_subido'], ['notas.txt', 'tipo']]);
  assert.equal(fuera[1].bytes, 100, 'sin tamaño comprobado se enseña el declarado');
  // las seis extensiones de Altavoz, en mayúsculas o minúsculas
  const todas = seleccionarAdjuntos(['pdf', 'jpg', 'jpeg', 'PNG', 'doc', 'DOCX'].map((ext, i) => doc(i + 1, `f.${ext}`, 10)));
  assert.equal(todas.adjuntos.length, 6);
});

test('seleccionarAdjuntos: dos documentos con el mismo nombre salen con nombres distintos (y la extensión intacta); la firma no se pisa', () => {
  const { adjuntos } = seleccionarAdjuntos([doc(1, 'dni.jpg', 10), doc(2, 'dni.jpg', 11), doc(3, 'DNI.jpg', 12), doc(4, 'firma.png', 13), doc(0, 'firma.png', 283)]);
  assert.deepEqual(nombresDe(adjuntos), ['dni.jpg', 'dni (2).jpg', 'DNI (3).jpg', 'firma.png', 'firma (2).png']);
  assert.deepEqual(adjuntos.map((a) => a.doc.orden), [1, 2, 3, 4, 0]);
  assert.equal(new Set(nombresDe(adjuntos).map((n) => n.toLowerCase())).size, 5);
});

test('seleccionarAdjuntos: con maxAdjuntos 0 todo queda fuera (así se arma «sin adjuntos»); los límites se pueden rebajar', () => {
  const lista = [doc(1, 'a.pdf', 10), doc(2, 'b.pdf', 10)];
  const nada = seleccionarAdjuntos(lista, { maxAdjuntos: 0 });
  assert.deepEqual(nada.adjuntos, []);
  assert.deepEqual(nada.fuera.map((f) => f.motivo), ['cupo', 'cupo']);
  assert.deepEqual(nombresDe(seleccionarAdjuntos(lista, { maxAdjuntos: 1 }).adjuntos), ['a.pdf']);
  assert.deepEqual(nombresDe(seleccionarAdjuntos(lista, { maxBytes: 15 }).adjuntos), ['a.pdf']);
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
