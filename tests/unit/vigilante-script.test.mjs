// tests/unit/vigilante-script.test.mjs · El script del vigilante (scripts/vigilante-tramitacion.mjs) como CAJA NEGRA.
//
// Cada prueba lanza el script de verdad (un proceso hijo de Node) contra un endpoint FALSO que vive en este mismo test
// (node:http en 127.0.0.1, puerto libre). El aviso de Telegram es un STUB: un script de shell que añade lo que recibe a un
// fichero. Estado, testigo y configuración van a una carpeta temporal. Nada toca /root, ni el Telegram real, ni la base,
// ni la red: ninguna prueba deja una variable de entorno sin poner (correr() lo comprueba y se niega).
//
// Lo que se demuestra: avisa UNA vez por clave, no repite, avisa «resuelto» al desaparecer (y no cuando solo EMPEORA),
// avisa de la caída de la web al 2.º fallo y de la recuperación después, no suelta «resuelto» ni purga mientras la web no
// contesta, --dry y --una-vez no tocan estado ni testigo, purga a las 24 h, si el aviso falla se reintenta, solo lee campos
// conocidos del parte y NUNCA imprime el secreto ni la URL (ni en la salida ni en los mensajes).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/vigilante-tramitacion.mjs', import.meta.url));
const SECRETO = 'secreto-de-prueba-0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// El endpoint falso
// ---------------------------------------------------------------------------

let servidor;
let puerto;
let URL_FALSA;
let respuesta; // lo que contestará el endpoint falso: {status, cuerpo, retardoMs}
let peticiones; // lo que ha recibido

const parte = (extra = {}) => ({
  ok: true, conciliadas: 0, liberados: 0, reintentados: 0, enviados: 0, abandonadas: 0, limpiados: { cuotas: 0, accesos: 0 },
  atascados: [], subidas_a_medias: [], pendientes_total: 0, ...extra,
});
const REF_A = 'GNE-20261010-ABC123';
const REF_B = 'GNE-20261010-DEF456';
const REF_M = 'MEGA-20261010-XYZ789';
const FICHA_A = `https://tramitatucontrato.energy/bandeja/c/${REF_A}`;
const atascado = (extra = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', tipo: 'aviso', ref: REF_A, estado: 'pendiente', intentos: 3, codigo_respuesta: 'red',
  creado_en: '2026-10-10T10:00:00.000Z', minutos: 14, ficha: FICHA_A, ...extra,
});
const subida = (extra = {}) => ({ ref: REF_B, formulario: 'gnew', creada_en: '2026-10-10T09:00:00.000Z', actualizada_en: '2026-10-10T09:00:00.000Z', minutos: 80, ...extra });

before(async () => {
  servidor = createServer((req, res) => {
    peticiones.push({ metodo: req.method, autorizacion: req.headers.authorization, tipo: req.headers['content-type'] });
    req.resume();
    req.on('end', () => {
      const enviar = () => {
        if (res.writableEnded || res.destroyed) return;
        res.statusCode = respuesta.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(typeof respuesta.cuerpo === 'string' ? respuesta.cuerpo : JSON.stringify(respuesta.cuerpo));
      };
      if (respuesta.retardoMs) setTimeout(enviar, respuesta.retardoMs).unref();
      else enviar();
    });
  });
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  puerto = servidor.address().port;
  URL_FALSA = `http://127.0.0.1:${puerto}/api/tramitacion/vigilante`;
});

after(() => {
  servidor.closeAllConnections();
  servidor.close();
});

// ---------------------------------------------------------------------------
// El entorno de cada prueba: carpeta temporal, stub de Telegram, estado y testigo
// ---------------------------------------------------------------------------

let carpeta;
let rutas;

