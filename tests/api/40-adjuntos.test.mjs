// tests/api/40-adjuntos.test.mjs · Pruebas de API de los adjuntos del aviso a backoffice (orden 6).
//
// Decisión de Victor (10-oct-2026): backoffice vuelve a recibir cada contrato por correo CON LA DOCUMENTACIÓN ADJUNTA (los
// topes de Altavoz: 10 ficheros y 3.000.000 bytes reales entre todos). Lo que no cabe, o no se puede descargar, se queda «en la
// bandeja»; y si Altavoz rechaza los adjuntos, el aviso sale igualmente, sin ellos, en el mismo intento.
//
// Necesita el servidor local en marcha y la base REAL de Supabase (todo lo que se escribe lleva prueba=true y vive bajo
// pruebas/ en el almacén; se borra con scripts/limpiar-pruebas.mjs --todo):
//
//   node tests/servidor-local.mjs &    →    node --test tests/api/40-adjuntos.test.mjs    →    node scripts/limpiar-pruebas.mjs --todo    →    kill <PID>
//
// Altavoz es SIEMPRE simulado: no sale ningún correo. Para ver qué adjuntos LLEVARÍA cada aviso (nombres, bytes y md5) se usa el
// gancho GET /__pruebas/correos del servidor local, que los apunta en memoria (el «espía» de tests/cartero-espia.mjs); por eso
// TODO se hace por HTTP contra ese servidor (confirmar, el vigilante, «volver a enviar»): una llamada a cola.js o a vigilante.js
// desde este proceso enviaría en este proceso y el espía no vería nada. Solo se usan alias de Victor (victor.molins.10+algo@gmail.com).
//
// Cada envío lleva un titular único, y el asunto del aviso lo lleva (en MAYÚSCULAS, como se guarda lo que escribe el comercial): así se
// encuentra su envío entre los que anota el espía.
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FORM_TOKENS, secretoBandeja } from '../../api/_lib/config.js';
import { carpetaDe, nonce } from '../../api/_lib/nombres.js';
import { NOMBRE_COOKIE, firmarSesion } from '../../api/_lib/sesion.js';
import { ErrorSupabase, actualizar, borrar, borrarObjetos, descargarObjeto, subirObjeto } from '../../api/_lib/supabase.js';
import { generarJpeg, generarPdf, generarPng } from '../fixtures/generar.mjs';
import { esperarAHermanosAnteriores } from './hermanos.mjs';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env.local', import.meta.url)));
} catch (error) {
  if (error?.code === 'ENOENT') throw new Error('Falta .env.local en la raíz del proyecto (punto de control A del diseño).');
  throw error;
}

const BASE = 'http://127.0.0.1:8765';
const TOPE_MS = 120_000;
const SECRETO = process.env.VIGILANTE_SECRETO; // nunca se imprime
const EMAIL_BANDEJA = String(process.env.BANDEJA_EMAILS ?? '').split(',')[0].trim().toLowerCase(); // un alias de Victor en pruebas

const EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com';
const EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com';
const IBAN = 'ES9121000418450200051332';
const IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332';
const CUPS = 'ES0021000000000001RK';
const MIB = 1024 * 1024;

// Comparten el servidor local y su entorno (Altavoz caído, rechazo por adjuntos…): esperan a los ficheros anteriores (00, 10, 20, 30)
before(() => esperarAHermanosAnteriores(import.meta.url), { timeout: 10 * 60_000 });

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function llamar(metodo, ruta, { cuerpo, cabeceras = {}, cookie } = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...cabeceras },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TOPE_MS),
  });
  const texto = await respuesta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    json = null;
  }
  return { status: respuesta.status, json, texto };
}

const post = (ruta, cuerpo, opciones) => llamar('POST', ruta, { cuerpo, ...opciones });
const get = (ruta, opciones) => llamar('GET', ruta, opciones);

const md5 = (datos) => createHash('md5').update(datos).digest('hex');
const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const azar = (n = 6) => Array.from({ length: n }, () => LETRAS[randomInt(LETRAS.length)]).join('');

function nuevaRef(formulario = 'gnew') {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // el mismo que generateRefId del html
  const hoy = new Date();
  const dia = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;
  return `${formulario === 'gnew' ? 'GNE' : 'MEGA'}-${dia}-${Array.from({ length: 6 }, () => alfabeto[randomInt(alfabeto.length)]).join('')}`;
}

function datosGnew(extra = {}) {
  return {
    quien_eres: 'Comercial de Prueba',
    email_comercial: EMAIL_COMERCIAL,
    compania: 'Compañía de Prueba',
    cups: CUPS,
    oferta: 'Fijo 12 meses',
    tarifa: '2.0TD',
    p1: '4,6', p2: '4,6', p3: '', p4: '', p5: '', p6: '',
    titular: 'Titular de Prueba SL',
    cif_nif: '00000000T',
    nombre_firmante: 'Firmante de Prueba',
    dni_firmante: '12345678Z',
    cuenta_bancaria: IBAN_TECLEADO,
    dir_suministro: 'Calle de Prueba 1, 2.º A',
    codigo_postal: '28001',
    poblacion: 'Madrid',
    provincia: 'Madrid',
    movil: '600000000',
    email_cliente: EMAIL_CLIENTE,
    cambio_titular: 'No',
    titular_anterior: '',
    observaciones: 'Prueba de adjuntos',
    terminos: true,
    ...extra,
  };
}

