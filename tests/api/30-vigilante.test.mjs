// tests/api/30-vigilante.test.mjs · Pruebas de API del vigilante (orden 5): POST /api/tramitacion/vigilante.
//
// Necesita el servidor local en marcha y la base REAL de Supabase (todo lo que se escribe lleva prueba=true y vive bajo
// pruebas/ en el almacén; se borra con scripts/limpiar-pruebas.mjs --todo):
//
//   node tests/servidor-local.mjs &    →    node --test tests/api/30-vigilante.test.mjs    →    node scripts/limpiar-pruebas.mjs --todo    →    kill <PID>
//
// Se «hace de cron» con fetch: POST con `Authorization: Bearer <VIGILANTE_SECRETO>` (el de .env.local, que no se imprime
// nunca). El estado de la base se lee por el gancho /__pruebas/tramitacion o, para lo que el gancho no enseña (cuotas,
// accesos, filas de producción simuladas), con la clave de servicio de .env.local. Altavoz es siempre simulado: «caído»
// con /__pruebas/altavoz. Solo se usan alias de Victor (victor.molins.10+algo@gmail.com).
//
// Las filas «subiendo» viejas se INSERTAN ya con su fecha (creada_en y actualizada_en): un UPDATE no sirve, porque el
// trigger de la tabla pone actualizada_en = now() en cada cambio. Otras pruebas dejan sus propios correos en la cola de
// pruebas: por eso los totales del parte se comprueban con «≥» y lo propio de cada prueba se mira fila a fila, por su
// referencia. Todo lo que se crea aquí se borra al terminar (after), aunque limpiar-pruebas.mjs lo barra luego.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FORM_TOKENS } from '../../api/_lib/config.js';
import { carpetaDe, nonce } from '../../api/_lib/nombres.js';
import { actualizar, borrar, insertar, seleccionar } from '../../api/_lib/supabase.js';
import { ejecutarPasada } from '../../api/_lib/vigilante.js';
import { generarJpeg, generarPdf, generarPng } from '../fixtures/generar.mjs';
import { esperarAHermanosAnteriores } from './hermanos.mjs';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env.local', import.meta.url)));
} catch (error) {
  if (error?.code === 'ENOENT') throw new Error('Falta .env.local en la raíz del proyecto (punto de control A del diseño).');
  throw error;
}

const BASE = 'http://127.0.0.1:8765';
const RUTA = '/api/tramitacion/vigilante';
const TOPE_MS = 120_000;
const SECRETO = process.env.VIGILANTE_SECRETO; // nunca se imprime

const EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com';
const EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com';
const EMAIL_BANDEJA = 'victor.molins.10+bandeja@gmail.com';
const IBAN = 'ES9121000418450200051332';
const IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332';
const CUPS = 'ES0021000000000001RK';

// Espera a los ficheros anteriores (00, 10, 20): comparten el servidor local y su entorno. Ver ./hermanos.mjs.
before(() => esperarAHermanosAnteriores(import.meta.url), { timeout: 10 * 60_000 });

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
const conSecreto = () => ({ Authorization: `Bearer ${SECRETO}` });

/** Una pasada del vigilante, como la haría el cron. Devuelve el parte. */
async function vigilar() {
  const r = await post(RUTA, {}, conSecreto());
  assert.equal(r.status, 200, r.texto.slice(0, 300));
  assert.equal(r.json.ok, true);
  return r.json;
}

const altavoz = async (caido) => {
  const r = await post('/__pruebas/altavoz', { caido });
  assert.deepEqual(r.json, { ok: true, caido });
};

const hace = (minutos) => new Date(Date.now() - minutos * 60_000).toISOString();
const MINUTOS_DIA = 24 * 60;

function nuevaRef(formulario = 'gnew') {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // el mismo que generateRefId del html
  let azar = '';
  for (let i = 0; i < 6; i++) azar += alfabeto[randomInt(alfabeto.length)];
  const hoy = new Date();
  const dia = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;
  return `${formulario === 'gnew' ? 'GNE' : 'MEGA'}-${dia}-${azar}`;
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
    nuevo_titular: '',
    observaciones: 'Línea 1\nLínea 2',
    terminos: true,
    ...extra,
  };
}

const documento = (orden, nombre, datos) => ({ orden, nombre, datos });
const FIRMA = `data:image/png;base64,${generarPng().toString('base64')}`;
const PEQUENOS = () => [
  documento(1, 'contrato.pdf', generarPdf(4096)),
  documento(2, 'dni.jpg', generarJpeg()),
  documento(3, 'factura.png', generarPng()),
];

const entradaIniciar = ({ ref, documentos }) => ({
  formulario: 'gnew',
  token: FORM_TOKENS.gnew,
  ref,
  ref_anterior: null,
  hp: '',
  datos: datosGnew(),
  firma: FIRMA,
  archivos: documentos.map(({ orden, nombre, datos }) => ({ orden, nombre, tamano: datos.length })),
});

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