beforeEach(() => {
  respuesta = { status: 200, cuerpo: parte(), retardoMs: 0 };
  peticiones = [];
  carpeta = mkdtempSync(join(tmpdir(), 'vigilante-test-'));
  rutas = {
    avisos: join(carpeta, 'telegram.txt'),
    fallar: join(carpeta, 'fallar'),
    llamadas: join(carpeta, 'llamadas.txt'), // una línea por cada vez que se llama al stub, funcione o no
    notificar: join(carpeta, 'notificar.sh'),
    estado: join(carpeta, 'estado.json'),
    testigo: join(carpeta, 'testigo'),
    configuracion: join(carpeta, 'vigilante.env'), // no existe salvo que la prueba la escriba
  };
  // El stub de «notifica-telegram.sh»: cuenta la llamada y añade el mensaje (primer argumento) al fichero; con el fichero «fallar» presente, falla
  writeFileSync(rutas.notificar, `#!/bin/sh\nprintf 'x\\n' >> '${rutas.llamadas}'\n[ -f '${rutas.fallar}' ] && exit 3\nprintf '%s\\n' "$1" >> '${rutas.avisos}'\n`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(carpeta, { recursive: true, force: true });
});

const leer = (ruta) => (existsSync(ruta) ? readFileSync(ruta, 'utf8') : '');
const mensajes = () => leer(rutas.avisos).split('\n').filter(Boolean);
const llamadasAlStub = () => leer(rutas.llamadas).split('\n').filter(Boolean).length;
const estadoGuardado = () => JSON.parse(readFileSync(rutas.estado, 'utf8'));
const escribirEstado = (estado) => writeFileSync(rutas.estado, JSON.stringify(estado), { mode: 0o600 });
const haceHoras = (horas) => new Date(Date.now() - horas * 3_600_000).toISOString();

/**
 * Lanza el script y devuelve {codigo, stdout, stderr, salida}. Comprueba SIEMPRE, en cualquier pasada y pase lo que pase,
 * que ni el secreto ni la URL de la web aparecen en la salida ni en lo que se ha mandado al stub de Telegram.
 * `env` se mezcla con el entorno mínimo; `reemplazar` lo sustituye entero (para probar la configuración).
 */
async function correr(args = [], { env = {}, reemplazar = false } = {}) {
  const base = {
    PATH: process.env.PATH,
    VIGILANTE_ENV: rutas.configuracion,
    VIGILANTE_URL: URL_FALSA,
    VIGILANTE_SECRETO: SECRETO,
    NOTIFICAR: rutas.notificar,
    ESTADO: rutas.estado,
    TESTIGO: rutas.testigo,
  };
  const entorno = reemplazar ? { PATH: process.env.PATH, ...env } : { ...base, ...env };
  // Red de seguridad: estas pruebas JAMÁS pueden llegar al Telegram real ni a los ficheros reales del VPS
  for (const nombre of ['NOTIFICAR', 'ESTADO', 'TESTIGO', 'VIGILANTE_ENV']) {
    assert.ok(typeof entorno[nombre] === 'string' && entorno[nombre].startsWith(carpeta), `${nombre} debe apuntar a la carpeta temporal de la prueba`);
  }

  const resultado = await new Promise((resolver) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: entorno, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      resolver({ codigo: error ? (typeof error.code === 'number' ? error.code : 99) : 0, stdout, stderr });
    });
  });
  resultado.salida = `${resultado.stdout}\n${resultado.stderr}`;

  for (const [que, texto] of [['la salida', resultado.salida], ['los avisos de Telegram', leer(rutas.avisos)], ['el estado guardado', leer(rutas.estado)]]) {
    assert.ok(!texto.includes(SECRETO), `${que} no debe llevar el secreto`);
    assert.ok(!texto.includes(URL_FALSA) && !texto.includes(`127.0.0.1:${puerto}`) && !texto.includes('/api/tramitacion/vigilante'), `${que} no debe llevar la URL de la web`);
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Avisar una vez, no repetir, avisar «resuelto»
// ---------------------------------------------------------------------------

describe('Vigilante (script) · una vez por clave y mensaje de resuelto', () => {
  it('avisa de lo nuevo con las frases de siempre, manda el secreto solo en la cabecera, guarda estado y toca el testigo', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()], subidas_a_medias: [subida()], pendientes_total: 2 });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    assert.deepEqual(mensajes(), [
      `🔴 Tramitación: el AVISO de ${REF_A} lleva 14 min sin salir (3 intentos; Altavoz no responde). Ficha: ${FICHA_A}`,
      `🟡 Tramitación: el envío ${REF_B} lleva 1 h 20 min con la documentación sin terminar de subir.`,
    ]);
    assert.deepEqual(peticiones, [{ metodo: 'POST', autorizacion: `Bearer ${SECRETO}`, tipo: 'application/json' }]);
    assert.deepEqual(Object.keys(estadoGuardado().alertas).sort(), [`correo:${atascado().id}:pendiente`, `subida:${REF_B}`].sort());
    assert.equal(statSync(rutas.estado).mode & 0o777, 0o600, 'El estado se guarda con permisos 0600');
    assert.ok(existsSync(rutas.testigo), 'La pasada toca el testigo');
    assert.match(r.stdout, /pasada correcta · conciliadas 0 · cerrojos liberados 0 · reintentados 0 · enviados 0 · abandonadas 0 · pendientes 2 · atascados 1 · subidas a medias 1/);
    assert.match(r.stdout, /Avisos: nuevos 2 · ya avisados 0 · resueltos 0/);
  });

  it('no repite en la 2.ª pasada (aunque cambien los minutos o los intentos) y avisa «resuelto» cuando desaparece', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()], subidas_a_medias: [subida()] });
    await correr();
    assert.equal(mensajes().length, 2);

    respuesta.cuerpo = parte({ atascados: [atascado({ minutos: 19, intentos: 4 })], subidas_a_medias: [subida({ minutos: 85 })] });
    const segunda = await correr();
    assert.equal(mensajes().length, 2, 'La misma incidencia no se vuelve a avisar');
    assert.match(segunda.stdout, /ya avisado/);
    assert.match(segunda.stdout, /Avisos: nuevos 0 · ya avisados 2 · resueltos 0/);

    respuesta.cuerpo = parte(); // todo resuelto
    const tercera = await correr();
    assert.deepEqual(mensajes().slice(2).sort(), [
      `✅ Tramitación: el AVISO de ${REF_A} ya ha salido.`,
      `✅ Tramitación: el envío ${REF_B} ya no está a medias.`,
    ].sort());
    assert.match(tercera.stdout, /Avisos: nuevos 0 · ya avisados 0 · resueltos 2/);
    assert.deepEqual(estadoGuardado().alertas, {});

    await correr();
    assert.equal(mensajes().length, 4, 'Y el «resuelto» tampoco se repite');
  });

  it('si el mismo correo EMPEORA (cambia de estado) se avisa de nuevo y no se dice que «ya ha salido»; cuando sale, una vez', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    await correr();
    respuesta.cuerpo = parte({ atascados: [atascado({ estado: 'agotado', intentos: 8, minutos: 190 })] });
    await correr();
    assert.deepEqual(mensajes(), [
      `🔴 Tramitación: el AVISO de ${REF_A} lleva 14 min sin salir (3 intentos; Altavoz no responde). Ficha: ${FICHA_A}`,
      `🔴 Tramitación: el AVISO de ${REF_A} no se ha podido enviar tras 8 intentos. Revísalo en la bandeja. Ficha: ${FICHA_A}`,
    ]);
    assert.deepEqual(Object.keys(estadoGuardado().alertas), [`correo:${atascado().id}:agotado`], 'La clave vieja se ha sustituido en silencio');
    respuesta.cuerpo = parte();
    await correr();
    assert.equal(mensajes().length, 3);
    assert.equal(mensajes()[2], `✅ Tramitación: el AVISO de ${REF_A} ya ha salido.`);
  });

  it('cada estado final tiene su frase en llano; el acuse es «ACUSE»; sin ficha no hay «Ficha:»; las duraciones se leen bien', async () => {
    const id = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
    respuesta.cuerpo = parte({
      atascados: [
        atascado({ id: id(1), estado: 'suprimido', codigo_respuesta: 'destinatario_suprimido', intentos: 1, minutos: 2 }),
        atascado({ id: id(2), tipo: 'acuse', estado: 'suprimido', codigo_respuesta: 'destinatario_suprimido', intentos: 1, minutos: 2 }),
        atascado({ id: id(3), estado: 'error_configuracion', codigo_respuesta: 'http_401', intentos: 1, minutos: 3, ficha: null }),
        atascado({ id: id(4), estado: 'incierto', codigo_respuesta: 'envio_incierto', intentos: 1, minutos: 3 }),
        atascado({ id: id(5), tipo: 'acuse', ref: REF_M, estado: 'pendiente', codigo_respuesta: 'modo_prueba', intentos: 1, minutos: 11, ficha: `https://tramitatucontrato.energy/bandeja/c/${REF_M}` }),
        atascado({ id: id(6), estado: 'pendiente', codigo_respuesta: 'envio_no_disponible', intentos: 0, minutos: 60 }),
        atascado({ id: id(7), estado: 'enviando', codigo_respuesta: null, intentos: 2, minutos: 2 * 24 * 60 }),
      ],
      subidas_a_medias: [subida({ minutos: 59 }), subida({ ref: REF_M, formulario: 'mega', minutos: 120 }), subida({ ref: 'GNE-20261010-GHI012', minutos: 47 * 60 + 59 })],
    });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    const todos = mensajes();
    const buscar = (texto) => todos.find((m) => m.includes(texto));
    assert.match(buscar('el AVISO de GNE-20261010-ABC123 no se ha podido enviar: el buzón'), /el buzón de tramitación está bloqueado en Altavoz y no recibe ningún aviso\. Revísalo en la bandeja\. Ficha: /);
    assert.match(buscar('el ACUSE de GNE-20261010-ABC123 no se ha podido enviar'), /la dirección del comercial está bloqueada en Altavoz/);
    assert.equal(buscar('Altavoz rechaza la configuración'), `🔴 Tramitación: el AVISO de ${REF_A} no se ha podido enviar: Altavoz rechaza la configuración del envío (clave, permiso o remitente). Revísalo en la bandeja.`, 'Sin ficha, sin «Ficha:»');
    assert.match(buscar('puede haber salido o no'), /Altavoz no lo confirma\. Compruébalo antes de repetirlo; en la bandeja está «Volver a enviar»\./);
    assert.equal(buscar(`ACUSE de ${REF_M}`), `🔴 Tramitación: el ACUSE de ${REF_M} lleva 11 min sin salir (1 intento; Altavoz está en modo prueba). Ficha: https://tramitatucontrato.energy/bandeja/c/${REF_M}`);
    assert.match(buscar('lleva 1 h sin salir'), /\(todavía sin intentar; Altavoz no puede enviar ahora mismo\)/);
    assert.match(buscar('lleva 2 días sin salir'), /\(2 intentos; Altavoz no responde\)/);
    assert.ok(buscar(`el envío ${REF_B} lleva 59 min con`));
    assert.ok(buscar(`el envío ${REF_M} lleva 2 h con`));
    assert.ok(buscar('el envío GNE-20261010-GHI012 lleva 47 h 59 min con'));
    assert.equal(todos.length, 10);
  });
});