const documento = (orden, nombre, datos) => ({ orden, nombre, datos });
const FIRMA_PNG = generarPng();
const FIRMA = `data:image/png;base64,${FIRMA_PNG.toString('base64')}`;
/** Un JPEG pequeño pero DISTINTO de los demás (un byte de cola): así el md5 dice de qué documento se trata. */
const jpegUnico = (n) => Buffer.concat([generarJpeg(), Buffer.from([n & 0xff, (n >> 8) & 0xff])]);

async function subir(subida, datos) {
  const r = await fetch(subida.url, {
    method: 'PUT',
    headers: { Origin: BASE, 'Content-Type': subida.tipo_mime, 'x-upsert': 'true' },
    body: datos,
    signal: AbortSignal.timeout(TOPE_MS),
  });
  const texto = await r.text();
  assert.ok(r.status >= 200 && r.status < 300, `El PUT al almacén debe dar 2xx (dio ${r.status}): ${texto.slice(0, 120)}`);
}

// Todo lo que crea este fichero, para borrarlo al terminar
const refsDePrueba = [];

/**
 * Un envío completo: iniciar → subir → (algo opcional) → confirmar. Devuelve {ref, titular, id}. `titular` es único: sale en el
 * asunto del aviso y sirve para encontrarlo entre los envíos que anota el espía.
 */
async function enviar({ documentos, firma = FIRMA, etiqueta = 'X', antesDeConfirmar } = {}) {
  const titular = `Titular Adjuntos ${etiqueta} ${azar()} SL`;
  const ref = nuevaRef();
  refsDePrueba.push(ref);
  const r1 = await post('/api/tramitacion/iniciar', {
    formulario: 'gnew',
    token: FORM_TOKENS.gnew,
    ref,
    ref_anterior: null,
    hp: '',
    datos: datosGnew({ titular }),
    firma,
    archivos: documentos.map(({ orden, nombre, datos }) => ({ orden, nombre, tamano: datos.length })),
  });
  assert.equal(r1.status, 200, r1.texto);
  for (const s of r1.json.subidas) await subir(s, documentos.find((d) => d.orden === s.orden).datos);
  if (antesDeConfirmar) await antesDeConfirmar({ ref, titular });
  const r2 = await post('/api/tramitacion/confirmar', { formulario: 'gnew', token: FORM_TOKENS.gnew, ref });
  assert.equal(r2.status, 200, r2.texto);
  assert.equal(r2.json.listo, true);
  const estado = await estadoDe(ref);
  return { ref, titular, id: estado.tramitacion.id, estado };
}

async function estadoDe(ref) {
  const r = await get(`/__pruebas/tramitacion?ref=${ref}`);
  assert.equal(r.status, 200, `La tramitación ${ref} debe existir en la base de pruebas`);
  return r.json;
}

/**
 * Lo que el espía anotó de los envíos cuyo asunto lleva ese titular: [{adjuntos, resultado, tope, etiqueta…}] del más antiguo al más nuevo.
 * El asunto lleva el titular EN MAYÚSCULAS (lo que escribe el comercial se guarda así) y el espía filtra con `includes`, que distingue mayúsculas.
 */
