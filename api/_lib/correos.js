// api/_lib/correos.js · Asuntos y cuerpos de los tres correos: aviso a backoffice, acuse al comercial
// y código de acceso a la bandeja (diseño §2.5).
//
// Aquí solo se arma el contenido; enviarlo es cosa del cartero. El aspecto sale de
// buildEmailHtml / buildAcuseHtml de los Code.gs de siempre (cabecera #094D38 GNEW y
// #0D9488 MEGA). Desde la orden 6 (decisión de Victor, 10-oct-2026) el aviso a backoffice vuelve a llevar la
// documentación ADJUNTA, con los mismos topes que el Code.gs y que Altavoz (hasta 10 ficheros y 3.000.000 bytes
// reales entre todos; ver seleccionarAdjuntos); lo que no cabe se queda «en la bandeja», y el botón a la ficha
// va SIEMPRE. El acuse al comercial no cambia: sin adjuntos, sin IBAN ni DNI.
// Todo lo que viene del formulario se escapa en el HTML; el texto plano no se escapa
// (si no, saldrían «&amp;» a la vista).
import { ADJUNTOS_AVISO, MARCAS, CODIGO_ACCESO } from './config.js';
import { enUnaLinea, extensionDe, recortar } from './nombres.js';

/** Etiqueta que lleva cada tipo de correo en Altavoz (para encontrarlos después). */
export const ETIQUETA_CORREO = Object.freeze({
  aviso: 'tramitacion-aviso',
  acuse: 'tramitacion-acuse',
  codigo_acceso: 'bandeja-codigo',
});

export const MAX_ASUNTO = 200;

// Frases fijas del aviso a backoffice (las mismas en HTML y en texto)
const TITULO_ADJUNTOS = 'Documentación adjunta a este correo';
const TEXTO_NO_CABEN = 'No caben como adjunto y están en la bandeja:';
const TEXTO_BOTON_BANDEJA = 'Abrir en la bandeja';

/** Escapa lo que va dentro del HTML (texto y atributos). */
export function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FORMATO_FECHA = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23', // con hour12:false algunos ICU sueltan «24:00» a medianoche
});

/** «08/10/2026 a las 17:45», en hora de Madrid. Una fecha ilegible se sustituye por «ahora». */
export function fechaMadrid(fecha = new Date()) {
  let d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) d = new Date();
  const p = Object.fromEntries(FORMATO_FECHA.formatToParts(d).map((x) => [x.type, x.value]));
  const dos = (v) => String(v).padStart(2, '0'); // es-ES no rellena con ceros aunque se pida 2-digit
  return `${dos(p.day)}/${dos(p.month)}/${p.year} a las ${dos(p.hour)}:${dos(p.minute)}`;
}

/** Enlace a la ficha de una tramitación en la bandeja: <sitio>/bandeja/c/<ref>. */
export function urlFichaDe(sitio, ref) {
  return `${String(sitio ?? '').replace(/\/+$/, '')}/bandeja/c/${encodeURIComponent(String(ref ?? ''))}`;
}

// ---------------------------------------------------------------------------
// Asuntos
// ---------------------------------------------------------------------------

// Con los topes por parte (40 + 60 + 60 + 25) el asunto solo se pasa de 200 si todo viene al límite, y
// entonces el corte cae siempre dentro del CUPS (la última parte): nunca deja un separador colgando.
const ajustarAsunto = (asunto) => recortar(asunto, MAX_ASUNTO);

/**
 * Asunto del aviso (SIN la referencia):
 *   GNEW: Nuevo Contrato - <compañía 40> - <titular 60> - <comercial 60> - <CUPS 25>
 *   MEGA: Nuevo Contrato MEGA - <titular 60> - <comercial 60> - <CUPS 25>
 * Cada parte va en una línea y recortada; las que faltan se omiten sin dejar guiones
 * dobles; el total no pasa de 200. `datos` puede ser la fila de la base (titular_nombre,
 * comercial_nombre) o lo que manda el formulario (titular, quien_eres).
 */