// ---------------------------------------------------------------------------
// La web no contesta
// ---------------------------------------------------------------------------

describe('Vigilante (script) · la web no contesta', () => {
  it('avisa al 2.º fallo seguido (no al 1.º), no repite, y al volver avisa de la recuperación; el testigo se toca en cada pasada', async () => {
    respuesta = { status: 503, cuerpo: { ok: false, codigo: 'temporal' }, retardoMs: 0 };
    const primero = await correr();
    assert.equal(primero.codigo, 1);
    assert.match(primero.stdout, /FALLO 1: la web ha contestado HTTP 503/);
    assert.deepEqual(mensajes(), [], 'Un solo fallo no avisa');
    assert.equal(estadoGuardado().fallos, 1);
    assert.ok(existsSync(rutas.testigo), 'El cron ha corrido: el testigo se toca aunque la web falle');

    const segundo = await correr();
    assert.equal(segundo.codigo, 1);
    assert.deepEqual(mensajes(), ['🔴 Tramitación: el vigilante no consigue hablar con la web (2 veces seguidas). Los correos pendientes no se están reintentando.']);

    await correr();
    await correr();
    assert.equal(mensajes().length, 1, 'La caída no se repite mientras dure');

    respuesta = { status: 200, cuerpo: parte(), retardoMs: 0 };
    const vuelta = await correr();
    assert.equal(vuelta.codigo, 0);
    assert.equal(mensajes().length, 2);
    assert.equal(mensajes()[1], '✅ Tramitación: la web vuelve a responder al vigilante.');
    assert.equal(estadoGuardado().fallos, 0);
    assert.deepEqual(estadoGuardado().alertas, {});

    await correr();
    assert.equal(mensajes().length, 2, 'Y la recuperación tampoco se repite');
  });

  it('un fallo suelto entre dos pasadas buenas no avisa de nada (el contador se reinicia)', async () => {
    await correr();
    respuesta = { status: 502, cuerpo: '', retardoMs: 0 };
    await correr();
    respuesta = { status: 200, cuerpo: parte(), retardoMs: 0 };
    await correr();
    respuesta = { status: 502, cuerpo: '', retardoMs: 0 };
    await correr();
    assert.deepEqual(mensajes(), []);
    assert.equal(estadoGuardado().fallos, 1);
  });

  it('todo lo que no es un 2xx con parte válido cuenta como fallo: 401, 500, JSON roto, ok:false, sin conexión y sin respuesta a tiempo', async () => {
    const casos = [
      ['401', { status: 401, cuerpo: { ok: false, codigo: 'no_autorizado' } }, /HTTP 401/],
      ['500', { status: 500, cuerpo: 'Internal Server Error' }, /HTTP 500/],
      ['JSON roto', { status: 200, cuerpo: '{"ok":' }, /no es válida/],
      ['ok:false', { status: 200, cuerpo: { ok: false } }, /no es válida/],
      ['una lista', { status: 200, cuerpo: [] }, /no es válida/],
    ];
    for (const [nombre, contestacion, esperado] of casos) {
      respuesta = { ...contestacion, retardoMs: 0 };
      const r = await correr();
      assert.equal(r.codigo, 1, nombre);
      assert.match(r.stdout, esperado, nombre);
    }

    // sin conexión: nadie escucha en ese puerto (el 1 no lo usa nadie)
    const sinConexion = await correr([], { env: { VIGILANTE_URL: 'http://127.0.0.1:1/api/tramitacion/vigilante' } });
    assert.equal(sinConexion.codigo, 1);
    assert.match(sinConexion.stdout, /no se ha podido conectar con la web/);
    assert.ok(!sinConexion.salida.includes('127.0.0.1:1'), 'Ni siquiera la URL de la prueba sin conexión sale en la salida');

    // la web tarda más que el tope (aquí 300 ms en vez de 55 s)
    respuesta = { status: 200, cuerpo: parte(), retardoMs: 5000 };
    const lenta = await correr([], { env: { VIGILANTE_TOPE_MS: '300' } });
    assert.equal(lenta.codigo, 1);
    assert.match(lenta.stdout, /la web no ha contestado a tiempo/);

    // 7 fallos → la caída ya se había avisado una sola vez (al 2.º)
    assert.equal(mensajes().length, 1);
    assert.match(mensajes()[0], /\(2 veces seguidas\)/);
  });

  it('mientras la web no contesta no se manda ningún «resuelto» ni se purga nada (ni lo de más de 24 h): no se sabe si siguen ahí', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()], subidas_a_medias: [subida()] });
    await correr();
    assert.equal(mensajes().length, 2);

    // Una entrada vieja (sin ver desde hace 25 h) que la próxima pasada BUENA olvidaría en silencio
    const REF_VIEJA = 'GNE-20261001-CCC333';
    const previo = estadoGuardado();
    previo.alertas[`subida:${REF_VIEJA}`] = { tipo: 'subida', ref: REF_VIEJA, desde: haceHoras(30), visto: haceHoras(25) };
    escribirEstado(previo);

    respuesta = { status: 500, cuerpo: '', retardoMs: 0 };
    await correr();
    await correr();
    await correr();
    assert.equal(mensajes().length, 3, 'Solo el aviso de que la web no contesta; nada de «resuelto»');
    const durante = estadoGuardado();
    assert.deepEqual(
      Object.keys(durante.alertas).sort(),
      [...Object.keys(previo.alertas), 'endpoint'].sort(),
      'Las incidencias siguen apuntadas, también la de hace 25 h: con la web caída no se purga',
    );

    // Vuelve la web y las incidencias siguen: se avisa de la recuperación, NO se repiten, y ahora sí se olvida lo viejo (en silencio)
    respuesta = { status: 200, cuerpo: parte({ atascados: [atascado()], subidas_a_medias: [subida()] }), retardoMs: 0 };
    const vuelta = await correr();
    assert.deepEqual(mensajes().slice(3), ['✅ Tramitación: la web vuelve a responder al vigilante.']);
    assert.match(vuelta.stdout, /1 entradas sin ver en 24 h olvidadas/);
    assert.ok(!Object.keys(estadoGuardado().alertas).includes(`subida:${REF_VIEJA}`));
  });
});