async function estadoDe(ref) {
  const r = await llamar('GET', `/__pruebas/tramitacion?ref=${ref}`);
  assert.equal(r.status, 200, `La tramitación ${ref} debe existir en la base de pruebas`);
  return r.json;
}

const tipos = (e) => e.eventos.map((x) => x.tipo);
const correoDe = (e, tipo) => e.correos.find((c) => c.tipo === tipo);

// Todo lo que crea este fichero, para borrarlo al terminar
const refsDePrueba = [];
const refsDeProduccionSimulada = [];

/** Un envío completo (iniciar → subir → confirmar). Con Altavoz caído deja los dos correos pendientes. */
async function crearRecibida() {
  const documentos = PEQUENOS();
  const ref = nuevaRef();
  refsDePrueba.push(ref);
  const r1 = await post('/api/tramitacion/iniciar', entradaIniciar({ ref, documentos }));
  assert.equal(r1.status, 200, r1.texto);
  for (const s of r1.json.subidas) await subir(s, documentos.find((d) => d.orden === s.orden).datos);
  const r2 = await post('/api/tramitacion/confirmar', { formulario: 'gnew', token: FORM_TOKENS.gnew, ref });
  assert.equal(r2.status, 200, r2.texto);
  assert.equal(r2.json.listo, true);
  const estado = await estadoDe(ref);
  return { ref, id: estado.tramitacion.id, estado };
}

/** Una fila de `tramitaciones` hecha a mano (INSERT: conserva creada_en y actualizada_en tal como se dan). */
function filaSintetica({ ref, prueba = true, estado = 'subiendo', creada, actualizada, extra = {} }) {
  return {
    ref,
    formulario: 'gnew',
    estado,
    prueba,
    sospechosa: false,
    carpeta: prueba ? carpetaDe({ prueba: true, formulario: 'gnew', ref, nonce: nonce(10) }) : `aislamiento-vigilante/${ref}`,
    comercial_nombre: 'Comercial de Prueba',
    comercial_email: EMAIL_COMERCIAL,
    compania: 'Compañía de Prueba',
    cups: CUPS,
    titular_nombre: 'Titular de Prueba SL',
    titular_nif: '00000000T',
    iban: IBAN,
    direccion: 'Calle de Prueba 1',
    cp: '28001',
    poblacion: 'Madrid',
    provincia: 'Madrid',
    telefono: '600000000',
    email_cliente: EMAIL_CLIENTE,
    ...(creada ? { creada_en: creada } : {}),
    ...(actualizada ? { actualizada_en: actualizada } : {}),
    ...extra,
  };
}

async function insertarSintetica(opciones) {
  (opciones.prueba === false ? refsDeProduccionSimulada : refsDePrueba).push(opciones.ref);
  return (await insertar('tramitaciones', filaSintetica(opciones)))[0];
}

const filaDe = async (ref) => (await seleccionar('tramitaciones', { select: '*', ref: `eq.${ref}` }))[0] ?? null;

/** Les toca ya: el vigilante solo reintenta los correos cuyo proximo_intento ha pasado. */
const vencer = (id) => actualizar('tramitacion_correos', { tramitacion_id: `eq.${id}`, estado: 'eq.pendiente' }, { proximo_intento: hace(1) });
const poner = (id, tipo, cambios) => actualizar('tramitacion_correos', { tramitacion_id: `eq.${id}`, tipo: `eq.${tipo}` }, cambios);

// (los nombres, en las dos formas: los envíos hechos por la API se guardan en MAYÚSCULAS y las filas sintéticas de este fichero, tal cual)
const DATOS_PERSONALES = [EMAIL_COMERCIAL, EMAIL_CLIENTE, IBAN, IBAN_TECLEADO, 'Titular de Prueba', 'Comercial de Prueba', 'Firmante de Prueba',
  'TITULAR DE PRUEBA', 'COMERCIAL DE PRUEBA', 'FIRMANTE DE PRUEBA', CUPS, '12345678Z', '00000000T'];
function sinDatosPersonales(texto, contexto) {
  for (const dato of DATOS_PERSONALES) assert.ok(!texto.includes(dato), `${contexto}: el parte no debe llevar datos personales («${dato.slice(0, 8)}…»)`);
}

before(() => {
  assert.equal(process.env.TRAMITACION_PRUEBA, '1', 'Estas pruebas solo corren en modo prueba');
  assert.equal(process.env.ALTAVOZ_SIMULAR, '1', 'La simulación es obligatoria');
  assert.ok(typeof SECRETO === 'string' && SECRETO.length >= 32, 'Falta VIGILANTE_SECRETO (32 caracteres o más) en .env.local');
});

