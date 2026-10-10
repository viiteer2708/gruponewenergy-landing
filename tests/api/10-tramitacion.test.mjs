// tests/api/10-tramitacion.test.mjs · Pruebas de API de Tramitación v2 (orden 2b): iniciar, confirmar, cola de correos.
//
// Necesita el servidor local en marcha y la base REAL de Supabase (todo lo que se escribe lleva prueba=true y vive bajo
// pruebas/ en el almacén; se borra con scripts/limpiar-pruebas.mjs --todo):
//
//   node tests/servidor-local.mjs &    →    node --test "tests/api/*.test.mjs"    →    node scripts/limpiar-pruebas.mjs --todo    →    kill <PID>
//
// Se «hace de navegador» con fetch: JSON a /api/tramitacion/*, y PUT directo a las URLs firmadas del almacén (sin
// clave, con Origin). El estado de la base se lee SIEMPRE por el gancho /__pruebas/tramitacion del servidor local.
// La segunda parte (cola de correos) llama a api/_lib/cola.js dentro de este mismo proceso: Altavoz es siempre simulado.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { enviarAviso, ErrorSimulacion } from '../../api/_lib/cartero.js';
import {
  atascados, conciliar, intentarEnvio, liberarCerrojos, reenviar, reintentarPendientes,
} from '../../api/_lib/cola.js';
import { FORM_TOKENS, LIMITES, supabaseUrl } from '../../api/_lib/config.js';
import { actualizar, borrar, insertar, seleccionar } from '../../api/_lib/supabase.js';
import { FRASES } from '../../api/_lib/validadores.js';
import { generarJpeg, generarPdf, generarPng } from '../fixtures/generar.mjs';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env.local', import.meta.url)));
} catch (error) {
  if (error?.code === 'ENOENT') throw new Error('Falta .env.local en la raíz del proyecto (punto de control A del diseño).');
  throw error;
}

const BASE = 'http://127.0.0.1:8765';
const TOPE_MS = 120_000;
const MIB = 1024 * 1024;

const AVISO_DESTINO = process.env.AVISO_DESTINO; // nunca se imprime
const EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com';
const EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com';
const IBAN = 'ES9121000418450200051332';
const IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332';
const DNI_TITULAR = '00000000T';
const DNI_FIRMANTE = '12345678Z';
const CUPS = 'ES0021000000000001RK';
const CUPS_OTRO = 'ES0021000000000002RE';
const CUPS_GAS = 'ES0031000000000003BS';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function llamar(metodo, ruta, { cuerpo, cabeceras = {}, tipo = 'application/json' } = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { ...(cuerpo !== undefined ? { 'Content-Type': tipo } : {}), ...cabeceras },
    body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    signal: AbortSignal.timeout(TOPE_MS),
  });
  const texto = await respuesta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    json = null;
  }
  return { status: respuesta.status, json, texto, cabeceras: respuesta.headers };
}

const post = (ruta, cuerpo, cabeceras) => llamar('POST', ruta, { cuerpo, cabeceras });

function nuevaRef(formulario = 'gnew') {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // el mismo que generateRefId del html
  let azar = '';
  for (let i = 0; i < 6; i++) azar += alfabeto[randomInt(alfabeto.length)];
  const hoy = new Date();
  const dia = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;
  return `${formulario === 'gnew' ? 'GNE' : 'MEGA'}-${dia}-${azar}`;
}

/** Datos del formulario GNEW tal como los teclea un comercial (con minúsculas, espacios y comas que el servidor normaliza). */
function datosGnew(extra = {}) {
  return {
    quien_eres: 'Comercial de Prueba',
    email_comercial: 'Victor.Molins.10+Comercial@gmail.com',
    compania: 'Compañía de Prueba',
    cups: 'es0021000000000001rk',
    oferta: 'Fijo 12 meses',
    tarifa: '2.0TD',
    p1: '4,6', p2: '4,6', p3: '', p4: '', p5: '', p6: '',
    titular: 'Titular de Prueba SL',
    cif_nif: '00000000-T',
    nombre_firmante: 'Firmante de Prueba',
    dni_firmante: DNI_FIRMANTE,
    cuenta_bancaria: IBAN_TECLEADO,
    dir_suministro: 'Calle de Prueba 1, 2.º A',
    codigo_postal: '28001',
    poblacion: 'Madrid',
    provincia: 'Madrid',
    movil: '600 000 000',
    email_cliente: EMAIL_CLIENTE,
    cambio_titular: 'No',
    nuevo_titular: '',
    observaciones: 'Línea 1\nLínea 2 con <b>etiqueta</b> & más',
    terminos: true,
    ...extra,
  };
}

function datosMega(extra = {}) {
  const { compania, ...base } = datosGnew({ cups: CUPS_GAS, tarifa: 'RL.1', oferta: 'Gas fijo', titular: 'Titular Mega de Prueba SL' });
  assert.ok(compania); // MEGA no pregunta la compañía
  return { ...base, ...extra };
}

/** Un documento de prueba: lo que sube el navegador (Buffer) y cómo se anuncia en `archivos`. */
const documento = (orden, nombre, datos, extra = {}) => ({ orden, nombre, datos, ...extra });
const anuncio = (documentos) => documentos.map(({ orden, nombre, datos, tamano_original: original }) => ({
  orden, nombre, tamano: datos.length, ...(original ? { tamano_original: original } : {}),
}));

const FIRMA = `data:image/png;base64,${generarPng().toString('base64')}`;

function entradaIniciar({ formulario = 'gnew', ref, refAnterior = null, datos, documentos, firma = FIRMA, ...extra }) {
  return {
    formulario,
    token: FORM_TOKENS[formulario],
    ref,
    ref_anterior: refAnterior,
    hp: '',
    datos: datos ?? (formulario === 'gnew' ? datosGnew() : datosMega()),
    firma,
    archivos: anuncio(documentos),
    ...extra,
  };
}

const iniciar = (entrada, cabeceras) => post('/api/tramitacion/iniciar', entrada, cabeceras);
const confirmar = (ref, formulario = 'gnew', cabeceras) => post('/api/tramitacion/confirmar', { formulario, token: FORM_TOKENS[formulario], ref }, cabeceras);

/** PUT directo al almacén, como el navegador: Content-Type del tipo anunciado, x-upsert, Origin y NINGUNA clave. */
async function subir(subida, datos, tipo = subida.tipo_mime) {
  const respuesta = await fetch(subida.url, {
    method: 'PUT',
    headers: { Origin: BASE, 'Content-Type': tipo, 'x-upsert': 'true' },
    body: datos,
    signal: AbortSignal.timeout(TOPE_MS),
  });
  const texto = await respuesta.text();
  assert.ok(respuesta.status >= 200 && respuesta.status < 300, `El PUT al almacén debe dar 2xx (dio ${respuesta.status}): ${texto.slice(0, 160)}`);
}

async function subirTodo(subidas, documentos) {
  for (const subida of subidas) {
    if (subida.ya_subido) continue;
    await subir(subida, documentos.find((d) => d.orden === subida.orden).datos);
  }
}

async function estadoDe(ref) {
  const r = await llamar('GET', `/__pruebas/tramitacion?ref=${ref}`);
  assert.equal(r.status, 200, `La tramitación ${ref} debe existir en la base de pruebas`);
  return r.json;
}

async function existe(ref) {
  return (await llamar('GET', `/__pruebas/tramitacion?ref=${ref}`)).status === 200;
}

async function cambiarEntorno(cambios) {
  const r = await post('/__pruebas/env', cambios);
  assert.equal(r.status, 200, 'El gancho de entorno debe aceptar la variable');
  return r.json.previo;
}

/** Envío completo hasta «listo»: iniciar → subir → confirmar. Devuelve el estado de la base. */
async function enviarCompleto({ formulario = 'gnew', datos, documentos, firma = FIRMA } = {}) {
  const ref = nuevaRef(formulario);
  const r1 = await iniciar(entradaIniciar({ formulario, ref, datos, documentos, firma }));
  assert.equal(r1.status, 200, r1.texto);
  await subirTodo(r1.json.subidas, documentos);
  const r2 = await confirmar(ref, formulario);
  assert.equal(r2.status, 200, r2.texto);
  assert.equal(r2.json.listo, true);
  return { ref, estado: await estadoDe(ref) };
}

const PEQUENOS = () => [documento(1, 'dni.jpg', generarJpeg()), documento(2, 'factura.png', generarPng())];
const tipos = (estado) => estado.eventos.map((e) => e.tipo);
const correoDe = (estado, tipo) => estado.correos.find((c) => c.tipo === tipo);
const sinEspacios = (texto) => String(texto).replace(/\s+/g, '');

// ---------------------------------------------------------------------------
// Parte 1 · iniciar y confirmar por HTTP
// ---------------------------------------------------------------------------