// ---------------------------------------------------------------------------
// --dry, --una-vez y la purga
// ---------------------------------------------------------------------------

describe('Vigilante (script) · --dry, --una-vez y purga a las 24 h', () => {
  it('--dry imprime el parte y lo que AVISARÍA sin avisar, sin guardar el estado y sin tocar el testigo', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()], subidas_a_medias: [subida()] });
    const r = await correr(['--dry']);
    assert.equal(r.codigo, 0, r.salida);
    assert.equal(mensajes().length, 0, 'El stub no ha recibido nada');
    assert.ok(!existsSync(rutas.avisos));
    assert.ok(!existsSync(rutas.estado), 'No se ha creado el estado');
    assert.ok(!existsSync(rutas.testigo), 'No se ha tocado el testigo');
    assert.match(r.stdout, /SIMULACRO \(--dry\)/);
    assert.match(r.stdout, /AVISARÍA: 🔴 Tramitación: el AVISO de GNE-20261010-ABC123 lleva 14 min sin salir/);
    assert.match(r.stdout, /AVISARÍA: 🟡 Tramitación: el envío GNE-20261010-DEF456 lleva 1 h 20 min/);
    assert.match(r.stdout, /Avisos: nuevos 2 · ya avisados 0 · resueltos 0 \(simulacro: no se ha avisado\)/);
    assert.equal(peticiones.length, 1, 'Sí llama a la web (que hace su trabajo de siempre)');

    // Y como no guardó nada, la pasada de verdad que viene después SÍ avisa
    await correr();
    assert.equal(mensajes().length, 2);
  });

  it('--dry lee el estado (dice qué ya estaba avisado) pero no lo cambia: ni lo crea, ni lo actualiza, ni borra lo resuelto', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    await correr();
    const antes = leer(rutas.estado);
    const mtimeAntes = statSync(rutas.estado).mtimeMs;
    utimesSync(rutas.testigo, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

    respuesta.cuerpo = parte(); // se resolvió
    const r = await correr(['--dry']);
    assert.match(r.stdout, /AVISARÍA: ✅ Tramitación: el AVISO de GNE-20261010-ABC123 ya ha salido\./);
    assert.equal(leer(rutas.estado), antes, 'El estado queda exactamente igual');
    assert.equal(statSync(rutas.estado).mtimeMs, mtimeAntes);
    assert.equal(statSync(rutas.testigo).mtime.getUTCFullYear(), 2020, 'El testigo no se toca');
    assert.equal(mensajes().length, 1, 'Solo el aviso de la primera pasada');
  });

  it('--una-vez ignora el estado guardado (avisa de todo), no lo modifica y no toca el testigo', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    await correr();
    assert.equal(mensajes().length, 1);
    const antes = leer(rutas.estado);
    utimesSync(rutas.testigo, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

    const r = await correr(['--una-vez']);
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.stdout, /PASADA SUELTA \(--una-vez\)/);
    assert.equal(mensajes().length, 2, 'Avisa otra vez porque no mira lo que ya estaba avisado');
    assert.equal(leer(rutas.estado), antes, 'El estado no se toca');
    assert.equal(statSync(rutas.testigo).mtime.getUTCFullYear(), 2020);

    // sin estado previo, --una-vez tampoco lo crea
    rmSync(rutas.estado);
    rmSync(rutas.testigo);
    await correr(['--una-vez']);
    assert.ok(!existsSync(rutas.estado) && !existsSync(rutas.testigo));

    // las dos juntas: solo imprime
    const antesDeLaDoble = mensajes().length;
    const doble = await correr(['--dry', '--una-vez']);
    assert.match(doble.stdout, /AVISARÍA/);
    assert.equal(mensajes().length, antesDeLaDoble);
  });

  it('las entradas no vistas en 24 h se olvidan sin avisar; las de menos de 24 h se resuelven con su mensaje', async () => {
    escribirEstado({
      version: 1,
      fallos: 0,
      alertas: {
        'correo:viejo-1:pendiente': { tipo: 'correo', id: 'viejo-1', ref: 'GNE-20261001-AAA111', correo: 'aviso', desde: haceHoras(30), visto: haceHoras(25) },
        'subida:GNE-20261001-BBB222': { tipo: 'subida', ref: 'GNE-20261001-BBB222', desde: haceHoras(5), visto: haceHoras(23) },
        endpoint: { tipo: 'endpoint', desde: haceHoras(48), visto: haceHoras(26) },
      },
    });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    assert.deepEqual(mensajes(), ['✅ Tramitación: el envío GNE-20261001-BBB222 ya no está a medias.'], 'Lo de hace 25 h y 26 h se olvida sin decir nada');
    assert.match(r.stdout, /2 entradas sin ver en 24 h olvidadas/);
    assert.deepEqual(estadoGuardado().alertas, {});
  });

  it('un fichero de estado ilegible se avisa en el registro y se empieza de cero', async () => {
    writeFileSync(rutas.estado, '{esto no es json');
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.stdout, /el fichero de estado no se podía leer; se empieza de cero/);
    assert.equal(mensajes().length, 1);
    assert.equal(estadoGuardado().version, 1, 'Y queda un estado bueno');
  });
});