after(async () => {
  await altavoz(false);
  if (refsDePrueba.length > 0) await borrar('tramitaciones', { ref: `in.(${refsDePrueba.join(',')})`, prueba: 'eq.true' });
  if (refsDeProduccionSimulada.length > 0) await borrar('tramitaciones', { ref: `in.(${refsDeProduccionSimulada.join(',')})`, prueba: 'eq.false' });
});

// ---------------------------------------------------------------------------
// 1 · Quién puede llamar
// ---------------------------------------------------------------------------

describe('Vigilante · acceso y forma de la respuesta', { timeout: 300_000 }, () => {
  it('sin Bearer, o con uno que no es el secreto → 401 no_autorizado', async () => {
    const intentos = [
      ['sin cabecera Authorization', {}],
      ['solo la palabra Bearer', { Authorization: 'Bearer' }],
      ['el secreto sin la palabra Bearer', { Authorization: SECRETO }],
      ['esquema Basic', { Authorization: `Basic ${SECRETO}` }],
      ['Bearer con otro secreto de la misma longitud', { Authorization: `Bearer ${'x'.repeat(SECRETO.length)}` }],
      ['Bearer con un secreto más corto', { Authorization: `Bearer ${SECRETO.slice(0, -1)}` }],
      ['Bearer con un secreto más largo', { Authorization: `Bearer ${SECRETO}x` }],
      ['Bearer con dos palabras', { Authorization: `Bearer ${SECRETO} otra` }],
    ];
    for (const [descripcion, cabeceras] of intentos) {
      const r = await post(RUTA, {}, cabeceras);
      assert.equal(r.status, 401, descripcion);
      assert.deepEqual([r.json.ok, r.json.codigo, r.json.retryable], [false, 'no_autorizado', false], descripcion);
      assert.equal(r.cabeceras.get('cache-control'), 'no-store', descripcion);
      assert.equal(r.cabeceras.get('www-authenticate'), 'Bearer', descripcion);
      assert.ok(!r.texto.includes(SECRETO), 'La respuesta nunca repite el secreto');
    }
  });

  it('solo POST: GET, PUT, DELETE y PATCH → 405 con Allow, aunque lleven el secreto', async () => {
    for (const metodo of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await llamar(metodo, RUTA, { cabeceras: conSecreto() });
      assert.equal(r.status, 405, metodo);
      assert.equal(r.cabeceras.get('allow'), 'POST', metodo);
      assert.equal(r.cabeceras.get('cache-control'), 'no-store', metodo);
    }
  });

  it('con el secreto: 200, sin caché, el cuerpo de la petición se ignora (aunque sea un JSON roto) y la forma del parte es la documentada', async () => {
    const r = await llamar('POST', RUTA, { cuerpo: '{"roto":', cabeceras: conSecreto() });
    assert.equal(r.status, 200, r.texto.slice(0, 300));
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    const j = r.json;
    assert.equal(j.ok, true);
    for (const campo of ['conciliadas', 'liberados', 'reintentados', 'enviados', 'abandonadas', 'pendientes_total']) {
      assert.ok(Number.isInteger(j[campo]) && j[campo] >= 0, `${campo} es un número entero (vale ${j[campo]})`);
    }
    assert.deepEqual(Object.keys(j.limpiados).sort(), ['accesos', 'cuotas']);
    assert.ok(Array.isArray(j.atascados) && Array.isArray(j.subidas_a_medias));
    for (const a of j.atascados) {
      assert.deepEqual(Object.keys(a).sort(), ['codigo_respuesta', 'creado_en', 'estado', 'ficha', 'id', 'intentos', 'minutos', 'ref', 'tipo']);
    }
    for (const s of j.subidas_a_medias) {
      assert.deepEqual(Object.keys(s).sort(), ['actualizada_en', 'creada_en', 'formulario', 'minutos', 'ref']);
    }
    assert.ok(!r.texto.includes(SECRETO));
    sinDatosPersonales(r.texto, 'pasada vacía');
  });
});

// ---------------------------------------------------------------------------
// 2 · La cola de correos
// ---------------------------------------------------------------------------

