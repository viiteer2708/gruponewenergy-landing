// tests/api/20-bandeja.test.mjs · Pruebas de API de la bandeja de backoffice (orden 4): código de acceso, sesión,
// lista, ficha, estado y «volver a enviar»; (14-oct-2026) quién ha abierto cada ficha: evento `ficha_abierta` y `vistas`; y
// (16-oct-2026) «Marcar como sin abrir»: evento `marcada_sin_abrir` (POST /api/bandeja/estado {ref, accion:'sin_abrir'}) y el
// NOMBRE de quien entra (GET/POST /api/bandeja/yo): cada persona lo escribe la primera vez y es el «quién» de abrir, marcar sin abrir,
// tramitar y volver a enviar (sin nombre, el correo, y la ficha no apunta aperturas).
//
// Necesita el servidor local en marcha y la base REAL de Supabase (todo lo que se escribe lleva prueba=true y vive bajo
// pruebas/ en el almacén; se borra con scripts/limpiar-pruebas.mjs --todo):
//
//   node tests/servidor-local.mjs &    →    node --test tests/api/20-bandeja.test.mjs    →    node scripts/limpiar-pruebas.mjs --todo    →    kill <PID>
//
// Se «hace de navegador» con fetch: JSON a /api/bandeja/*, con la cookie de sesión reenviada a mano (fetch de Node no
// guarda cookies). El código de acceso se lee del correo SIMULADO (/__pruebas/correos); el resto de la base se lee por
// el gancho /__pruebas/tramitacion o, para lo que el gancho no enseña (accesos), con la clave de servicio de .env.local.
// Altavoz es siempre simulado. Solo se usan alias de Victor (victor.molins.10+algo@gmail.com).
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  MINUTOS_ENTRE_APERTURAS, ficha as fichaEnEsteProceso, marcarSinAbrir as marcarEnEsteProceso, respuestaDeError,
} from '../../api/_lib/bandeja.js';
import { FORM_TOKENS, secretoBandeja, supabaseUrl } from '../../api/_lib/config.js';
import { NOMBRE_COOKIE, firmarSesion, hashCodigo } from '../../api/_lib/sesion.js';
import { actualizar, borrar, insertar, seleccionar } from '../../api/_lib/supabase.js';
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

// El correo con acceso es el primero de BANDEJA_EMAILS (un alias de Victor en pruebas). Nunca se imprime.
const EMAIL = String(process.env.BANDEJA_EMAILS ?? '').split(',')[0].trim().toLowerCase();
const FUERA = 'victor.molins.10+fuera@gmail.com'; // alias sin acceso
const ES_ALIAS = /^victor\.molins\.10\+[a-z0-9._-]+@gmail\.com$/;

// El nombre con el que las sesiones de estas pruebas firman lo que hacen (lo escribe `sesionNueva` con POST /api/bandeja/yo). Las
// pruebas que quieren una sesión SIN nombre —como las cookies de antes del nombre— la piden con `sesionNueva(EMAIL, null)` o la firman a mano.
const NOMBRE = 'PRUEBA API';
const FRASE_NOMBRE = 'Escribe tu nombre (solo letras, de 2 a 40).';

const EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com';
const EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com';
const IBAN = 'ES9121000418450200051332';
const IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332';
const CUPS = 'ES0021000000000001RK';
const CUPS_GAS = 'ES0031000000000003BS';

// Espera a los ficheros anteriores (00, 10): comparten el servidor local y su entorno. Ver ./hermanos.mjs.
before(() => esperarAHermanosAnteriores(import.meta.url), { timeout: 10 * 60_000 });

const FRASE_CODIGO = 'Si tu correo tiene acceso, te hemos enviado un código de 6 cifras. Caduca en 10 minutos. Revisa también el spam.';
const FRASE_CODIGO_MALO = 'El código no es correcto o ha caducado. Pide uno nuevo.';
const FRASE_SESION = 'Tu sesión ha caducado o no es válida. Vuelve a entrar.';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function llamar(metodo, ruta, { cuerpo, cabeceras = {}, tipo = 'application/json', cookie } = {}) {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo !== undefined ? { 'Content-Type': tipo } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...cabeceras,
    },
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
  return { status: respuesta.status, json, texto, cabeceras: respuesta.headers, cookies: respuesta.headers.getSetCookie() };
}

const post = (ruta, cuerpo, opciones) => llamar('POST', ruta, { cuerpo, ...opciones });
const get = (ruta, opciones) => llamar('GET', ruta, opciones);

/** IP de mentira propia de cada prueba: sus cuotas empiezan de cero. */
const ipNueva = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
const desde = (ip) => ({ 'x-forwarded-for': ip });

const sesionDe = (cookies) => {
  const crudo = cookies.find((c) => c.startsWith(`${NOMBRE_COOKIE}=`));
  return crudo ? crudo.split(';')[0] : null;
};

async function cambiarEntorno(cambios) {
  const r = await post('/__pruebas/env', cambios);
  assert.equal(r.status, 200, 'El gancho de entorno debe aceptar la variable');
  return r.json.previo;
}

/** Último código enviado a `email`, leído del correo SIMULADO (el único sitio donde el cuerpo queda guardado). */
async function ultimoCodigo(email) {
  const r = await get(`/__pruebas/correos?para=${encodeURIComponent(email)}&tipo=codigo_acceso`);
  assert.equal(r.status, 200, r.texto);
  const enviados = r.json.correos
    .filter((c) => c.estado === 'enviado' && typeof c.cuerpo_texto === 'string')
    .sort((a, b) => Date.parse(b.enviado_en) - Date.parse(a.enviado_en));
  assert.ok(enviados.length > 0, 'Debe haber un correo de código simulado para ese alias');
  const m = /es (\d{6})\./.exec(enviados[0].cuerpo_texto);
  assert.ok(m, 'El correo debe llevar el código de 6 cifras');
  return { codigo: m[1], correo: enviados[0] };
}

/** Pide un código y lo lee. */
async function pedirYLeer(email = EMAIL, ip = ipNueva()) {
  const r = await post('/api/bandeja/codigo', { email }, { cabeceras: desde(ip) });
  assert.equal(r.status, 200, r.texto);
  return { ...(await ultimoCodigo(email)), ip };
}

/**
 * Sesión completa: pide el código, lo teclea, escribe el nombre (POST /api/bandeja/yo) y devuelve la cookie —la NUEVA, con nombre— lista
 * para reenviar. Con `nombre = null` se queda con la de `entrar`, que no lleva nombre (como las sesiones de antes del nombre).
 */
async function sesionNueva(email = EMAIL, nombre = NOMBRE) {
  const { codigo, ip } = await pedirYLeer(email);
  const r = await post('/api/bandeja/entrar', { email, codigo }, { cabeceras: desde(ip) });
  assert.equal(r.status, 200, r.texto);
  const cookie = sesionDe(r.cookies);
  assert.ok(cookie, 'Entrar debe dar la cookie de sesión');
  if (nombre === null) return cookie;
  const conNombre = await post('/api/bandeja/yo', { nombre }, { cookie });
  assert.equal(conNombre.status, 200, conNombre.texto);
  assert.equal(conNombre.json.nombre, nombre, 'El nombre de las pruebas ya viene limpio (en mayúsculas)');
  const nueva = sesionDe(conNombre.cookies);
  assert.ok(nueva, 'Escribir el nombre debe dar la cookie nueva');
  return nueva;
}

const accesosDe = (email) => seleccionar('tramitacion_accesos', { select: '*', email: `eq.${email}`, order: 'creado_en.desc' });

// -- datos de contrato -------------------------------------------------------------------------------------------

function nuevaRef(formulario = 'gnew') {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
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
    observaciones: 'Línea 1\nLínea 2 con <b>etiqueta</b> & más',
    terminos: true,
    ...extra,
  };
}

function datosMega(extra = {}) {
  const { compania, ...base } = datosGnew({ cups: CUPS_GAS, tarifa: 'RL.1', oferta: 'Gas fijo', titular: 'Titular Mega de Prueba SL' });
  assert.ok(compania);
  return { ...base, ...extra };
}

const documento = (orden, nombre, datos) => ({ orden, nombre, datos });
const FIRMA = `data:image/png;base64,${generarPng().toString('base64')}`;