// ---------------------------------------------------------------------------
// Si Telegram falla
// ---------------------------------------------------------------------------

describe('Vigilante (script) · si el aviso no sale', () => {
  it('una incidencia que no se ha podido avisar NO se da por avisada: se reintenta en la pasada siguiente', async () => {
    writeFileSync(rutas.fallar, '');
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    const fallida = await correr();
    assert.equal(fallida.codigo, 0, 'La pasada se hace igual');
    assert.match(fallida.stdout, /NO SE HA PODIDO AVISAR \(ha terminado con el código 3\); se reintenta en la pasada siguiente/);
    assert.match(fallida.stdout, /sin poder avisar 1/);
    assert.equal(mensajes().length, 0);
    assert.deepEqual(estadoGuardado().alertas, {}, 'No queda apuntada como avisada');

    rmSync(rutas.fallar); // Telegram vuelve
    await correr();
    assert.equal(mensajes().length, 1);
    await correr();
    assert.equal(mensajes().length, 1, 'Ahora sí, y una sola vez');
  });

  it('con Telegram caído solo se intenta UNA vez por pasada (no se insiste con cada incidencia) y todo se reintenta en la siguiente', async () => {
    writeFileSync(rutas.fallar, '');
    respuesta.cuerpo = parte({ atascados: [atascado(), atascado({ id: 'aaaaaaaa-0000-4000-8000-000000000002', tipo: 'acuse', minutos: 12 })], subidas_a_medias: [subida()] });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    assert.equal(llamadasAlStub(), 1, 'Tres incidencias, un solo intento: el primero ya ha dicho que Telegram no funciona');
    assert.match(r.stdout, /SIN AVISAR \(el aviso anterior ha fallado en esta pasada/);
    assert.match(r.stdout, /sin poder avisar 3/);
    assert.deepEqual(estadoGuardado().alertas, {}, 'Ninguna queda apuntada como avisada');

    rmSync(rutas.fallar); // vuelve Telegram
    await correr();
    assert.equal(mensajes().length, 3, 'Las tres salen de golpe en la pasada siguiente');
    await correr();
    assert.equal(mensajes().length, 3);
  });

  it('un «resuelto» que no sale se reintenta: la incidencia sigue apuntada hasta que se pueda decir', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    await correr();
    respuesta.cuerpo = parte();
    writeFileSync(rutas.fallar, '');
    await correr();
    assert.equal(Object.keys(estadoGuardado().alertas).length, 1, 'Sigue apuntada');
    rmSync(rutas.fallar);
    await correr();
    assert.deepEqual(mensajes().slice(1), [`✅ Tramitación: el AVISO de ${REF_A} ya ha salido.`]);
    assert.deepEqual(estadoGuardado().alertas, {});
  });

  it('un NOTIFICAR que no existe o no se puede ejecutar tampoco rompe la pasada', async () => {
    respuesta.cuerpo = parte({ atascados: [atascado()] });
    const r = await correr([], { env: { NOTIFICAR: join(carpeta, 'no-existe.sh') } });
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.stdout, /NO SE HA PODIDO AVISAR \(no se ha podido ejecutar\)/);
  });
});