describe('Vigilante · cola de correos (reintentar, cerrojos, atascados, conciliar)', { timeout: 900_000 }, () => {
  it('Altavoz caído: confirmar deja 2 pendientes; sin secreto 401; con secreto y caído se reintentan (intentos y espera suben, enviados 0); recuperado, salen', async (t) => {
    await altavoz(true);
    try {
      const { ref, id, estado } = await crearRecibida();
      let e = estado;
      assert.equal(e.tramitacion.estado, 'recibida', 'El contrato está a salvo aunque los correos no salgan');
      assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'pendiente', 1], ['aviso', 'pendiente', 1]]);

      // sin el secreto no pasa nada
      assert.equal((await post(RUTA, {})).status, 401);
      assert.deepEqual((await estadoDe(ref)).correos.map((c) => c.intentos), [1, 1]);

      // todavía no les toca (esperan 1 minuto): una pasada con el secreto no los mira, y los cuenta como pendientes
      let parte = await vigilar();
      assert.deepEqual((await estadoDe(ref)).correos.map((c) => c.intentos), [1, 1], 'Un correo que espera su turno no se toca');
      assert.ok(parte.pendientes_total >= 2, `Los dos correos cuentan como pendientes (${parte.pendientes_total})`);

      // les toca, pero Altavoz sigue caído → se reintentan, no salen, y la espera crece
      await vencer(id);
      parte = await vigilar();
      assert.ok(parte.reintentados >= 2, `Se han reintentado al menos los dos de esta prueba (${parte.reintentados})`);
      assert.equal(parte.enviados, 0, 'Con Altavoz caído no puede salir ninguno');
      e = await estadoDe(ref);
      for (const c of e.correos) {
        assert.deepEqual([c.estado, c.intentos, c.codigo_respuesta, c.simulado], ['pendiente', 2, 'envio_no_disponible', false]);
        const espera = Date.parse(c.proximo_intento) - Date.now();
        assert.ok(espera > 2.5 * 60_000 && espera < 3.5 * 60_000, `La 2.ª espera es de 3 minutos (${Math.round(espera / 1000)} s)`);
        assert.equal(c.bloqueado_hasta, null);
        assert.equal(c.cuerpo_html, null, 'Solo se guarda el cuerpo de lo que sale en simulación');
      }
      const fallos = e.eventos.filter((x) => x.tipo === 'correo_fallo');
      assert.equal(fallos.length, 4);
      assert.deepEqual(fallos.slice(2).map((x) => [x.actor, x.detalle.intentos]), [['vigilante', 2], ['vigilante', 2]]);

      // y no se martillea: otra pasada seguida no vuelve a tocarlos
      await vigilar();
      assert.deepEqual((await estadoDe(ref)).correos.map((c) => c.intentos), [2, 2]);
      assert.ok(!(await vigilar()).atascados.some((a) => a.ref === ref), 'Un correo pendiente de hace un minuto aún no es un atasco');

      // con más de 10 minutos sin salir ya es un atasco, con la ficha para abrirlo
      await poner(id, 'aviso', { creado_en: hace(25) });
      parte = await vigilar();
      const mios = parte.atascados.filter((a) => a.ref === ref);
      assert.equal(mios.length, 1, 'Solo el aviso, que es el viejo');
      assert.deepEqual([mios[0].tipo, mios[0].estado, mios[0].intentos, mios[0].codigo_respuesta], ['aviso', 'pendiente', 2, 'envio_no_disponible']);
      assert.ok(mios[0].minutos >= 24 && mios[0].minutos <= 27, `Lleva unos 25 minutos (${mios[0].minutos})`);
      assert.equal(mios[0].ficha, `${process.env.SITIO_URL.replace(/\/+$/, '')}/bandeja/c/${ref}`);
      sinDatosPersonales(JSON.stringify(parte), 'con un atasco');

      // Altavoz vuelve: salen los dos (con el cuerpo regenerado desde la fila) y dejan de ser un atasco
      await altavoz(false);
      await vencer(id);
      parte = await vigilar();
      assert.ok(parte.enviados >= 2, `Han salido al menos los dos de esta prueba (${parte.enviados})`);
      e = await estadoDe(ref);
      assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos, c.simulado]), [['acuse', 'enviado', 3, true], ['aviso', 'enviado', 3, true]]);
      assert.ok(correoDe(e, 'aviso').cuerpo_html.includes(`/bandeja/c/${ref}`) && correoDe(e, 'aviso').cuerpo_html.includes(IBAN));
      assert.equal(correoDe(e, 'aviso').ultimo_error, null);
      // (el aviso y el acuse tienen el mismo proximo_intento: el orden en que los coge el vigilante no está definido)
      assert.deepEqual(e.eventos.filter((x) => /_enviado$/.test(x.tipo)).map((x) => `${x.tipo}:${x.actor}`).sort(), ['acuse_enviado:vigilante', 'aviso_enviado:vigilante']);
      assert.ok(!parte.atascados.some((a) => a.ref === ref), 'Enviado deja de ser un atasco');
      t.diagnostic(`${ref}: 1 intento (caído) → 2 (caído por el vigilante, espera 3 min) → atascado a los 25 min → 3 (enviado por el vigilante)`);
    } finally {
      await altavoz(false);
    }
  });

  it('cerrojos: uno vencido vuelve a pendiente contando intento y se envía en la misma pasada; uno vivo no se toca', async () => {
    const { ref, id } = await crearRecibida();
    await poner(id, 'aviso', { estado: 'enviando', bloqueado_hasta: hace(2), intentos: 3 });
    await poner(id, 'acuse', { estado: 'enviando', bloqueado_hasta: new Date(Date.now() + 5 * 60_000).toISOString(), intentos: 3 }); // cerrojo vivo
    const parte = await vigilar();
    assert.ok(parte.liberados >= 1, `Ha liberado al menos el cerrojo vencido (${parte.liberados})`);
    const e = await estadoDe(ref);
    assert.deepEqual([correoDe(e, 'aviso').estado, correoDe(e, 'aviso').intentos, correoDe(e, 'aviso').bloqueado_hasta], ['enviado', 5, null], 'Liberar cuenta un intento y el envío otro');
    assert.deepEqual([correoDe(e, 'acuse').estado, correoDe(e, 'acuse').intentos], ['enviando', 3], 'Un cerrojo vivo no se toca');
    await poner(id, 'acuse', { estado: 'enviado', bloqueado_hasta: null });
  });

  it('un correo en estado final (bloqueado, error de configuración, incierto, agotado) es un atasco AL MOMENTO y el robot no lo reintenta', async () => {
    const { ref, id } = await crearRecibida();
    await poner(id, 'aviso', { estado: 'suprimido', codigo_respuesta: 'destinatario_suprimido', intentos: 1, enviado_en: null });
    await poner(id, 'acuse', { estado: 'error_configuracion', codigo_respuesta: 'http_401', intentos: 1, enviado_en: null });
    let parte = await vigilar();
    let mios = parte.atascados.filter((a) => a.ref === ref).sort((a, b) => a.tipo.localeCompare(b.tipo));
    assert.deepEqual(mios.map((a) => [a.tipo, a.estado, a.intentos, a.codigo_respuesta]), [
      ['acuse', 'error_configuracion', 1, 'http_401'],
      ['aviso', 'suprimido', 1, 'destinatario_suprimido'],
    ], 'Recién creados, pero terminales: ya son un atasco');
    assert.ok(mios.every((a) => a.minutos <= 5), 'Son recientes');
    let e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'error_configuracion', 1], ['aviso', 'suprimido', 1]], 'El robot no reintenta lo terminal');

    await poner(id, 'aviso', { estado: 'incierto', codigo_respuesta: 'envio_incierto' });
    await poner(id, 'acuse', { estado: 'agotado', codigo_respuesta: 'envio_no_disponible', intentos: 8 });
    parte = await vigilar();
    mios = parte.atascados.filter((a) => a.ref === ref).sort((a, b) => a.tipo.localeCompare(b.tipo));
    assert.deepEqual(mios.map((a) => [a.tipo, a.estado]), [['acuse', 'agotado'], ['aviso', 'incierto']]);
    e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => c.estado), ['agotado', 'incierto']);
  });

  it('conciliación: una recibida (o tramitada) sin correos los recupera y los envía, con su evento; una de hace más de 7 días no', async () => {
    const a = await crearRecibida();
    const b = await crearRecibida();
    const fuera = await crearRecibida(); // saldrá de la ventana de 7 días y sin correos: se borra al acabar para no ensuciar a los demás
    await actualizar('tramitaciones', { id: `eq.${b.id}` }, { estado: 'tramitada', tramitada_en: hace(1), tramitada_por: EMAIL_BANDEJA });
    await actualizar('tramitaciones', { id: `eq.${fuera.id}` }, { recibida_en: hace(8 * MINUTOS_DIA) });
    for (const x of [a, b, fuera]) await borrar('tramitacion_correos', { tramitacion_id: `eq.${x.id}` });
    assert.deepEqual((await estadoDe(a.ref)).correos, []);

    try {
      const parte = await vigilar();
      assert.ok(parte.conciliadas >= 2, `Concilia al menos las dos de esta prueba (${parte.conciliadas})`);
      assert.ok(parte.enviados >= 4, `Y los envía en la misma pasada (${parte.enviados})`);
      for (const x of [a, b]) {
        const e = await estadoDe(x.ref);
        assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado]), [['acuse', 'enviado'], ['aviso', 'enviado']], x.ref);
        const evento = e.eventos.find((ev) => ev.tipo === 'correos_conciliados');
        assert.deepEqual([evento.actor, evento.detalle], ['vigilante', { creados: 2 }], x.ref);
        const desdeLaConciliacion = tipos(e).slice(tipos(e).indexOf('correos_conciliados'));
        assert.equal(desdeLaConciliacion[0], 'correos_conciliados', 'Primero se preparan los correos…');
        assert.deepEqual(desdeLaConciliacion.slice(1).sort(), ['acuse_enviado', 'aviso_enviado'], '…y después salen los dos');
      }
      assert.equal((await estadoDe(b.ref)).tramitacion.estado, 'tramitada', 'Conciliar no cambia el estado');
      assert.deepEqual((await estadoDe(fuera.ref)).correos, [], 'Una recibida de hace 8 días queda fuera de la conciliación');

      // y no se repite
      await vigilar();
      assert.equal((await estadoDe(a.ref)).eventos.filter((ev) => ev.tipo === 'correos_conciliados').length, 1);
    } finally {
      await borrar('tramitaciones', { id: `eq.${fuera.id}` });
    }
    assert.deepEqual(await seleccionar('tramitaciones', { select: 'id', id: `eq.${fuera.id}` }), []);
  });

  it('dos pasadas a la vez (el cron se solapa) envían cada correo UNA sola vez', async () => {
    await altavoz(true);
    let creada;
    try {
      creada = await crearRecibida();
    } finally {
      await altavoz(false);
    }
    const { ref, id } = creada;
    await vencer(id);
    const [x, y] = await Promise.all([vigilar(), vigilar()]);
    assert.ok(x.enviados + y.enviados >= 2, 'Entre las dos han salido los dos correos');
    const e = await estadoDe(ref);
    assert.deepEqual(e.correos.map((c) => [c.tipo, c.estado, c.intentos]), [['acuse', 'enviado', 2], ['aviso', 'enviado', 2]], 'Un intento del cartero más el del vigilante; ni uno de más');
    assert.equal(tipos(e).filter((tipo) => tipo === 'aviso_enviado').length, 1, 'Un solo envío del aviso');
    assert.equal(tipos(e).filter((tipo) => tipo === 'acuse_enviado').length, 1, 'Un solo envío del acuse');
  });

  it('presupuesto de tiempo: pasado el límite no se empieza ningún envío más (lo recoge la pasada siguiente)', async () => {
    await altavoz(true);
    let creada;
    try {
      creada = await crearRecibida();
    } finally {
      await altavoz(false);
    }
    const { ref, id } = creada;
    await vencer(id);

    const sinTiempo = await ejecutarPasada({ limiteEnvioMs: 0 });
    assert.equal(sinTiempo.reintentados, 0, 'Con el presupuesto agotado no se intenta ningún envío');
    assert.equal(sinTiempo.enviados, 0);
    assert.deepEqual((await estadoDe(ref)).correos.map((c) => [c.estado, c.intentos]), [['pendiente', 1], ['pendiente', 1]]);

    const uno = await ejecutarPasada({ maxCorreos: 1 });
    assert.equal(uno.reintentados, 1, 'maxCorreos limita los envíos de la pasada');

    const resto = await vigilar();
    assert.ok(resto.reintentados + uno.reintentados >= 2);
    assert.deepEqual((await estadoDe(ref)).correos.map((c) => c.estado), ['enviado', 'enviado']);
  });
});

