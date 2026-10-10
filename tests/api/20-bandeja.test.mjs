// tests/api/20-bandeja.test.mjs · Pruebas de API de la bandeja de backoffice (orden 4): código de acceso, sesión,
// lista, ficha, estado y «volver a enviar».
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
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { FORM_TOKENS, secretoBandeja, supabaseUrl } from '../../api/_lib/config.js';
import { NOMBRE_COOKIE, firmarSesion, hashCodigo } from '../../api/_lib/sesion.js';
import { actualizar, borrar, insertar, seleccionar } from '../../api/_lib/supabase.js';
import { generarJpeg, generarPdf, generarPng } from '../fixtures/generar.mjs';

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

const EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com';
const EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com';
const IBAN = 'ES9121000418450200051332';
const IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332';
const CUPS = 'ES0021000000000001RK';
const CUPS_GAS = 'ES0031000000000003BS';

/**
 * `node --test "tests/api/*.test.mjs"` lanza los ficheros A LA VEZ, y todos hablan con el MISMO servidor local, cuyo entorno
 * cambian los ganchos (/__pruebas/env: cuotas, Altavoz caído, «modo producción»…). Dos ficheros que cambian el entorno a la
 * vez se estropean entre sí (con TRAMITACION_PRUEBA=0 el servidor rechaza hasta las escrituras del otro). Por eso cada
 * fichero espera a que terminen los hermanos con número MENOR (00 → 10 → 20…), cuantos núcleos haya: así el orden es siempre
 * el mismo y nunca se esperan dos entre sí. Los hermanos son los procesos con el mismo padre (el lanzador de `node --test`).
 * Sin `ps`, o lanzado a mano sin lanzador, no hay a quién esperar y sigue.
 */
async function esperarAHermanosAnteriores({ maxMs = 8 * 60_000 } = {}) {
  const mio = Number(/(\d+)-[^/\\]*\.test\.mjs$/.exec(fileURLToPath(import.meta.url))?.[1]);
  if (!Number.isFinite(mio)) return;
  const fin = Date.now() + maxMs;
  let avisado = false;
  for (;;) {
    let anteriores = [];
    try {
      const salida = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.ppid)], { encoding: 'utf8', timeout: 10_000 });
      anteriores = salida.split('\n')
        .map((linea) => /^\s*(\d+)\s+(.*)$/.exec(linea))
        .filter((m) => m && Number(m[1]) !== process.pid)
        .map((m) => /(?:^|[/\s])(\d+)-[^/\s]*\.test\.mjs(?:\s|$)/.exec(m[2]))
        .filter((m) => m && Number(m[1]) < mio)
        .map((m) => m[0].trim());
    } catch {
      return; // sin `ps` (o sin padre): no hay a quién esperar
    }
    if (anteriores.length === 0) return;
    if (Date.now() > fin) throw new Error(`Los ficheros anteriores (${anteriores.join(', ')}) no terminan: no se puede usar el servidor a la vez`);
    if (!avisado) {
      console.log(`Espero a que terminen los ficheros anteriores de tests/api (${anteriores.join(', ')}): comparten el servidor local y su entorno.`);
      avisado = true;
    }
    await esperar(2000);
  }
}

before(() => esperarAHermanosAnteriores(), { timeout: 10 * 60_000 });

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