describe('Tramitación v2 · iniciar y confirmar', { timeout: 900_000 }, () => {
  before(async () => {
    assert.ok(AVISO_DESTINO, 'AVISO_DESTINO debe estar en .env.local');
    for (let intento = 0; intento < 40; intento++) {
      try {
        const r = await llamar('GET', '/__pruebas/correos?tipo=aviso');
        if (r.status === 200 && r.json?.ok) return;
      } catch {
        // el servidor aún no ha arrancado
      }
      await esperar(500);
    }
    throw new Error('El servidor local no responde en 127.0.0.1:8765: arráncalo con «node tests/servidor-local.mjs &».');
  });

  it('envío completo: 3 archivos (uno de 5,5 MiB) + firma → listo, recibida, 4 documentos subidos, aviso y acuse simulados', async (t) => {
    const documentos = [
      documento(1, 'contrato.pdf', generarPdf()),
      documento(2, 'dni.jpg', generarJpeg()),
      documento(3, 'factura.png', generarPng()),
    ];
    const ref = nuevaRef();
    const r1 = await iniciar(entradaIniciar({ ref, documentos }));
    assert.equal(r1.status, 200, r1.texto);
    assert.deepEqual([r1.json.ok, r1.json.ref, r1.json.estado, r1.json.listo], [true, ref, 'subiendo', false]);
    assert.equal(r1.json.subidas.length, 3);
    const prefijo = `${supabaseUrl()}/storage/v1/object/upload/sign/tramitaciones/pruebas/gnew/`;
    for (const s of r1.json.subidas) {
      assert.ok(s.url.startsWith(prefijo) && s.url.includes('?token='), 'La URL debe ser absoluta, del almacén y con token');
      assert.ok(!/contrato|dni|factura/.test(s.url), 'El nombre original no puede ir en la URL ni en la clave del objeto');
      assert.equal(s.ya_subido, false);
    }
    assert.deepEqual(r1.json.subidas.map((s) => [s.orden, s.nombre, s.tipo_mime]), [
      [1, 'contrato.pdf', 'application/pdf'], [2, 'dni.jpg', 'image/jpeg'], [3, 'factura.png', 'image/png'],
    ]);

    await subirTodo(r1.json.subidas, documentos);
    const r2 = await confirmar(ref);
    assert.equal(r2.status, 200, r2.texto);
    assert.deepEqual([r2.json.ok, r2.json.listo, r2.json.estado, r2.json.ref], [true, true, 'recibida', ref]);

    const e = await estadoDe(ref);
    // la fila
    const f = e.tramitacion;
    assert.equal(f.estado, 'recibida');
    assert.equal(f.prueba, true);
    assert.equal(f.sospechosa, false);
    assert.ok(f.recibida_en);
    assert.equal(f.cups, CUPS, 'El CUPS se guarda en mayúsculas y compacto');
    assert.equal(f.iban, IBAN, 'El IBAN se guarda compacto');
    assert.equal(f.titular_nif, DNI_TITULAR);
    assert.equal(f.comercial_email, EMAIL_COMERCIAL, 'El email del comercial se guarda en minúsculas');
    assert.deepEqual(f.potencias, { p1: '4.6', p2: '4.6' }, 'Las potencias: coma → punto y solo las rellenas');
    assert.match(f.ip_hash, /^[0-9a-f]{32}$/, 'Se guarda el HMAC de la IP, nunca la IP');
    assert.ok(!JSON.stringify(f).includes('127.0.0.1'));
    assert.match(f.carpeta, new RegExp(`^pruebas/gnew/\\d{4}/\\d{2}/${ref}-[a-z2-7]{10}$`));
    assert.ok(f.busqueda.includes('titular de prueba') && f.busqueda.includes(ref.toLowerCase()) && f.busqueda.includes('compania de prueba'));
    // los documentos: orden 0 = firma
    assert.deepEqual(e.documentos.map((d) => d.orden), [0, 1, 2, 3]);
    for (const d of e.documentos) {
      assert.equal(d.estado, 'subido');
      assert.equal(Number(d.tamano_comprobado), Number(d.tamano_declarado), `El documento ${d.orden} debe tener el tamaño comprobado`);
      assert.ok(d.subido_en);
      assert.match(d.ruta, new RegExp(`^${f.carpeta}/0${d.orden}\\.(png|pdf|jpg)$`), 'La clave del objeto es <carpeta>/NN.ext');
    }
    assert.deepEqual(e.documentos.map((d) => [d.nombre, d.tipo_mime, d.es_firma]), [
      ['firma.png', 'image/png', true], ['contrato.pdf', 'application/pdf', false], ['dni.jpg', 'image/jpeg', false], ['factura.png', 'image/png', false],
    ]);
    assert.equal(Number(e.documentos[1].tamano_comprobado), documentos[0].datos.length);
    assert.equal(Number(e.documentos[0].tamano_comprobado), generarPng().length);

    // los correos
    const asunto = `Nuevo Contrato - Compañía de Prueba - Titular de Prueba SL - Comercial de Prueba - ${CUPS}`;
    const aviso = correoDe(e, 'aviso');
    const acuse = correoDe(e, 'acuse');
    for (const c of [aviso, acuse]) {
      assert.equal(c.estado, 'enviado');
      assert.equal(c.simulado, true);
      assert.match(c.altavoz_id, /^simulado-\d+$/);
      assert.equal(c.intentos, 1);
      assert.equal(c.marca, 'GNEW');
      assert.ok(c.enviado_en);
    }
    assert.equal(aviso.asunto, asunto);
    assert.equal(aviso.para, AVISO_DESTINO);
    assert.equal(aviso.responder_a, EMAIL_COMERCIAL);
    assert.equal(aviso.etiqueta, 'tramitacion-aviso');
    assert.ok(aviso.cuerpo_html.includes(IBAN), 'El aviso lleva el IBAN completo');
    assert.ok(aviso.cuerpo_texto.includes(IBAN));
    assert.ok(aviso.cuerpo_html.includes(`${BASE}/bandeja/c/${ref}`), 'El aviso lleva el botón a la ficha de la bandeja');
    assert.ok(aviso.cuerpo_html.includes('Abrir en la bandeja'), 'El botón a la bandeja (con adjuntos o sin ellos)');
    assert.ok(!aviso.cuerpo_html.includes('Ver y descargar la documentación'), 'El texto antiguo del botón ya no está');
    for (const nombre of ['contrato.pdf', 'dni.jpg', 'factura.png', 'firma.png']) assert.ok(aviso.cuerpo_html.includes(nombre), `El aviso lista ${nombre}`);
    // Orden 6: el PDF de 5,5 MiB no cabe como adjunto (el tope es de 3.000.000 bytes) y se queda en la bandeja; lo demás va adjunto
    assert.ok(aviso.cuerpo_html.includes('Documentación adjunta a este correo (3)'), 'dni.jpg, factura.png y la firma van adjuntos');
    assert.ok(aviso.cuerpo_html.includes('No caben como adjunto y están en la bandeja:</strong> contrato.pdf (5,50 MB).'), 'El PDF grande se queda en la bandeja');
    assert.ok(aviso.cuerpo_html.includes('&lt;b&gt;etiqueta&lt;/b&gt;') && !aviso.cuerpo_html.includes('<b>etiqueta</b>'), 'Lo que teclea el comercial va escapado');
    assert.equal(acuse.asunto, `Recibido: ${asunto}`);
    assert.equal(acuse.para, EMAIL_COMERCIAL);
    assert.equal(acuse.responder_a, AVISO_DESTINO);
    assert.equal(acuse.etiqueta, 'tramitacion-acuse');
    assert.ok(acuse.cuerpo_html.includes(ref) && acuse.cuerpo_texto.includes(ref));
    for (const prohibido of [IBAN, 'ES91', DNI_TITULAR, DNI_FIRMANTE, '/bandeja/', EMAIL_CLIENTE]) {
      assert.ok(!sinEspacios(acuse.cuerpo_html).includes(prohibido) && !sinEspacios(acuse.cuerpo_texto).includes(prohibido), `El acuse no puede llevar ${prohibido === IBAN ? 'el IBAN' : prohibido}`);
    }

    // el historial: en orden y sin datos personales
    assert.deepEqual(tipos(e), ['creada', 'firma_guardada', 'recibida', 'aviso_enviado', 'acuse_enviado']);
    const recibida = e.eventos.find((x) => x.tipo === 'recibida');
    assert.deepEqual(recibida.detalle, { n_documentos: 4, bytes: e.documentos.reduce((s, d) => s + Number(d.tamano_comprobado), 0) });
    const historial = JSON.stringify(e.eventos);
    for (const dato of [IBAN, EMAIL_COMERCIAL, EMAIL_CLIENTE, DNI_TITULAR, 'Titular de Prueba']) assert.ok(!historial.includes(dato), 'El historial no lleva datos personales');

    // el gancho de correos ve el aviso simulado
    const g = await llamar('GET', `/__pruebas/correos?para=${encodeURIComponent(AVISO_DESTINO)}&tipo=aviso`);
    assert.equal(g.status, 200);
    assert.ok(g.json.correos.length <= 5 && g.json.correos.some((c) => c.cuerpo_html?.includes(ref)), 'El gancho /__pruebas/correos debe devolver el aviso con su cuerpo');
    t.diagnostic(`${ref}: 4 documentos subidos (${recibida.detalle.bytes} bytes), aviso y acuse simulados, eventos ${tipos(e).join(' > ')}`);
  });

  it('idempotencia: iniciar y confirmar repetidos con la misma ref → listo, una sola fila, un solo aviso y un solo acuse', async () => {
    const documentos = PEQUENOS();
    const { ref, estado: antes } = await enviarCompleto({ documentos });
    const entrada = entradaIniciar({ ref, documentos });
    for (let i = 0; i < 2; i++) {
      const r = await iniciar(entrada);
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.ok, r.json.listo, r.json.estado, r.json.subidas], [true, true, 'recibida', undefined]);
    }
    for (let i = 0; i < 2; i++) {
      const r = await confirmar(ref);
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.ok, r.json.listo, r.json.estado], [true, true, 'recibida']);
    }
    const despues = await estadoDe(ref);
    assert.equal(despues.tramitacion.id, antes.tramitacion.id, 'Es la misma fila');
    assert.equal(despues.correos.length, 2);
    assert.deepEqual(tipos(despues), ['creada', 'firma_guardada', 'recibida', 'aviso_enviado', 'acuse_enviado'], 'Ningún evento ni correo nuevo');
    assert.deepEqual(despues.correos.map((c) => [c.tipo, c.intentos, c.id]), antes.correos.map((c) => [c.tipo, c.intentos, c.id]));
  });

  it('confirmar sin subir → 409 faltan_archivos; con un tamaño que no es el declarado → tamano_distinto; tras subir bien → listo', async (t) => {
    const documentos = PEQUENOS();
    const ref = nuevaRef();
    const r1 = await iniciar(entradaIniciar({ ref, documentos, firma: '' }));
    assert.equal(r1.status, 200, r1.texto);
    assert.equal(r1.json.subidas.length, 2);

    // nada subido
    let c = await confirmar(ref);
    assert.equal(c.status, 409);
    assert.deepEqual([c.json.ok, c.json.codigo, c.json.retryable], [false, 'faltan_archivos', true]);
    assert.deepEqual(c.json.faltan, [
      { orden: 1, nombre: 'dni.jpg', motivo: 'no_subido' }, { orden: 2, nombre: 'factura.png', motivo: 'no_subido' },
    ]);
    assert.equal((await estadoDe(ref)).tramitacion.estado, 'subiendo');

    // solo el 2.º, bien
    await subir(r1.json.subidas[1], documentos[1].datos);
    c = await confirmar(ref);
    assert.equal(c.status, 409);
    assert.deepEqual(c.json.faltan, [{ orden: 1, nombre: 'dni.jpg', motivo: 'no_subido' }]);

    // el 1.º con un tamaño que no es el declarado (el almacén lo acepta: es un JPEG de otro peso)
    await subir(r1.json.subidas[0], Buffer.concat([documentos[0].datos, Buffer.from([0, 0, 0])]));
    c = await confirmar(ref);
    assert.equal(c.status, 409);
    assert.deepEqual(c.json.faltan, [{ orden: 1, nombre: 'dni.jpg', motivo: 'tamano_distinto' }]);

    // `iniciar` da URL solo de lo que falta
    const r2 = await iniciar(entradaIniciar({ ref, documentos, firma: '' }));
    assert.equal(r2.status, 200, r2.texto);
    const [primera, segunda] = r2.json.subidas;
    assert.equal(primera.ya_subido, false);
    assert.ok(primera.url?.includes('?token='), 'El que tiene mal el tamaño vuelve a recibir URL');
    assert.equal(segunda.ya_subido, true);
    assert.equal(segunda.url, null, 'El que ya está completo no lleva URL');

    await subirTodo(r2.json.subidas, documentos);
    c = await confirmar(ref);
    assert.equal(c.status, 200, c.texto);
    assert.equal(c.json.listo, true);
    const e = await estadoDe(ref);
    assert.equal(e.tramitacion.estado, 'recibida');
    assert.deepEqual(e.documentos.map((d) => d.orden), [1, 2], 'Sin firma: solo los dos archivos');
    assert.ok(e.documentos.every((d) => d.estado === 'subido' && Number(d.tamano_comprobado) === Number(d.tamano_declarado)));
    assert.deepEqual(e.correos.map((x) => x.estado), ['enviado', 'enviado']);
    t.diagnostic('409 no_subido → 409 no_subido (parcial) → 409 tamano_distinto → iniciar con URL solo del que falta → 200 listo');
  });

  it('lista distinta con la misma referencia → 409 lista_distinta, y la fila no se toca', async () => {
    const ref = nuevaRef();
    const base = [documento(1, 'dni.jpg', generarJpeg())];
    assert.equal((await iniciar(entradaIniciar({ ref, documentos: base }))).status, 200);

    const masArchivos = await iniciar(entradaIniciar({ ref, documentos: [...base, documento(2, 'factura.png', generarPng())], datos: datosGnew({ titular: 'Otro Titular SL' }) }));
    assert.equal(masArchivos.status, 409, masArchivos.texto);
    assert.deepEqual([masArchivos.json.ok, masArchivos.json.codigo], [false, 'lista_distinta']);

    const otroTamano = await iniciar(entradaIniciar({ ref, documentos: [documento(1, 'dni.jpg', Buffer.concat([generarJpeg(), Buffer.from([1])]))] }));
    assert.equal(otroTamano.status, 409, otroTamano.texto);
    const otroNombre = await iniciar(entradaIniciar({ ref, documentos: [documento(1, 'otro.jpg', generarJpeg())] }));
    assert.equal(otroNombre.status, 409, otroNombre.texto);

    const e = await estadoDe(ref);
    assert.equal(e.documentos.filter((d) => d.orden >= 1).length, 1);
    assert.equal(e.tramitacion.titular_nombre, 'Titular de Prueba SL', 'Un 409 no cambia los datos');
    assert.deepEqual(tipos(e), ['creada', 'firma_guardada']);
  });

  it('ref_anterior → la vieja queda abandonada (si es del mismo comercial) y `iniciar` sobre ella la reanuda', async () => {
    const refA = nuevaRef();
    const refB = nuevaRef();
    const refC = nuevaRef();
    const listaA = [documento(1, 'dni.jpg', generarJpeg())];
    const listaB = [documento(1, 'dni.jpg', generarJpeg()), documento(2, 'factura.png', generarPng())];

    assert.equal((await iniciar(entradaIniciar({ ref: refA, documentos: listaA }))).status, 200);
    const b = await iniciar(entradaIniciar({ ref: refB, refAnterior: refA, documentos: listaB }));
    assert.equal(b.status, 200, b.texto);
    assert.equal(b.json.estado, 'subiendo');

    let a = await estadoDe(refA);
    assert.equal(a.tramitacion.estado, 'abandonada');
    const abandono = a.eventos.find((x) => x.tipo === 'abandonada');
    assert.deepEqual(abandono.detalle, { motivo: 'lista_cambiada', nueva_ref: refB });
    assert.equal((await estadoDe(refB)).tramitacion.estado, 'subiendo');

    // otra persona (otro email) no puede abandonar el envío ajeno
    const c = await iniciar(entradaIniciar({ ref: refC, refAnterior: refB, documentos: listaA, datos: datosGnew({ email_comercial: 'victor.molins.10+otro@gmail.com' }) }));
    assert.equal(c.status, 200, c.texto);
    assert.equal((await estadoDe(refB)).tramitacion.estado, 'subiendo', 'Un envío de otro comercial no se abandona');

    // una referencia anterior igual a la nueva se ignora
    assert.equal((await iniciar(entradaIniciar({ ref: refB, refAnterior: refB, documentos: listaB }))).status, 200);
    assert.equal((await estadoDe(refB)).tramitacion.estado, 'subiendo');

    // iniciar sobre la abandonada: se reanuda (con su misma lista)
    const reanudada = await iniciar(entradaIniciar({ ref: refA, documentos: listaA, datos: datosGnew({ observaciones: 'Reanudada con una nota nueva' }) }));
    assert.equal(reanudada.status, 200, reanudada.texto);
    assert.deepEqual([reanudada.json.estado, reanudada.json.listo, reanudada.json.subidas.length], ['subiendo', false, 1]);
    a = await estadoDe(refA);
    assert.equal(a.tramitacion.estado, 'subiendo');
    assert.equal(a.tramitacion.observaciones, 'Reanudada con una nota nueva', 'Al reanudar se guardan los datos actuales');
    assert.deepEqual(tipos(a), ['creada', 'firma_guardada', 'abandonada', 'reanudada']);

    // y una abandonada con una lista distinta no se reanuda
    const refD = nuevaRef();
    const refE = nuevaRef();
    await iniciar(entradaIniciar({ ref: refD, documentos: listaA }));
    await iniciar(entradaIniciar({ ref: refE, refAnterior: refD, documentos: listaB }));
    const distinta = await iniciar(entradaIniciar({ ref: refD, documentos: listaB }));
    assert.equal(distinta.status, 409);
    assert.equal((await estadoDe(refD)).tramitacion.estado, 'abandonada');
  });

  it('token incorrecto → 401, sin crear nada (iniciar y confirmar)', async () => {
    const documentos = PEQUENOS();
    const ref = nuevaRef();
    const base = entradaIniciar({ ref, documentos });
    for (const token of ['no-es-el-token', FORM_TOKENS.mega, '', undefined, 12345]) {
      const r = await iniciar({ ...base, token });
      assert.equal(r.status, 401, `token ${JSON.stringify(token)}`);
      assert.deepEqual([r.json.ok, r.json.codigo, r.json.retryable], [false, 'no_autorizado', false]);
      assert.match(r.json.mensaje, /Recarga la página/);
    }
    assert.equal((await iniciar({ ...base, formulario: 'otro' })).status, 401);
    assert.equal((await post('/api/tramitacion/confirmar', { formulario: 'gnew', token: 'mal', ref })).status, 401);
    assert.equal(await existe(ref), false, 'Sin token no se crea nada');
  });

  it('honeypot → 200 listo (éxito falso), fila descartada, sin documentos ni correos; también con cuerpo mínimo de bot', async () => {
    const ref = nuevaRef();
    const r = await iniciar(entradaIniciar({ ref, documentos: PEQUENOS(), hp: 'http://spam.example' }));
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual([r.json.ok, r.json.listo, r.json.estado, r.json.ref], [true, true, 'recibida', ref]);
    let e = await estadoDe(ref);
    assert.equal(e.tramitacion.estado, 'descartada');
    assert.equal(e.tramitacion.sospechosa, true);
    assert.deepEqual([e.documentos, e.correos], [[], []]);
    assert.deepEqual(tipos(e), ['descartada']);

    // un bot sin datos: las columnas NOT NULL no pueden romper el éxito falso
    const refBot = nuevaRef();
    const minimo = await iniciar({ formulario: 'gnew', token: FORM_TOKENS.gnew, ref: refBot, hp: 'x', datos: {}, archivos: [] });
    assert.equal(minimo.status, 200, minimo.texto);
    assert.equal(minimo.json.listo, true);
    e = await estadoDe(refBot);
    assert.equal(e.tramitacion.estado, 'descartada');
    assert.equal(e.tramitacion.cups, '');

    // un bot con una referencia inventada recibe una válida
    const inventada = await iniciar({ formulario: 'mega', token: FORM_TOKENS.mega, ref: 'basura', hp: 'x' });
    assert.equal(inventada.status, 200, inventada.texto);
    assert.match(inventada.json.ref, /^MEGA-\d{8}-[A-Z0-9]{6}$/);
    assert.equal((await estadoDe(inventada.json.ref)).tramitacion.estado, 'descartada');

    // si el bot llega a confirmar, también éxito falso y siguen sin correos
    const c = await confirmar(ref);
    assert.equal(c.status, 200, c.texto);
    assert.equal(c.json.listo, true);
    assert.deepEqual((await estadoDe(ref)).correos, []);
  });

  it('CUPS malo → 400 datos con campos.cups (y los demás errores a la vez), sin crear nada', async () => {
    const ref = nuevaRef();
    const r = await iniciar(entradaIniciar({ ref, documentos: PEQUENOS(), datos: datosGnew({ cups: 'ES0000000000000000XX' }) }));
    assert.equal(r.status, 400, r.texto);
    assert.deepEqual([r.json.ok, r.json.codigo, r.json.retryable], [false, 'datos', false]);
    assert.deepEqual(r.json.campos, { cups: FRASES.cups });
    assert.equal(await existe(ref), false);

    const varios = await iniciar(entradaIniciar({
      ref: nuevaRef(),
      documentos: PEQUENOS(),
      datos: datosGnew({ cuenta_bancaria: 'ES00 0000', movil: '123', email_cliente: 'no-es-email', terminos: false, titular: '' }),
    }));
    assert.equal(varios.status, 400);
    assert.deepEqual(Object.keys(varios.json.campos).sort(), ['cuenta_bancaria', 'email_cliente', 'movil', 'terminos', 'titular']);
  });

  it('validación de archivos y firma: sin archivos, tipo no admitido, vacío, orden repetido, firma rara y ref inválida', async () => {
    const dni = documento(1, 'dni.jpg', generarJpeg());
    const casos = [
      ['sin archivos', { archivos: [] }, { documentacion: FRASES.documentos }],
      ['archivos que no es una lista', { archivos: 'x' }, { documentacion: FRASES.documentos }],
      ['extensión no admitida', { archivos: [{ orden: 1, nombre: 'virus.exe', tamano: 100 }] }, { documentacion: 'Solo se admiten documentos PDF, JPG, PNG, DOC o DOCX.' }],
      ['sin extensión', { archivos: [{ orden: 1, nombre: 'documento', tamano: 100 }] }, { documentacion: 'Solo se admiten documentos PDF, JPG, PNG, DOC o DOCX.' }],
      ['archivo vacío', { archivos: [{ orden: 1, nombre: 'a.pdf', tamano: 0 }] }, { documentacion: 'Hay un documento vacío. Quítalo y vuelve a adjuntarlo.' }],
      ['orden repetido', { archivos: [{ orden: 1, nombre: 'a.pdf', tamano: 5 }, { orden: 1, nombre: 'b.pdf', tamano: 5 }] }, { documentacion: 'Hay un documento que no se ha podido preparar. Quítalo y vuelve a adjuntarlo.' }],
      ['tamaño que no es número', { archivos: [{ orden: 1, nombre: 'a.pdf', tamano: '5' }] }, { documentacion: 'Hay un documento que no se ha podido preparar. Quítalo y vuelve a adjuntarlo.' }],
      ['firma que no es PNG', { firma: 'data:image/jpeg;base64,AAAA' }, { firma: 'La firma no es válida. Bórrala y vuelve a firmar.' }],
      ['firma PNG con otros bytes', { firma: 'data:image/png;base64,AAAAAAAAAAAAAAAA' }, { firma: 'La firma no es válida. Bórrala y vuelve a firmar.' }],
      ['firma con base64 roto', { firma: 'data:image/png;base64,@@@@' }, { firma: 'La firma no es válida. Bórrala y vuelve a firmar.' }],
    ];
    for (const [nombre, cambios, campos] of casos) {
      const r = await iniciar({ ...entradaIniciar({ ref: nuevaRef(), documentos: [dni] }), ...cambios });
      assert.equal(r.status, 400, `${nombre}: ${r.texto}`);
      assert.equal(r.json.codigo, 'datos', nombre);
      assert.deepEqual(r.json.campos, campos, nombre);
    }
    // referencia con otro formato, o de otro formulario
    for (const ref of ['', 'GNE-1-A', 'MEGA-20261009-ABCDEF', null, 42, nuevaRef('mega')]) {
      const r = await iniciar({ ...entradaIniciar({ ref: nuevaRef(), documentos: [dni] }), ref });
      assert.equal(r.status, 400, `ref ${JSON.stringify(ref)}`);
      assert.equal(r.json.codigo, 'peticion');
    }
    // datos ausentes del todo: salen todos los campos obligatorios
    const sinDatos = await iniciar({ ...entradaIniciar({ ref: nuevaRef(), documentos: [dni] }), datos: undefined });
    assert.equal(sinDatos.status, 400);
    assert.ok(Object.keys(sinDatos.json.campos).length >= 15);
  });

  it('texto hostil: saltos de línea, NUL y Unicode suelto se limpian (nada llega a la base ni al asunto sin sanear) y las cabeceras no se inyectan', async () => {
    const documentos = [documento(1, 'dni.jpg', generarJpeg())];
    const datos = datosGnew({
      quien_eres: 'Nombre\nCon salto\tY tab',
      compania: 'Compañía\r\nBcc: otro@ejemplo.com',
      observaciones: 'a\u0000b\ud800c\r\nd',
    });
    const { ref, estado: e } = await enviarCompleto({ datos, documentos });
    assert.equal(e.tramitacion.comercial_nombre, 'Nombre Con salto Y tab');
    assert.equal(e.tramitacion.compania, 'Compañía Bcc: otro@ejemplo.com');
    assert.equal(e.tramitacion.observaciones, 'a b\ufffdc\nd');
    const aviso = correoDe(e, 'aviso');
    assert.ok(!/[\r\n]/.test(aviso.asunto), 'El asunto es de una sola línea');
    assert.equal(aviso.estado, 'enviado');
    assert.equal(aviso.responder_a, EMAIL_COMERCIAL);

    // una dirección con salto de línea no pasa por email: es el camino de una inyección de cabeceras
    const inyeccion = await iniciar(entradaIniciar({ ref: nuevaRef(), documentos, datos: datosGnew({ email_comercial: 'a@b.es\nBcc: x@y.es' }) }));
    assert.equal(inyeccion.status, 400);
    assert.deepEqual(Object.keys(inyeccion.json.campos), ['email_comercial']);
    assert.ok(ref);
  });

  it('límites: 16 archivos → 413; justo en el tope de cada límite se acepta y un byte más se rechaza (25 MiB por archivo, 60 MiB en total)', async (t) => {
    const archivo = (orden, tamano, ext = 'pdf') => ({ orden, nombre: `doc${orden}.${ext}`, tamano });
    const enviar = (archivos) => iniciar({ ...entradaIniciar({ ref: nuevaRef(), documentos: [documento(1, 'a.jpg', generarJpeg())] }), archivos });

    const dieciseis = await enviar(Array.from({ length: 16 }, (_, i) => archivo(i + 1, 1000)));
    assert.equal(dieciseis.status, 413, dieciseis.texto);
    assert.deepEqual([dieciseis.json.ok, dieciseis.json.codigo, dieciseis.json.retryable], [false, 'limites', false]);
    assert.equal(dieciseis.json.mensaje, 'La documentación supera el máximo: 15 archivos, 25 MB por archivo y 60 MB en total');
    assert.equal((await enviar(Array.from({ length: 15 }, (_, i) => archivo(i + 1, 1000)))).status, 200, '15 archivos sí');

    assert.equal(LIMITES.maxBytesArchivo, 26_214_400, 'El tope por archivo es el del bucket: 25 MiB');
    assert.equal(LIMITES.maxBytesContrato, 62_914_560, 'El tope total es 60 MiB');
    assert.equal((await enviar([archivo(1, 26_214_400)])).status, 200, 'Exactamente 25 MiB entra');
    assert.equal((await enviar([archivo(1, 26_214_401)])).status, 413, '25 MiB + 1 byte, no');
    assert.equal((await enviar([archivo(1, 26 * MIB)])).status, 413);
    assert.equal((await enviar([archivo(1, 26_214_400), archivo(2, 26_214_400), archivo(3, 10 * MIB)])).status, 200, 'Exactamente 60 MiB en total entra');
    assert.equal((await enviar([archivo(1, 26_214_400), archivo(2, 26_214_400), archivo(3, 10 * MIB + 1)])).status, 413, '60 MiB + 1 byte, no');
    t.diagnostic('15 archivos OK · 16 → 413 · 26.214.400 B OK · 26.214.401 B → 413 · 62.914.560 B en total OK · +1 → 413');
  });

  it('cuota: con CUOTA_INICIAR_HORA=3 la 4.ª llamada de una IP da 429 (y se restaura); otra IP no queda limitada', async () => {
    const ip = `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`; // IP propia: contador de cuota recién estrenado
    const cabeceras = { 'x-forwarded-for': ip };
    const previo = await cambiarEntorno({ CUOTA_INICIAR_HORA: '3' });
    try {
      const llamada = () => iniciar({ formulario: 'gnew', token: FORM_TOKENS.gnew, ref: nuevaRef(), datos: {}, archivos: [] }, cabeceras);
      for (let i = 1; i <= 3; i++) assert.equal((await llamada()).status, 400, `La llamada ${i} aún entra`);
      const cuarta = await llamada();
      assert.equal(cuarta.status, 429, cuarta.texto);
      assert.deepEqual([cuarta.json.ok, cuarta.json.codigo, cuarta.json.retryable], [false, 'demasiados', false]);
      assert.equal(cuarta.json.mensaje, 'Se han recibido demasiados envíos desde tu conexión. Espera unos minutos.');
      const otraIp = await iniciar({ formulario: 'gnew', token: FORM_TOKENS.gnew, ref: nuevaRef(), datos: {}, archivos: [] }, { 'x-forwarded-for': `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}` });
      assert.equal(otraIp.status, 400, 'Otra IP tiene su propio contador');
    } finally {
      await cambiarEntorno({ CUOTA_INICIAR_HORA: previo.CUOTA_INICIAR_HORA });
    }
    // restaurado el límite, la misma IP ya no está limitada
    assert.equal((await iniciar({ formulario: 'gnew', token: FORM_TOKENS.gnew, ref: nuevaRef(), datos: {}, archivos: [] }, cabeceras)).status, 400);
    assert.equal((await cambiarEntorno({ CUOTA_INICIAR_HORA: previo.CUOTA_INICIAR_HORA })).CUOTA_INICIAR_HORA, previo.CUOTA_INICIAR_HORA, 'El límite quedó restaurado');

    // confirmar tiene la suya
    const ipC = `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
    const previoC = await cambiarEntorno({ CUOTA_CONFIRMAR_HORA: '2' });
    try {
      for (let i = 1; i <= 2; i++) assert.equal((await confirmar(nuevaRef(), 'gnew', { 'x-forwarded-for': ipC })).status, 404);
      const tercera = await confirmar(nuevaRef(), 'gnew', { 'x-forwarded-for': ipC });
      assert.equal(tercera.status, 429, tercera.texto);
      assert.equal(tercera.json.codigo, 'demasiados');
    } finally {
      await cambiarEntorno({ CUOTA_CONFIRMAR_HORA: previoC.CUOTA_CONFIRMAR_HORA });
    }
  });

  it('Altavoz caído: confirmar sigue dando listo, los correos quedan pendientes con su espera y no se martillea', async (t) => {
    const documentos = PEQUENOS();
    const antes = await post('/__pruebas/altavoz', { caido: true });
    assert.deepEqual(antes.json, { ok: true, caido: true });
    let ref;
    try {
      const r = await enviarCompleto({ documentos });
      ref = r.ref;
      const e = r.estado;
      assert.equal(e.tramitacion.estado, 'recibida', 'El contrato está a salvo aunque los correos no salgan');
      assert.equal(e.correos.length, 2);
      for (const c of e.correos) {
        assert.equal(c.estado, 'pendiente');
        assert.equal(c.intentos, 1);
        assert.equal(c.codigo_respuesta, 'envio_no_disponible');
        assert.ok(c.ultimo_error && !/@|ES91/.test(c.ultimo_error), 'El último error es una frase corta sin datos personales');
        assert.equal(c.simulado, false);
        assert.equal(c.altavoz_id, null);
        assert.equal(c.cuerpo_html, null, 'Solo se guarda el cuerpo de lo que sale en simulación');
        assert.equal(c.bloqueado_hasta, null);
        const espera = Date.parse(c.proximo_intento) - Date.now();
        assert.ok(espera > 20_000 && espera < 150_000, `La 1.ª espera es de 1 minuto (${Math.round(espera / 1000)} s)`);
      }
      assert.deepEqual(tipos(e), ['creada', 'firma_guardada', 'recibida', 'correo_fallo', 'correo_fallo']);
      assert.deepEqual(e.eventos.filter((x) => x.tipo === 'correo_fallo').map((x) => x.detalle), [
        { tipo: 'aviso', estado: 'pendiente', codigo: 'envio_no_disponible', intentos: 1 },
        { tipo: 'acuse', estado: 'pendiente', codigo: 'envio_no_disponible', intentos: 1 },
      ]);

      // un reintento del navegador no vuelve a intentar un correo que espera su turno
      const otra = await confirmar(ref);
      assert.equal(otra.status, 200);
      assert.equal(otra.json.listo, true);
      const despues = await estadoDe(ref);
      assert.deepEqual(despues.correos.map((c) => c.intentos), [1, 1]);
      assert.equal(despues.correos.length, 2);
      t.diagnostic(`${ref}: recibida con los dos correos pendientes (1 intento, espera ≈ 1 min, ${e.correos[0].codigo_respuesta})`);
    } finally {
      const despues = await post('/__pruebas/altavoz', { caido: false });
      assert.deepEqual(despues.json, { ok: true, caido: false });
    }
  });

  it('JSON roto o que no es un objeto → 400 peticion (iniciar y confirmar)', async () => {
    for (const ruta of ['/api/tramitacion/iniciar', '/api/tramitacion/confirmar']) {
      for (const [descripcion, cuerpo, tipo] of [
        ['JSON cortado', '{"ref":', 'application/json'],
        ['basura con tipo JSON', 'esto no es json', 'application/json'],
        ['texto plano', 'hola', 'text/plain'],
        ['una lista', '[]', 'application/json'],
        ['null', 'null', 'application/json'],
      ]) {
        const r = await llamar('POST', ruta, { cuerpo, tipo });
        assert.equal(r.status, 400, `${ruta} ${descripcion}: ${r.texto}`);
        assert.deepEqual([r.json.ok, r.json.codigo, r.json.retryable], [false, 'peticion', false], descripcion);
        assert.match(r.json.mensaje, /Recarga la página/);
      }
    }
  });

  it('solo POST: otro método → 405 con Allow', async () => {
    for (const ruta of ['/api/tramitacion/iniciar', '/api/tramitacion/confirmar']) {
      const r = await llamar('GET', ruta);
      assert.equal(r.status, 405);
      assert.equal(r.cabeceras.get('allow'), 'POST');
      assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    }
  });

  it('MEGA: compañía fija, tipo de suministro deducido de la tarifa y asunto «Nuevo Contrato MEGA - …»', async () => {
    const documentos = PEQUENOS();
    const { ref, estado: e } = await enviarCompleto({
      formulario: 'mega',
      documentos,
      datos: datosMega({ compania: 'Lo que diga un cliente tramposo', tipo_suministro: 'Luz' }),
    });
    assert.match(ref, /^MEGA-\d{8}-[A-Z0-9]{6}$/);
    assert.equal(e.tramitacion.formulario, 'mega');
    assert.equal(e.tramitacion.compania, 'MEGA ENERGIA');
    assert.equal(e.tramitacion.tipo_suministro, 'Gas', 'RL.1 es gas, diga lo que diga el cliente');
    assert.match(e.tramitacion.carpeta, new RegExp(`^pruebas/mega/\\d{4}/\\d{2}/${ref}-`));
    const aviso = correoDe(e, 'aviso');
    const acuse = correoDe(e, 'acuse');
    assert.equal(aviso.marca, 'MEGA');
    assert.equal(aviso.asunto, `Nuevo Contrato MEGA - Titular Mega de Prueba SL - Comercial de Prueba - ${CUPS_GAS}`);
    assert.equal(acuse.asunto, `Recibido: ${aviso.asunto}`);
    assert.equal(aviso.para, AVISO_DESTINO, 'MEGA usa el mismo buzón: no hace falta AVISO_DESTINO_MEGA');
    assert.ok(aviso.cuerpo_html.includes(`${BASE}/bandeja/c/${ref}`));
    assert.ok(aviso.cuerpo_html.includes('#0D9488'), 'Cabecera turquesa de MEGA');
    assert.deepEqual([aviso.estado, acuse.estado], ['enviado', 'enviado']);

    // una tarifa que no está en el desplegable de MEGA se rechaza
    const mala = await iniciar(entradaIniciar({ formulario: 'mega', ref: nuevaRef('mega'), documentos, datos: datosMega({ tarifa: '9.9XX' }) }));
    assert.equal(mala.status, 400);
    assert.deepEqual(Object.keys(mala.json.campos), ['tarifa']);
  });

  it('datos corregidos antes de terminar: iniciar de nuevo con la misma ref actualiza la fila y lo apunta (sin datos personales en el historial)', async () => {
    const ref = nuevaRef();
    const documentos = [documento(1, 'dni.jpg', generarJpeg())];
    assert.equal((await iniciar(entradaIniciar({ ref, documentos }))).status, 200);
    const igual = await iniciar(entradaIniciar({ ref, documentos }));
    assert.equal(igual.status, 200);
    assert.deepEqual(tipos(await estadoDe(ref)), ['creada', 'firma_guardada'], 'Repetir lo mismo no genera eventos');

    const corregido = await iniciar(entradaIniciar({ ref, documentos, datos: datosGnew({ cups: CUPS_OTRO, titular: 'Titular Corregido SL' }) }));
    assert.equal(corregido.status, 200, corregido.texto);
    const e = await estadoDe(ref);
    assert.equal(e.tramitacion.cups, CUPS_OTRO);
    assert.equal(e.tramitacion.titular_nombre, 'Titular Corregido SL');
    assert.ok(e.tramitacion.busqueda.includes('titular corregido'), 'La búsqueda se actualiza con los datos nuevos');
    const evento = e.eventos.find((x) => x.tipo === 'datos_actualizados');
    assert.deepEqual(evento.detalle, { campos: ['cups', 'titular_nombre'] });
    assert.ok(!JSON.stringify(e.eventos).includes('Corregido'));
  });

  it('confirmar sobre una tramitación ya recibida a la que le faltan los correos (corte tras el cambio de estado) los crea y los envía', async () => {
    const { ref, estado: antes } = await enviarCompleto({ documentos: PEQUENOS() });
    const borrados = await borrar('tramitacion_correos', { tramitacion_id: `eq.${antes.tramitacion.id}` }, { devolver: true });
    assert.equal(borrados.length, 2);
    assert.deepEqual((await estadoDe(ref)).correos, []);

    const r = await confirmar(ref);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual([r.json.listo, r.json.estado], [true, 'recibida']);
    const e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.simulado]), [['acuse', 'enviado', true], ['aviso', 'enviado', true]]);
    assert.ok(correoDe(e, 'aviso').cuerpo_html.includes(IBAN));
    assert.equal(e.tramitacion.estado, 'recibida');
  });

  it('carreras: tres iniciar y tres confirmar a la vez con la misma ref dejan una fila, una lista de documentos y UN solo aviso y acuse', async (t) => {
    const documentos = PEQUENOS();
    const ref = nuevaRef();
    const entrada = entradaIniciar({ ref, documentos });
    const iniciales = await Promise.all([iniciar(entrada), iniciar(entrada), iniciar(entrada)]);
    for (const r of iniciales) {
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.estado, r.json.listo, r.json.subidas.length], ['subiendo', false, 2]);
    }
    let e = await estadoDe(ref);
    assert.deepEqual(e.documentos.map((d) => d.orden), [0, 1, 2], 'Una sola lista de documentos, sin repetidos');
    assert.equal(tipos(e).filter((x) => x === 'creada').length, 1);

    await subirTodo(iniciales[0].json.subidas, documentos);
    const finales = await Promise.all([confirmar(ref), confirmar(ref), confirmar(ref)]);
    for (const r of finales) {
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.listo, r.json.estado], [true, 'recibida']);
    }
    e = await estadoDe(ref);
    assert.equal(e.tramitacion.estado, 'recibida');
    assert.equal(tipos(e).filter((x) => x === 'recibida').length, 1, 'Solo una petición cierra la tramitación');
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'enviado', 1], ['aviso', 'enviado', 1]], 'Cada correo se envía una sola vez');
    assert.equal(tipos(e).filter((x) => x === 'aviso_enviado').length, 1);
    assert.equal(tipos(e).filter((x) => x === 'acuse_enviado').length, 1);
    t.diagnostic(`${ref}: eventos ${tipos(e).join(' > ')}`);
  });

  it('con TRAMITACION_PRUEBA apagado el servidor local no escribe: se rechaza cualquier escritura y no queda ninguna fila sin marca de prueba', async () => {
    const ref = nuevaRef();
    const documentos = PEQUENOS();
    const previo = await cambiarEntorno({ TRAMITACION_PRUEBA: '0' });
    try {
      const r = await iniciar(entradaIniciar({ ref, documentos }));
      assert.equal(r.status, 500, r.texto);
      assert.equal(r.json.codigo, 'modo_prueba_apagado');
      const c = await confirmar(ref);
      assert.equal(c.status, 500);
      assert.equal(c.json.codigo, 'modo_prueba_apagado');
      assert.equal((await llamar('GET', '/api/tramitacion/iniciar')).status, 405, 'Las lecturas sí se atienden (aquí llegan al handler)');
    } finally {
      await cambiarEntorno({ TRAMITACION_PRUEBA: previo.TRAMITACION_PRUEBA });
    }
    assert.deepEqual(await seleccionar('tramitaciones', { select: 'id', ref: `eq.${ref}` }), [], 'No se ha escrito nada: ni de prueba ni sin marcar');
    assert.equal((await iniciar(entradaIniciar({ ref, documentos }))).status, 200, 'Restaurado el modo prueba, vuelve a funcionar');
  });

  it('el servidor local se comporta como Vercel: lo interno no se sirve y el gancho de entorno no deja tocar la simulación', async () => {
    for (const ruta of ['/api/_lib/config.js', '/api/_lib/supabase', '/CLAUDE.md', '/supabase/tramitacion.sql', '/.env.local', '/tests/servidor-local.mjs', '/google-apps-script/Code.gs', '/api/tramitacion/iniciar.js', '/../.env.local', '/%2e%2e/.env.local']) {
      const r = await llamar('GET', ruta);
      assert.ok([400, 404].includes(r.status), `${ruta} no debe servirse (dio ${r.status})`);
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|FORM_TOKEN|create table/i.test(r.texto), `${ruta} no puede filtrar contenido interno`);
    }
    assert.equal((await llamar('GET', '/gnew')).status, 200, '/gnew se sirve por la reescritura de vercel.json');
    const prohibidas = [
      { ALTAVOZ_SIMULAR: '0' }, { ALTAVOZ_API_KEY: 'x' }, { ALTAVOZ_URL: 'http://x' }, { SUPABASE_URL: 'http://x' },
      { AVISO_DESTINO: 'victor.molins.10+otro@gmail.com' }, { BANDEJA_SECRETO: 'x'.repeat(40) }, { SITIO_URL: 'http://x' },
      { CUOTA_INICIAR_HORA: '3', ALTAVOZ_SIMULAR: '0' }, // una permitida junto a una prohibida: no se aplica NINGUNA
    ];
    for (const cambios of prohibidas) {
      const r = await post('/__pruebas/env', cambios);
      assert.equal(r.status, 403, `Debe rechazar ${Object.keys(cambios).join(', ')}`);
    }
    // la variable permitida del último intento no se aplicó
    const previo = await cambiarEntorno({ CUOTA_INICIAR_HORA: '1000' });
    assert.equal(previo.CUOTA_INICIAR_HORA, '1000');
    assert.equal((await post('/__pruebas/env', { CUOTA_INICIAR_HORA: 'abc; rm -rf' })).status, 400, 'Valores raros, fuera');
    assert.equal((await post('/__pruebas/env', {})).status, 400);
    // y todo sigue en pie: el servidor sigue simulando
    const e = (await enviarCompleto({ documentos: [documento(1, 'dni.jpg', generarJpeg())] })).estado;
    assert.ok(e.correos.every((c) => c.simulado === true));
  });
});

// ---------------------------------------------------------------------------
// Parte 2 · la cola de correos, a nivel de librería (api/_lib/cola.js dentro de este proceso; Altavoz simulado)
// ---------------------------------------------------------------------------

describe('Tramitación v2 · cola de correos (reintentar, cerrojos, atascados, reenviar, conciliar)', { timeout: 600_000 }, () => {
  const entornoOriginal = {};

  before(() => {
    for (const variable of ['ALTAVOZ_SIMULAR', 'ALTAVOZ_SIMULAR_FALLO', 'TRAMITACION_PRUEBA']) entornoOriginal[variable] = process.env[variable];
    assert.equal(process.env.TRAMITACION_PRUEBA, '1', 'Estas pruebas solo corren en modo prueba');
    assert.equal(process.env.ALTAVOZ_SIMULAR, '1', 'La simulación es obligatoria');
  });

  after(() => {
    for (const [variable, valor] of Object.entries(entornoOriginal)) {
      if (valor === undefined) delete process.env[variable];
      else process.env[variable] = valor;
    }
  });

  const hace = (minutos) => new Date(Date.now() - minutos * 60_000).toISOString();
  const enMinutos = (minutos) => new Date(Date.now() + minutos * 60_000).toISOString();
  const poner = (idTramitacion, tipo, cambios) => actualizar('tramitacion_correos', { tramitacion_id: `eq.${idTramitacion}`, tipo: `eq.${tipo}` }, cambios);

  it('la guarda: en modo prueba sin simulación se falla con un error claro y NUNCA se llama a la red', async () => {
    const original = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = async () => {
      llamadas += 1;
      throw new Error('No debería haberse llamado a fetch');
    };
    const valido = { marca: 'GNEW', para: AVISO_DESTINO, asunto: 'Prueba', texto: 'Hola' };
    try {
      for (const apagar of [() => { process.env.ALTAVOZ_SIMULAR = '0'; }, () => { delete process.env.ALTAVOZ_SIMULAR; }, () => { process.env.ALTAVOZ_SIMULAR = ''; }]) {
        apagar();
        await assert.rejects(() => enviarAviso(valido), (error) => error instanceof ErrorSimulacion && /simulación/.test(error.message));
      }
      assert.equal(llamadas, 0, 'No se intentó enviar nada');
    } finally {
      globalThis.fetch = original;
      process.env.ALTAVOZ_SIMULAR = '1';
    }

    // simulada, el correo «sale» sin red; y un correo inválido se rechaza como lo haría Altavoz (422)
    globalThis.fetch = async () => {
      llamadas += 1;
      throw new Error('No debería haberse llamado a fetch');
    };
    try {
      const bien = await enviarAviso(valido);
      assert.deepEqual([bien.estado, bien.simulado, bien.http], ['enviado', true, 200]);
      assert.match(bien.altavoz_id, /^simulado-\d+$/);
      for (const malo of [{ ...valido, para: 'Nombre <a@b.es>' }, { ...valido, para: 'a@b.es, c@d.es' }, { ...valido, responder_a: 'no es un email' }, { ...valido, asunto: '   ' }, { ...valido, texto: '' }, { ...valido, marca: 'NET' }]) {
        const r = await enviarAviso(malo);
        assert.deepEqual([r.estado, r.terminal, r.http], ['error_configuracion', true, 422], JSON.stringify(Object.keys(malo)));
        assert.match(r.motivo, /^El correo no es válido: /);
      }
      assert.equal(llamadas, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('la guarda dentro de la cola: intentarEnvio con la simulación apagada lanza, suelta el cerrojo y no cuenta intento', async () => {
    await post('/__pruebas/altavoz', { caido: true });
    let ref;
    let id;
    try {
      const r = await enviarCompleto({ documentos: PEQUENOS() });
      ref = r.ref;
      id = r.estado.tramitacion.id;
    } finally {
      await post('/__pruebas/altavoz', { caido: false });
    }
    const aviso = (await poner(id, 'aviso', { proximo_intento: hace(1) }))[0];
    assert.equal(aviso.estado, 'pendiente');
    process.env.ALTAVOZ_SIMULAR = '0';
    try {
      await assert.rejects(() => intentarEnvio(aviso.id), ErrorSimulacion);
      await assert.rejects(() => reintentarPendientes({ max: 50 }), ErrorSimulacion, 'El vigilante tampoco se traga la guarda');
    } finally {
      process.env.ALTAVOZ_SIMULAR = '1';
    }
    const despues = correoDe(await estadoDe(ref), 'aviso');
    assert.deepEqual([despues.estado, despues.intentos, despues.bloqueado_hasta], ['pendiente', 1, null], 'El correo queda como estaba: ni enviado ni con un intento de más');
  });

  it('reintentar: no toca lo que espera su turno; con Altavoz caído sube el intento y la espera; recuperado, envía y guarda el cuerpo', async (t) => {
    await post('/__pruebas/altavoz', { caido: true });
    let ref;
    let id;
    try {
      const r = await enviarCompleto({ documentos: PEQUENOS() });
      ref = r.ref;
      id = r.estado.tramitacion.id;
    } finally {
      await post('/__pruebas/altavoz', { caido: false });
    }

    // 1. aún no les toca (esperan 1 minuto): reintentarPendientes no los mira
    await reintentarPendientes({ max: 50 });
    assert.deepEqual((await estadoDe(ref)).correos.map((c) => [c.estado, c.intentos]), [['pendiente', 1], ['pendiente', 1]]);

    // 2. les toca, pero Altavoz sigue caído → intento 2, espera de 3 minutos
    await poner(id, 'aviso', { proximo_intento: hace(1) });
    await poner(id, 'acuse', { proximo_intento: hace(1) });
    process.env.ALTAVOZ_SIMULAR_FALLO = '1';
    try {
      const pase = await reintentarPendientes({ max: 50 });
      assert.ok(pase.reintentados >= 2 && pase.enviados === 0, JSON.stringify(pase));
    } finally {
      delete process.env.ALTAVOZ_SIMULAR_FALLO;
    }
    let e = await estadoDe(ref);
    for (const c of e.correos) {
      assert.deepEqual([c.estado, c.intentos], ['pendiente', 2]);
      const espera = Date.parse(c.proximo_intento) - Date.now();
      assert.ok(espera > 2.5 * 60_000 && espera < 3.5 * 60_000, `La 2.ª espera es de 3 minutos (${Math.round(espera / 1000)} s)`);
    }
    assert.deepEqual(tipos(e).filter((x) => x === 'correo_fallo').length, 4);

    // 3. atascados: mientras son recientes, no; con más de 10 minutos, sí
    assert.ok(!(await atascados()).some((a) => a.ref === ref), 'Un correo pendiente de hace un minuto aún no es un atasco');
    await poner(id, 'aviso', { creado_en: hace(25) });
    const atasco = (await atascados()).filter((a) => a.ref === ref);
    assert.deepEqual(atasco.map((a) => [a.tipo, a.estado, a.intentos, a.codigo_respuesta]), [['aviso', 'pendiente', 2, 'envio_no_disponible']]);
    assert.ok(atasco[0].minutos >= 24 && atasco[0].minutos <= 27);

    // 4. recuperado: sale, guarda el cuerpo y deja de ser un atasco
    await poner(id, 'aviso', { proximo_intento: hace(1) });
    await poner(id, 'acuse', { proximo_intento: hace(1) });
    const pase = await reintentarPendientes({ max: 50 });
    assert.ok(pase.enviados >= 2, JSON.stringify(pase));
    e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos, c.simulado]), [['acuse', 'enviado', 3, true], ['aviso', 'enviado', 3, true]]);
    assert.ok(correoDe(e, 'aviso').cuerpo_html.includes(IBAN) && correoDe(e, 'aviso').cuerpo_html.includes(`/bandeja/c/${ref}`), 'El cuerpo se regenera desde la fila y los documentos');
    assert.equal(correoDe(e, 'aviso').ultimo_error, null);
    assert.ok(!(await atascados()).some((a) => a.ref === ref));
    assert.deepEqual(tipos(e).slice(-2), ['aviso_enviado', 'acuse_enviado']);
    t.diagnostic(`${ref}: 1 intento (caído) → 2 (caído, espera 3 min) → 3 (enviado); atascado a los 25 min; ya no atascado al enviarse`);
  });

  it('cerrojos: uno vencido vuelve a pendiente contando intento y se envía; uno vivo no se toca; el octavo intento lo agota', async () => {
    const { ref, estado } = await enviarCompleto({ documentos: PEQUENOS() });
    const id = estado.tramitacion.id;

    await poner(id, 'aviso', { estado: 'enviando', bloqueado_hasta: hace(2), intentos: 3 });
    await poner(id, 'acuse', { estado: 'enviando', bloqueado_hasta: enMinutos(5), intentos: 3 }); // cerrojo vivo
    assert.ok((await liberarCerrojos()) >= 1);
    let e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'aviso').estado, correoDe(e, 'aviso').intentos, correoDe(e, 'aviso').bloqueado_hasta], ['pendiente', 4, null], 'Liberar cuenta como un intento');
    assert.deepEqual([correoDe(e, 'acuse').estado, correoDe(e, 'acuse').intentos], ['enviando', 3], 'Un cerrojo vivo no se toca');

    await reintentarPendientes({ max: 50 });
    e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'aviso').estado, correoDe(e, 'aviso').intentos], ['enviado', 5]);
    assert.equal(correoDe(e, 'acuse').estado, 'enviando', 'El pase del vigilante tampoco toca un cerrojo vivo');

    // el octavo intento fallido agota
    await poner(id, 'acuse', { estado: 'enviando', bloqueado_hasta: hace(2), intentos: 7 });
    await liberarCerrojos();
    e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'acuse').estado, correoDe(e, 'acuse').intentos, correoDe(e, 'acuse').codigo_respuesta], ['agotado', 8, 'cerrojo']);
    assert.ok((await atascados()).some((a) => a.ref === ref && a.estado === 'agotado'), 'Un agotado es un atasco aunque sea reciente');
    // y un fallo en el 8.º intento de verdad también agota
    await poner(id, 'acuse', { estado: 'pendiente', intentos: 7, bloqueado_hasta: null, proximo_intento: hace(1), codigo_respuesta: null });
    process.env.ALTAVOZ_SIMULAR_FALLO = '1';
    try {
      await reintentarPendientes({ max: 50 });
    } finally {
      delete process.env.ALTAVOZ_SIMULAR_FALLO;
    }
    e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'acuse').estado, correoDe(e, 'acuse').intentos], ['agotado', 8]);
  });

  it('cerrojo optimista: dos intentos a la vez sobre el mismo correo pendiente lo envían UNA sola vez', async () => {
    await post('/__pruebas/altavoz', { caido: true });
    let ref;
    let id;
    try {
      const r = await enviarCompleto({ documentos: PEQUENOS() });
      ref = r.ref;
      id = r.estado.tramitacion.id;
    } finally {
      await post('/__pruebas/altavoz', { caido: false });
    }
    const aviso = (await poner(id, 'aviso', { proximo_intento: hace(1) }))[0];
    const [a, b] = await Promise.all([intentarEnvio(aviso.id), intentarEnvio(aviso.id)]);
    assert.deepEqual([a.intentado, b.intentado].sort(), [false, true], 'Uno coge el cerrojo y el otro se aparta');
    assert.deepEqual([a, b].find((x) => !x.intentado), { intentado: false, motivo: 'ocupado' });
    let e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'aviso').estado, correoDe(e, 'aviso').intentos], ['enviado', 2]);
    assert.equal(tipos(e).filter((x) => x === 'aviso_enviado').length, 1, 'Un solo envío del aviso');
    // sobre uno ya enviado tampoco hace nada
    assert.deepEqual(await intentarEnvio(aviso.id), { intentado: false, motivo: 'ocupado' });
    e = await estadoDe(ref);
    assert.equal(correoDe(e, 'aviso').intentos, 2);
  });

  it('aislamiento por modo: el robot del servidor de pruebas no toca ni cuenta ni concilia una tramitación que NO es de prueba', async () => {
    // Una fila de mentira con prueba=false, solo el instante que dura la comprobación (se borra siempre al acabar).
    const ref = nuevaRef();
    const referencia = { ref, formulario: 'gnew' };
    const fila = {
      ...referencia, estado: 'recibida', prueba: false, sospechosa: false, carpeta: `aislamiento/${ref}`, recibida_en: new Date().toISOString(),
      comercial_nombre: 'Aislamiento', comercial_email: EMAIL_COMERCIAL, compania: 'Aislamiento', cups: CUPS, titular_nombre: 'Aislamiento', titular_nif: DNI_TITULAR,
      iban: IBAN, direccion: 'x', cp: '28001', poblacion: 'x', provincia: 'x', telefono: '600000000', email_cliente: EMAIL_CLIENTE,
    };
    try {
      const [creada] = await insertar('tramitaciones', fila);
      const [aviso] = await insertar('tramitacion_correos', {
        tramitacion_id: creada.id, tipo: 'aviso', marca: 'GNEW', para: AVISO_DESTINO, asunto: 'Aislamiento', proximo_intento: hace(5), creado_en: hace(30),
      });
      await reintentarPendientes({ max: 50 });
      await liberarCerrojos();
      await conciliar();
      assert.ok(!(await atascados()).some((x) => x.id === aviso.id), 'Un atasco de producción no es asunto del servidor de pruebas');
      const [despues] = await seleccionar('tramitacion_correos', { id: `eq.${aviso.id}` });
      assert.deepEqual([despues.estado, despues.intentos, despues.enviado_en], ['pendiente', 0, null], 'No se ha intentado enviar');
      assert.equal((await seleccionar('tramitacion_correos', { tramitacion_id: `eq.${creada.id}` })).length, 1, 'Y no se le ha creado el acuse');
    } finally {
      await borrar('tramitaciones', { ref: `eq.${ref}`, prueba: 'eq.false' });
    }
    assert.deepEqual(await seleccionar('tramitaciones', { select: 'id', ref: `eq.${ref}` }), [], 'La fila de la comprobación se ha borrado');
  });

  it('reenviar: deja el correo a cero y lo envía al momento (con el email de backoffice en el historial); con el cerrojo vivo no toca nada', async () => {
    const { ref, estado } = await enviarCompleto({ documentos: PEQUENOS() });
    const id = estado.tramitacion.id;
    const actor = 'victor.molins.10+bandeja@gmail.com';

    const r = await reenviar(id, 'aviso', { actor });
    assert.deepEqual(r, { ok: true, ocupado: false, estado: 'enviado', intentos: 1 });
    let e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'aviso').estado, correoDe(e, 'aviso').intentos], ['enviado', 1]);
    const evento = e.eventos.find((x) => x.tipo === 'aviso_reenviado');
    assert.equal(evento.actor, actor);
    assert.deepEqual(tipos(e).slice(-2), ['aviso_reenviado', 'aviso_enviado']);

    // desde un estado terminal también
    await poner(id, 'acuse', { estado: 'suprimido', codigo_respuesta: 'destinatario_suprimido', intentos: 1 });
    assert.deepEqual(await reenviar(id, 'acuse', { actor }), { ok: true, ocupado: false, estado: 'enviado', intentos: 1 });
    assert.equal(correoDe(await estadoDe(ref), 'acuse').codigo_respuesta, null);

    // con el cerrojo vivo no se toca
    await poner(id, 'aviso', { estado: 'enviando', bloqueado_hasta: enMinutos(5) });
    assert.deepEqual(await reenviar(id, 'aviso', { actor }), { ok: true, ocupado: true });
    assert.equal(correoDe(await estadoDe(ref), 'aviso').estado, 'enviando');

    assert.deepEqual(await reenviar('00000000-0000-0000-0000-000000000000', 'aviso'), { ok: false, motivo: 'desconocida' });
    await assert.rejects(() => reenviar(id, 'codigo_acceso'), RangeError);
  });

  it('conciliar: a una recibida sin correos le crea el aviso y el acuse (con evento) y el vigilante los envía; no toca lo completo ni lo viejo', async () => {
    const { ref, estado } = await enviarCompleto({ documentos: PEQUENOS() });
    const id = estado.tramitacion.id;
    const otra = await enviarCompleto({ documentos: PEQUENOS() });

    await borrar('tramitacion_correos', { tramitacion_id: `eq.${id}` });
    assert.deepEqual((await estadoDe(ref)).correos, []);

    assert.ok((await conciliar()) >= 1);
    let e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'pendiente', 0], ['aviso', 'pendiente', 0]]);
    const evento = e.eventos.find((x) => x.tipo === 'correos_conciliados');
    assert.deepEqual([evento.actor, evento.detalle], ['vigilante', { creados: 2 }]);
    assert.deepEqual(tipos(await estadoDe(otra.ref)).filter((x) => x === 'correos_conciliados'), [], 'Lo que ya tenía correos no se toca');

    await conciliar();
    assert.equal((await estadoDe(ref)).eventos.filter((x) => x.tipo === 'correos_conciliados').length, 1, 'Conciliar otra vez no repite nada');
    await reintentarPendientes({ max: 50 });
    e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => c.estado), ['enviado', 'enviado']);

    // solo los últimos 7 días
    await borrar('tramitacion_correos', { tramitacion_id: `eq.${id}` });
    await actualizar('tramitaciones', { id: `eq.${id}` }, { recibida_en: hace(8 * 24 * 60) });
    await conciliar();
    assert.deepEqual((await estadoDe(ref)).correos, [], 'Una recibida de hace 8 días queda fuera de la conciliación');
  });
});