// ---------------------------------------------------------------------------
// 3 · Envíos que no terminan de subir
// ---------------------------------------------------------------------------

describe('Vigilante · envíos a medias y abandonados (se mide por actualizada_en, no por creada_en)', { timeout: 600_000 }, () => {
  it('subidas a medias (de 1 h a 24 h sin movimiento) salen en el parte; con más de 24 h pasan a abandonada con su evento', async () => {
    const dosHoras = await insertarSintetica({ ref: nuevaRef(), creada: hace(120), actualizada: hace(120) });
    const veinticincoHoras = await insertarSintetica({ ref: nuevaRef(), creada: hace(25 * 60), actualizada: hace(25 * 60) });
    const retomada = await insertarSintetica({ ref: nuevaRef(), creada: hace(30 * 60), actualizada: hace(90) }); // creada hace 30 h, con movimiento hace 90 min
    const reciente = await insertarSintetica({ ref: nuevaRef(), creada: hace(10), actualizada: hace(10) });
    const reciente2 = await insertarSintetica({ ref: nuevaRef(), creada: hace(30 * 60), actualizada: hace(30) }); // creada hace 30 h pero tocada hace 30 min

    const parte = await vigilar();
    assert.ok(parte.abandonadas >= 1, `Ha abandonado al menos la de 25 h (${parte.abandonadas})`);
    const enLista = new Map(parte.subidas_a_medias.map((s) => [s.ref, s]));

    // 2 h sin movimiento: sigue subiendo y sale en el parte, con los minutos desde su último movimiento
    assert.equal((await filaDe(dosHoras.ref)).estado, 'subiendo');
    assert.ok(enLista.has(dosHoras.ref));
    assert.ok(Math.abs(enLista.get(dosHoras.ref).minutos - 120) <= 3, `Lleva unos 120 min (${enLista.get(dosHoras.ref).minutos})`);
    assert.equal(enLista.get(dosHoras.ref).formulario, 'gnew');

    // 25 h: abandonada, con evento del vigilante, y ya no sale en la lista
    assert.equal((await filaDe(veinticincoHoras.ref)).estado, 'abandonada');
    assert.ok(!enLista.has(veinticincoHoras.ref));
    const eventos = await seleccionar('tramitacion_eventos', { select: 'tipo,actor,detalle', tramitacion_id: `eq.${veinticincoHoras.id}` });
    assert.deepEqual(eventos, [{ tipo: 'abandonada', actor: 'vigilante', detalle: { motivo: 'sin_actividad', horas: 24 } }]);

    // creada hace 30 h pero con movimiento hace 90 min: NO se abandona (el criterio es actualizada_en) y los minutos cuentan desde ahí
    assert.equal((await filaDe(retomada.ref)).estado, 'subiendo', 'Una fila retomada de más de 24 h no se abandona');
    assert.ok(Math.abs(enLista.get(retomada.ref).minutos - 90) <= 3, `Lleva unos 90 min, no 1800 (${enLista.get(retomada.ref).minutos})`);

    // menos de 1 h sin movimiento: ni abandonada ni en la lista
    for (const fila of [reciente, reciente2]) {
      assert.equal((await filaDe(fila.ref)).estado, 'subiendo');
      assert.ok(!enLista.has(fila.ref), 'Todavía no es una subida a medias');
    }
    sinDatosPersonales(JSON.stringify(parte), 'con subidas a medias');
    for (const ref of [dosHoras.ref, retomada.ref]) {
      assert.deepEqual(Object.keys(enLista.get(ref)).sort(), ['actualizada_en', 'creada_en', 'formulario', 'minutos', 'ref']);
    }

    // una segunda pasada no vuelve a abandonar lo ya abandonado
    await vigilar();
    assert.equal((await seleccionar('tramitacion_eventos', { select: 'id', tramitacion_id: `eq.${veinticincoHoras.id}` })).length, 1);
  });

  it('reanudar una abandonada de hace más de 24 h (iniciar con su misma referencia) NO hace que el vigilante la vuelva a abandonar', async (t) => {
    const ref = nuevaRef();
    await insertarSintetica({ ref, creada: hace(26 * 60), actualizada: hace(25 * 60) });
    await vigilar();
    assert.equal((await filaDe(ref)).estado, 'abandonada', 'Sin movimiento en 25 h: abandonada');

    // El comercial vuelve y reenvía con la misma referencia: iniciar la reanuda
    const documentos = PEQUENOS();
    const r = await post('/api/tramitacion/iniciar', entradaIniciar({ ref, documentos }));
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.estado, 'subiendo');
    let e = await estadoDe(ref);
    assert.equal(e.tramitacion.estado, 'subiendo');
    assert.ok(tipos(e).includes('reanudada'));
    const antiguedad = Date.now() - Date.parse(e.tramitacion.creada_en);
    const sinMovimiento = Date.now() - Date.parse(e.tramitacion.actualizada_en);
    assert.ok(antiguedad > 25 * 60 * 60_000, 'La fila sigue siendo de hace más de 24 h…');
    assert.ok(sinMovimiento < 5 * 60_000, '…pero el UPDATE de la reanudación ha puesto actualizada_en en este momento');

    // El vigilante la deja en paz mientras sube
    const parte = await vigilar();
    assert.equal((await filaDe(ref)).estado, 'subiendo', 'No se vuelve a abandonar una fila reanudada');
    assert.ok(!parte.subidas_a_medias.some((s) => s.ref === ref), 'Y tampoco es una subida a medias: se acaba de mover');
    assert.equal(tipos(await estadoDe(ref)).filter((tipo) => tipo === 'abandonada').length, 1, 'Solo la abandonó una vez');

    // Termina de subir y se recibe con normalidad
    for (const s of r.json.subidas) await subir(s, documentos.find((d) => d.orden === s.orden).datos);
    const fin = await post('/api/tramitacion/confirmar', { formulario: 'gnew', token: FORM_TOKENS.gnew, ref });
    assert.equal(fin.status, 200, fin.texto);
    e = await estadoDe(ref);
    assert.equal(e.tramitacion.estado, 'recibida');
    t.diagnostic(`${ref}: creada hace 26 h → abandonada → reanudada → el vigilante no la toca → recibida`);
  });
});