// ---------------------------------------------------------------------------
// Qué lee del parte y qué nunca imprime
// ---------------------------------------------------------------------------

describe('Vigilante (script) · solo lee campos conocidos y nunca imprime secretos ni datos personales', () => {
  it('lo que no encaja con la forma esperada se descarta, y los campos de más (con datos personales) no llegan a ningún mensaje', async () => {
    const PERSONALES = ['persona.real@ejemplo.com', 'Nombre Apellido', 'ES9121000418450200051332', 'Calle Falsa 123', SECRETO, URL_FALSA];
    respuesta.cuerpo = parte({
      mensaje: `${SECRETO} ${URL_FALSA}`,
      secreto: SECRETO,
      atascados: [
        atascado({ para: PERSONALES[0], titular_nombre: PERSONALES[1], iban: PERSONALES[2], direccion: PERSONALES[3], asunto: `Nuevo Contrato - ${PERSONALES[1]}`, codigo_respuesta: `raro ${PERSONALES[0]}` }),
        atascado({ id: 'cccccccc-0000-4000-8000-000000000002', ref: 'GNE-<b>x</b>' }), // referencia que no es una referencia
        atascado({ id: 'cccccccc-0000-4000-8000-000000000003', estado: 'inventado' }), // estado desconocido
        { ...atascado(), id: undefined }, // sin id
        'esto no es un objeto',
        null,
      ],
      subidas_a_medias: [{ ref: 'no-es-una-ref', minutos: 99 }, subida({ titular: PERSONALES[1] }), 5],
    });
    const r = await correr();
    assert.equal(r.codigo, 0, r.salida);
    const todos = [r.salida, leer(rutas.avisos), leer(rutas.estado)].join('\n');
    for (const dato of PERSONALES) assert.ok(!todos.includes(dato), `No debe aparecer «${dato.slice(0, 12)}…» en ninguna parte`);
    assert.equal(mensajes().length, 2, 'Solo el atasco válido y la subida válida');
    assert.match(mensajes()[0], /\(3 intentos; Altavoz no responde\)/, 'Un código de respuesta desconocido se lee como «Altavoz no responde»');
    assert.match(r.stdout, /atascados 1 · subidas a medias 1/);
  });

  it('en TODAS las pasadas (buenas, malas, --dry, errores de configuración) ni el secreto ni la URL salen en la salida', async () => {
    // correr() ya lo comprueba en cada llamada; aquí se recorre a propósito un abanico de situaciones, incluida una web
    // maliciosa que repite el secreto y la URL en el cuerpo de un error
    respuesta = { status: 500, cuerpo: `error ${SECRETO} ${URL_FALSA}`, retardoMs: 0 };
    await correr();
    await correr(['--dry']);
    respuesta = { status: 200, cuerpo: `${SECRETO}`, retardoMs: 0 };
    await correr();
    respuesta = { status: 200, cuerpo: parte({ atascados: [atascado()] }), retardoMs: 0 };
    await correr();
    await correr(['--una-vez']);
    await correr(['--ayuda']);
    await correr(['--loquesea']);
    await correr([], { env: { VIGILANTE_URL: 'http://ejemplo.invalid/x' } });
    await correr([], { env: { VIGILANTE_SECRETO: 'con espacio' } });
    await correr([], { env: { VIGILANTE_URL: 'esto no es una url' } });
    assert.ok(peticiones.length >= 4);
  });
});