export function asuntoDe(formulario, datos) {
  const d = datos ?? {};
  const parte = (valor, max) => recortar(enUnaLinea(valor), max);
  const titular = parte(d.titular_nombre ?? d.titular, 60);
  const comercial = parte(d.comercial_nombre ?? d.quien_eres, 60);
  const cups = parte(d.cups, 25);
  let partes;
  if (formulario === 'mega') partes = ['Nuevo Contrato MEGA', titular, comercial, cups];
  else if (formulario === 'gnew') partes = ['Nuevo Contrato', parte(d.compania, 40), titular, comercial, cups];
  else throw new TypeError('Formulario no válido');
  return ajustarAsunto(partes.filter(Boolean).join(' - '));
}

// ---------------------------------------------------------------------------
// Adjuntos del aviso: qué documentos van adjuntos y cómo se llaman
// ---------------------------------------------------------------------------

/**
 * El nombre tal como lo dejará Altavoz: los saltos de línea, tabuladores y comillas dobles pasan a un espacio y se
 * recortan los espacios de los lados (api.md §5). Lo que no tenga nombre se llama «documento».
 */
export function nombreDeAdjunto(nombre) {
  return String(nombre ?? '').replace(/[\r\n\t"]+/g, ' ').trim() || 'documento';
}

/**
 * Hace distintos los nombres de una lista sin perder la extensión: dni.jpg, dni (2).jpg, dni (3).jpg. No distingue
 * mayúsculas de minúsculas (Windows y Mac tampoco: «DNI.jpg» y «dni.jpg» se pisarían al guardarlos). Devuelve una
 * lista del mismo largo y en el mismo orden. Altavoz NO exige nombres distintos: esto lo hacemos para que backoffice
 * no se encuentre dos «dni.jpg» en el correo.
 */
export function nombresUnicos(nombres) {
  const usados = new Set();
  return (Array.isArray(nombres) ? nombres : []).map((crudo) => {
    const base = nombreDeAdjunto(crudo);
    const punto = base.lastIndexOf('.');
    const raiz = punto > 0 ? base.slice(0, punto) : base;
    const extension = punto > 0 ? base.slice(punto) : '';
    let nombre = base;
    for (let n = 2; usados.has(nombre.toLowerCase()); n++) {
      const sufijo = ` (${n})${extension}`;
      nombre = `${Array.from(raiz).slice(0, Math.max(1, ADJUNTOS_AVISO.maxNombre - sufijo.length)).join('')}${sufijo}`;
    }
    usados.add(nombre.toLowerCase());
    return nombre;
  });
}

const EXTENSIONES_ADJUNTO = new Set(ADJUNTOS_AVISO.extensiones);

/**
 * Qué documentos de una tramitación van adjuntos al aviso y cuáles se quedan solo en la bandeja. Las mismas reglas que
 * el Code.gs de siempre y que los topes de Altavoz:
 *   · solo los documentos en estado `subido` y con su tamaño comprobado (`tamano_comprobado` > 0);
 *   · primero los de orden 1..N, por su orden; la firma (orden 0) al FINAL;
 *   · cada uno entra si los bytes acumulados más los suyos no pasan de 3.000.000 Y quedan plazas (10 EN TOTAL, la firma
 *     incluida); si uno no cabe, se salta y los siguientes se miran igualmente («por orden de llegada»).
 * Devuelve {adjuntos, fuera}, ambas en el orden de arriba:
 *   adjuntos  [{doc, nombre, bytes, pos}]           nombre = el que llevará el adjunto (distinto del de los demás);
 *                                                   pos = su lugar en ese orden (para volver a ordenar lo que cambie de lista)
 *   fuera     [{doc, nombre, bytes, motivo, pos}]   motivo: 'cupo' (no cabe en bytes o en plazas) · 'no_subido' · 'tipo'
 *                                                   (quien descarga añade 'descarga': no se ha podido bajar del almacén)
 * `maxAdjuntos`/`maxBytes` se pueden rebajar (con `maxAdjuntos: 0` todo queda fuera: es lo que se hace sin adjuntos).
 * No descarga nada: los `bytes` que cuentan son los de la base; quien descarga comprueba que coinciden.
 */
export function seleccionarAdjuntos(documentos, { maxAdjuntos = ADJUNTOS_AVISO.max, maxBytes = ADJUNTOS_AVISO.maxBytes } = {}) {
  const lista = (Array.isArray(documentos) ? documentos : []).filter((d) => d !== null && typeof d === 'object');
  const lugar = (doc) => (Number(doc.orden) === 0 ? Number.POSITIVE_INFINITY : Number(doc.orden ?? 0));
  const ordenados = [...lista].sort((a, b) => lugar(a) - lugar(b));
  const nombres = nombresUnicos(ordenados.map((doc) => doc.nombre));

  const adjuntos = [];
  const fuera = [];
  let acumulado = 0;
  ordenados.forEach((doc, i) => {
    const nombre = nombres[i];
    const comprobado = Number(doc.tamano_comprobado);
    const tieneTamano = doc.tamano_comprobado !== null && doc.tamano_comprobado !== undefined && Number.isSafeInteger(comprobado) && comprobado > 0;
    let motivo = null;
    if (doc.estado !== 'subido' || !tieneTamano) motivo = 'no_subido';
    else if (!EXTENSIONES_ADJUNTO.has(extensionDe(nombre)) || Array.from(nombre).length > ADJUNTOS_AVISO.maxNombre) motivo = 'tipo';
    else if (adjuntos.length >= maxAdjuntos || acumulado + comprobado > maxBytes) motivo = 'cupo';

    if (motivo === null) {
      acumulado += comprobado;
      adjuntos.push({ doc, nombre, bytes: comprobado, pos: i });
    } else {
      const declarado = Number(doc.tamano_declarado);
      const bytes = tieneTamano ? comprobado : (Number.isSafeInteger(declarado) && declarado >= 0 ? declarado : null);
      fuera.push({ doc, nombre, bytes, motivo, pos: i });
    }
  });
  return { adjuntos, fuera };
}

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

function tamanoTexto(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
}

function textoPotencias(potencias) {
  if (!potencias || typeof potencias !== 'object') return '';
  const partes = [];
  for (const clave of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    const valor = potencias[clave];
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
      partes.push(`${clave.toUpperCase()}: ${enUnaLinea(valor)} kW`);
    }
  }
  return partes.join(' | ');
}

function textoCambioTitular(valor) {
  if (valor === true) return 'Sí';
  if (typeof valor === 'string' && ['si', 'sí'].includes(valor.trim().toLowerCase())) return 'Sí';
  return 'No';
}

function documentosOrdenados(documentos) {
  return [...(Array.isArray(documentos) ? documentos : [])]
    .sort((a, b) => (a?.orden ?? 0) - (b?.orden ?? 0))
    .map((doc) => ({
      nombre: enUnaLinea(doc?.nombre) || 'documento',
      tamano: tamanoTexto(doc?.tamano_comprobado ?? doc?.tamano_declarado ?? doc?.tamano),
    }));
}

function exigirTramitacion(tramitacion) {
  if (!tramitacion || typeof tramitacion !== 'object') throw new TypeError('Falta la tramitación');
  if (!Object.hasOwn(MARCAS, tramitacion.formulario)) throw new TypeError('Formulario no válido');
  return MARCAS[tramitacion.formulario];
}

const tieneValor = (v) => v !== undefined && v !== null && String(v).trim() !== '';

function filasAviso(t) {
  return [
    ['Referencia', t.ref],
    ['Comercial', t.comercial_nombre],
    ['Email Comercial', t.comercial_email],
    ['Compañía', t.compania],
    ['CUPS', t.cups],
    ['Tipo Suministro', t.tipo_suministro],
    ['Oferta', t.oferta],
    ['Tarifa', t.tarifa],
    ['Potencias', textoPotencias(t.potencias)],
    ['Titular / Razón Social', t.titular_nombre],
    ['CIF / NIF', t.titular_nif],
    ['Nombre Firmante', t.firmante_nombre],
    ['DNI Firmante', t.firmante_nif],
    ['Dir. Suministro', t.direccion],
    ['Código Postal', t.cp],
    ['Población', t.poblacion],
    ['Provincia', t.provincia],
    ['Móvil', t.telefono],
    ['Email Cliente', t.email_cliente],
    ['Cuenta Bancaria (IBAN)', t.iban],
    ['Cambio Titular', textoCambioTitular(t.cambio_titular)],
    ['Nuevo Titular', t.nuevo_titular],
    ['Observaciones', t.observaciones],
  ].filter(([, valor]) => tieneValor(valor));
}

function filasAcuse(t, fecha) {
  // Sin IBAN, sin DNI/NIF, sin teléfono ni email del cliente: el comercial no necesita verlos de vuelta.
  return [
    ['Referencia', t.ref],
    ['Fecha', fecha],
    ['Compañía', t.compania],
    ['CUPS', t.cups],
    ['Titular / Razón Social', t.titular_nombre],
    ['Oferta', t.oferta],
    ['Tarifa', t.tarifa],
  ].filter(([, valor]) => tieneValor(valor));
}

function tablaHtml(filas, c) {
  const celdas = filas.map(([etiqueta, valor]) => (
    '<tr>'
    + `<td style="padding:10px 14px;font-weight:600;color:${c.etiqueta};background:${c.fondoEtiqueta};border:1px solid #e2e8f0;width:36%;font-size:13px;vertical-align:top">${escapeHtml(etiqueta)}</td>`
    + `<td style="padding:10px 14px;border:1px solid #e2e8f0;font-size:13px;color:#111827;word-break:break-word">${escapeHtml(valor).replace(/\r?\n/g, '<br>')}</td>`
    + '</tr>'
  ));
  return `<table style="width:100%;border-collapse:collapse">${celdas.join('')}</table>`;
}

function listaDocumentosHtml(titulo, docs, c, conTamano) {
  if (docs.length === 0) return '';
  const items = docs.map((doc) => (
    conTamano
      ? `<li style="margin:8px 0;padding:10px 14px;background:${c.fondoLista};border:1px solid #e2e8f0;border-radius:8px;font-size:13px">`
        + `<span style="color:${c.destacado};font-weight:600">${escapeHtml(doc.nombre)}</span>`
        + (doc.tamano ? `<span style="color:${c.textoSuave};margin-left:8px">${escapeHtml(doc.tamano)}</span>` : '')
        + '</li>'
      : `<li style="margin:4px 0">${escapeHtml(doc.nombre)}</li>`
  ));
  const lista = conTamano
    ? `<ul style="list-style:none;padding:0;margin:0">${items.join('')}</ul>`
    : `<ul style="margin:0;padding-left:20px;font-size:13px;color:#374151">${items.join('')}</ul>`;
  return `<h3 style="color:${c.etiqueta};margin:24px 0 12px;font-size:15px">${escapeHtml(titulo)} (${docs.length})</h3>${lista}`;
}

function envolver(contenido) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + `<body style="margin:0;padding:0">${contenido}</body></html>`;
}