// ---------------------------------------------------------------------------
// 4 · Aislamiento y limpieza
// ---------------------------------------------------------------------------

describe('Vigilante · aislamiento por modo y limpieza', { timeout: 600_000 }, () => {
  it('aislamiento por modo: el vigilante del servidor de pruebas no toca ni cuenta ni concilia nada que NO sea de prueba', async () => {
    const vieja = await insertarSintetica({ ref: nuevaRef(), prueba: false, creada: hace(30 * 60), actualizada: hace(30 * 60) });
    const sinCorreos = await insertarSintetica({ ref: nuevaRef(), prueba: false, estado: 'recibida', extra: { recibida_en: hace(5) } });
    const conCorreo = await insertarSintetica({ ref: nuevaRef(), prueba: false, estado: 'recibida', extra: { recibida_en: hace(60) } });
    const [aviso] = await insertar('tramitacion_correos', {
      tramitacion_id: conCorreo.id, tipo: 'aviso', marca: 'GNEW', para: 'victor.molins.10+aislamiento@gmail.com', asunto: 'Aislamiento', proximo_intento: hace(5), creado_en: hace(30),
    });
    const [acuse] = await insertar('tramitacion_correos', {
      tramitacion_id: conCorreo.id, tipo: 'acuse', marca: 'GNEW', para: 'victor.molins.10+aislamiento@gmail.com', asunto: 'Aislamiento', estado: 'agotado', intentos: 8, creado_en: hace(30),
    });

    const parte = await vigilar();

    assert.equal((await filaDe(vieja.ref)).estado, 'subiendo', 'Una subiendo de producción de hace 30 h no se abandona desde el servidor de pruebas');
    assert.ok(!parte.subidas_a_medias.some((s) => s.ref === vieja.ref), 'Ni sale en el parte');
    assert.deepEqual(await seleccionar('tramitacion_correos', { select: 'id', tramitacion_id: `eq.${sinCorreos.id}` }), [], 'No se concilia una recibida de producción');
    const [despues] = await seleccionar('tramitacion_correos', { id: `eq.${aviso.id}` });
    assert.deepEqual([despues.estado, despues.intentos, despues.enviado_en], ['pendiente', 0, null], 'No se intenta enviar un correo de producción');
    assert.ok(!parte.atascados.some((a) => a.id === aviso.id || a.id === acuse.id || a.ref === conCorreo.ref), 'Los atascos de producción no son asunto del servidor de pruebas');
  });

  it('limpieza (paso 4): borra cuotas y códigos de acceso de MÁS de un día, solo los de prueba, y deja lo reciente y lo ajeno', async () => {
    const azar = nonce(8);
    const viejo = `pruebas:vigilante-viejo-${azar}`;
    const reciente = `pruebas:vigilante-reciente-${azar}`;
    const ajeno = `vigilante-ajeno-${azar}`; // sin el prefijo pruebas:, como una cuota de producción
    const aliasViejo = `victor.molins.10+vigilante-viejo-${azar}@gmail.com`;
    const aliasReciente = `victor.molins.10+vigilante-reciente-${azar}@gmail.com`;
    const ajenoAcceso = `alguien.de.produccion-${azar}@example.invalid`;
    const caducada = hace(2 * MINUTOS_DIA);
    const acceso = (email, creado) => ({ email, codigo_hash: 'f'.repeat(64), caduca_en: caducada, creado_en: creado });
    try {
      await insertar('tramitacion_cuotas', [
        { clave: viejo, ventana_inicio: caducada, cuenta: 3 },
        { clave: reciente, ventana_inicio: hace(10), cuenta: 1 },
        { clave: ajeno, ventana_inicio: caducada, cuenta: 1 },
      ], { devolver: false });
      await insertar('tramitacion_accesos', [
        acceso(aliasViejo, caducada),
        acceso(aliasReciente, hace(10)),
        acceso(ajenoAcceso, caducada),
      ], { devolver: false });

      const parte = await vigilar();
      assert.ok(parte.limpiados.cuotas >= 1 && parte.limpiados.accesos >= 1, JSON.stringify(parte.limpiados));

      const cuotas = (await seleccionar('tramitacion_cuotas', { select: 'clave', clave: `in.(${viejo},${reciente},${ajeno})` })).map((c) => c.clave).sort();
      assert.deepEqual(cuotas, [ajeno, reciente].sort(), 'Cae la cuota de prueba de más de un día; la reciente y la que no es de prueba se quedan');
      const accesos = (await seleccionar('tramitacion_accesos', { select: 'email', email: `in.(${aliasViejo},${aliasReciente},${ajenoAcceso})` })).map((c) => c.email).sort();
      assert.deepEqual(accesos, [aliasReciente, ajenoAcceso].sort(), 'Cae el código de un alias de prueba de más de un día; el reciente y el de un correo que no es de prueba se quedan');
    } finally {
      await borrar('tramitacion_cuotas', { clave: `in.(${viejo},${reciente},${ajeno})` });
      await borrar('tramitacion_accesos', { email: `in.(${aliasViejo},${aliasReciente},${ajenoAcceso})` });
    }
  });
});