const entradaIniciar = ({ formulario = 'gnew', ref, refAnterior = null, datos, documentos, firma = FIRMA, hp = '' }) => ({
  formulario,
  token: FORM_TOKENS[formulario],
  ref,
  ref_anterior: refAnterior,
  hp,
  datos: datos ?? (formulario === 'gnew' ? datosGnew() : datosMega()),
  firma,
  archivos: documentos.map(({ orden, nombre, datos: d }) => ({ orden, nombre, tamano: d.length })),
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

/** Empieza un envío (iniciar) y, si `completo`, sube los archivos y lo confirma. Devuelve la referencia. */
async function crearTramitacion({ formulario = 'gnew', datos, documentos, firma = FIRMA, completo = true, refAnterior = null, hp = '' }) {
  const ref = nuevaRef(formulario);
  const r1 = await post('/api/tramitacion/iniciar', entradaIniciar({ formulario, ref, refAnterior, datos, documentos, firma, hp }));
  assert.equal(r1.status, 200, r1.texto);
  if (!completo || hp) return ref;
  for (const s of r1.json.subidas) await subir(s, documentos.find((d) => d.orden === s.orden).datos);
  const r2 = await post('/api/tramitacion/confirmar', { formulario, token: FORM_TOKENS[formulario], ref });
  assert.equal(r2.status, 200, r2.texto);
  assert.equal(r2.json.listo, true);
  return ref;
}

async function estadoDe(ref) {
  const r = await get(`/__pruebas/tramitacion?ref=${ref}`);
  assert.equal(r.status, 200, `La tramitación ${ref} debe existir en la base de pruebas`);
  return r.json;
}

const tipos = (e) => e.eventos.map((x) => x.tipo);
const correoDe = (e, tipo) => e.correos.find((c) => c.tipo === tipo);
const PEQUENOS = () => [
  documento(1, 'contrato.pdf', generarPdf(4096)),
  documento(2, 'dni.jpg', generarJpeg()),
  documento(3, 'factura.png', generarPng()),
];

/** Decodifica el JWT de una URL firmada (solo la carga, sin comprobar la firma): para ver cuánto tiempo vale. */
function cargaDelToken(url) {
  const token = new URL(url).searchParams.get('token');
  assert.ok(token, 'La URL firmada lleva token');
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------
// Parte 1 · acceso: código, sesión, cuotas
// ---------------------------------------------------------------------------

describe('Bandeja · acceso (código por email, sesión y cuotas)', { timeout: 600_000 }, () => {
  before(async () => {
    assert.match(EMAIL, ES_ALIAS, 'BANDEJA_EMAILS debe empezar por un alias de Victor (victor.molins.10+algo@gmail.com) en las pruebas');
    for (let intento = 0; intento < 40; intento++) {
      try {
        const r = await get('/__pruebas/correos?tipo=aviso');
        if (r.status === 200 && r.json?.ok) return;
      } catch {
        // el servidor aún no ha arrancado
      }
      await esperar(500);
    }
    throw new Error('El servidor local no responde en 127.0.0.1:8765: arráncalo con «node tests/servidor-local.mjs &».');
  });

  it('sin cookie, todo lo que lleva sesión da 401 «sesion» (y no manda ninguna cookie)', async () => {
    const intentos = [
      get('/api/bandeja/yo'),
      get('/api/bandeja/lista'),
      get('/api/bandeja/ficha?ref=GNE-20261009-ABCDEF'),
      post('/api/bandeja/estado', { ref: 'GNE-20261009-ABCDEF', accion: 'tramitar' }),
      post('/api/bandeja/reenviar', { ref: 'GNE-20261009-ABCDEF', tipo: 'aviso' }),
      post('/api/bandeja/yo', { nombre: 'Laura García' }),
    ];
    for (const r of await Promise.all(intentos)) {
      assert.equal(r.status, 401, r.texto);
      assert.deepEqual(r.json, { ok: false, codigo: 'sesion', mensaje: FRASE_SESION, retryable: false });
      assert.deepEqual(r.cookies, [], 'Sin cookie de entrada no hay nada que borrar');
      assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    }
  });

  it('pedir código: el correo SIN acceso recibe la misma respuesta y no se envía nada; el correo CON acceso recibe su código, que solo queda como hash', async (t) => {
    const ipFuera = ipNueva();
    const antes = Date.now();
    const rFuera = await post('/api/bandeja/codigo', { email: FUERA }, { cabeceras: desde(ipFuera) });
    const rDentro = await post('/api/bandeja/codigo', { email: EMAIL.toUpperCase() }, { cabeceras: desde(ipNueva()) }); // sin mayúsculas ni espacios
    assert.equal(rFuera.status, 200, rFuera.texto);
    assert.equal(rDentro.status, 200, rDentro.texto);
    assert.deepEqual(rFuera.json, { ok: true, mensaje: FRASE_CODIGO });
    assert.deepEqual(rDentro.json, rFuera.json, 'La respuesta no puede delatar quién tiene acceso');
    assert.equal(rFuera.texto, rDentro.texto, 'Ni siquiera un byte distinto');
    assert.equal(rFuera.cabeceras.get('cache-control'), 'no-store');

    // fuera de la lista: ni correo ni código
    const correosFuera = await get(`/__pruebas/correos?para=${encodeURIComponent(FUERA)}&tipo=codigo_acceso`);
    assert.deepEqual(correosFuera.json.correos, [], 'Fuera de la lista no sale ningún correo');
    assert.deepEqual(await accesosDe(FUERA), [], 'Fuera de la lista no se guarda ningún código');
    assert.deepEqual(await seleccionar('tramitacion_correos', { select: 'id', para: `eq.${FUERA}` }), [], 'Ni siquiera un apunte de correo');

    // con acceso: el correo simulado (solo texto, marca GNEW, etiqueta bandeja-codigo)
    const { codigo, correo } = await ultimoCodigo(EMAIL);
    assert.match(codigo, /^\d{6}$/);
    assert.equal(correo.tipo, 'codigo_acceso');
    assert.equal(correo.marca, 'GNEW');
    assert.equal(correo.etiqueta, 'bandeja-codigo');
    assert.equal(correo.tramitacion_id, null);
    assert.equal(correo.para, EMAIL);
    assert.equal(correo.responder_a, null);
    assert.equal(correo.cuerpo_html, null, 'El código solo va en texto');
    assert.equal(correo.simulado, true);
    assert.match(correo.altavoz_id, /^simulado-\d+$/);
    assert.equal(correo.asunto, 'Tu código para entrar en la bandeja de tramitación');
    assert.ok(!correo.asunto.includes(codigo), 'El código no va en el asunto');
    assert.equal(correo.cuerpo_texto, `Tu código para entrar en la bandeja de tramitación es ${codigo}. Caduca en 10 minutos. Si no lo has pedido tú, ignora este correo.`);
    assert.ok(Date.parse(correo.enviado_en) >= antes - 2000);

    // en la base: el HMAC, nunca el código
    const [acceso] = await accesosDe(EMAIL);
    assert.equal(acceso.codigo_hash, hashCodigo(EMAIL, codigo, secretoBandeja()), 'Se guarda el HMAC(secreto, email + código)');
    assert.match(acceso.codigo_hash, /^[0-9a-f]{64}$/);
    for (const [columna, valor] of Object.entries(acceso)) assert.notEqual(String(valor), codigo, `La columna ${columna} no puede ser el código en claro`);
    assert.equal(acceso.intentos, 0);
    assert.equal(acceso.usado_en, null);
    assert.match(acceso.ip_hash, /^[0-9a-f]{32}$/, 'De la IP solo se guarda su HMAC');
    const vida = Date.parse(acceso.caduca_en) - Date.now();
    assert.ok(vida > 9 * 60_000 && vida <= 10 * 60_000 + 2000, `El código caduca a los 10 minutos (${Math.round(vida / 1000)} s)`);
    t.diagnostic('correo con acceso: código enviado (solo hash en la base); correo sin acceso: misma respuesta, 0 correos, 0 accesos');
  });

  it('entrar: el código correcto da la cookie (HttpOnly, SameSite=Lax, 365 días), `yo` dice quién es y el código solo vale una vez', async () => {
    const { codigo, ip } = await pedirYLeer();
    const r = await post('/api/bandeja/entrar', { email: EMAIL, codigo: ` ${codigo.slice(0, 3)} ${codigo.slice(3)} ` }, { cabeceras: desde(ip) }); // con espacios
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.cookies.length, 1);
    const [pares, ...atributos] = r.cookies[0].split(';').map((x) => x.trim());
    assert.match(pares, /^bandeja_sesion=[A-Za-z0-9_.-]+$/);
    assert.ok(atributos.includes('HttpOnly') && atributos.includes('SameSite=Lax') && atributos.includes('Path=/') && atributos.includes('Max-Age=31536000'), `Atributos: ${atributos.join(' · ')}`);
    assert.ok(!atributos.includes('Secure'), 'Por http en local no lleva Secure');
    assert.ok(!r.texto.includes(pares.split('=')[1]), 'La cookie no viaja en el cuerpo');

    const cookie = pares;
    const yo = await get('/api/bandeja/yo', { cookie });
    assert.equal(yo.status, 200);
    assert.deepEqual(yo.json, { ok: true, email: EMAIL, nombre: null }, 'Entrar con el código no da nombre: se escribe después (`yo`)');

    const [acceso] = await accesosDe(EMAIL);
    assert.ok(acceso.usado_en, 'El código queda gastado');

    const otraVez = await post('/api/bandeja/entrar', { email: EMAIL, codigo }, { cabeceras: desde(ipNueva()) });
    assert.equal(otraVez.status, 401, 'Un código solo vale una vez');
    assert.deepEqual(otraVez.json, { ok: false, codigo: 'codigo', mensaje: FRASE_CODIGO_MALO, retryable: false });
    assert.deepEqual(otraVez.cookies, [], 'Un fallo no da cookie');
  });

  it('un código se gasta UNA sola vez aunque lleguen dos peticiones a la vez', async () => {
    const { codigo } = await pedirYLeer();
    const [a, b] = await Promise.all([
      post('/api/bandeja/entrar', { email: EMAIL, codigo }, { cabeceras: desde(ipNueva()) }),
      post('/api/bandeja/entrar', { email: EMAIL, codigo }, { cabeceras: desde(ipNueva()) }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401], `Una entra y la otra no (${a.status}, ${b.status})`);
  });

  it('entrar con un correo sin acceso, o con algo que no es un código: la misma frase, sin cookie y sin gastar intentos', async () => {
    const { codigo, ip } = await pedirYLeer(); // hay un código vivo para EMAIL
    const fuera = await post('/api/bandeja/entrar', { email: FUERA, codigo }, { cabeceras: desde(ip) });
    assert.equal(fuera.status, 401, fuera.texto);
    assert.deepEqual(fuera.json, { ok: false, codigo: 'codigo', mensaje: FRASE_CODIGO_MALO, retryable: false });
    for (const raro of ['', 'abc', '12345', '1234567', '12 34 5x']) {
      const r = await post('/api/bandeja/entrar', { email: EMAIL, codigo: raro }, { cabeceras: desde(ipNueva()) });
      assert.equal(r.status, 401, `«${raro}»`);
      assert.equal(r.json.mensaje, FRASE_CODIGO_MALO);
    }
    const [acceso] = await accesosDe(EMAIL);
    assert.equal(acceso.intentos, 0, 'Lo que no puede ser un código no cuenta como intento');
    assert.equal(acceso.usado_en, null);
    // y el código bueno sigue entrando
    assert.equal((await post('/api/bandeja/entrar', { email: EMAIL, codigo }, { cabeceras: desde(ipNueva()) })).status, 200);
  });

  it('código erróneo: 4 fallos dan 401, el 5.º da 429 y el código queda quemado (ni el correcto entra); uno nuevo sí', async () => {
    const { codigo, ip } = await pedirYLeer();
    const malo = codigo === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await post('/api/bandeja/entrar', { email: EMAIL, codigo: malo }, { cabeceras: desde(ip) });
      assert.equal(r.status, 401, `Fallo ${i}: ${r.texto}`);
      assert.equal(r.json.mensaje, FRASE_CODIGO_MALO);
    }
    const quinto = await post('/api/bandeja/entrar', { email: EMAIL, codigo: malo }, { cabeceras: desde(ip) });
    assert.equal(quinto.status, 429, quinto.texto);
    assert.deepEqual(quinto.json, { ok: false, codigo: 'demasiados', mensaje: 'Has probado demasiadas veces. Pide un código nuevo.', retryable: false });
    const correcto = await post('/api/bandeja/entrar', { email: EMAIL, codigo }, { cabeceras: desde(ip) });
    assert.equal(correcto.status, 429, 'Quemado: ni el código correcto entra');
    assert.deepEqual(correcto.cookies, []);
    const [quemado] = await accesosDe(EMAIL);
    assert.equal(quemado.intentos, 5);
    assert.equal(quemado.usado_en, null);
    // pedir uno nuevo lo arregla
    const nuevo = await pedirYLeer();
    assert.equal((await post('/api/bandeja/entrar', { email: EMAIL, codigo: nuevo.codigo }, { cabeceras: desde(ipNueva()) })).status, 200);
  });

  it('un código caducado da 401 y no se gasta; un código nuevo anula el anterior', async () => {
    const caducado = await pedirYLeer();
    const [fila] = await accesosDe(EMAIL);
    await actualizar('tramitacion_accesos', { id: `eq.${fila.id}` }, { caduca_en: new Date(Date.now() - 60_000).toISOString() });
    const r = await post('/api/bandeja/entrar', { email: EMAIL, codigo: caducado.codigo }, { cabeceras: desde(ipNueva()) });
    assert.equal(r.status, 401, r.texto);
    assert.equal(r.json.mensaje, FRASE_CODIGO_MALO);
    assert.equal((await accesosDe(EMAIL))[0].usado_en, null, 'Un código caducado no se marca como usado');

    const primero = await pedirYLeer();
    const segundo = await pedirYLeer();
    assert.notEqual(primero.codigo, segundo.codigo);
    const viejo = await post('/api/bandeja/entrar', { email: EMAIL, codigo: primero.codigo }, { cabeceras: desde(ipNueva()) });
    assert.equal(viejo.status, 401, 'El código anterior ya no vale');
    const vigente = await post('/api/bandeja/entrar', { email: EMAIL, codigo: segundo.codigo }, { cabeceras: desde(ipNueva()) });
    assert.equal(vigente.status, 200, 'El último sí');
  });

  it('cookie manipulada, caducada, sin firma válida o de un correo que ya no tiene acceso → 401 (y se borra la cookie rota)', async () => {
    const cookie = await sesionNueva();
    assert.equal((await get('/api/bandeja/yo', { cookie })).status, 200);
    const valor = cookie.split('=')[1];
    const [carga, firma] = valor.split('.');
    const ahora = Date.now();
    const cargaAjena = Buffer.from(JSON.stringify({ e: EMAIL, iat: 1, exp: Math.floor(ahora / 1000) + 10 ** 9 })).toString('base64url');
    // (la cookie de esta prueba lleva nombre: cambiarlo a mano tampoco vale; y un correo sin acceso no entra aunque lleve nombre)
    const cargaOtroNombre = Buffer.from(JSON.stringify({ e: EMAIL, iat: 1, exp: Math.floor(ahora / 1000) + 10 ** 9, n: 'OTRA PERSONA' })).toString('base64url');
    const malas = {
      'carga cambiada con la firma vieja': `${cargaAjena}.${firma}`,
      'nombre cambiado con la firma vieja': `${cargaOtroNombre}.${firma}`,
      'correo sin acceso (bien firmada y con nombre)': firmarSesion(FUERA, secretoBandeja(), { nombre: 'LAURA GARCÍA' }),
      'firma cambiada': `${carga}.${firma.slice(0, -2)}${firma.endsWith('A') ? 'BB' : 'AA'}`,
      'sin firma': carga,
      'basura': 'esto.no.es.una.cookie',
      'caducada (hace 366 días)': firmarSesion(EMAIL, secretoBandeja(), { ahora: ahora - 366 * 24 * 3600 * 1000 }),
      'firmada con otro secreto': firmarSesion(EMAIL, 'otro-secreto-que-no-es-el-de-la-bandeja-0123456789'),
      'correo sin acceso (bien firmada)': firmarSesion(FUERA, secretoBandeja()),
    };
    for (const [motivo, valorMalo] of Object.entries(malas)) {
      const r = await get('/api/bandeja/yo', { cookie: `${NOMBRE_COOKIE}=${valorMalo}` });
      assert.equal(r.status, 401, `${motivo}: ${r.texto}`);
      assert.equal(r.json.codigo, 'sesion', motivo);
      assert.ok(r.cookies.some((c) => c.startsWith(`${NOMBRE_COOKIE}=;`) && c.includes('Max-Age=0')), `${motivo}: se borra la cookie rota`);
    }
    // y la buena sigue funcionando
    assert.equal((await get('/api/bandeja/yo', { cookie })).status, 200);
  });

  it('yo: sin nombre dice `nombre: null`; escribir el nombre da una cookie NUEVA (con el nombre limpio) y desde entonces `yo` lo dice; la cookie vieja sigue valiendo; se puede cambiar', async (t) => {
    const sinNombre = await sesionNueva(EMAIL, null);
    const antes = await get('/api/bandeja/yo', { cookie: sinNombre });
    assert.equal(antes.status, 200, antes.texto);
    assert.deepEqual(antes.json, { ok: true, email: EMAIL, nombre: null });
    assert.deepEqual(antes.cookies, [], 'Un GET no manda cookie');
    assert.equal(antes.cabeceras.get('cache-control'), 'no-store');

    const r = await post('/api/bandeja/yo', { nombre: '  laura   garcía ' }, { cookie: sinNombre });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, email: EMAIL, nombre: 'LAURA GARCÍA' }, 'Recortado, con los espacios juntados y en mayúsculas (tildes y Ñ intactas)');
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    assert.equal(r.cookies.length, 1);
    const [pares, ...atributos] = r.cookies[0].split(';').map((x) => x.trim());
    assert.match(pares, /^bandeja_sesion=[A-Za-z0-9_.-]+$/);
    assert.ok(atributos.includes('HttpOnly') && atributos.includes('SameSite=Lax') && atributos.includes('Path=/') && atributos.includes('Max-Age=31536000'), `Atributos: ${atributos.join(' · ')}`);
    assert.ok(!atributos.includes('Secure'), 'Por http en local no lleva Secure');
    assert.ok(!r.texto.includes(pares.split('=')[1]), 'La cookie no viaja en el cuerpo');
    const cookie = pares;
    assert.notEqual(cookie, sinNombre, 'Es otra cookie');
    assert.deepEqual((await get('/api/bandeja/yo', { cookie })).json, { ok: true, email: EMAIL, nombre: 'LAURA GARCÍA' });
    assert.deepEqual((await get('/api/bandeja/yo', { cookie: sinNombre })).json, { ok: true, email: EMAIL, nombre: null }, 'La anterior no se ha tocado: sigue valiendo, sin nombre');

    // se puede cambiar (otra persona en el mismo ordenador): la nueva lleva el nombre nuevo
    const cambio = await post('/api/bandeja/yo', { nombre: "pedro d'ñandú" }, { cookie });
    assert.equal(cambio.status, 200, cambio.texto);
    assert.equal(cambio.json.nombre, "PEDRO D'ÑANDÚ");
    assert.deepEqual((await get('/api/bandeja/yo', { cookie: sesionDe(cambio.cookies) })).json, { ok: true, email: EMAIL, nombre: "PEDRO D'ÑANDÚ" });

    // detrás de Vercel (https) la cookie nueva lleva Secure, como la de entrar
    const seguro = await post('/api/bandeja/yo', { nombre: 'ana' }, { cookie, cabeceras: { 'x-forwarded-proto': 'https' } });
    assert.ok(seguro.cookies[0].split(';').map((x) => x.trim()).includes('Secure'), seguro.cookies[0]);
    // el correo de la cookie nueva es el de la sesión, no el que mande el cliente
    const ajeno = await post('/api/bandeja/yo', { nombre: 'ana', email: FUERA }, { cookie });
    assert.equal(ajeno.json.email, EMAIL);
    assert.deepEqual((await get('/api/bandeja/yo', { cookie: sesionDe(ajeno.cookies) })).json, { ok: true, email: EMAIL, nombre: 'ANA' });
    t.diagnostic('yo: null → POST → cookie nueva con el nombre limpio; la vieja sigue valiendo; Secure con https; el correo sale de la sesión');
  });

  it('yo: un nombre que no vale → 400 con su frase en llano y la cookie no cambia; sin sesión → 401; solo JSON; otro método → 405', async () => {
    const cookie = await sesionNueva(EMAIL, null);
    for (const malo of ['', '   ', 'a', 'ana2', '2ana', 'ana@gmail.com', 'a'.repeat(41), '<b>ana</b>', '--', '😀😀', 'ana_lópez']) {
      const r = await post('/api/bandeja/yo', { nombre: malo }, { cookie });
      assert.equal(r.status, 400, `«${malo}»: ${r.texto}`);
      assert.deepEqual(r.json, { ok: false, codigo: 'nombre', mensaje: FRASE_NOMBRE, retryable: false });
      assert.deepEqual(r.cookies, [], 'Un nombre malo no da cookie');
    }
    for (const cuerpo of [{}, { nombre: 5 }, { nombre: null }, { nombre: ['ana'] }, { nombre: { a: 1 } }, { nombre: true }]) {
      const r = await post('/api/bandeja/yo', cuerpo, { cookie });
      assert.equal(r.status, 400, JSON.stringify(cuerpo));
      assert.equal(r.json.codigo, 'nombre', JSON.stringify(cuerpo));
      assert.equal(r.json.mensaje, FRASE_NOMBRE);
    }
    assert.equal((await post('/api/bandeja/yo', [], { cookie })).status, 400, 'Una lista no es un objeto');
    const roto = await llamar('POST', '/api/bandeja/yo', { cuerpo: '{"nombre": ', cookie });
    assert.equal(roto.status, 400, roto.texto);
    assert.equal(roto.json.codigo, 'peticion');
    const plano = await llamar('POST', '/api/bandeja/yo', { cuerpo: JSON.stringify({ nombre: 'Laura' }), tipo: 'text/plain', cookie });
    assert.equal(plano.status, 415, 'Un formulario ajeno (text/plain) no puede poner un nombre');
    assert.deepEqual((await get('/api/bandeja/yo', { cookie })).json, { ok: true, email: EMAIL, nombre: null }, 'Y la sesión sigue sin nombre');

    // sin sesión, con una cookie rota o de un correo sin acceso: 401 (y no se pone ningún nombre)
    const sin = await post('/api/bandeja/yo', { nombre: 'Laura' });
    assert.equal(sin.status, 401, sin.texto);
    assert.deepEqual(sin.json, { ok: false, codigo: 'sesion', mensaje: FRASE_SESION, retryable: false });
    assert.deepEqual(sin.cookies, []);
    for (const valor of ['basura.basura', firmarSesion(FUERA, secretoBandeja(), { nombre: 'LAURA' })]) {
      const rota = await post('/api/bandeja/yo', { nombre: 'Laura' }, { cookie: `${NOMBRE_COOKIE}=${valor}` });
      assert.equal(rota.status, 401, rota.texto);
      assert.ok(rota.cookies.some((c) => c.startsWith(`${NOMBRE_COOKIE}=;`) && c.includes('Max-Age=0')), 'Se borra la cookie rota, no se firma una nueva');
    }
    for (const metodo of ['PUT', 'DELETE', 'PATCH']) {
      const r = await llamar(metodo, '/api/bandeja/yo', { cookie });
      assert.equal(r.status, 405, metodo);
      assert.equal(r.cabeceras.get('allow'), 'GET, POST');
    }
  });

  it('salir borra la cookie (no necesita sesión) y solo acepta JSON', async () => {
    const r = await post('/api/bandeja/salir', {});
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.cookies.length, 1);
    assert.ok(r.cookies[0].startsWith(`${NOMBRE_COOKIE}=;`) && r.cookies[0].includes('Max-Age=0') && r.cookies[0].includes('HttpOnly'));
    const texto = await llamar('POST', '/api/bandeja/salir', { cuerpo: '{}', tipo: 'text/plain' });
    assert.equal(texto.status, 415);
    assert.equal((await get('/api/bandeja/salir')).status, 405);
  });

  it('formato de las peticiones: JSON roto → 400, text/plain → 415, método equivocado → 405, correo que no parece un correo → 400', async () => {
    for (const ruta of ['/api/bandeja/codigo', '/api/bandeja/entrar']) {
      const roto = await llamar('POST', ruta, { cuerpo: '{"email": ', cabeceras: desde(ipNueva()) });
      assert.equal(roto.status, 400, `${ruta}: ${roto.texto}`);
      assert.equal(roto.json.codigo, 'peticion');
      const plano = await llamar('POST', ruta, { cuerpo: JSON.stringify({ email: EMAIL, codigo: '123456' }), tipo: 'text/plain', cabeceras: desde(ipNueva()) });
      assert.equal(plano.status, 415, `${ruta}: un formulario ajeno no puede llegar hasta aquí`);
      assert.equal((await get(ruta)).status, 405);
      assert.equal((await post(ruta, [], { cabeceras: desde(ipNueva()) })).status, 400, 'Una lista no es un objeto');
      assert.equal((await post(ruta, { email: 42 }, { cabeceras: desde(ipNueva()) })).status, 400);
    }
    const sinCodigo = await post('/api/bandeja/entrar', { email: EMAIL }, { cabeceras: desde(ipNueva()) });
    assert.equal(sinCodigo.status, 400);
    for (const raro of ['', 'sin-arroba', 'a@b', 'dos@@gmail.com', `${'a'.repeat(300)}@gmail.com`]) {
      const r = await post('/api/bandeja/codigo', { email: raro }, { cabeceras: desde(ipNueva()) });
      assert.equal(r.status, 400, `«${raro.slice(0, 20)}»`);
      assert.deepEqual(r.json, { ok: false, codigo: 'email', mensaje: 'Escribe un correo electrónico válido.', retryable: false });
    }
    assert.equal(sesionDe((await get('/api/bandeja/yo')).cookies), null);
  });

  it('cuotas: por IP (códigos y entradas) y por correo; el 429 sale igual con o sin acceso; los límites se restauran', async () => {
    // 1) códigos por IP
    const ip = ipNueva();
    let previo = await cambiarEntorno({ CUOTA_CODIGO_IP_HORA: '2' });
    try {
      for (let i = 1; i <= 2; i++) assert.equal((await post('/api/bandeja/codigo', { email: FUERA }, { cabeceras: desde(ip) })).status, 200, `Código ${i}`);
      const tercera = await post('/api/bandeja/codigo', { email: FUERA }, { cabeceras: desde(ip) });
      assert.equal(tercera.status, 429, tercera.texto);
      assert.deepEqual(tercera.json, { ok: false, codigo: 'demasiados', mensaje: 'Has pedido demasiados códigos. Espera un rato antes de pedir otro.', retryable: false });
      assert.equal((await post('/api/bandeja/codigo', { email: FUERA }, { cabeceras: desde(ipNueva()) })).status, 200, 'Otra IP tiene su propio contador');
    } finally {
      await cambiarEntorno({ CUOTA_CODIGO_IP_HORA: previo.CUOTA_CODIGO_IP_HORA });
    }
    assert.equal((await post('/api/bandeja/codigo', { email: FUERA }, { cabeceras: desde(ip) })).status, 200, 'Restaurado el límite, la misma IP ya no está limitada');

    // 2) códigos por correo: el mismo 429 para un correo sin acceso y para uno con acceso (que ya ha pedido varios hoy)
    const desconocido = `victor.molins.10+cuota${randomInt(100000, 999999)}@gmail.com`;
    previo = await cambiarEntorno({ CUOTA_CODIGO_EMAIL_HORA: '1' });
    try {
      assert.equal((await post('/api/bandeja/codigo', { email: desconocido }, { cabeceras: desde(ipNueva()) })).status, 200);
      const sinAcceso = await post('/api/bandeja/codigo', { email: desconocido }, { cabeceras: desde(ipNueva()) });
      const conAcceso = await post('/api/bandeja/codigo', { email: EMAIL }, { cabeceras: desde(ipNueva()) }); // ya había pedido varios códigos esta hora
      assert.equal(sinAcceso.status, 429, sinAcceso.texto);
      assert.equal(conAcceso.status, 429, conAcceso.texto);
      assert.equal(sinAcceso.texto, conAcceso.texto, 'El 429 no delata quién tiene acceso');
    } finally {
      await cambiarEntorno({ CUOTA_CODIGO_EMAIL_HORA: previo.CUOTA_CODIGO_EMAIL_HORA });
    }
    assert.deepEqual(
      await seleccionar('tramitacion_cuotas', { select: 'clave', clave: 'like.*@*' }),
      [],
      'Las cuotas guardan hashes: ninguna clave lleva una dirección de correo',
    );

    // 3) entradas por IP: se cuentan aunque el correo no tenga acceso
    const ipEntrar = ipNueva();
    previo = await cambiarEntorno({ CUOTA_ENTRAR_IP_HORA: '2' });
    try {
      for (let i = 1; i <= 2; i++) assert.equal((await post('/api/bandeja/entrar', { email: FUERA, codigo: '123456' }, { cabeceras: desde(ipEntrar) })).status, 401);
      const tercera = await post('/api/bandeja/entrar', { email: FUERA, codigo: '123456' }, { cabeceras: desde(ipEntrar) });
      assert.equal(tercera.status, 429, tercera.texto);
      assert.deepEqual(tercera.json, { ok: false, codigo: 'demasiados', mensaje: 'Demasiados intentos desde tu conexión. Espera unos minutos.', retryable: false });
    } finally {
      await cambiarEntorno({ CUOTA_ENTRAR_IP_HORA: previo.CUOTA_ENTRAR_IP_HORA });
    }
  });

  it('Altavoz caído: el código no sale → 503 con su frase en llano, el código queda inutilizado y el intento anotado', async () => {
    const previo = await cambiarEntorno({ ALTAVOZ_SIMULAR_FALLO: '1' });
    let antes;
    try {
      antes = (await accesosDe(EMAIL)).length;
      const r = await post('/api/bandeja/codigo', { email: EMAIL }, { cabeceras: desde(ipNueva()) });
      assert.equal(r.status, 503, r.texto);
      assert.deepEqual(r.json, { ok: false, codigo: 'correo', mensaje: 'No hemos podido enviarte el código. Inténtalo de nuevo en un minuto.', retryable: true });
      const accesos = await accesosDe(EMAIL);
      assert.equal(accesos.length, antes + 1);
      assert.ok(accesos[0].usado_en, 'El código que no llegó a salir queda quemado');
      const [anotado] = await seleccionar('tramitacion_correos', { select: '*', tipo: 'eq.codigo_acceso', para: `eq.${EMAIL}`, order: 'creado_en.desc', limit: 1 });
      assert.equal(anotado.estado, 'agotado', 'Un código no se reintenta: queda en un estado final');
      assert.equal(anotado.codigo_respuesta, 'envio_no_disponible');
      assert.equal(anotado.cuerpo_texto, null);
      assert.equal(anotado.tramitacion_id, null);
      assert.equal(anotado.simulado, true, 'En simulación nada sale de verdad (y así la limpieza de pruebas lo encuentra)');
    } finally {
      await cambiarEntorno({ ALTAVOZ_SIMULAR_FALLO: previo.ALTAVOZ_SIMULAR_FALLO });
    }
    // y al volver Altavoz todo funciona
    const bien = await pedirYLeer();
    assert.equal((await post('/api/bandeja/entrar', { email: EMAIL, codigo: bien.codigo }, { cabeceras: desde(ipNueva()) })).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 · lista, ficha, estado y «volver a enviar»
// ---------------------------------------------------------------------------

describe('Bandeja · lista, ficha, estado y volver a enviar', { timeout: 900_000 }, () => {
  let cookie;
  let A; // GNEW completa: 3 documentos + firma
  let B; // MEGA completa: 1 documento
  let C; // GNEW todavía subiendo
  let D; // GNEW descartada (honeypot)
  let E; // GNEW abandonada (el comercial cambió la lista)
  let FALSA; // referencia válida que no existe

  const autorizado = (extra = {}) => ({ cookie, ...extra });

  before(async () => {
    assert.match(EMAIL, ES_ALIAS);
    cookie = await sesionNueva();
    FALSA = nuevaRef();

    A = await crearTramitacion({ documentos: PEQUENOS() });
    B = await crearTramitacion({ formulario: 'mega', documentos: [documento(1, 'contrato mega.pdf', generarPdf(2048))] });
    C = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Subiendo SL' }), documentos: [documento(1, 'pendiente.pdf', generarPdf(2048))], completo: false });
    D = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Bot SL' }), documentos: [documento(1, 'bot.pdf', generarPdf(2048))], hp: 'soy un robot' });
    const vieja = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Abandonado SL' }), documentos: [documento(1, 'vieja.pdf', generarPdf(2048))], completo: false });
    await crearTramitacion({ datos: datosGnew({ titular: 'Titular Abandonado SL' }), documentos: [documento(1, 'vieja.pdf', generarPdf(2048)), documento(2, 'nueva.jpg', generarJpeg())], completo: false, refAnterior: vieja });
    E = vieja;
    assert.equal((await estadoDe(E)).tramitacion.estado, 'abandonada');
  });

  it('lista (por defecto, «Pendientes»): las recibidas, con los campos justos y sin ningún dato bancario ni de contacto del cliente', async (t) => {
    const r = await get('/api/bandeja/lista', autorizado());
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    const porRef = new Map(r.json.items.map((i) => [i.ref, i]));
    assert.ok(porRef.has(A) && porRef.has(B), 'Salen las dos recibidas');
    for (const ref of [C, D, E]) assert.ok(!porRef.has(ref), `${ref}: lo que no está recibido no sale en Pendientes`);
    const a = porRef.get(A);
    assert.deepEqual(Object.keys(a).sort(), [
      'cups', 'compania', 'comercial_nombre', 'creada_en', 'estado', 'formulario', 'n_documentos', 'recibida_en', 'ref', 'tarifa', 'titular_nombre', 'vistas',
    ].sort());
    assert.deepEqual(a.vistas, [], 'Nadie ha abierto todavía la ficha de A: `vistas` va vacía, no ausente');
    assert.deepEqual(
      { formulario: a.formulario, estado: a.estado, compania: a.compania, titular_nombre: a.titular_nombre, cups: a.cups, comercial_nombre: a.comercial_nombre, tarifa: a.tarifa, n_documentos: a.n_documentos },
      { formulario: 'gnew', estado: 'recibida', compania: 'COMPAÑÍA DE PRUEBA', titular_nombre: 'TITULAR DE PRUEBA SL', cups: CUPS, comercial_nombre: 'COMERCIAL DE PRUEBA', tarifa: '2.0TD', n_documentos: 4 },
    );
    assert.ok(a.creada_en && a.recibida_en);
    assert.deepEqual(
      { formulario: porRef.get(B).formulario, compania: porRef.get(B).compania, n_documentos: porRef.get(B).n_documentos },
      { formulario: 'mega', compania: 'MEGA ENERGIA', n_documentos: 2 },
    );
    const crudo = JSON.stringify(r.json);
    for (const secreto of [IBAN, IBAN_TECLEADO, EMAIL_CLIENTE, EMAIL_COMERCIAL, '12345678Z', '600000000']) assert.ok(!crudo.includes(secreto), 'La lista no lleva datos que solo hacen falta en la ficha');
    const fechas = r.json.items.map((i) => Date.parse(i.creada_en));
    assert.deepEqual(fechas, [...fechas].sort((x, y) => y - x), 'Más recientes primero');
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    t.diagnostic(`pendientes: ${r.json.items.length} filas; A tiene 4 documentos (3 + la firma)`);
  });

  it('lista por estado: Tramitadas, Incompletas (subiendo + abandonada), Descartadas y Todas (sin las descartadas)', async () => {
    const refs = async (estado) => (await get(`/api/bandeja/lista?estado=${estado}`, autorizado())).json.items.map((i) => i.ref);
    const tramitadas = await refs('tramitadas');
    assert.ok(![A, B, C, D, E].some((r) => tramitadas.includes(r)), 'Todavía no hay ninguna tramitada entre las nuestras');
    const incompletas = await refs('incompletas');
    assert.ok(incompletas.includes(C) && incompletas.includes(E), 'Subiendo y abandonada salen en Incompletas');
    assert.ok(!incompletas.includes(A) && !incompletas.includes(D));
    const estados = new Map((await get('/api/bandeja/lista?estado=incompletas', autorizado())).json.items.map((i) => [i.ref, i.estado]));
    assert.equal(estados.get(C), 'subiendo');
    assert.equal(estados.get(E), 'abandonada');
    const descartadas = await refs('descartadas');
    assert.ok(descartadas.includes(D) && !descartadas.includes(A));
    const todas = await refs('todas');
    for (const ref of [A, B, C, E]) assert.ok(todas.includes(ref), `${ref} sale en Todas`);
    assert.ok(!todas.includes(D), 'Las descartadas no salen en Todas: tienen su propio filtro');
    assert.deepEqual(await refs('pendientes'), (await get('/api/bandeja/lista', autorizado())).json.items.map((i) => i.ref), 'Pendientes es el valor por defecto');
  });

  it('búsqueda: por titular, CUPS, referencia y comercial; sin tildes ni mayúsculas; varias palabras en cualquier orden; los símbolos raros no rompen nada', async () => {
    const buscar = async (q, estado = 'todas') => {
      const r = await get(`/api/bandeja/lista?estado=${estado}&q=${encodeURIComponent(q)}`, autorizado());
      assert.equal(r.status, 200, `«${q}»: ${r.texto}`);
      return r.json.items.map((i) => i.ref);
    };
    assert.ok((await buscar('titular de prueba sl')).includes(A));
    assert.ok((await buscar('TITULAR DE PRUEBA')).includes(A), 'Sin distinguir mayúsculas');
    assert.ok((await buscar(CUPS.toLowerCase())).includes(A), 'Por CUPS');
    assert.ok((await buscar(A)).includes(A) && !(await buscar(A)).includes(B), 'Por referencia (solo esa)');
    assert.ok((await buscar('comercial de prueba')).includes(B), 'Por comercial');
    assert.ok((await buscar('compañía')).includes(A), 'Con tilde y ñ: «compañía» encuentra «compania»');
    assert.ok((await buscar('COMPAÑÍA de prueba')).includes(A));
    assert.ok((await buscar('prueba titular')).includes(A), 'Varias palabras: valen en cualquier orden');
    assert.ok((await buscar('mega energia')).includes(B), 'Por compañía');
    assert.deepEqual(await buscar('titular zzzinexistente'), [], 'Todas las palabras tienen que aparecer');
    assert.ok(!(await buscar('subiendo')).includes(A));
    assert.ok((await buscar('subiendo')).includes(C));
    assert.ok(!(await buscar('titular de prueba', 'tramitadas')).includes(A), 'La búsqueda respeta el filtro de estado');
    for (const rara of ["%", "_", "a,b", "(x)", "*", "'", '"', '\\', 'x;drop table', '&estado=todas', '..', ' ', '   ', 'a'.repeat(300)]) {
      const r = await get(`/api/bandeja/lista?q=${encodeURIComponent(rara)}`, autorizado());
      assert.equal(r.status, 200, `«${rara.slice(0, 15)}»: ${r.texto}`);
    }
    assert.equal((await get('/api/bandeja/lista?q=%25%25%25', autorizado())).json.items.length, (await get('/api/bandeja/lista', autorizado())).json.items.length, 'Los símbolos se quitan: «%%%» es como no buscar nada');
  });

  it('paginación: 30 por página, `siguiente` sin saltarse ni repetir ninguna fila (31 filas sueltas con fecha propia)', async (t) => {
    // Filas sueltas (sin documentos ni correos) de hace 10 días: más viejas que A y B (salen después en la lista) y fuera de la
    // ventana de 7 días de `conciliar`, que si no les crearía correos y estropearía los casos de la cola de 10-tramitacion.
    const hace10d = Date.now() - 10 * 24 * 3_600_000;
    const lote = String(randomInt(10000, 99999)); // marca propia: la búsqueda `lote<N>` solo encuentra estas 31 filas
    const filas = Array.from({ length: 31 }, (_, i) => {
      const ref = `GNE-20260101-P${lote}${String(i).padStart(2, '0')}`;
      const fecha = new Date(hace10d - i * 1000).toISOString(); // fechas distintas: la paginación es por fecha
      return {
        ref,
        formulario: 'gnew',
        estado: 'recibida',
        prueba: true,
        carpeta: `pruebas/gnew/2026/01/${ref}-paginaxxxxx`,
        comercial_nombre: 'Paginacion de Prueba',
        comercial_email: EMAIL_COMERCIAL,
        compania: 'Compañía de Prueba',
        cups: CUPS,
        titular_nombre: `Titular Pagina ${lote} ${String(i).padStart(2, '0')}`,
        titular_nif: '00000000T',
        iban: IBAN,
        direccion: 'Calle de Prueba 1',
        cp: '28001',
        poblacion: 'Madrid',
        provincia: 'Madrid',
        telefono: '600000000',
        email_cliente: EMAIL_CLIENTE,
        busqueda: `lote${lote} titular pagina`,
        creada_en: fecha,
        recibida_en: fecha,
      };
    });
    await insertar('tramitaciones', filas, { devolver: false });
    const propias = new Set(filas.map((f) => f.ref));
    try {
      const vistas = [];
      let antes;
      let paginas = 0;
      do {
        const url = `/api/bandeja/lista?estado=pendientes&q=lote${lote}${antes ? `&antes=${encodeURIComponent(antes)}` : ''}`;
        const r = await get(url, autorizado());
        assert.equal(r.status, 200, r.texto);
        assert.ok(r.json.items.length <= 30, 'Como mucho 30 por página');
        vistas.push(...r.json.items.map((i) => i.ref));
        antes = r.json.siguiente;
        paginas += 1;
        if (antes) assert.equal(r.json.items.length, 30, 'Si hay siguiente, esta página va llena');
      } while (antes && paginas < 5);
      assert.equal(paginas, 2, '31 filas = una página de 30 y otra de 1');
      assert.equal(new Set(vistas).size, vistas.length, 'Ninguna fila repetida');
      assert.deepEqual([...vistas].sort(), [...propias].sort(), 'Ninguna fila saltada');
      const sinFiltro = (await get('/api/bandeja/lista?estado=pendientes', autorizado())).json;
      assert.equal(sinFiltro.items.length, 30);
      assert.ok(sinFiltro.siguiente, 'Sin filtrar hay más de 30 pendientes: hay siguiente');
      t.diagnostic(`${paginas} páginas, ${vistas.length} filas propias sin repetir ni saltar`);
    } finally {
      await borrar('tramitaciones', { ref: `in.(${filas.map((f) => f.ref).join(',')})` }); // no se deja nada suelto
    }
  });

  it('parámetros de la lista que no valen → 400; método equivocado → 405', async () => {
    for (const ruta of ['/api/bandeja/lista?estado=cualquiera', '/api/bandeja/lista?estado=', '/api/bandeja/lista?antes=ayer', '/api/bandeja/lista?antes=2026-13-45T99:00:00Z', '/api/bandeja/lista?antes=1%27%20or%201=1']) {
      const r = await get(ruta, autorizado());
      assert.equal(r.status, 400, `${ruta}: ${r.texto}`);
      assert.equal(r.json.codigo, 'peticion');
    }
    assert.equal((await post('/api/bandeja/lista', {}, autorizado())).status, 405);
    assert.equal((await post('/api/bandeja/ficha', {}, autorizado())).status, 405);
    assert.equal((await get('/api/bandeja/estado', autorizado())).status, 405);
    assert.equal((await get('/api/bandeja/reenviar', autorizado())).status, 405);
    assert.equal((await llamar('PUT', '/api/bandeja/yo', autorizado())).status, 405, '`yo` admite GET y POST (el nombre): otro método no');
  });

  it('ficha: todos los datos (IBAN completo), documentos con enlaces de 10 minutos que responden 200 y no llevan el nombre del archivo, correos e historial', async (t) => {
    const r = await get(`/api/bandeja/ficha?ref=${A}`, autorizado());
    assert.equal(r.status, 200, r.texto);
    const { tramitacion: f, documentos, correos, eventos, enlaces_caducan_en: caducan } = r.json;

    // los datos
    assert.equal(f.ref, A);
    assert.deepEqual(
      { formulario: f.formulario, estado: f.estado, sospechosa: f.sospechosa, comercial_nombre: f.comercial_nombre, comercial_email: f.comercial_email, compania: f.compania, cups: f.cups },
      { formulario: 'gnew', estado: 'recibida', sospechosa: false, comercial_nombre: 'COMERCIAL DE PRUEBA', comercial_email: EMAIL_COMERCIAL, compania: 'COMPAÑÍA DE PRUEBA', cups: CUPS },
    );
    assert.equal(f.iban, IBAN, 'El IBAN sale completo');
    assert.deepEqual(
      { oferta: f.oferta, tarifa: f.tarifa, potencias: f.potencias, titular_nombre: f.titular_nombre, titular_nif: f.titular_nif, firmante_nombre: f.firmante_nombre, firmante_nif: f.firmante_nif },
      { oferta: 'FIJO 12 MESES', tarifa: '2.0TD', potencias: { p1: '4.6', p2: '4.6' }, titular_nombre: 'TITULAR DE PRUEBA SL', titular_nif: '00000000T', firmante_nombre: 'FIRMANTE DE PRUEBA', firmante_nif: '12345678Z' },
    );
    assert.deepEqual(
      { direccion: f.direccion, cp: f.cp, poblacion: f.poblacion, provincia: f.provincia, telefono: f.telefono, email_cliente: f.email_cliente, cambio_titular: f.cambio_titular, nuevo_titular: f.nuevo_titular },
      { direccion: 'CALLE DE PRUEBA 1, 2.º A', cp: '28001', poblacion: 'MADRID', provincia: 'MADRID', telefono: '600000000', email_cliente: EMAIL_CLIENTE, cambio_titular: false, nuevo_titular: null },
    );
    assert.equal(f.observaciones, 'LÍNEA 1\nLÍNEA 2 CON <B>ETIQUETA</B> & MÁS', 'Los datos viajan tal cual en el JSON (en mayúsculas, como se guardan); escaparlos es cosa de la página');
    assert.ok(f.creada_en && f.recibida_en && f.actualizada_en);
    assert.equal(f.tramitada_en, null);
    assert.equal(f.tramitada_por, null);
    for (const interno of ['id', 'carpeta', 'busqueda', 'ip_hash', 'navegador', 'prueba']) assert.ok(!(interno in f), `La ficha no enseña «${interno}»`);

    // los documentos y sus enlaces
    assert.deepEqual(documentos.map((d) => d.orden), [0, 1, 2, 3]);
    assert.deepEqual(documentos.map((d) => [d.nombre, d.tipo_mime, d.es_firma, d.subido]), [
      ['firma.png', 'image/png', true, true],
      ['contrato.pdf', 'application/pdf', false, true],
      ['dni.jpg', 'image/jpeg', false, true],
      ['factura.png', 'image/png', false, true],
    ]);
    const esperados = { 0: generarPng().length, 1: 4096, 2: generarJpeg().length, 3: generarPng().length };
    const prefijo = `${supabaseUrl()}/storage/v1/object/sign/tramitaciones/pruebas/gnew/`;
    for (const d of documentos) {
      assert.equal(d.tamano, esperados[d.orden], `Tamaño del documento ${d.orden}`);
      assert.ok(d.url.startsWith(prefijo), 'La URL es absoluta, del almacén y firmada');
      assert.match(d.url, new RegExp(`/${A}-[a-z2-7]{10}/0${d.orden}\\.(png|pdf|jpg)\\?token=`), 'La clave del objeto es <carpeta>/NN.ext');
      assert.ok(!/contrato|dni|factura|firma\.png/i.test(d.url), 'El nombre original no va en la URL');
      assert.ok(!d.url.includes(IBAN) && !d.url.includes('victor.molins'), 'Ni datos personales');
      const token = cargaDelToken(d.url);
      const vida = token.exp - Math.floor(Date.now() / 1000);
      assert.ok(vida > 540 && vida <= 605, `El enlace vale ~10 minutos (${vida} s)`);
      const descarga = await fetch(d.url, { headers: { Origin: BASE }, signal: AbortSignal.timeout(TOPE_MS) });
      assert.equal(descarga.status, 200, `El enlace del documento ${d.orden} debe responder 200`);
      assert.ok(descarga.headers.get('access-control-allow-origin'), 'Con CORS: el navegador puede leerlo para «Descargar» y el ZIP');
      const bytes = Buffer.from(await descarga.arrayBuffer());
      assert.equal(bytes.length, d.tamano, `El documento ${d.orden} baja entero`);
    }
    const margen = Date.parse(caducan) - Date.now();
    assert.ok(margen > 540_000 && margen <= 605_000, `enlaces_caducan_en es dentro de ~10 minutos (${Math.round(margen / 1000)} s)`);

    // correos e historial
    assert.deepEqual(correos.map((c) => c.tipo), ['acuse', 'aviso']);
    for (const c of correos) {
      assert.deepEqual(Object.keys(c).sort(), ['codigo_respuesta', 'enviado_en', 'estado', 'intentos', 'tipo']);
      assert.equal(c.estado, 'enviado');
      assert.equal(c.intentos, 1);
      assert.ok(c.enviado_en);
    }
    assert.deepEqual(eventos.map((e) => e.tipo), ['creada', 'firma_guardada', 'recibida', 'aviso_enviado', 'acuse_enviado'], 'Del más antiguo al más nuevo');
    assert.deepEqual(Object.keys(eventos[0]).sort(), ['actor', 'creado_en', 'detalle', 'tipo']);
    assert.deepEqual(eventos[2].detalle.n_documentos, 4);
    assert.ok(eventos.length <= 50);
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    t.diagnostic('ficha de A: IBAN completo, 4 enlaces de 10 min que dan 200 con CORS y sin el nombre del archivo');
  });

  it('ficha de una MEGA, de una que sigue subiendo (sin enlaces), de una abandonada y de una descartada (sin documentos: no revienta)', async () => {
    const m = (await get(`/api/bandeja/ficha?ref=${B}`, autorizado())).json;
    assert.equal(m.tramitacion.formulario, 'mega');
    assert.equal(m.tramitacion.tipo_suministro, 'GAS');
    assert.equal(m.tramitacion.compania, 'MEGA ENERGIA');
    assert.deepEqual(m.documentos.map((d) => d.nombre), ['firma.png', 'contrato mega.pdf']);

    const c = (await get(`/api/bandeja/ficha?ref=${C}`, autorizado())).json;
    assert.equal(c.tramitacion.estado, 'subiendo');
    assert.deepEqual(c.documentos.map((d) => [d.orden, d.subido, d.url]), [[0, true, c.documentos[0].url], [1, false, null]], 'Lo que no ha subido no tiene enlace');
    assert.ok(c.documentos[0].url, 'La firma (que sube el servidor) sí');
    assert.deepEqual(c.correos, [], 'Aún no hay correos');

    const e = (await get(`/api/bandeja/ficha?ref=${E}`, autorizado())).json;
    assert.equal(e.tramitacion.estado, 'abandonada');
    assert.ok(e.eventos.some((x) => x.tipo === 'abandonada' && x.actor === 'comercial'));

    const d = await get(`/api/bandeja/ficha?ref=${D}`, autorizado());
    assert.equal(d.status, 200, d.texto);
    assert.equal(d.json.tramitacion.estado, 'descartada');
    assert.equal(d.json.tramitacion.sospechosa, true);
    assert.deepEqual(d.json.documentos, []);
    assert.deepEqual(d.json.correos, []);
    assert.equal(d.json.enlaces_caducan_en, null);
    assert.ok(d.json.eventos.some((x) => x.tipo === 'descartada'));
  });

  it('ficha: una referencia que no existe, que no tiene forma de referencia o que trae trampas → 404 en llano', async () => {
    const malas = [FALSA, 'GNE-1', '', 'nada', '../../etc/passwd', `${A}&select=*`, `${A}%00`, `${A.toLowerCase()}`, 'MEGA-20261009-ABC', "GNE-20261009-ABCDEF'--", 'GNE-20261009-ABCDEF\nGNE-20261009-ABCDEF'];
    for (const ref of malas) {
      const r = await get(`/api/bandeja/ficha?ref=${encodeURIComponent(ref)}`, autorizado());
      assert.equal(r.status, 404, `«${ref.slice(0, 30)}»: ${r.texto}`);
      assert.deepEqual(r.json, { ok: false, codigo: 'no_encontrada', mensaje: 'No encontramos esta tramitación.', retryable: false });
    }
    assert.equal((await get('/api/bandeja/ficha', autorizado())).status, 404, 'Sin ref');
  });

  it('con TRAMITACION_PRUEBA=0 las filas de prueba no salen (ni en la lista ni en la ficha) y al restaurar vuelven', async () => {
    const previo = await cambiarEntorno({ TRAMITACION_PRUEBA: '0' });
    try {
      const lista = await get('/api/bandeja/lista?estado=todas', autorizado());
      assert.equal(lista.status, 200, lista.texto);
      assert.ok(!lista.json.items.some((i) => [A, B, C, E].includes(i.ref)), 'Las filas de prueba no se ven en modo producción');
      const ficha = await get(`/api/bandeja/ficha?ref=${A}`, autorizado());
      assert.equal(ficha.status, 404, ficha.texto);
      assert.equal((await get('/api/bandeja/yo', autorizado())).status, 200, 'La sesión no depende del modo');
    } finally {
      await cambiarEntorno({ TRAMITACION_PRUEBA: previo.TRAMITACION_PRUEBA });
    }
    assert.equal((await get(`/api/bandeja/ficha?ref=${A}`, autorizado())).status, 200, 'Restaurado, la fila de prueba vuelve a verse');
    assert.ok((await get('/api/bandeja/lista', autorizado())).json.items.some((i) => i.ref === A));
  });

  it('estado: tramitar guarda quién (el NOMBRE de la sesión) y cuándo, volver a pendiente lo borra, y cada paso deja su evento con ese nombre', async (t) => {
    const antes = Date.now();
    const r1 = await post('/api/bandeja/estado', { ref: A, accion: 'tramitar' }, autorizado());
    assert.equal(r1.status, 200, r1.texto);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.estado, 'tramitada');
    assert.equal(r1.json.tramitada_por, NOMBRE);
    assert.ok(!r1.texto.includes(EMAIL), 'El correo no viaja en la respuesta: el «quién» es el nombre');
    assert.ok(Date.parse(r1.json.tramitada_en) >= antes - 2000);
    let e = await estadoDe(A);
    assert.equal(e.tramitacion.estado, 'tramitada');
    assert.equal(e.tramitacion.tramitada_por, NOMBRE);
    assert.ok(e.tramitacion.tramitada_en);
    const ev = e.eventos.find((x) => x.tipo === 'tramitada');
    assert.equal(ev.actor, NOMBRE);
    assert.deepEqual(ev.detalle, {}, 'El detalle sigue sin datos personales: ni el nombre ni el correo');

    // en la ficha y en la lista
    const ficha = (await get(`/api/bandeja/ficha?ref=${A}`, autorizado())).json.tramitacion;
    assert.deepEqual([ficha.estado, ficha.tramitada_por], ['tramitada', NOMBRE]);
    assert.ok(!(await get('/api/bandeja/lista?estado=pendientes', autorizado())).json.items.some((i) => i.ref === A));
    assert.ok((await get('/api/bandeja/lista?estado=tramitadas', autorizado())).json.items.some((i) => i.ref === A));

    // repetirlo no vale
    const otra = await post('/api/bandeja/estado', { ref: A, accion: 'tramitar' }, autorizado());
    assert.equal(otra.status, 409, otra.texto);
    assert.deepEqual(otra.json, { ok: false, codigo: 'transicion', mensaje: 'Esta tramitación ya no está como creías. Recarga la página para ver cómo está ahora.', retryable: false });

    // volver a pendiente
    const r2 = await post('/api/bandeja/estado', { ref: A, accion: 'reabrir' }, autorizado());
    assert.equal(r2.status, 200, r2.texto);
    assert.deepEqual(r2.json, { ok: true, estado: 'recibida', tramitada_por: null, tramitada_en: null });
    e = await estadoDe(A);
    assert.equal(e.tramitacion.estado, 'recibida');
    assert.equal(e.tramitacion.tramitada_por, null);
    assert.equal(e.tramitacion.tramitada_en, null);
    const reabierta = e.eventos.find((x) => x.tipo === 'reabierta');
    assert.equal(reabierta.actor, NOMBRE);
    assert.equal((await post('/api/bandeja/estado', { ref: A, accion: 'reabrir' }, autorizado())).status, 409, 'Reabrir una que ya está pendiente no vale');
    assert.ok((await get('/api/bandeja/lista?estado=pendientes', autorizado())).json.items.some((i) => i.ref === A), 'Vuelve a Pendientes');
    assert.deepEqual(tipos(e).filter((x) => x === 'tramitada' || x === 'reabierta'), ['tramitada', 'reabierta']);
    t.diagnostic('tramitar → tramitada (por el nombre de la sesión) → reabrir → recibida, con sus dos eventos');
  });

  it('estado: lo que no está recibido no se puede tramitar; ref desconocida → 404; acción o ref ausentes → 400; solo JSON', async () => {
    for (const ref of [C, D, E]) {
      const r = await post('/api/bandeja/estado', { ref, accion: 'tramitar' }, autorizado());
      assert.equal(r.status, 409, `${ref}: ${r.texto}`);
      assert.equal((await estadoDe(ref)).tramitacion.tramitada_por, null);
    }
    assert.equal((await post('/api/bandeja/estado', { ref: FALSA, accion: 'tramitar' }, autorizado())).status, 404);
    assert.equal((await post('/api/bandeja/estado', { ref: 'nada', accion: 'tramitar' }, autorizado())).status, 404);
    for (const cuerpo of [{ ref: A }, { ref: A, accion: 'borrar' }, { ref: A, accion: 'constructor' }, { accion: 'tramitar' }, { ref: 7, accion: 'tramitar' }, []]) {
      const r = await post('/api/bandeja/estado', cuerpo, autorizado());
      assert.equal(r.status, 400, JSON.stringify(cuerpo));
      assert.equal(r.json.codigo, 'peticion');
    }
    const plano = await llamar('POST', '/api/bandeja/estado', { cuerpo: JSON.stringify({ ref: A, accion: 'tramitar' }), tipo: 'text/plain', cookie });
    assert.equal(plano.status, 415, 'Un formulario ajeno (text/plain) no puede cambiar nada');
    assert.equal((await estadoDe(A)).tramitacion.estado, 'recibida', 'Y no cambió nada');
    const roto = await llamar('POST', '/api/bandeja/estado', { cuerpo: '{"ref":', cookie });
    assert.equal(roto.status, 400);
  });

  it('volver a enviar: el aviso vuelve a salir (intentos a 1, eventos con el nombre de quien lo pidió) y el acuse no se toca', async (t) => {
    const antes = await estadoDe(A);
    const avisoAntes = correoDe(antes, 'aviso');
    const acuseAntes = correoDe(antes, 'acuse');
    const r = await post('/api/bandeja/reenviar', { ref: A, tipo: 'aviso' }, autorizado());
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, estado: 'enviado' });
    const despues = await estadoDe(A);
    const aviso = correoDe(despues, 'aviso');
    assert.equal(aviso.estado, 'enviado');
    assert.equal(aviso.intentos, 1, 'Los intentos vuelven a empezar');
    assert.equal(aviso.id, avisoAntes.id, 'Es la misma fila');
    assert.notEqual(aviso.altavoz_id, avisoAntes.altavoz_id, 'Ha salido otra vez');
    assert.ok(Date.parse(aviso.enviado_en) > Date.parse(avisoAntes.enviado_en));
    assert.equal(aviso.simulado, true);
    assert.ok(aviso.cuerpo_html.includes(A) && aviso.cuerpo_html.includes(IBAN), 'El cuerpo se regenera desde la tramitación');
    assert.deepEqual(correoDe(despues, 'acuse'), acuseAntes, 'El acuse queda como estaba');
    const nuevos = despues.eventos.slice(antes.eventos.length);
    assert.deepEqual(nuevos.map((x) => [x.tipo, x.actor]), [['aviso_reenviado', NOMBRE], ['aviso_enviado', NOMBRE]]);

    // el acuse también, y con Altavoz caído queda pendiente (se reintenta solo) sin fallar
    const previo = await cambiarEntorno({ ALTAVOZ_SIMULAR_FALLO: '1' });
    try {
      const caido = await post('/api/bandeja/reenviar', { ref: A, tipo: 'acuse' }, autorizado());
      assert.equal(caido.status, 200, caido.texto);
      assert.deepEqual(caido.json, { ok: true, estado: 'pendiente' });
      const acuse = correoDe(await estadoDe(A), 'acuse');
      assert.equal(acuse.estado, 'pendiente');
      assert.equal(acuse.intentos, 1);
      assert.ok(Date.parse(acuse.proximo_intento) > Date.now(), 'Queda con su espera: el vigilante lo reintenta');
    } finally {
      await cambiarEntorno({ ALTAVOZ_SIMULAR_FALLO: previo.ALTAVOZ_SIMULAR_FALLO });
    }
    const bien = await post('/api/bandeja/reenviar', { ref: A, tipo: 'acuse' }, autorizado());
    assert.deepEqual(bien.json, { ok: true, estado: 'enviado' });
    const final = await estadoDe(A);
    assert.equal(correoDe(final, 'acuse').estado, 'enviado');
    assert.deepEqual(final.eventos.filter((x) => x.tipo === 'acuse_reenviado').map((x) => x.actor), [NOMBRE, NOMBRE]);
    t.diagnostic('aviso reenviado y acuse reenviado dos veces (una con Altavoz caído): eventos con el nombre de backoffice');
  });

  it('volver a enviar: no crea correos de un envío que aún no está completo; ref desconocida → 404; tipo o ref ausentes → 400; solo JSON', async () => {
    for (const ref of [C, D, E]) {
      const r = await post('/api/bandeja/reenviar', { ref, tipo: 'aviso' }, autorizado());
      assert.equal(r.status, 409, `${ref}: ${r.texto}`);
      assert.deepEqual(r.json, { ok: false, codigo: 'estado', mensaje: 'Este envío todavía no está completo, así que no hay correos que reenviar.', retryable: false });
      assert.deepEqual((await estadoDe(ref)).correos, [], 'No se ha creado ningún correo');
    }
    assert.equal((await post('/api/bandeja/reenviar', { ref: FALSA, tipo: 'aviso' }, autorizado())).status, 404);
    for (const cuerpo of [{ ref: A }, { ref: A, tipo: 'codigo_acceso' }, { ref: A, tipo: 'otro' }, { tipo: 'aviso' }, { ref: A, tipo: ['aviso'] }]) {
      assert.equal((await post('/api/bandeja/reenviar', cuerpo, autorizado())).status, 400, JSON.stringify(cuerpo));
    }
    const plano = await llamar('POST', '/api/bandeja/reenviar', { cuerpo: JSON.stringify({ ref: A, tipo: 'aviso' }), tipo: 'text/plain', cookie });
    assert.equal(plano.status, 415);
  });

  it('una tramitación ya tramitada también deja volver a enviar sus correos, y la sesión cerrada ya no puede nada', async () => {
    const ref = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Tramitado SL' }), documentos: [documento(1, 'otro.pdf', generarPdf(2048))] });
    assert.equal((await post('/api/bandeja/estado', { ref, accion: 'tramitar' }, autorizado())).status, 200);
    const r = await post('/api/bandeja/reenviar', { ref, tipo: 'acuse' }, autorizado());
    assert.deepEqual(r.json, { ok: true, estado: 'enviado' });
    // cerrar sesión: el navegador tira la cookie; sin ella, 401 en todo
    const salida = await post('/api/bandeja/salir', {}, autorizado());
    assert.equal(salida.status, 200);
    for (const intento of [get('/api/bandeja/lista'), get(`/api/bandeja/ficha?ref=${ref}`), post('/api/bandeja/estado', { ref, accion: 'reabrir' })]) {
      assert.equal((await intento).status, 401);
    }
    assert.equal((await estadoDe(ref)).tramitacion.estado, 'tramitada', 'Y no se cambió nada sin sesión');
  });
});

// ---------------------------------------------------------------------------
// Parte 3 · quién ha abierto cada ficha: evento `ficha_abierta` (ficha?abrir=1) y `vistas` de la lista; y «Marcar como sin abrir»
// (evento `marcada_sin_abrir`: una apertura solo cuenta si es más nueva que la última marca); y el NOMBRE que firma todo eso
// ---------------------------------------------------------------------------

describe('Bandeja · quién ha abierto cada ficha (y «Marcar como sin abrir») y con qué nombre', { timeout: 900_000 }, () => {
  let cookie;
  const autorizado = (extra = {}) => ({ cookie, ...extra });
  const SESION = { email: EMAIL, nombre: NOMBRE }; // lo que `exigirSesion` entrega al llamar a la lógica en este proceso
  const OTRA = 'victor.molins.10+otra-persona@gmail.com'; // otra persona de backoffice (alias de Victor): solo aparece en la base, no entra
  const hace = (minutos) => new Date(Date.now() - minutos * 60_000).toISOString();
  const lote = String(randomInt(10000, 99999)); // marca propia: la búsqueda `lote<N>` solo encuentra las fichas sueltas de esta parte
  const sueltas = []; // sus referencias, para borrarlas al terminar (con ellas caen sus eventos)
  let contador = 0;

  const aperturasDe = async (ref) => (await estadoDe(ref)).eventos.filter((e) => e.tipo === 'ficha_abierta');
  const abrirFicha = (ref, extra = '&abrir=1') => get(`/api/bandeja/ficha?ref=${ref}${extra}`, autorizado());
  const pares = (eventos) => eventos.map((e) => [e.tipo, e.actor]);

  /** Las tarjetas de la lista (todas las fichas) que encuentra una búsqueda, por referencia. */
  async function tarjetas(q) {
    const r = await get(`/api/bandeja/lista?estado=todas&q=${encodeURIComponent(q)}`, autorizado());
    assert.equal(r.status, 200, r.texto);
    return new Map(r.json.items.map((i) => [i.ref, i]));
  }

  /**
   * Una ficha suelta (sin documentos ni correos) para probar sin pasar por el almacén: de hace 10 días, fuera de la ventana de
   * `conciliar`. Pendiente (`recibida`) salvo que se pida otro estado. Devuelve su referencia, su id y la búsqueda (`q`) que solo
   * la encuentra a ella (la lista da hasta 30 por página).
   */
  async function fichaSuelta(titulo, estado = 'recibida') {
    contador += 1;
    const ref = `GNE-20260101-V${lote}${contador}`;
    const fecha = new Date(Date.now() - 10 * 24 * 3_600_000 - contador * 1000).toISOString();
    const [fila] = await insertar('tramitaciones', {
      ref,
      formulario: 'gnew',
      estado,
      prueba: true,
      carpeta: `pruebas/gnew/2026/01/${ref}-aperturasxx`,
      comercial_nombre: 'Aperturas de Prueba',
      comercial_email: EMAIL_COMERCIAL,
      compania: 'Compañía de Prueba',
      cups: CUPS,
      titular_nombre: `Titular Aperturas ${titulo}`,
      titular_nif: '00000000T',
      iban: IBAN,
      direccion: 'Calle de Prueba 1',
      cp: '28001',
      poblacion: 'Madrid',
      provincia: 'Madrid',
      telefono: '600000000',
      email_cliente: EMAIL_CLIENTE,
      busqueda: `lote${lote} titular aperturas ${titulo.toLowerCase()}`,
      creada_en: fecha,
      recibida_en: fecha,
    });
    sueltas.push(ref);
    return { ref, id: fila.id, q: `lote${lote} ${titulo.toLowerCase()}` };
  }

  const apertura = (id, actor, minutos, tipo = 'ficha_abierta') => ({ tramitacion_id: id, tipo, actor, detalle: {}, creado_en: hace(minutos) });

  before(async () => {
    assert.match(EMAIL, ES_ALIAS);
    assert.equal(MINUTOS_ENTRE_APERTURAS, 15, 'La ventana por persona es de 15 minutos (los casos de abajo se calculan con ella)');
    cookie = await sesionNueva();
  });

  after(async () => {
    if (sueltas.length > 0) await borrar('tramitaciones', { ref: `in.(${sueltas.join(',')})` }); // no se deja nada suelto
  });

  it('abrir=1 apunta la apertura una sola vez (ya en el historial de la respuesta); sin él no se apunta nada; la lista lo cuenta en `vistas`', async (t) => {
    const ref = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Visto SL' }), documentos: [documento(1, 'visto.pdf', generarPdf(2048))] });
    const base = (await estadoDe(ref)).eventos.map((e) => e.tipo);
    assert.ok(!base.includes('ficha_abierta'));

    // (a) la lista: nadie la ha abierto
    assert.deepEqual((await tarjetas(ref)).get(ref).vistas, []);

    // (d) sin `abrir`, o con algo que no es «1» (también el primero de un parámetro repetido), la ficha se ve y no se apunta nada
    for (const extra of ['', '&abrir=0', '&abrir=', '&abrir=true', '&abrir=2', '&abrir=0&abrir=1']) {
      const r = await abrirFicha(ref, extra);
      assert.equal(r.status, 200, `«${extra}»: ${r.texto}`);
      assert.deepEqual(r.json.eventos.map((e) => e.tipo), base, `«${extra}» no apunta nada`);
    }
    assert.deepEqual(await aperturasDe(ref), []);
    assert.deepEqual((await tarjetas(ref)).get(ref).vistas, [], 'Y la lista sigue sin verla abierta');

    // (b) con abrir=1: 200 y la apertura ya sale en los eventos de la propia respuesta, como el más nuevo, con el correo de la sesión
    const primera = await abrirFicha(ref);
    assert.equal(primera.status, 200, primera.texto);
    assert.deepEqual(primera.json.eventos.map((e) => e.tipo), [...base, 'ficha_abierta'], 'Del más antiguo al más nuevo: la apertura, la última');
    const nueva = primera.json.eventos.at(-1);
    assert.deepEqual(Object.keys(nueva).sort(), ['actor', 'creado_en', 'detalle', 'tipo'], 'Con la misma forma que los demás eventos (sin id)');
    assert.equal(nueva.actor, NOMBRE, 'El actor es el NOMBRE de la sesión (no su correo)');
    assert.deepEqual(nueva.detalle, {}, 'El detalle sigue vacío: ni el nombre ni el correo');
    assert.ok(Math.abs(Date.parse(nueva.creado_en) - Date.now()) < 120_000, 'Se apunta con la hora de ahora');
    const guardadas = await aperturasDe(ref);
    assert.equal(guardadas.length, 1);
    assert.equal(guardadas[0].actor, NOMBRE);
    assert.deepEqual(guardadas[0].detalle, {});
    assert.equal(Date.parse(guardadas[0].creado_en), Date.parse(nueva.creado_en), 'Lo que enseña la respuesta es lo que hay en la base');

    // (c) otra vez con abrir=1 en seguida (también con el parámetro repetido): sigue habiendo UNA, y la ficha la enseña
    for (const extra of ['&abrir=1', '&abrir=1&abrir=1']) {
      const r = await abrirFicha(ref, extra);
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual(r.json.eventos.map((e) => e.tipo), [...base, 'ficha_abierta'], `«${extra}» no apunta otra`);
    }
    // (d) y sin abrir, la ficha enseña la apertura que ya hay y no apunta ninguna más
    const sin = await abrirFicha(ref, '');
    assert.deepEqual(sin.json.eventos.map((e) => e.tipo), [...base, 'ficha_abierta']);
    assert.equal((await aperturasDe(ref)).length, 1);

    // (e) la lista: una entrada, con quién y cuándo
    const tarjeta = (await tarjetas(ref)).get(ref);
    assert.deepEqual(Object.keys(tarjeta.vistas[0]).sort(), ['en', 'por']);
    assert.equal(tarjeta.vistas.length, 1);
    assert.equal(tarjeta.vistas[0].por, NOMBRE);
    assert.equal(Date.parse(tarjeta.vistas[0].en), Date.parse(nueva.creado_en));

    // abrir=1 en una referencia que no existe sigue dando el 404 en llano, y sin sesión el 401: ninguno apunta nada
    const inexistente = await abrirFicha(nuevaRef());
    assert.equal(inexistente.status, 404, inexistente.texto);
    assert.deepEqual(inexistente.json, { ok: false, codigo: 'no_encontrada', mensaje: 'No encontramos esta tramitación.', retryable: false });
    const sinSesion = await get(`/api/bandeja/ficha?ref=${ref}&abrir=1`);
    assert.equal(sinSesion.status, 401, sinSesion.texto);
    assert.equal(sinSesion.json.codigo, 'sesion');
    assert.equal((await aperturasDe(ref)).length, 1, 'El 404 y el 401 no dejan rastro');
    t.diagnostic('abrir=1 → UNA apertura en la respuesta y en la base; repetirlo, o no mandar abrir, no apunta más; la lista da vistas=[{por, en}]');
  });

  it('la ventana de 15 minutos es por persona: una apertura tuya de hace 10 min frena otra; una de hace 16 min no; la de otra persona no cuenta', async () => {
    const reciente = await fichaSuelta('Reciente');
    const antigua = await fichaSuelta('Antigua');
    const ajena = await fichaSuelta('Ajena');
    await insertar('tramitacion_eventos', [
      apertura(reciente.id, NOMBRE, MINUTOS_ENTRE_APERTURAS - 5), // «tuya» = con el nombre de esta sesión (una apertura de otro nombre no frena)
      apertura(antigua.id, NOMBRE, MINUTOS_ENTRE_APERTURAS + 1),
      apertura(ajena.id, OTRA, 1),
    ], { devolver: false });

    // hace 10 min: no se apunta otra
    const r1 = await abrirFicha(reciente.ref);
    assert.equal(r1.status, 200, r1.texto);
    assert.deepEqual(pares(r1.json.eventos), [['ficha_abierta', NOMBRE]]);
    assert.equal((await aperturasDe(reciente.ref)).length, 1);

    // hace 16 min: sí, y queda detrás de la vieja
    const r2 = await abrirFicha(antigua.ref);
    assert.equal(r2.status, 200, r2.texto);
    assert.deepEqual(pares(r2.json.eventos), [['ficha_abierta', NOMBRE], ['ficha_abierta', NOMBRE]]);
    assert.ok(Date.parse(r2.json.eventos[1].creado_en) - Date.parse(r2.json.eventos[0].creado_en) > MINUTOS_ENTRE_APERTURAS * 60_000, 'La nueva es de ahora y la vieja de hace más de 15 min');
    assert.equal((await aperturasDe(antigua.ref)).length, 2);
    assert.deepEqual(pares((await abrirFicha(antigua.ref)).json.eventos), [['ficha_abierta', NOMBRE], ['ficha_abierta', NOMBRE]], 'Con la nueva ya reciente, otra vez no');

    // la de otra persona, aunque sea de hace 1 min, no cuenta: se apunta la tuya
    const r3 = await abrirFicha(ajena.ref);
    assert.equal(r3.status, 200, r3.texto);
    assert.deepEqual(pares(r3.json.eventos), [['ficha_abierta', OTRA], ['ficha_abierta', NOMBRE]]);

    // en la lista: una entrada por persona, la apertura más reciente de cada una y las más recientes primero
    const lista = await tarjetas(`lote${lote}`);
    assert.deepEqual(lista.get(reciente.ref).vistas.map((v) => v.por), [NOMBRE]);
    assert.deepEqual(lista.get(antigua.ref).vistas.map((v) => v.por), [NOMBRE], 'Dos aperturas de la misma persona: una sola entrada');
    assert.ok(Date.now() - Date.parse(lista.get(antigua.ref).vistas[0].en) < 5 * 60_000, 'Y es la más reciente (la de ahora, no la de hace 16 min)');
    assert.deepEqual(lista.get(ajena.ref).vistas.map((v) => v.por), [NOMBRE, OTRA]);
  });

  it('`vistas`: una entrada por persona (la más reciente), de más reciente a más antigua, como mucho 5; solo cuentan las aperturas; por ficha se leen las 20 últimas', async () => {
    const [p1, p2, p3, p4, p5, p6, p7, p8] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `victor.molins.10+vistas-${x}@gmail.com`);
    const siete = await fichaSuelta('Siete');
    const una = await fichaSuelta('Una');
    const ninguna = await fichaSuelta('Ninguna');
    const veintidos = await fichaSuelta('Veintidos');
    const lejana = await fichaSuelta('Lejana');
    await insertar('tramitacion_eventos', [
      // siete personas (p6 y p7 se quedan fuera por el tope de 5); p1 abre dos veces; y un evento que NO es una apertura
      apertura(siete.id, p1, 60), apertura(siete.id, p1, 5), apertura(siete.id, p2, 30), apertura(siete.id, p3, 20), apertura(siete.id, p4, 90),
      apertura(siete.id, p5, 120), apertura(siete.id, p6, 150), apertura(siete.id, p7, 200), apertura(siete.id, p8, 1, 'aviso_enviado'),
      apertura(una.id, p2, 300),
      // 22 aperturas de p1 (de hace 1 a 22 min) y una MÁS ANTIGUA de p2: por ficha se leen las 20 últimas, así que p2 no sale
      ...Array.from({ length: 22 }, (_, i) => apertura(veintidos.id, p1, i + 1)),
      apertura(veintidos.id, p2, 400),
      // una sola apertura, más vieja que las 22 de la ficha de al lado: el tope es por ficha y no en total
      apertura(lejana.id, p3, 600),
    ], { devolver: false });

    const lista = await tarjetas(`lote${lote}`);
    const mira = (ficha) => lista.get(ficha.ref).vistas.map((v) => v.por);
    assert.deepEqual(mira(siete), [p1, p3, p2, p4, p5], 'Una por persona, de más reciente a más antigua, hasta 5 (sin p6 ni p7 ni el que solo tiene un aviso)');
    const enSiete = lista.get(siete.ref).vistas;
    assert.ok(Math.abs(Date.parse(enSiete[0].en) - (Date.now() - 5 * 60_000)) < 2 * 60_000, 'De p1 sale su apertura MÁS reciente (hace 5 min, no la de hace 60)');
    const tiempos = enSiete.map((v) => Date.parse(v.en));
    assert.deepEqual(tiempos, [...tiempos].sort((x, y) => y - x), 'De más reciente a más antigua');
    assert.deepEqual(mira(una), [p2]);
    assert.deepEqual(lista.get(ninguna.ref).vistas, [], '`[]` si nadie la ha abierto');
    assert.deepEqual(mira(veintidos), [p1], 'Por ficha se leen las 20 últimas aperturas: la de p2, más vieja, no entra');
    assert.deepEqual(mira(lejana), [p3], 'El tope de 20 es por ficha: la de al lado no se la come');
    for (const ficha of [siete, una, ninguna, veintidos, lejana]) {
      assert.deepEqual(Object.keys(lista.get(ficha.ref)).sort(), [
        'comercial_nombre', 'compania', 'creada_en', 'cups', 'estado', 'formulario', 'n_documentos', 'recibida_en', 'ref', 'tarifa', 'titular_nombre', 'vistas',
      ], 'El item solo lleva el campo nuevo `vistas`: los eventos embebidos no se cuelan');
    }
    assert.ok(!JSON.stringify([...lista.values()]).includes('tramitacion_eventos'), 'Ni el nombre de la tabla');
  });

  it('si no se puede apuntar la apertura (la base la rechaza o no hay red), la ficha sale igual y el registro lleva una frase fija sin datos', async () => {
    const { ref } = await fichaSuelta('Fallo');
    const fetchReal = globalThis.fetch;
    const consolaReal = console.error;
    const registro = [];
    const casos = [
      ['la base rechaza la escritura (503)', () => new Response(JSON.stringify({ message: `texto con datos ${EMAIL} ${ref}` }), { status: 503, headers: { 'Content-Type': 'application/json' } })],
      ['no hay red', () => { throw new TypeError(`fetch failed ${EMAIL}`); }],
    ];
    for (const [motivo, fallar] of casos) {
      // Solo se estropea la ESCRITURA de eventos; lo demás (leer la ficha) va a la base de verdad. La ficha se pide en este proceso.
      globalThis.fetch = async (url, opciones) => (String(url).includes('/rest/v1/tramitacion_eventos') && opciones?.method === 'POST' ? fallar() : fetchReal(url, opciones));
      console.error = (...partes) => registro.push(partes.join(' '));
      let r;
      try {
        r = await fichaEnEsteProceso(ref, { sesion: SESION, abrir: true });
      } finally {
        globalThis.fetch = fetchReal;
        console.error = consolaReal;
      }
      assert.equal(r.status, 200, `${motivo}: la ficha sale igual`);
      assert.equal(r.cuerpo.tramitacion.ref, ref, motivo);
      assert.ok(!r.cuerpo.eventos.some((e) => e.tipo === 'ficha_abierta'), `${motivo}: sin apertura en el historial`);
    }
    assert.equal(registro.length, 2, 'Una línea por fallo');
    for (const linea of registro) {
      assert.match(linea, /^\[bandeja\/ficha\] no se ha podido apuntar que se abre la ficha: \S/);
      assert.ok(!linea.includes(EMAIL) && !linea.includes(NOMBRE) && !linea.includes(ref) && !linea.includes('datos'), `Ni correos, ni nombres, ni referencias, ni el cuerpo de la respuesta en el registro: ${linea}`);
    }
    assert.deepEqual(await aperturasDe(ref), [], 'No se apuntó nada');

    // y sin el fallo, la misma llamada sí la apunta (la prueba no se engaña)
    const bien = await fichaEnEsteProceso(ref, { sesion: SESION, abrir: true });
    assert.equal(bien.status, 200);
    assert.deepEqual(pares(bien.cuerpo.eventos), [['ficha_abierta', NOMBRE]]);
    assert.equal((await aperturasDe(ref)).length, 1);
  });

  // ---- «Marcar como sin abrir» (16-oct-2026): POST /api/bandeja/estado {ref, accion:'sin_abrir'} → evento `marcada_sin_abrir` ----

  const MARCA = 'marcada_sin_abrir';
  const FRASE_SOLO_PENDIENTE = 'Solo se puede dejar sin abrir un contrato pendiente.';
  const sinAbrir = (ref, extra) => post('/api/bandeja/estado', { ref, accion: 'sin_abrir' }, autorizado(extra));
  const marcasDe = async (ref) => (await estadoDe(ref)).eventos.filter((e) => e.tipo === MARCA);

  /** La tarjeta de UNA ficha suelta en la lista de ese filtro (null si no sale). */
  async function tarjetaDe(f, estado = 'todas') {
    const r = await get(`/api/bandeja/lista?estado=${estado}&q=${encodeURIComponent(f.q)}`, autorizado());
    assert.equal(r.status, 200, r.texto);
    return r.json.items.find((i) => i.ref === f.ref) ?? null;
  }

  /**
   * Siembra eventos UNO A UNO y del más antiguo al más nuevo: así el orden por `id` (el que mira la ficha para el freno de 15
   * minutos) y el de `creado_en` (el que mira la lista) son el mismo, como lo son en producción.
   */
  async function sembrar(eventos) {
    for (const e of eventos) await insertar('tramitacion_eventos', e, { devolver: false });
  }

  it('«Marcar como sin abrir»: 200, evento con el nombre de la sesión, la apertura se conserva, la fila no se toca y la lista vuelve a «Sin abrir» (Pendientes y Todas); marcar dos veces seguidas es marcar una', async (t) => {
    const f = await fichaSuelta('Marcada');
    const antes = (await estadoDe(f.ref)).tramitacion;
    assert.equal((await abrirFicha(f.ref)).status, 200);
    assert.deepEqual((await tarjetaDe(f)).vistas.map((v) => v.por), [NOMBRE], 'Antes de marcar, la ha abierto esta sesión');

    const r = await sinAbrir(f.ref);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    const marcas = await marcasDe(f.ref);
    assert.equal(marcas.length, 1);
    assert.equal(marcas[0].actor, NOMBRE, 'El autor es el nombre de la sesión');
    assert.deepEqual(marcas[0].detalle, {});
    assert.equal((await aperturasDe(f.ref)).length, 1, 'La apertura NO se borra: el historial se conserva');
    assert.deepEqual((await estadoDe(f.ref)).tramitacion, antes, 'La fila de tramitaciones no se toca (ni su `actualizada_en`: un UPDATE dispararía el trigger y el vigilante abandona las subidas por esa fecha)');

    for (const estado of ['pendientes', 'todas']) {
      const tarjeta = await tarjetaDe(f, estado);
      assert.ok(tarjeta, `Sale en ${estado}`);
      assert.equal(tarjeta.estado, 'recibida');
      assert.deepEqual(tarjeta.vistas, [], `En ${estado}, la ficha vuelve a «Sin abrir» (vistas vacía)`);
    }

    // la ficha enseña la marca en el historial, con la forma de los demás eventos y detrás de la apertura
    const historial = await abrirFicha(f.ref, '');
    assert.deepEqual(pares(historial.json.eventos), [['ficha_abierta', NOMBRE], [MARCA, NOMBRE]]);
    assert.deepEqual(Object.keys(historial.json.eventos[1]).sort(), ['actor', 'creado_en', 'detalle', 'tipo']);

    // marcar otra vez seguida: 200 y SIN evento duplicado
    const otra = await sinAbrir(f.ref);
    assert.equal(otra.status, 200, otra.texto);
    assert.deepEqual(otra.json, { ok: true });
    assert.equal((await marcasDe(f.ref)).length, 1, 'Dos marcas seguidas son una sola');
    assert.deepEqual((await tarjetaDe(f)).vistas, []);
    t.diagnostic('marcar → 200, UNA marca con el actor, apertura intacta, fila sin tocar, vistas=[] en Pendientes y Todas; repetirla no apunta otra');
  });

  it('después de marcar, volver a abrirla ENSEGUIDA (menos de 15 minutos) cuenta: es la trampa del freno; otra apertura seguida ya no, y se puede marcar de nuevo', async () => {
    const f = await fichaSuelta('Reabierta');
    await abrirFicha(f.ref);
    assert.equal((await sinAbrir(f.ref)).status, 200);
    assert.deepEqual((await tarjetaDe(f)).vistas, []);

    const r = await abrirFicha(f.ref); // la misma persona, a los pocos segundos de su primera apertura
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(pares(r.json.eventos), [['ficha_abierta', NOMBRE], [MARCA, NOMBRE], ['ficha_abierta', NOMBRE]], 'Apertura, marca, apertura');
    const aperturas = await aperturasDe(f.ref);
    assert.equal(aperturas.length, 2, 'La segunda apertura SÍ se apunta aunque no hayan pasado 15 minutos de la primera');
    const vistas = (await tarjetaDe(f)).vistas;
    assert.deepEqual(vistas.map((v) => v.por), [NOMBRE], 'Y la lista la vuelve a dar por abierta');
    assert.equal(Date.parse(vistas[0].en), Date.parse(aperturas[1].creado_en), 'Con la apertura de DESPUÉS de la marca');

    assert.equal((await abrirFicha(f.ref)).json.eventos.filter((e) => e.tipo === 'ficha_abierta').length, 2, 'Otra apertura seguida: el freno de siempre');
    assert.equal((await aperturasDe(f.ref)).length, 2);

    // lo último que pasó es una apertura, así que marcar de nuevo SÍ apunta otra marca
    assert.equal((await sinAbrir(f.ref)).status, 200);
    assert.equal((await marcasDe(f.ref)).length, 2);
    assert.deepEqual((await tarjetaDe(f)).vistas, []);
  });

  it('con varias personas, en la lista solo cuentan las aperturas posteriores a la última marca (marca la más nueva, en medio, la más antigua y varias marcas)', async () => {
    const [p1, p2, p3] = ['a', 'b', 'c'].map((x) => `victor.molins.10+marca-${x}@gmail.com`);
    const nueva = await fichaSuelta('MarcaNueva');
    const medio = await fichaSuelta('MarcaMedio');
    const antigua = await fichaSuelta('MarcaAntigua');
    const varias = await fichaSuelta('MarcaVarias');
    await insertar('tramitacion_eventos', [
      // la marca es lo más nuevo → nadie la ha abierto
      apertura(nueva.id, p1, 60), apertura(nueva.id, p2, 45), apertura(nueva.id, p3, 30, MARCA),
      // la marca queda en medio → solo p3 y p1, las de después (p2 abrió ANTES de marcar y ya no cuenta)
      apertura(medio.id, p1, 60), apertura(medio.id, p2, 45), apertura(medio.id, p3, 30, MARCA), apertura(medio.id, p3, 20), apertura(medio.id, p1, 10),
      // la marca es lo más antiguo → todas valen
      apertura(antigua.id, p3, 90, MARCA), apertura(antigua.id, p1, 60), apertura(antigua.id, p2, 45),
      // dos marcas → manda la más nueva: p2 abrió ENTRE las dos y no cuenta
      apertura(varias.id, p1, 100), apertura(varias.id, p2, 90, MARCA), apertura(varias.id, p2, 80), apertura(varias.id, p3, 70, MARCA), apertura(varias.id, p3, 60), apertura(varias.id, p1, 50),
    ], { devolver: false });

    const lista = await tarjetas(`lote${lote} marca`);
    const mira = (f) => lista.get(f.ref).vistas.map((v) => v.por);
    assert.deepEqual(mira(nueva), [], 'Marca lo más nuevo: nadie');
    assert.deepEqual(mira(medio), [p1, p3], 'Marca en medio: las de después, de más reciente a más antigua, sin p2');
    assert.ok(Math.abs(Date.parse(lista.get(medio.ref).vistas[0].en) - (Date.now() - 10 * 60_000)) < 2 * 60_000, 'De p1 sale su apertura de DESPUÉS de la marca (hace 10 min, no la de hace 60)');
    assert.deepEqual(mira(antigua), [p2, p1], 'Marca lo más antiguo: valen todas');
    assert.deepEqual(mira(varias), [p1, p3], 'Dos marcas: manda la más nueva');
    for (const f of [nueva, medio, antigua, varias]) {
      assert.deepEqual(Object.keys(lista.get(f.ref)).sort(), [
        'comercial_nombre', 'compania', 'creada_en', 'cups', 'estado', 'formulario', 'n_documentos', 'recibida_en', 'ref', 'tarifa', 'titular_nombre', 'vistas',
      ], 'El item sigue llevando solo `vistas`: ni el tipo ni los eventos embebidos se cuelan');
    }
  });

  it('el freno de 15 minutos mira la marca: una apertura tuya de hace 8 min no frena si alguien marcó DESPUÉS; una marca anterior a tu apertura reciente no cambia nada', async () => {
    const despues = await fichaSuelta('FrenoMarcaDespues');
    const antes = await fichaSuelta('FrenoMarcaAntes');
    const vieja = await fichaSuelta('FrenoApertura20');
    const caducado = await fichaSuelta('FrenoMarcaVieja');
    await sembrar([apertura(despues.id, NOMBRE, 8), apertura(despues.id, OTRA, 5, MARCA)]);
    await sembrar([apertura(antes.id, OTRA, 8, MARCA), apertura(antes.id, NOMBRE, 5)]);
    await sembrar([apertura(vieja.id, NOMBRE, 20), apertura(vieja.id, OTRA, 3, MARCA)]);
    await sembrar([apertura(caducado.id, OTRA, 40, MARCA), apertura(caducado.id, NOMBRE, 20)]);

    // tu apertura (hace 8 min) y una marca más nueva (hace 5): se apunta
    const r1 = await abrirFicha(despues.ref);
    assert.equal(r1.status, 200, r1.texto);
    assert.deepEqual(pares(r1.json.eventos), [['ficha_abierta', NOMBRE], [MARCA, OTRA], ['ficha_abierta', NOMBRE]]);
    assert.equal((await aperturasDe(despues.ref)).length, 2);

    // una marca (hace 8 min) y luego tu apertura (hace 5): la marca queda detrás de tu apertura reciente, sigue el freno → no se apunta
    const r2 = await abrirFicha(antes.ref);
    assert.equal(r2.status, 200, r2.texto);
    assert.deepEqual(pares(r2.json.eventos), [[MARCA, OTRA], ['ficha_abierta', NOMBRE]]);
    assert.equal((await aperturasDe(antes.ref)).length, 1);

    // tu apertura de hace 20 min y una marca de hace 3: se apunta (de todas formas habría pasado el freno, y con la marca más)
    assert.equal(pares((await abrirFicha(vieja.ref)).json.eventos).length, 3);
    assert.equal((await aperturasDe(vieja.ref)).length, 2);

    // una marca de hace 40 min y tu apertura de hace 20 (pasados los 15): se apunta, como siempre
    assert.equal((await abrirFicha(caducado.ref)).json.eventos.filter((e) => e.tipo === 'ficha_abierta').length, 2);
    assert.equal((await aperturasDe(caducado.ref)).length, 2);

    // sin `abrir` no se apunta nada, ni con marca
    const sinAbrirParam = await fichaSuelta('FrenoSinAbrirParam');
    await sembrar([apertura(sinAbrirParam.id, OTRA, 5, MARCA)]);
    assert.deepEqual(pares((await abrirFicha(sinAbrirParam.ref, '')).json.eventos), [[MARCA, OTRA]]);
    assert.deepEqual(await aperturasDe(sinAbrirParam.ref), []);
  });

  it('«Marcar como sin abrir» solo vale en una pendiente: 409 con su frase en llano en tramitada, subiendo, abandonada y descartada; tras «Volver a pendiente» vuelve a valer', async () => {
    for (const estado of ['tramitada', 'subiendo', 'abandonada', 'descartada']) {
      const f = await fichaSuelta(`Sin abrir ${estado}`, estado);
      const r = await sinAbrir(f.ref);
      assert.equal(r.status, 409, `${estado}: ${r.texto}`);
      assert.deepEqual(r.json, { ok: false, codigo: 'estado', mensaje: FRASE_SOLO_PENDIENTE, retryable: false });
      assert.deepEqual(await marcasDe(f.ref), [], `${estado}: no deja ninguna marca`);
    }

    // el recorrido real: pendiente → tramitada (409) → vuelta a pendiente (200)
    const f = await fichaSuelta('Recorrido');
    assert.equal((await post('/api/bandeja/estado', { ref: f.ref, accion: 'tramitar' }, autorizado())).status, 200);
    assert.equal((await sinAbrir(f.ref)).status, 409, 'Ya tramitada: no se puede dejar sin abrir');
    assert.deepEqual(await marcasDe(f.ref), []);
    assert.equal((await post('/api/bandeja/estado', { ref: f.ref, accion: 'reabrir' }, autorizado())).status, 200);
    assert.equal((await sinAbrir(f.ref)).status, 200, 'De nuevo pendiente: sí');
    assert.equal((await marcasDe(f.ref)).length, 1);
    assert.equal((await estadoDe(f.ref)).tramitacion.estado, 'recibida', 'Dejarla sin abrir no cambia su estado');
  });

  it('«Marcar como sin abrir»: cuerpo malo o acción desconocida → 400; referencia que no existe o de otro modo → 404; sin sesión → 401; y nada de eso deja una marca', async () => {
    const f = await fichaSuelta('Peticiones');
    await abrirFicha(f.ref);
    const malos = [
      { accion: 'sin_abrir' }, { ref: 7, accion: 'sin_abrir' }, { ref: null, accion: 'sin_abrir' }, { ref: [f.ref], accion: 'sin_abrir' },
      { ref: f.ref, accion: 'Sin_abrir' }, { ref: f.ref, accion: 'sin abrir' }, { ref: f.ref, accion: ['sin_abrir'] }, { ref: f.ref, accion: '' },
      { ref: f.ref }, {}, [],
    ];
    for (const cuerpo of malos) {
      const r = await post('/api/bandeja/estado', cuerpo, autorizado());
      assert.equal(r.status, 400, JSON.stringify(cuerpo));
      assert.equal(r.json.codigo, 'peticion');
    }
    const plano = await llamar('POST', '/api/bandeja/estado', { cuerpo: JSON.stringify({ ref: f.ref, accion: 'sin_abrir' }), tipo: 'text/plain', cookie });
    assert.equal(plano.status, 415, 'Un formulario ajeno (text/plain) no puede marcar nada');
    assert.equal((await llamar('POST', '/api/bandeja/estado', { cuerpo: '{"ref":', cookie })).status, 400);

    for (const ref of [nuevaRef(), nuevaRef('mega'), 'nada', '../../etc/passwd', `${f.ref}&select=*`]) {
      const r = await sinAbrir(ref);
      assert.equal(r.status, 404, `«${ref}»: ${r.texto}`);
      assert.deepEqual(r.json, { ok: false, codigo: 'no_encontrada', mensaje: 'No encontramos esta tramitación.', retryable: false });
    }

    const sinSesion = await post('/api/bandeja/estado', { ref: f.ref, accion: 'sin_abrir' });
    assert.equal(sinSesion.status, 401, sinSesion.texto);
    assert.equal(sinSesion.json.codigo, 'sesion');
    assert.equal((await get('/api/bandeja/estado', autorizado())).status, 405, 'Solo POST');

    // con TRAMITACION_PRUEBA=0 las filas de prueba no existen para la bandeja (la misma regla que la ficha). El servidor local no
    // deja ESCRIBIR en ese modo (solo atiende lecturas), así que se mira en este proceso: el 404 sale antes de escribir nada
    const modo = process.env.TRAMITACION_PRUEBA;
    process.env.TRAMITACION_PRUEBA = '0';
    try {
      const r = await marcarEnEsteProceso({ ref: f.ref, accion: 'sin_abrir' }, SESION);
      assert.equal(r.status, 404);
      assert.equal(r.cuerpo.codigo, 'no_encontrada');
    } finally {
      if (modo === undefined) delete process.env.TRAMITACION_PRUEBA;
      else process.env.TRAMITACION_PRUEBA = modo;
    }

    assert.deepEqual(await marcasDe(f.ref), [], 'Nada de lo anterior ha dejado una marca');
    assert.equal((await sinAbrir(f.ref)).status, 200, 'Y con todo en orden, marcar vale');
    assert.equal((await marcasDe(f.ref)).length, 1);
  });

  it('si la base no guarda la marca, NO se contesta 200: se lanza y el handler lo convierte en el 503 en llano (no se traga el fallo como `registrarEvento`)', async () => {
    const f = await fichaSuelta('FalloMarca');
    const fetchReal = globalThis.fetch;
    const consolaReal = console.error;
    const registro = [];
    const casos = [
      ['la base rechaza la escritura (503)', () => new Response(JSON.stringify({ message: `texto con datos ${EMAIL} ${f.ref}` }), { status: 503, headers: { 'Content-Type': 'application/json' } })],
      ['no hay red', () => { throw new TypeError(`fetch failed ${EMAIL}`); }],
    ];
    for (const [motivo, fallar] of casos) {
      // Solo se estropea la ESCRITURA de eventos; lo demás (buscar la ficha, mirar su último evento) va a la base de verdad
      globalThis.fetch = async (url, opciones) => (String(url).includes('/rest/v1/tramitacion_eventos') && opciones?.method === 'POST' ? fallar() : fetchReal(url, opciones));
      console.error = (...partes) => registro.push(partes.join(' '));
      let lanzado = null;
      let respuesta = null;
      try {
        try {
          await marcarEnEsteProceso({ ref: f.ref, accion: 'sin_abrir' }, SESION);
        } catch (error) {
          lanzado = error;
          respuesta = respuestaDeError(error, 'estado'); // lo que hace el handler de api/bandeja/estado.js
        }
      } finally {
        globalThis.fetch = fetchReal;
        console.error = consolaReal;
      }
      assert.ok(lanzado, `${motivo}: tiene que lanzar, no contestar 200 sin haber apuntado nada`);
      assert.equal(respuesta.status, 503, motivo);
      assert.equal(respuesta.cuerpo.codigo, 'temporal');
      assert.equal(respuesta.cuerpo.retryable, true);
      assert.equal(respuesta.cuerpo.mensaje, 'No hemos podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.', 'En llano');
    }
    assert.equal(registro.length, 2, 'Una línea por fallo');
    for (const linea of registro) {
      assert.match(linea, /^\[bandeja\/estado\] \S/);
      assert.ok(!linea.includes(EMAIL) && !linea.includes(NOMBRE) && !linea.includes(f.ref) && !linea.includes('datos'), `Ni correos, ni nombres, ni referencias, ni el cuerpo de la respuesta en el registro: ${linea}`);
    }
    assert.deepEqual(await marcasDe(f.ref), [], 'No se apuntó nada');

    // y sin el fallo, la misma llamada sí la apunta (la prueba no se engaña)
    const bien = await marcarEnEsteProceso({ ref: f.ref, accion: 'sin_abrir' }, SESION);
    assert.deepEqual([bien.status, bien.cuerpo], [200, { ok: true }]);
    assert.equal((await marcasDe(f.ref)).length, 1);
  });

  // ---- El nombre es el «quién» de todo lo que se hace en la bandeja (16-oct-2026): con nombre, el nombre; sin él, el correo de siempre ----

  it('CON nombre: abrir, marcar sin abrir, tramitar, volver a pendiente y volver a enviar se apuntan con el NOMBRE (y `tramitada_por`); el correo de la sesión no sale en ningún sitio', async (t) => {
    const laura = await sesionNueva(EMAIL, 'LAURA GARCÍA');
    const como = (extra = {}) => ({ cookie: laura, ...extra });
    const ref = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Con Nombre SL' }), documentos: [documento(1, 'con-nombre.pdf', generarPdf(2048))] });
    const antes = (await estadoDe(ref)).eventos.length;

    const abierta = await get(`/api/bandeja/ficha?ref=${ref}&abrir=1`, como());
    assert.equal(abierta.status, 200, abierta.texto);
    assert.deepEqual(pares(abierta.json.eventos.slice(antes)), [['ficha_abierta', 'LAURA GARCÍA']], 'La apertura, en el historial de la propia respuesta y con el nombre');
    assert.equal((await post('/api/bandeja/estado', { ref, accion: 'sin_abrir' }, como())).status, 200);
    const tramitada = await post('/api/bandeja/estado', { ref, accion: 'tramitar' }, como());
    assert.equal(tramitada.status, 200, tramitada.texto);
    assert.equal(tramitada.json.tramitada_por, 'LAURA GARCÍA');
    assert.equal((await estadoDe(ref)).tramitacion.tramitada_por, 'LAURA GARCÍA');
    assert.deepEqual((await post('/api/bandeja/reenviar', { ref, tipo: 'aviso' }, como())).json, { ok: true, estado: 'enviado' });
    const reabierta = await post('/api/bandeja/estado', { ref, accion: 'reabrir' }, como());
    assert.equal(reabierta.status, 200, reabierta.texto);
    assert.equal((await estadoDe(ref)).tramitacion.tramitada_por, null, 'Volver a pendiente lo borra');

    const e = await estadoDe(ref);
    assert.deepEqual(pares(e.eventos.slice(antes)), [
      ['ficha_abierta', 'LAURA GARCÍA'], ['marcada_sin_abrir', 'LAURA GARCÍA'], ['tramitada', 'LAURA GARCÍA'],
      ['aviso_reenviado', 'LAURA GARCÍA'], ['aviso_enviado', 'LAURA GARCÍA'], ['reabierta', 'LAURA GARCÍA'],
    ], 'Cada cosa que hace backoffice lleva el nombre de quien la hace, también el envío que dispara «Volver a enviar»');
    for (const evento of e.eventos.slice(antes)) assert.ok(!('nombre' in evento.detalle) && !('email' in evento.detalle), `${evento.tipo}: el detalle no lleva ni el nombre ni el correo`);
    assert.ok(!JSON.stringify(e.eventos).includes(EMAIL), 'El correo de la sesión no está en ningún evento');
    assert.ok(!JSON.stringify(e.tramitacion).includes(EMAIL), 'Ni en la fila');
    t.diagnostic('abrir → sin abrir → tramitar → volver a enviar → reabrir: todo con «LAURA GARCÍA»');
  });

  it('SIN nombre (una cookie de antes del nombre): `abrir=1` NO apunta la apertura y la ficha sale igual; marcar, tramitar, volver a pendiente y volver a enviar siguen funcionando con el CORREO de actor', async (t) => {
    const antigua = `${NOMBRE_COOKIE}=${firmarSesion(EMAIL, secretoBandeja())}`; // exactamente lo que ya tiene backoffice: una sesión sin `n`
    const como = (extra = {}) => ({ cookie: antigua, ...extra });
    assert.deepEqual((await get('/api/bandeja/yo', como())).json, { ok: true, email: EMAIL, nombre: null });
    assert.equal((await get('/api/bandeja/lista', como())).status, 200, 'Entra igual: el nombre es una etiqueta, no un acceso');

    // la ficha sale igual, pero sin apuntar quién la abre (una apertura sin saber quién es no sirve)
    const f = await fichaSuelta('SinNombre');
    for (const extra of ['&abrir=1', '&abrir=1&abrir=1']) {
      const r = await get(`/api/bandeja/ficha?ref=${f.ref}${extra}`, como());
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.tramitacion.ref, f.ref, 'La ficha sale igual');
      assert.ok(r.json.documentos && r.json.correos && r.json.eventos, 'Con todo lo suyo');
      assert.deepEqual(r.json.eventos, [], `«${extra}» no apunta nada`);
    }
    assert.deepEqual(await aperturasDe(f.ref), [], 'Sin nombre, ninguna apertura');
    assert.deepEqual((await tarjetaDe(f)).vistas, [], 'Y la lista la sigue viendo «Sin abrir»');

    // marcar sin abrir, tramitar y volver a pendiente: con el correo, como siempre
    assert.equal((await post('/api/bandeja/estado', { ref: f.ref, accion: 'sin_abrir' }, como())).status, 200);
    assert.deepEqual((await marcasDe(f.ref)).map((x) => x.actor), [EMAIL]);
    const tramitada = await post('/api/bandeja/estado', { ref: f.ref, accion: 'tramitar' }, como());
    assert.equal(tramitada.status, 200, tramitada.texto);
    assert.equal(tramitada.json.tramitada_por, EMAIL);
    assert.equal((await estadoDe(f.ref)).tramitacion.tramitada_por, EMAIL);
    assert.equal((await post('/api/bandeja/estado', { ref: f.ref, accion: 'reabrir' }, como())).status, 200);
    assert.deepEqual(pares((await estadoDe(f.ref)).eventos), [[MARCA, EMAIL], ['tramitada', EMAIL], ['reabierta', EMAIL]]);

    // volver a enviar (hace falta una tramitación completa, con sus correos)
    const ref = await crearTramitacion({ datos: datosGnew({ titular: 'Titular Sin Nombre SL' }), documentos: [documento(1, 'sin-nombre.pdf', generarPdf(2048))] });
    const antes = (await estadoDe(ref)).eventos.length;
    assert.deepEqual((await post('/api/bandeja/reenviar', { ref, tipo: 'acuse' }, como())).json, { ok: true, estado: 'enviado' });
    assert.deepEqual(pares((await estadoDe(ref)).eventos.slice(antes)), [['acuse_reenviado', EMAIL], ['acuse_enviado', EMAIL]]);
    t.diagnostic('cookie de antes del nombre: entra, la ficha sale, no se apunta la apertura; lo demás con el correo');
  });

  it('al cambiar de nombre la siguiente apertura se apunta AL MOMENTO (es otra persona, no la frena la ventana de 15 minutos); lo ya guardado con el correo no se reescribe', async () => {
    const f = await fichaSuelta('CambioDeNombre');
    await sembrar([apertura(f.id, EMAIL, 60)]); // una apertura de ANTES del nombre: se guardó con el correo y se queda como está
    const laura = await sesionNueva(EMAIL, 'LAURA GARCÍA');
    const abrirComo = (galleta) => get(`/api/bandeja/ficha?ref=${f.ref}&abrir=1`, { cookie: galleta });

    assert.deepEqual(pares((await abrirComo(laura)).json.eventos), [['ficha_abierta', EMAIL], ['ficha_abierta', 'LAURA GARCÍA']], 'Otro «quién»: la del correo de hace una hora no la frena');
    assert.equal((await abrirComo(laura)).json.eventos.length, 2, 'Con el mismo nombre otra vez enseguida, no (la ventana de 15 minutos de siempre)');

    // «Cambiar nombre»: otra persona en el mismo ordenador
    const cambio = await post('/api/bandeja/yo', { nombre: 'pedro ñandú' }, { cookie: laura });
    assert.equal(cambio.status, 200, cambio.texto);
    const pedro = sesionDe(cambio.cookies);
    assert.deepEqual(pares((await abrirComo(pedro)).json.eventos), [['ficha_abierta', EMAIL], ['ficha_abierta', 'LAURA GARCÍA'], ['ficha_abierta', 'PEDRO ÑANDÚ']]);
    assert.deepEqual((await aperturasDe(f.ref)).map((x) => x.actor), [EMAIL, 'LAURA GARCÍA', 'PEDRO ÑANDÚ'], 'Nada se reescribe: cada apertura se queda con quien la hizo');
    assert.deepEqual((await tarjetaDe(f)).vistas.map((v) => v.por), ['PEDRO ÑANDÚ', 'LAURA GARCÍA', EMAIL], 'La lista: una entrada por «quién», de más reciente a más antigua');
  });
});