function cabeceraHtml(c, titulo, subtitulo) {
  return `<div style="background:${c.cabecera};color:#ffffff;padding:20px 24px;border-radius:10px 10px 0 0">`
    + `<h2 style="margin:0;font-size:18px">${escapeHtml(titulo)}</h2>`
    + `<p style="margin:6px 0 0;opacity:.85;font-size:13px">${escapeHtml(subtitulo)}</p>`
    + '</div>';
}

const esUrlHttp = (url) => typeof url === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(url.trim());

function textoFilas(filas) {
  return filas.map(([etiqueta, valor]) => `${etiqueta}: ${String(valor)}`).join('\n');
}

function textoDocumentos(titulo, docs, conTamano) {
  if (docs.length === 0) return '';
  const lineas = docs.map((doc) => `- ${doc.nombre}${conTamano && doc.tamano ? ` (${doc.tamano})` : ''}`);
  return `${titulo} (${docs.length}):\n${lineas.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Aviso a backoffice
// ---------------------------------------------------------------------------

/** Lo que se enseña de cada documento en el aviso: {nombre, tamano}. El tamaño sale de los bytes reales. */
const comoLista = (entradas) => entradas.map((e) => ({ nombre: enUnaLinea(e.nombre) || 'documento', tamano: tamanoTexto(e.bytes) }));

/** «contrato.pdf (5,50 MB), foto.jpg (2,10 MB)» (sin el tamaño si no se conoce). */
const enFrase = (docs) => docs.map((d) => (d.tamano ? `${d.nombre} (${d.tamano})` : d.nombre)).join(', ');

/**
 * Aviso a backoffice: todos los datos del contrato (IBAN completo incluido), la documentación ADJUNTA a este correo
 * (nombre y tamaño de cada adjunto), un aviso con lo que no cabe como adjunto y se queda en la bandeja, y SIEMPRE un
 * botón a la ficha de la bandeja.
 *   tramitacion  la fila de `tramitaciones`
 *   documentos   las filas de `tramitacion_documentos`
 *   seleccion    {adjuntos, fuera}: lo que de verdad lleva el correo (ver seleccionarAdjuntos; quien descarga los
 *                ficheros mueve a `fuera` los que no se han podido descargar). Si no se pasa, se supone que NO va
 *                nada adjunto y todos los documentos están «en la bandeja»
 *   urlFicha     https://…/bandeja/c/<ref>  (ver urlFichaDe)
 *   destino      el buzón al que el comercial debe mandar lo que falte (AVISO_DESTINO)
 * Devuelve {asunto, html, texto}.
 */
export function armarAviso({ tramitacion, documentos = [], seleccion, urlFicha, destino } = {}) {
  const marca = exigirTramitacion(tramitacion);
  const t = tramitacion;
  const c = marca.colores;
  const { adjuntos, fuera } = seleccion ?? seleccionarAdjuntos(documentos, { maxAdjuntos: 0 });
  const adjuntados = comoLista(adjuntos ?? []);
  const enBandeja = comoLista(fuera ?? []);
  const filas = filasAviso(t);
  const fecha = fechaMadrid(t.recibida_en ?? t.creada_en ?? new Date());
  const enlace = esUrlHttp(urlFicha) ? urlFicha.trim() : '';
  const correoComercial = enUnaLinea(t.comercial_email);
  const buzon = enUnaLinea(destino);

  const pieTexto = 'Al responder a este correo, la respuesta le llega directamente al comercial'
    + `${correoComercial ? ` (${correoComercial})` : ''}. `
    + 'El comercial recibe un acuse con la indicación de enviar cualquier documento adicional a '
    + `${buzon || 'tramitación'} citando la referencia.`;

  const franja = t.sospechosa === true
    ? '<div style="margin:0 0 16px;padding:12px 14px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;font-size:13px;color:#7F1D1D">'
      + '<strong>Este envío ha activado el filtro antibots: revísalo con cuidado</strong></div>'
    : '';

  const boton = enlace
    ? '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px auto 4px"><tr>'
      + `<td align="center" bgcolor="${c.cabecera}" style="background:${c.cabecera};border-radius:8px">`
      + `<a href="${escapeHtml(enlace)}" style="display:inline-block;padding:14px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">`
      + `${TEXTO_BOTON_BANDEJA}</a></td></tr></table>`
    : '';

  // Lo que no ha cabido como adjunto (o no se ha podido descargar) está en la bandeja
  const avisoBandeja = enBandeja.length > 0
    ? '<div style="margin-top:12px;padding:12px 14px;background:#FFF7ED;border:1px solid #FDBA74;border-radius:8px;font-size:13px;color:#7C2D12">'
      + `<strong>${TEXTO_NO_CABEN}</strong> ${escapeHtml(enFrase(enBandeja))}.</div>`
    : '';

  const pie = `<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:${c.textoSuave};line-height:1.5">`
    + `${escapeHtml(pieTexto)}<br>Aviso automático de tramitatucontrato.energy.</div>`;

  const html = envolver(
    '<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">'
    + cabeceraHtml(c, 'Nuevo contrato para tramitar', `${fecha} — Ref: ${t.ref ?? ''}`)
    + '<div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">'
    + franja
    + tablaHtml(filas, c)
    + listaDocumentosHtml(TITULO_ADJUNTOS, adjuntados, c, true)
    + avisoBandeja
    + boton
    + pie
    + '</div></div>',
  );

  const texto = [
    'NUEVO CONTRATO PARA TRAMITAR',
    `${fecha} — Ref: ${t.ref ?? ''}`,
    t.sospechosa === true ? '\nESTE ENVÍO HA ACTIVADO EL FILTRO ANTIBOTS: REVÍSALO CON CUIDADO' : '',
    '',
    textoFilas(filas),
    '',
    textoDocumentos(TITULO_ADJUNTOS, adjuntados, true),
    enBandeja.length > 0 ? `\n${TEXTO_NO_CABEN} ${enFrase(enBandeja)}.` : '',
    enlace ? `\n${TEXTO_BOTON_BANDEJA}: ${enlace}` : '',
    '',
    pieTexto,
    'Aviso automático de tramitatucontrato.energy.',
  ].filter((linea, i, todas) => !(linea === '' && todas[i - 1] === '')).join('\n');

  return { asunto: asuntoDe(t.formulario, t), html, texto };
}