/** Sesión completa: pide el código, lo teclea y devuelve la cookie lista para reenviar. */
async function sesionNueva(email = EMAIL) {
  const { codigo, ip } = await pedirYLeer(email);
  const r = await post('/api/bandeja/entrar', { email, codigo }, { cabeceras: desde(ip) });
  assert.equal(r.status, 200, r.texto);
  const cookie = sesionDe(r.cookies);
  assert.ok(cookie, 'Entrar debe dar la cookie de sesión');
  return cookie;
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

  it('entrar: el código correcto da la cookie (HttpOnly, SameSite=Lax, 30 días), `yo` dice quién es y el código solo vale una vez', async () => {
    const { codigo, ip } = await pedirYLeer();
    const r = await post('/api/bandeja/entrar', { email: EMAIL, codigo: ` ${codigo.slice(0, 3)} ${codigo.slice(3)} ` }, { cabeceras: desde(ip) }); // con espacios
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.cookies.length, 1);
    const [pares, ...atributos] = r.cookies[0].split(';').map((x) => x.trim());
    assert.match(pares, /^bandeja_sesion=[A-Za-z0-9_.-]+$/);
    assert.ok(atributos.includes('HttpOnly') && atributos.includes('SameSite=Lax') && atributos.includes('Path=/') && atributos.includes('Max-Age=2592000'), `Atributos: ${atributos.join(' · ')}`);
    assert.ok(!atributos.includes('Secure'), 'Por http en local no lleva Secure');
    assert.ok(!r.texto.includes(pares.split('=')[1]), 'La cookie no viaja en el cuerpo');

    const cookie = pares;
    const yo = await get('/api/bandeja/yo', { cookie });
    assert.equal(yo.status, 200);
    assert.deepEqual(yo.json, { ok: true, email: EMAIL });

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
    const malas = {
      'carga cambiada con la firma vieja': `${cargaAjena}.${firma}`,
      'firma cambiada': `${carga}.${firma.slice(0, -2)}${firma.endsWith('A') ? 'BB' : 'AA'}`,
      'sin firma': carga,
      'basura': 'esto.no.es.una.cookie',
      'caducada (hace 31 días)': firmarSesion(EMAIL, secretoBandeja(), { ahora: ahora - 31 * 24 * 3600 * 1000 }),
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
      'cups', 'compania', 'comercial_nombre', 'creada_en', 'estado', 'formulario', 'n_documentos', 'recibida_en', 'ref', 'tarifa', 'titular_nombre',
    ].sort());
    assert.deepEqual(
      { formulario: a.formulario, estado: a.estado, compania: a.compania, titular_nombre: a.titular_nombre, cups: a.cups, comercial_nombre: a.comercial_nombre, tarifa: a.tarifa, n_documentos: a.n_documentos },
      { formulario: 'gnew', estado: 'recibida', compania: 'Compañía de Prueba', titular_nombre: 'Titular de Prueba SL', cups: CUPS, comercial_nombre: 'Comercial de Prueba', tarifa: '2.0TD', n_documentos: 4 },
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
    assert.equal((await post('/api/bandeja/yo', {}, autorizado())).status, 405);
  });

  it('ficha: todos los datos (IBAN completo), documentos con enlaces de 10 minutos que responden 200 y no llevan el nombre del archivo, correos e historial', async (t) => {
    const r = await get(`/api/bandeja/ficha?ref=${A}`, autorizado());
    assert.equal(r.status, 200, r.texto);
    const { tramitacion: f, documentos, correos, eventos, enlaces_caducan_en: caducan } = r.json;

    // los datos
    assert.equal(f.ref, A);
    assert.deepEqual(
      { formulario: f.formulario, estado: f.estado, sospechosa: f.sospechosa, comercial_nombre: f.comercial_nombre, comercial_email: f.comercial_email, compania: f.compania, cups: f.cups },
      { formulario: 'gnew', estado: 'recibida', sospechosa: false, comercial_nombre: 'Comercial de Prueba', comercial_email: EMAIL_COMERCIAL, compania: 'Compañía de Prueba', cups: CUPS },
    );
    assert.equal(f.iban, IBAN, 'El IBAN sale completo');
    assert.deepEqual(
      { oferta: f.oferta, tarifa: f.tarifa, potencias: f.potencias, titular_nombre: f.titular_nombre, titular_nif: f.titular_nif, firmante_nombre: f.firmante_nombre, firmante_nif: f.firmante_nif },
      { oferta: 'Fijo 12 meses', tarifa: '2.0TD', potencias: { p1: '4.6', p2: '4.6' }, titular_nombre: 'Titular de Prueba SL', titular_nif: '00000000T', firmante_nombre: 'Firmante de Prueba', firmante_nif: '12345678Z' },
    );
    assert.deepEqual(
      { direccion: f.direccion, cp: f.cp, poblacion: f.poblacion, provincia: f.provincia, telefono: f.telefono, email_cliente: f.email_cliente, cambio_titular: f.cambio_titular, nuevo_titular: f.nuevo_titular },
      { direccion: 'Calle de Prueba 1, 2.º A', cp: '28001', poblacion: 'Madrid', provincia: 'Madrid', telefono: '600000000', email_cliente: EMAIL_CLIENTE, cambio_titular: false, nuevo_titular: null },
    );
    assert.equal(f.observaciones, 'Línea 1\nLínea 2 con <b>etiqueta</b> & más', 'Los datos viajan tal cual en el JSON; escaparlos es cosa de la página');
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
    assert.equal(m.tramitacion.tipo_suministro, 'Gas');
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

  it('estado: tramitar guarda quién y cuándo, volver a pendiente lo borra, y cada paso deja su evento con el correo de backoffice', async (t) => {
    const antes = Date.now();
    const r1 = await post('/api/bandeja/estado', { ref: A, accion: 'tramitar' }, autorizado());
    assert.equal(r1.status, 200, r1.texto);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.estado, 'tramitada');
    assert.equal(r1.json.tramitada_por, EMAIL);
    assert.ok(Date.parse(r1.json.tramitada_en) >= antes - 2000);
    let e = await estadoDe(A);
    assert.equal(e.tramitacion.estado, 'tramitada');
    assert.equal(e.tramitacion.tramitada_por, EMAIL);
    assert.ok(e.tramitacion.tramitada_en);
    const ev = e.eventos.find((x) => x.tipo === 'tramitada');
    assert.equal(ev.actor, EMAIL);
    assert.deepEqual(ev.detalle, {});

    // en la ficha y en la lista
    const ficha = (await get(`/api/bandeja/ficha?ref=${A}`, autorizado())).json.tramitacion;
    assert.deepEqual([ficha.estado, ficha.tramitada_por], ['tramitada', EMAIL]);
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
    assert.equal(reabierta.actor, EMAIL);
    assert.equal((await post('/api/bandeja/estado', { ref: A, accion: 'reabrir' }, autorizado())).status, 409, 'Reabrir una que ya está pendiente no vale');
    assert.ok((await get('/api/bandeja/lista?estado=pendientes', autorizado())).json.items.some((i) => i.ref === A), 'Vuelve a Pendientes');
    assert.deepEqual(tipos(e).filter((x) => x === 'tramitada' || x === 'reabierta'), ['tramitada', 'reabierta']);
    t.diagnostic('tramitar → tramitada (por el correo de la sesión) → reabrir → recibida, con sus dos eventos');
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

  it('volver a enviar: el aviso vuelve a salir (intentos a 1, evento con quién lo pidió) y el acuse no se toca', async (t) => {
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
    assert.deepEqual(nuevos.map((x) => [x.tipo, x.actor]), [['aviso_reenviado', EMAIL], ['aviso_enviado', EMAIL]]);

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
    assert.deepEqual(final.eventos.filter((x) => x.tipo === 'acuse_reenviado').map((x) => x.actor), [EMAIL, EMAIL]);
    t.diagnostic('aviso reenviado y acuse reenviado dos veces (una con Altavoz caído): eventos con el correo de backoffice');
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