// ---------------------------------------------------------------------------
// Configuración y uso
// ---------------------------------------------------------------------------

describe('Vigilante (script) · configuración y uso', () => {
  it('sin URL o sin secreto: sale con el código 2, explica qué falta (sin valores) y no deja ni estado ni testigo', async () => {
    for (const quitar of [{ VIGILANTE_URL: '' }, { VIGILANTE_SECRETO: '' }]) {
      const r = await correr([], { env: quitar });
      assert.equal(r.codigo, 2, JSON.stringify(quitar));
      assert.match(r.stderr, /Falta la configuración: hacen falta VIGILANTE_URL y VIGILANTE_SECRETO/);
    }
    assert.ok(!existsSync(rutas.estado) && !existsSync(rutas.testigo) && !existsSync(rutas.avisos));
    assert.equal(peticiones.length, 0, 'Ni siquiera llama a la web');
  });

  it('rechaza una URL que no es https (salvo en 127.0.0.1), una URL ilegible y un secreto con espacios o caracteres raros', async () => {
    for (const [env, frase] of [
      [{ VIGILANTE_URL: 'http://ejemplo.invalid/api/tramitacion/vigilante' }, /tiene que empezar por https:\/\//],
      [{ VIGILANTE_URL: 'ftp://127.0.0.1/x' }, /tiene que empezar por https:\/\//],
      [{ VIGILANTE_URL: 'esto no es una url' }, /no es una dirección válida/],
      [{ VIGILANTE_SECRETO: 'tiene un espacio' }, /VIGILANTE_SECRETO no es válido/],
      [{ VIGILANTE_SECRETO: 'ñandú-con-acentos' }, /VIGILANTE_SECRETO no es válido/],
    ]) {
      const r = await correr([], { env });
      assert.equal(r.codigo, 2, JSON.stringify(Object.keys(env)));
      assert.match(r.stderr, frase);
    }
    assert.equal(peticiones.length, 0);
  });

  it('opción desconocida → código 2 con la ayuda; --ayuda → código 0 con el uso', async () => {
    const mala = await correr(['--loquesea']);
    assert.equal(mala.codigo, 2);
    assert.match(mala.stderr, /Opción desconocida: --loquesea/);
    assert.match(mala.stderr, /Uso: node scripts\/vigilante-tramitacion\.mjs/);
    const ayuda = await correr(['--ayuda']);
    assert.equal(ayuda.codigo, 0);
    assert.match(ayuda.stdout, /--dry/);
    assert.match(ayuda.stdout, /--una-vez/);
    assert.equal(peticiones.length, 0);
  });

  it('la configuración puede venir de un fichero (con comentarios, export y comillas) y el entorno manda sobre el fichero', async () => {
    writeFileSync(rutas.configuracion, [
      '# configuración de prueba',
      '',
      `export VIGILANTE_URL="${URL_FALSA}"`,
      `VIGILANTE_SECRETO='${SECRETO}'`,
      `NOTIFICAR=${rutas.notificar}`,
      `ESTADO=${rutas.estado}`,
      `TESTIGO=${rutas.testigo}`,
    ].join('\n'), { mode: 0o600 });
    respuesta.cuerpo = parte({ atascados: [atascado()] });

    // solo el fichero: nada de URL ni secreto en el entorno
    const soloFichero = await correr([], { reemplazar: true, env: { VIGILANTE_ENV: rutas.configuracion, NOTIFICAR: rutas.notificar, ESTADO: rutas.estado, TESTIGO: rutas.testigo, VIGILANTE_URL: '', VIGILANTE_SECRETO: '' } });
    assert.equal(soloFichero.codigo, 0, soloFichero.salida);
    assert.equal(mensajes().length, 1);
    assert.deepEqual(peticiones.map((p) => p.autorizacion), [`Bearer ${SECRETO}`]);

    // el entorno manda: la URL del entorno (el endpoint falso) gana a la del fichero (un puerto muerto)
    writeFileSync(rutas.configuracion, `VIGILANTE_URL=http://127.0.0.1:1/muerto\nVIGILANTE_SECRETO=${SECRETO}\n`, { mode: 0o600 });
    rmSync(rutas.estado);
    const entornoGana = await correr([], { env: { VIGILANTE_ENV: rutas.configuracion } });
    assert.equal(entornoGana.codigo, 0, entornoGana.salida);
    const soloMuerto = await correr([], { reemplazar: true, env: { VIGILANTE_ENV: rutas.configuracion, NOTIFICAR: rutas.notificar, ESTADO: rutas.estado, TESTIGO: rutas.testigo } });
    assert.equal(soloMuerto.codigo, 1, 'Sin la URL del entorno, usa la del fichero (la muerta)');
  });

  it('el script solo importa node:fs y node:child_process y no usa nada del repo', () => {
    const fuente = readFileSync(SCRIPT, 'utf8');
    const importaciones = [...fuente.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort();
    assert.deepEqual(importaciones, ['node:child_process', 'node:fs']);
    assert.ok(!/\brequire\s*\(/.test(fuente) && !/\bimport\s*\(/.test(fuente), 'Sin require ni import dinámico');
    assert.ok(!/\.\.\/api\/|\.\/api\//.test(fuente), 'No toca api/');
    assert.match(fuente, /^#!\/usr\/bin\/env node/, 'Lleva la línea de intérprete');
    assert.ok(/redirect:\s*'error'/.test(fuente), 'No sigue redirecciones: el secreto no viaja a otro sitio');
    assert.ok(!/console\.(log|error|warn|info)\([^)]*(config\.url|config\.secreto|\.secreto\b)/.test(fuente), 'Ninguna salida usa la URL ni el secreto');
  });
});