// ---------------------------------------------------------------------------
// Acuse al comercial
// ---------------------------------------------------------------------------

/**
 * Acuse de recibo al comercial: referencia, resumen y documentos recibidos, y a dónde
 * escribir si falta algo. NO lleva IBAN, DNI/NIF ni enlace a la bandeja.
 *   destino  el buzón de tramitación (AVISO_DESTINO): el acuse sale con «responder a» = destino
 * Devuelve {asunto, html, texto}; el asunto es «Recibido: » + el del aviso (recortado a 200).
 */
export function armarAcuse({ tramitacion, documentos = [], destino } = {}) {
  const marca = exigirTramitacion(tramitacion);
  const t = tramitacion;
  const c = marca.colores;
  const docs = documentosOrdenados(documentos);
  const fecha = fechaMadrid(t.recibida_en ?? t.creada_en ?? new Date());
  const filas = filasAcuse(t, fecha);
  const nombre = enUnaLinea(t.comercial_nombre);
  const buzon = enUnaLinea(destino);
  const ref = enUnaLinea(t.ref);
  const saludo = `Hola${nombre ? ` ${nombre}` : ''}, hemos recibido tu contrato y la documentación. Ya está en manos del equipo de tramitación.`;
  const buzonHtml = buzon
    ? `<a href="mailto:${escapeHtml(buzon)}" style="color:${c.destacado};font-weight:600">${escapeHtml(buzon)}</a>`
    : 'el equipo de tramitación';
  const buzonTextoPlano = buzon || 'el equipo de tramitación';
  const despedida = `Correo automático de tramitatucontrato.energy (${marca.nombre}). Guarda la referencia para cualquier consulta.`;

  const html = envolver(
    '<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">'
    + cabeceraHtml(c, 'Contrato recibido', `Ref: ${ref}`)
    + '<div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;font-size:14px;color:#111827;line-height:1.5">'
    + `<p style="margin:0 0 16px">${escapeHtml(saludo)}</p>`
    + tablaHtml(filas, c)
    + listaDocumentosHtml('Documentación recibida', docs, c, false)
    + `<div style="margin-top:20px;padding:14px 16px;background:${c.fondoNota};border:1px solid ${c.bordeNota};border-radius:8px;font-size:13px">`
    + '<strong>¿Falta algo o quieres añadir documentación?</strong><br>'
    + `Si el equipo de tramitación necesita algún documento más (por ejemplo, la <strong>factura</strong>), te escribirá desde ${buzonHtml}. `
    + `Para enviar documentación adicional o preguntar por el estado, <strong>responde a este correo</strong> o escribe a ${buzonHtml} `
    + `indicando siempre la referencia <strong>${escapeHtml(ref)}</strong>.`
    + '</div>'
    + `<p style="margin:16px 0 0;font-size:12px;color:${c.textoSuave}">${escapeHtml(despedida)}</p>`
    + '</div></div>',
  );

  const texto = [
    'CONTRATO RECIBIDO',
    `Ref: ${ref}`,
    '',
    saludo,
    '',
    textoFilas(filas),
    '',
    textoDocumentos('Documentación recibida', docs, false),
    '',
    '¿Falta algo o quieres añadir documentación?',
    `Si el equipo de tramitación necesita algún documento más (por ejemplo, la factura), te escribirá desde ${buzonTextoPlano}. `
      + `Para enviar documentación adicional o preguntar por el estado, responde a este correo o escribe a ${buzonTextoPlano} `
      + `indicando siempre la referencia ${ref}.`,
    '',
    despedida,
  ].filter((linea, i, todas) => !(linea === '' && todas[i - 1] === '')).join('\n');

  return { asunto: ajustarAsunto(`Recibido: ${asuntoDe(t.formulario, t)}`), html, texto };
}

// ---------------------------------------------------------------------------
// Código de acceso a la bandeja
// ---------------------------------------------------------------------------

/**
 * Correo con el código de 6 cifras para entrar en la bandeja. Es solo texto (a Altavoz se le
 * manda únicamente `texto`; por eso `html` es null) y el código NO va en el asunto.
 */
export function armarCodigo(codigo) {
  const limpio = String(codigo ?? '').trim();
  if (!/^\d{6}$/.test(limpio)) throw new TypeError('El código debe tener 6 cifras');
  return {
    asunto: 'Tu código para entrar en la bandeja de tramitación',
    texto: `Tu código para entrar en la bandeja de tramitación es ${limpio}. Caduca en ${CODIGO_ACCESO.caducaMin} minutos. Si no lo has pedido tú, ignora este correo.`,
    html: null,
  };
}