async function enviosDe(titular, tipo) {
  const r = await get(`/__pruebas/correos?tipo=${tipo}&asunto=${encodeURIComponent(titular.toUpperCase())}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.espia, true, 'El servidor local debe tener el espía de Altavoz (Node 22.15 o más: module.registerHooks)');
  return r.json.envios;
}

const correoDe = (estado, tipo) => estado.correos.find((c) => c.tipo === tipo);
const tipos = (estado) => estado.eventos.map((e) => e.tipo);
const evento = (estado, tipo) => estado.eventos.filter((e) => e.tipo === tipo);
/** [{nombre, md5, bytes}] de los documentos de la prueba, para compararlos con lo que llevó cada adjunto. */
const huella = (nombre, datos) => ({ nombre, bytes: datos.length, md5: md5(datos) });
const sinCuerpo = (adjuntos) => adjuntos.map(({ nombre, bytes, md5: m }) => ({ nombre, bytes, md5: m }));

async function altavoz(cuerpo) {
  const r = await post('/__pruebas/altavoz', cuerpo);
  assert.equal(r.status, 200, r.texto);
}
const altavozCaido = (caido) => altavoz({ caido });
const rechazoPorAdjuntos = (rechazo_adjuntos) => altavoz({ rechazo_adjuntos });

const hace = (minutos) => new Date(Date.now() - minutos * 60_000).toISOString();
/** Les toca ya, y los primeros de la cola (el vigilante coge hasta 10 por pasada, los más antiguos primero). */
const vencer = (id) => actualizar('tramitacion_correos', { tramitacion_id: `eq.${id}`, estado: 'eq.pendiente' }, { proximo_intento: hace(180) });

/** Una pasada del vigilante, como la haría el cron. Devuelve el parte. */
async function vigilar() {
  const r = await post('/api/tramitacion/vigilante', {}, { cabeceras: { Authorization: `Bearer ${SECRETO}` } });
  assert.equal(r.status, 200, r.texto.slice(0, 300));
  assert.equal(r.json.ok, true);
  return r.json;
}

before(async () => {
  assert.equal(process.env.TRAMITACION_PRUEBA, '1', 'Estas pruebas solo corren en modo prueba');
  assert.equal(process.env.ALTAVOZ_SIMULAR, '1', 'La simulación es obligatoria');
  assert.ok(typeof SECRETO === 'string' && SECRETO.length >= 32, 'Falta VIGILANTE_SECRETO (32 caracteres o más) en .env.local');
  assert.match(EMAIL_BANDEJA, /^victor\.molins\.10\+[a-z0-9._-]+@gmail\.com$/, 'BANDEJA_EMAILS debe empezar por un alias de Victor en las pruebas');
  for (let intento = 0; intento < 40; intento++) {
    try {
      const r = await get('/__pruebas/correos?tipo=aviso');
      if (r.status === 200 && r.json?.ok) {
        assert.equal(r.json.espia, true, 'El servidor local no tiene el espía de Altavoz: hace falta Node 22.15 o más (module.registerHooks)');
        return;
      }
    } catch (error) {
      if (error?.name === 'AssertionError') throw error;
    }
    await new Promise((listo) => setTimeout(listo, 500));
  }
  throw new Error('El servidor local no responde en 127.0.0.1:8765: arráncalo con «node tests/servidor-local.mjs &».');
});

after(async () => {
  await altavozCaido(false); // quita cualquier fallo simulado que quedara puesto
  if (refsDePrueba.length > 0) await borrar('tramitaciones', { ref: `in.(${refsDePrueba.join(',')})`, prueba: 'eq.true' });
});

// ---------------------------------------------------------------------------
// 0 · descargarObjeto contra el almacén REAL
// ---------------------------------------------------------------------------

describe('Adjuntos · descargarObjeto contra el almacén real', { timeout: 120_000 }, () => {
  const carpeta = carpetaDe({ prueba: true, formulario: 'gnew', ref: nuevaRef(), nonce: nonce(10) });
  const rutaPdf = `${carpeta}/01.pdf`;
  const rutaPng = `${carpeta}/00.png`;
  const pdf = generarPdf(1_200_000);

  after(async () => {
    await borrarObjetos([rutaPdf, rutaPng]);
  });

  it('sube un PDF y una firma, los vuelve a bajar con la clave de servicio y son los MISMOS bytes', async () => {
    await subirObjeto(rutaPdf, pdf, 'application/pdf');
    await subirObjeto(rutaPng, FIRMA_PNG, 'image/png');
    const bajadoPdf = await descargarObjeto(rutaPdf, { maxBytes: pdf.length });
    const bajadoPng = await descargarObjeto(rutaPng);
    assert.ok(Buffer.isBuffer(bajadoPdf) && Buffer.isBuffer(bajadoPng));
    assert.equal(bajadoPdf.length, pdf.length);
    assert.equal(md5(bajadoPdf), md5(pdf));
    assert.equal(md5(bajadoPng), md5(FIRMA_PNG));
  });

  it('un objeto que no existe da un ErrorSupabase (Storage lo cuenta como 400 con el 404 dentro) y un tope diminuto, «tiempo»', async () => {
    await assert.rejects(() => descargarObjeto(`${carpeta}/99.pdf`), (error) => {
      assert.ok(error instanceof ErrorSupabase);
      assert.equal(error.statusInterno, 404);
      assert.ok(!error.message.includes(carpeta), 'el mensaje no lleva rutas');
      return true;
    });
    await assert.rejects(() => descargarObjeto(rutaPdf, { tope: 1 }), (error) => error instanceof ErrorSupabase && error.codigo === 'tiempo');
    await assert.rejects(() => descargarObjeto(rutaPdf, { maxBytes: 1000 }), (error) => error instanceof ErrorSupabase && error.codigo === 'tamano');
  });
});

// ---------------------------------------------------------------------------
// a-d · qué documentos van adjuntos
// ---------------------------------------------------------------------------

describe('Adjuntos · qué documentos lleva el aviso', { timeout: 600_000 }, () => {
  it('a) 3 documentos pequeños + firma → el aviso lleva 4 adjuntos, la firma la última y con el md5 de lo subido; el acuse, ninguno', async (t) => {
    const documentos = [
      documento(1, 'contrato.pdf', generarPdf(4096)),
      documento(2, 'dni.jpg', jpegUnico(2)),
      documento(3, 'factura.png', Buffer.concat([generarPng(), Buffer.from([3])])),
    ];
    const { ref, titular, estado } = await enviar({ documentos, etiqueta: 'A' });

    const [aviso] = await enviosDe(titular, 'aviso');
    assert.ok(aviso, 'El espía debe haber visto el aviso');
    assert.deepEqual([aviso.resultado.estado, aviso.resultado.http, aviso.resultado.simulado, aviso.resultado.rechazo_adjuntos], ['enviado', 200, true, false]);
    assert.deepEqual(sinCuerpo(aviso.adjuntos), [
      huella('contrato.pdf', documentos[0].datos), huella('dni.jpg', documentos[1].datos), huella('factura.png', documentos[2].datos), huella('firma.png', FIRMA_PNG),
    ], 'cuatro adjuntos: los documentos por su orden y la firma al final, con los mismos bytes que se subieron');
    assert.ok(aviso.bytes_adjuntos <= 3_000_000);
    assert.equal(aviso.bytes_adjuntos, aviso.adjuntos.reduce((s, a) => s + a.bytes, 0));
    assert.ok(aviso.tope <= 15_000 && aviso.tope >= 8_000, `el aviso se manda con lo que queda de sus 15 s (${aviso.tope} ms)`);

    // el cuerpo del aviso lo dice y lleva el botón a la bandeja
    const correo = correoDe(estado, 'aviso');
    assert.equal(correo.estado, 'enviado');
    assert.equal(correo.intentos, 1);
    assert.deepEqual(sinCuerpo(correo.adjuntos), sinCuerpo(aviso.adjuntos), 'el gancho enlaza cada correo de la base con su envío');
    assert.ok(correo.cuerpo_html.includes('Documentación adjunta a este correo (4)'));
    for (const nombre of ['contrato.pdf', 'dni.jpg', 'factura.png', 'firma.png']) assert.ok(correo.cuerpo_html.includes(nombre), nombre);
    assert.ok(correo.cuerpo_html.includes('Abrir en la bandeja') && correo.cuerpo_html.includes(`${BASE}/bandeja/c/${ref}`));
    assert.ok(correo.cuerpo_texto.includes(`Abrir en la bandeja: ${BASE}/bandeja/c/${ref}`));
    // la referencia es interna e invisible (16-oct-2026): solo está en la dirección del botón; el contrato se identifica por el CUPS
    for (const [formato, cuerpo] of [['html', correo.cuerpo_html], ['texto', correo.cuerpo_texto], ['asunto', aviso.asunto]]) {
      const visible = cuerpo.split(`${BASE}/bandeja/c/${ref}`).join('');
      assert.ok(!visible.includes(ref) && !/referencia|Ref:/i.test(visible), `el aviso (${formato}) no enseña la referencia fuera de la dirección del botón`);
    }
    assert.ok(correo.cuerpo_html.includes(`— CUPS ${CUPS}`), 'la cabecera del aviso lleva el CUPS');
    assert.ok(!correo.cuerpo_html.includes('No caben como adjunto'), 'todo cabe: ningún aviso de «no caben»');
    assert.ok(correo.cuerpo_html.includes(IBAN), 'el aviso sigue llevando el IBAN completo');

    // el acuse sale sin adjuntos y sin IBAN, con su tope de siempre en confirmar (6 s)
    const [acuse] = await enviosDe(titular, 'acuse');
    assert.deepEqual(acuse.adjuntos, []);
    assert.equal(acuse.tope, 6_000);
    assert.deepEqual([acuse.resultado.estado, acuse.resultado.http], ['enviado', 200]);
    const acuseFila = correoDe(estado, 'acuse');
    assert.ok(!acuseFila.cuerpo_html.includes('Documentación adjunta') && !acuseFila.cuerpo_html.includes(IBAN) && !acuseFila.cuerpo_html.includes('/bandeja/'));
    for (const [formato, cuerpo] of [['html', acuseFila.cuerpo_html], ['texto', acuseFila.cuerpo_texto], ['asunto', acuse.asunto]]) {
      assert.ok(!cuerpo.includes(ref) && !/referencia|Ref:/i.test(cuerpo), `el acuse (${formato}) no lleva la referencia`);
    }
    assert.ok(acuseFila.cuerpo_texto.includes(`indicando siempre el CUPS ${CUPS}.`), 'el acuse cita el CUPS');

    // el historial: los cinco eventos de siempre, sin nada nuevo en el camino feliz, y los recuentos en `aviso_enviado`
    assert.deepEqual(tipos(estado), ['creada', 'firma_guardada', 'recibida', 'aviso_enviado', 'acuse_enviado']);
    assert.deepEqual(evento(estado, 'aviso_enviado')[0].detalle, { intentos: 1, simulado: true, adjuntos: 4, en_bandeja: 0 });
    assert.deepEqual(evento(estado, 'acuse_enviado')[0].detalle, { intentos: 1, simulado: true });
    t.diagnostic(`${ref}: 4 adjuntos (${aviso.bytes_adjuntos} bytes), la firma la última, md5 idénticos; acuse sin adjuntos`);
  });

  it('b) un documento de 5,5 MB (el primero) + dos pequeños → el grande NO va adjunto y sale en «están en la bandeja»; los pequeños sí', async (t) => {
    const documentos = [
      documento(1, 'escritura grande.pdf', generarPdf()),
      documento(2, 'dni.jpg', jpegUnico(21)),
      documento(3, 'factura.png', Buffer.concat([generarPng(), Buffer.from([31])])),
    ];
    assert.equal(documentos[0].datos.length, 5.5 * MIB);
    const { ref, titular, estado } = await enviar({ documentos, etiqueta: 'B' });

    const [aviso] = await enviosDe(titular, 'aviso');
    assert.deepEqual(sinCuerpo(aviso.adjuntos), [
      huella('dni.jpg', documentos[1].datos), huella('factura.png', documentos[2].datos), huella('firma.png', FIRMA_PNG),
    ], 'los pequeños y la firma van adjuntos aunque el grande (el primero) no quepa');
    assert.ok(aviso.bytes_adjuntos < 3_000_000);
    const correo = correoDe(estado, 'aviso');
    assert.equal(correo.estado, 'enviado');
    assert.ok(correo.cuerpo_html.includes('Documentación adjunta a este correo (3)'));
    assert.ok(correo.cuerpo_html.includes('<strong>No caben como adjunto y están en la bandeja:</strong> escritura grande.pdf (5,50 MB).'));
    assert.ok(correo.cuerpo_texto.includes('No caben como adjunto y están en la bandeja: escritura grande.pdf (5,50 MB).'));
    const adjuntaTexto = correo.cuerpo_texto.slice(correo.cuerpo_texto.indexOf('Documentación adjunta'), correo.cuerpo_texto.indexOf('No caben'));
    assert.ok(!adjuntaTexto.includes('escritura grande'), 'el grande no aparece entre los adjuntos');
    assert.ok(correo.cuerpo_html.includes(`${BASE}/bandeja/c/${ref}`), 'y el botón a la bandeja está');
    assert.deepEqual(evento(estado, 'aviso_enviado')[0].detalle, { intentos: 1, simulado: true, adjuntos: 3, en_bandeja: 1 });
    t.diagnostic(`${ref}: el PDF de 5,5 MB se queda en la bandeja; 3 adjuntos (${aviso.bytes_adjuntos} bytes)`);
  });

  it('c) 12 documentos pequeños + firma → exactamente 10 adjuntos (los 10 primeros); el resto y la firma, «en la bandeja»', async (t) => {
    const documentos = Array.from({ length: 12 }, (_, i) => documento(i + 1, `doc${String(i + 1).padStart(2, '0')}.jpg`, jpegUnico(100 + i)));
    const { ref, titular, estado } = await enviar({ documentos, etiqueta: 'C' });

    const [aviso] = await enviosDe(titular, 'aviso');
    assert.equal(aviso.adjuntos.length, 10, 'como mucho 10 adjuntos EN TOTAL');
    assert.deepEqual(sinCuerpo(aviso.adjuntos), documentos.slice(0, 10).map((d) => huella(d.nombre, d.datos)));
    const correo = correoDe(estado, 'aviso');
    assert.equal(correo.estado, 'enviado');
    assert.ok(correo.cuerpo_html.includes('Documentación adjunta a este correo (10)'));
    assert.ok(correo.cuerpo_texto.includes('No caben como adjunto y están en la bandeja: doc11.jpg (370 B), doc12.jpg (370 B), firma.png (283 B).'));
    assert.deepEqual(evento(estado, 'aviso_enviado')[0].detalle, { intentos: 1, simulado: true, adjuntos: 10, en_bandeja: 3 });
    // los 13 documentos están en la base y en el almacén: nada se pierde por no ir adjunto
    assert.equal(estado.documentos.filter((d) => d.estado === 'subido').length, 13);
    t.diagnostic(`${ref}: 10 adjuntos de 13 documentos; doc11, doc12 y la firma, en la bandeja`);
  });

  it('d) dos documentos con el mismo nombre → nombres distintos en los adjuntos, con su extensión', async (t) => {
    const documentos = [
      documento(1, 'dni.jpg', jpegUnico(401)),
      documento(2, 'dni.jpg', jpegUnico(402)),
      documento(3, 'DNI.jpg', jpegUnico(403)),
      documento(4, 'firma.png', Buffer.concat([generarPng(), Buffer.from([4])])),
    ];
    const { titular, estado } = await enviar({ documentos, etiqueta: 'D' });

    const [aviso] = await enviosDe(titular, 'aviso');
    assert.deepEqual(sinCuerpo(aviso.adjuntos), [
      huella('dni.jpg', documentos[0].datos),
      huella('dni (2).jpg', documentos[1].datos),
      huella('DNI (3).jpg', documentos[2].datos),
      huella('firma.png', documentos[3].datos),
      huella('firma (2).png', FIRMA_PNG),
    ], 'cada documento conserva SU contenido (md5) y un nombre distinto; la firma de verdad no pisa a un documento llamado «firma.png»');
    assert.equal(new Set(aviso.adjuntos.map((a) => a.nombre.toLowerCase())).size, 5, 'ni siquiera distinguiendo mayúsculas hay dos iguales');
    assert.ok(aviso.adjuntos.every((a) => /\.(jpg|png)$/.test(a.nombre)), 'la extensión no se pierde');
    const correo = correoDe(estado, 'aviso');
    for (const nombre of ['dni (2).jpg', 'DNI (3).jpg', 'firma (2).png']) assert.ok(correo.cuerpo_html.includes(nombre), nombre);
    t.diagnostic('dni.jpg, dni (2).jpg, DNI (3).jpg, firma.png, firma (2).png');
  });
});

// ---------------------------------------------------------------------------
// e-f · lo que falla: la descarga y Altavoz
// ---------------------------------------------------------------------------

describe('Adjuntos · si algo falla, backoffice recibe el aviso igualmente', { timeout: 600_000 }, () => {
  it('e) un documento que no se puede descargar (no está en el almacén) o que no pesa lo comprobado → el aviso sale, con ese documento «en la bandeja», y queda el evento', async (t) => {
    const documentos = [
      documento(1, 'contrato.pdf', generarPdf(4096)),
      documento(2, 'dni.jpg', jpegUnico(502)),
      documento(3, 'factura.png', Buffer.concat([generarPng(), Buffer.from([53])])),
    ];
    await altavozCaido(true); // al confirmar no sale nada: el aviso queda pendiente y lo reintenta el vigilante cuando "se estropee" el almacén
    let enviado;
    try {
      enviado = await enviar({ documentos, etiqueta: 'E' });
    } finally {
      await altavozCaido(false);
    }
    const { ref, titular, id } = enviado;
    const previo = correoDe(enviado.estado, 'aviso');
    assert.deepEqual([previo.estado, previo.intentos], ['pendiente', 1], 'con Altavoz caído, el aviso queda pendiente');
    const doc = (orden) => enviado.estado.documentos.find((d) => d.orden === orden);

    // Se estropea lo que el servidor cree del almacén. NO se toca el objeto: el almacén sirve las descargas por un CDN que
    // guarda el objeto ya descargado hasta ~60 s aunque se borre o se cambie, y el primer intento (con Altavoz caído) ya lo bajó.
    //  · el 2.º documento «ya no está»: su clave apunta a un objeto que no existe (Storage: NoSuchKey)
    //  · el 3.º «pesa otra cosa»: el tamaño comprobado al confirmar ya no es el del objeto
    await actualizar('tramitacion_documentos', { id: `eq.${doc(2).id}` }, { ruta: `${enviado.estado.tramitacion.carpeta}/77.jpg` }, { devolver: false });
    await actualizar('tramitacion_documentos', { id: `eq.${doc(3).id}` }, { tamano_comprobado: Number(doc(3).tamano_comprobado) + 1 }, { devolver: false });

    await vencer(id);
    await vigilar();

    const e = await estadoDe(ref);
    const aviso = correoDe(e, 'aviso');
    assert.deepEqual([aviso.estado, aviso.intentos], ['enviado', 2], 'el aviso sale igual');
    const envios = await enviosDe(titular, 'aviso');
    assert.equal(envios.length, 2, 'el intento con Altavoz caído y el del vigilante');
    assert.deepEqual(sinCuerpo(envios[1].adjuntos), [huella('contrato.pdf', documentos[0].datos), huella('firma.png', FIRMA_PNG)],
      'solo los que sí se han descargado bien: el que no está y el que no pesa lo comprobado no van');
    assert.ok(aviso.cuerpo_html.includes('Documentación adjunta a este correo (2)'));
    assert.match(aviso.cuerpo_html, /<strong>No caben como adjunto y están en la bandeja:<\/strong> dni\.jpg \([^)]*\), factura\.png \([^)]*\)\./);
    // el evento, sin nombres de documentos ni datos personales
    const falloDescarga = evento(e, 'adjuntos_no_descargados');
    assert.equal(falloDescarga.length, 1, 'queda apuntado una vez (en el intento en que ocurrió)');
    assert.deepEqual(falloDescarga[0].detalle, { n: 2, ordenes: [2, 3], causas: ['no_existe', 'tamano'] });
    assert.equal(falloDescarga[0].actor, 'vigilante');
    for (const dato of ['dni.jpg', 'factura.png', 'contrato', EMAIL_COMERCIAL, EMAIL_CLIENTE, IBAN, titular, titular.toUpperCase()]) assert.ok(!JSON.stringify(e.eventos).includes(dato), `el historial no lleva «${dato}»`);
    assert.deepEqual(evento(e, 'aviso_enviado').at(-1).detalle, { intentos: 2, simulado: true, adjuntos: 2, en_bandeja: 2 });
    assert.ok(tipos(e).indexOf('adjuntos_no_descargados') < tipos(e).indexOf('aviso_enviado'), 'el apunte del fallo va antes de «aviso enviado»');
    t.diagnostic(`${ref}: sin dni.jpg (no está) ni factura.png (otro tamaño); el aviso sale con 2 adjuntos y 2 en la bandeja`);
  });

  it('f) Altavoz rechaza por los adjuntos (422) → en el MISMO intento se reenvía sin adjuntos: aviso enviado, un solo intento, evento', async (t) => {
    const documentos = [documento(1, 'contrato.pdf', generarPdf(4096)), documento(2, 'dni.jpg', jpegUnico(602))];
    await rechazoPorAdjuntos(true);
    let enviado;
    try {
      enviado = await enviar({ documentos, etiqueta: 'F' });
    } finally {
      await rechazoPorAdjuntos(false);
    }
    const { ref, titular, estado } = enviado;

    const envios = await enviosDe(titular, 'aviso');
    assert.equal(envios.length, 2, 'la primera llamada (con adjuntos) y el reintento (sin ellos)');
    assert.equal(envios[0].adjuntos.length, 3, 'la primera llevaba los 2 documentos y la firma');
    assert.deepEqual([envios[0].resultado.http, envios[0].resultado.rechazo_adjuntos, envios[0].resultado.simulado], [422, true, false], '422 sin código, como el de Altavoz por unos adjuntos');
    assert.deepEqual(envios[1].adjuntos, [], 'la segunda va sin adjuntos');
    assert.deepEqual([envios[1].resultado.http, envios[1].resultado.estado, envios[1].resultado.simulado], [200, 'enviado', true]);
    assert.ok(Date.parse(envios[1].cuando) >= Date.parse(envios[0].cuando));

    const aviso = correoDe(estado, 'aviso');
    assert.deepEqual([aviso.estado, aviso.intentos], ['enviado', 1], 'sigue siendo UN intento en la cuenta de la fila');
    assert.deepEqual(aviso.adjuntos, [], 'y el aviso que salió no lleva adjuntos');
    assert.ok(!aviso.cuerpo_html.includes('Documentación adjunta'), 'el cuerpo tampoco dice que lleve adjuntos');
    assert.ok(aviso.cuerpo_html.includes('<strong>No caben como adjunto y están en la bandeja:</strong> contrato.pdf'));
    for (const nombre of ['contrato.pdf', 'dni.jpg', 'firma.png']) assert.ok(aviso.cuerpo_texto.includes(nombre), `${nombre} está en la lista de «en la bandeja»`);
    assert.ok(aviso.cuerpo_html.includes(`${BASE}/bandeja/c/${ref}`));

    // el historial: el rechazo apuntado (sin nombres) justo antes de `aviso_enviado`, que dice que no fue ninguno adjunto
    assert.deepEqual(tipos(estado), ['creada', 'firma_guardada', 'recibida', 'adjuntos_rechazados', 'aviso_enviado', 'acuse_enviado']);
    assert.deepEqual(evento(estado, 'adjuntos_rechazados')[0].detalle, { http: 422, n: 3 });
    assert.deepEqual(evento(estado, 'aviso_enviado')[0].detalle, { intentos: 1, simulado: true, adjuntos: 0, en_bandeja: 3 });
    // el acuse no tiene nada que ver
    const acuses = await enviosDe(titular, 'acuse');
    assert.equal(acuses.length, 1);
    assert.deepEqual([acuses[0].adjuntos, acuses[0].resultado.estado], [[], 'enviado']);

    // y con el modo apagado, el siguiente aviso vuelve a llevar adjuntos
    const otro = await enviar({ documentos: [documento(1, 'otro.pdf', generarPdf(2048))], etiqueta: 'F2' });
    assert.equal((await enviosDe(otro.titular, 'aviso'))[0].adjuntos.length, 2);
    t.diagnostic(`${ref}: 422 por los adjuntos → reenvío sin adjuntos en el mismo intento; aviso enviado con 1 solo intento`);
  });
});

// ---------------------------------------------------------------------------
// g-h · cada intento vuelve a descargar y a adjuntar
// ---------------------------------------------------------------------------

describe('Adjuntos · cada intento (vigilante, «volver a enviar») regenera el cuerpo y vuelve a adjuntar', { timeout: 600_000 }, () => {
  it('g) el vigilante reintenta un aviso pendiente y vuelve a adjuntar los documentos (mismos md5, con sus topes: 15 s el aviso, 8 s el acuse)', async (t) => {
    const documentos = [
      documento(1, 'contrato.pdf', generarPdf(4096)),
      documento(2, 'dni.jpg', jpegUnico(702)),
      documento(3, 'factura.png', Buffer.concat([generarPng(), Buffer.from([73])])),
    ];
    await altavozCaido(true);
    let enviado;
    try {
      enviado = await enviar({ documentos, etiqueta: 'G' });
    } finally {
      await altavozCaido(false);
    }
    const { ref, titular, id } = enviado;
    assert.deepEqual(enviado.estado.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'pendiente', 1], ['aviso', 'pendiente', 1]]);

    await vencer(id);
    const parte = await vigilar();
    assert.ok(parte.reintentados >= 2 && parte.enviados >= 2, `el vigilante reintenta y envía (parte: ${parte.reintentados} reintentados, ${parte.enviados} enviados)`);

    const e = await estadoDe(ref);
    const aviso = correoDe(e, 'aviso');
    assert.deepEqual([aviso.estado, aviso.intentos, aviso.simulado], ['enviado', 2, true]);
    const esperados = [huella('contrato.pdf', documentos[0].datos), huella('dni.jpg', documentos[1].datos), huella('factura.png', documentos[2].datos), huella('firma.png', FIRMA_PNG)];
    const envios = await enviosDe(titular, 'aviso');
    assert.equal(envios.length, 2);
    assert.deepEqual(envios.map((x) => x.resultado.http), [503, 200], 'el intento con Altavoz caído y el del vigilante');
    assert.deepEqual(sinCuerpo(envios[0].adjuntos), esperados, 'el primer intento ya los descargó y los adjuntó…');
    assert.deepEqual(sinCuerpo(envios[1].adjuntos), esperados, '…y el del vigilante los vuelve a descargar: mismos nombres, mismos bytes, mismos md5');
    assert.deepEqual(sinCuerpo(aviso.adjuntos), esperados);
    assert.ok(aviso.cuerpo_html.includes('Documentación adjunta a este correo (4)'), 'el cuerpo se regenera con los adjuntos');
    assert.ok(envios[1].tope <= 15_000 && envios[1].tope >= 8_000, `el vigilante da al aviso hasta 15 s (${envios[1].tope} ms)`);
    const acuses = await enviosDe(titular, 'acuse');
    assert.deepEqual(acuses.map((x) => [x.adjuntos.length, x.resultado.http]), [[0, 503], [0, 200]]);
    assert.equal(acuses[1].tope, 8_000, 'el acuse, que no lleva adjuntos, sigue con 8 s');
    const avisoEnviado = evento(e, 'aviso_enviado');
    assert.deepEqual([avisoEnviado[0].actor, avisoEnviado[0].detalle], ['vigilante', { intentos: 2, simulado: true, adjuntos: 4, en_bandeja: 0 }]);
    t.diagnostic(`${ref}: intento 1 (Altavoz caído) y 2 (vigilante) con los mismos 4 adjuntos, md5 idénticos`);
  });

  it('h) «Volver a enviar» desde la bandeja reenvía el aviso CON adjuntos (y el acuse sin ellos)', async (t) => {
    const documentos = [documento(1, 'contrato.pdf', generarPdf(4096)), documento(2, 'dni.jpg', jpegUnico(802))];
    const { ref, titular, estado } = await enviar({ documentos, etiqueta: 'H' });
    const esperados = [huella('contrato.pdf', documentos[0].datos), huella('dni.jpg', documentos[1].datos), huella('firma.png', FIRMA_PNG)];
    assert.deepEqual(sinCuerpo((await enviosDe(titular, 'aviso'))[0].adjuntos), esperados);

    // la sesión de backoffice, firmada con el secreto de la bandeja (el mismo que usa el servidor local)
    const cookie = `${NOMBRE_COOKIE}=${firmarSesion(EMAIL_BANDEJA, secretoBandeja())}`;
    const r = await post('/api/bandeja/reenviar', { ref, tipo: 'aviso' }, { cookie });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, estado: 'enviado' });

    const envios = await enviosDe(titular, 'aviso');
    assert.equal(envios.length, 2, 'el de confirmar y el de «volver a enviar»');
    assert.deepEqual(sinCuerpo(envios[1].adjuntos), esperados, 'se vuelve a descargar y a adjuntar: mismos bytes y md5');
    assert.ok(envios[1].tope <= 15_000 && envios[1].tope >= 8_000, `«volver a enviar» da al aviso hasta 15 s (${envios[1].tope} ms)`);
    const e = await estadoDe(ref);
    const aviso = correoDe(e, 'aviso');
    assert.deepEqual([aviso.estado, aviso.intentos], ['enviado', 1], '«volver a enviar» deja los intentos a cero y este es el primero');
    assert.deepEqual(sinCuerpo(aviso.adjuntos), esperados);
    assert.notEqual(aviso.altavoz_id, correoDe(estado, 'aviso').altavoz_id, 'ha salido otra vez');
    assert.deepEqual(tipos(e).slice(-2), ['aviso_reenviado', 'aviso_enviado']);
    assert.deepEqual(evento(e, 'aviso_reenviado')[0].actor, EMAIL_BANDEJA);
    assert.deepEqual(evento(e, 'aviso_enviado').at(-1).detalle, { intentos: 1, simulado: true, adjuntos: 3, en_bandeja: 0 });

    // y el acuse reenviado sigue sin adjuntos
    const r2 = await post('/api/bandeja/reenviar', { ref, tipo: 'acuse' }, { cookie });
    assert.deepEqual(r2.json, { ok: true, estado: 'enviado' });
    const acuses = await enviosDe(titular, 'acuse');
    assert.deepEqual(acuses.map((x) => x.adjuntos.length), [0, 0]);
    assert.equal(acuses[1].tope, 8_000);
    t.diagnostic(`${ref}: «volver a enviar» el aviso → de nuevo 3 adjuntos con el mismo md5; el acuse, sin adjuntos`);
  });
});
