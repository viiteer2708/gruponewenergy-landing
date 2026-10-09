// tests/api/00-almacen.test.mjs · SPIKE del almacén (Tramitación v2, orden 2a). Se corre el primero.
//
// Hipótesis que sostiene todo el diseño (riesgo 2 del doc): el NAVEGADOR puede subir y bajar archivos
// directamente del bucket privado «tramitaciones» de Supabase con una URL firmada, sin pasar por Vercel
// (que corta las peticiones a 4,5 MB) y sin ninguna clave. Aquí se comprueba, contra el Storage REAL:
//   · CORS: el preflight (OPTIONS) y las cabeceras de las respuestas de PUT y de GET,
//   · los tipos permitidos del bucket (un text/plain se rechaza),
//   · el límite de tamaño del bucket (25 MiB por archivo; 26 MiB se rechaza),
//   · x-upsert: repetir la subida de un archivo sobrescribe en vez de fallar.
// Si algo de esto falla NO se construye nada encima: se para y se cuenta (ver el doc, riesgo 2).
//
// Cómo se «hace de navegador»: con fetch, enviando `Origin` igual que SITIO_URL (el servidor local de
// pruebas, http://127.0.0.1:8765) y SIN `apikey` ni `Authorization` (el navegador no tiene la clave de
// servicio; `comoNavegador` lo impide). Solo firmar, listar y borrar pasan por api/_lib/supabase.js con la clave.
//
// Todo vive bajo pruebas/__spike/<nonce>/ y se borra al terminar (hook `after`, aunque algún test falle).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sitioUrl, supabaseUrl } from '../../api/_lib/config.js';
import { nonce } from '../../api/_lib/nombres.js';
import { BUCKET, borrarObjetos, crearUrlSubida, firmarDescargas, listarCarpeta } from '../../api/_lib/supabase.js';
import { generarPdf, generarPdfDemasiadoGrande, LIMITE_ALMACEN, TAMANO_PDF } from '../fixtures/generar.mjs';

// El entorno se carga por la ruta del fichero (no por el directorio desde el que se lance el test).
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env.local', import.meta.url)));
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('Falta .env.local en la raíz del proyecto: sin él no se puede probar el almacén (punto de control A del doc).');
  }
  throw error;
}

const ORIGEN_ESPERADO = 'http://127.0.0.1:8765';
const TOPE_NAVEGADOR_MS = 120_000;

// Estado compartido entre los pasos (se ejecutan en orden, uno detrás de otro).
const est = { origen: null, carpeta: null, urlGrande: null, pdf: null, pequeno: null };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const sha256 = (datos) => createHash('sha256').update(datos).digest('hex');
const es2xx = (status) => status >= 200 && status < 300;
const es4xx = (status) => status >= 400 && status < 500;

/** La URL sin el token, para poder escribirla en el parte sin secretos. */
const sinToken = (url) => url.replace(/token=[^&]+/, 'token=<token>');

function leerJson(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** Las cabeceras CORS (y las que influyen) de una respuesta, como objeto. */
function cabecerasCors(respuesta) {
  return Object.fromEntries([...respuesta.headers].filter(([nombre]) => nombre.startsWith('access-control') || nombre === 'vary'));
}

/** ¿Deja la respuesta leer el contenido a la página que está en `est.origen`? */
function permiteOrigen(respuesta) {
  const permitido = respuesta.headers.get('access-control-allow-origin');
  return permitido === '*' || permitido === est.origen;
}

/** Valores de una cabecera tipo lista («GET,PUT») en minúsculas y sin espacios. */
function listaCabecera(respuesta, nombre) {
  return (respuesta.headers.get(nombre) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Una petición como la haría el navegador de un comercial: lleva `Origin` y NADA de apikey ni Authorization.
 * Si algún día alguien la llama con esas cabeceras, el test falla en vez de «funcionar de más».
 */
function comoNavegador(url, { metodo = 'GET', cabeceras = {}, cuerpo } = {}) {
  const prohibidas = Object.keys(cabeceras).filter((nombre) => /^(apikey|authorization)$/i.test(nombre));
  assert.deepEqual(prohibidas, [], 'El navegador no tiene la clave de servicio: no puede mandar apikey ni Authorization');
  return fetch(url, {
    method: metodo,
    headers: { Origin: est.origen, ...cabeceras },
    body: cuerpo,
    signal: AbortSignal.timeout(TOPE_NAVEGADOR_MS),
  });
}

/** PUT de un archivo a una URL firmada, con las cabeceras exactas que mandará el formulario. */
async function subirComoNavegador(url, cuerpo, tipoMime) {
  const respuesta = await comoNavegador(url, {
    metodo: 'PUT',
    cabeceras: { 'Content-Type': tipoMime, 'x-upsert': 'true' },
    cuerpo,
  });
  const texto = await respuesta.text();
  return { respuesta, status: respuesta.status, texto, json: leerJson(texto) };
}

async function nombresEnLaCarpeta() {
  return (await listarCarpeta(est.carpeta)).map((o) => o.nombre);
}

// ---------------------------------------------------------------------------
// El spike
// ---------------------------------------------------------------------------

describe('Almacén de Tramitación v2: subida y descarga directas desde el navegador', () => {
  before(() => {
    // El origen se COMPRUEBA (no se supone) y ese mismo valor es el `Origin` de todas las peticiones.
    assert.strictEqual(sitioUrl(), ORIGEN_ESPERADO, 'SITIO_URL de la configuración debe ser el servidor local de pruebas');
    est.origen = sitioUrl();
    est.carpeta = `pruebas/__spike/${nonce(10)}`;
  });

  after(async () => {
    // Se borra TODO lo que haya en la carpeta (también lo que un PUT «rechazado» hubiera dejado por error)
    // y luego se comprueba que queda vacía. Corre aunque algún test haya fallado a medias.
    if (!est.carpeta) return;
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const restos = await listarCarpeta(est.carpeta);
        if (restos.length === 0) break;
        await borrarObjetos(restos.map((o) => `${est.carpeta}/${o.nombre}`));
      } catch {
        // se reintenta una vez; si sigue mal, la comprobación de abajo lo dice con la ruta
      }
    }
    const finales = await listarCarpeta(est.carpeta);
    assert.deepEqual(
      finales.map((o) => o.nombre),
      [],
      `La carpeta de la prueba debe quedar vacía; quedan estos objetos bajo ${est.carpeta}/ y hay que borrarlos a mano`,
    );
    const carpetas = await listarCarpeta('pruebas/__spike', { incluirCarpetas: true });
    assert.ok(
      !carpetas.some((o) => o.carpeta && est.carpeta.endsWith(`/${o.nombre}`)),
      'La carpeta de esta prueba no debe aparecer ya bajo pruebas/__spike',
    );
  });

  it('firma una URL de subida con token, válida durante horas y con permiso para sobrescribir (x-upsert)', async (t) => {
    const ruta = `${est.carpeta}/01.pdf`;
    est.urlGrande = await crearUrlSubida(ruta);

    const esperado = `${supabaseUrl()}/storage/v1/object/upload/sign/${BUCKET}/${ruta}?token=`;
    assert.ok(est.urlGrande.startsWith(esperado), 'La URL debe ser absoluta: <SUPABASE_URL>/storage/v1/object/upload/sign/tramitaciones/<ruta>?token=…');
    const token = new URL(est.urlGrande).searchParams.get('token');
    const partes = token.split('.');
    assert.equal(partes.length, 3, 'El token debe ser un JWT de tres partes');
    const claims = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    assert.equal(claims.upsert, true, 'Firmada con x-upsert, la URL debe llevar upsert:true dentro del token');
    const vida = claims.exp - claims.iat;
    assert.ok(vida >= 3600, `La URL debe valer al menos 1 h para subidas lentas (vale ${vida} s)`);
    t.diagnostic(`URL firmada: ${sinToken(est.urlGrande)} · token JWT con [${Object.keys(claims).join(', ')}] · vale ${vida} s · upsert=${claims.upsert}`);
  });

  it('el preflight (OPTIONS con Origin, PUT y content-type,x-upsert) deja pasar al navegador', async (t) => {
    const respuesta = await comoNavegador(est.urlGrande, {
      metodo: 'OPTIONS',
      cabeceras: {
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-upsert',
      },
    });
    await respuesta.arrayBuffer();
    assert.ok(es2xx(respuesta.status), `El preflight debe responder 2xx (respondió ${respuesta.status})`);
    assert.ok(respuesta.headers.get('access-control-allow-origin'), 'Falta access-control-allow-origin en el preflight');
    assert.ok(permiteOrigen(respuesta), `access-control-allow-origin debe ser * o ${est.origen}`);
    const metodos = listaCabecera(respuesta, 'access-control-allow-methods');
    assert.ok(metodos.includes('put') || metodos.includes('*'), 'access-control-allow-methods debe incluir PUT');
    const permitidas = listaCabecera(respuesta, 'access-control-allow-headers');
    for (const cabecera of ['content-type', 'x-upsert']) {
      assert.ok(permitidas.includes(cabecera) || permitidas.includes('*'), `access-control-allow-headers debe incluir ${cabecera}`);
    }
    t.diagnostic(`OPTIONS → HTTP ${respuesta.status} · ${JSON.stringify(cabecerasCors(respuesta))}`);
  });

  it('PUT de 5,5 MiB con Content-Type: application/pdf y x-upsert: true → 2xx, con CORS en la respuesta', async (t) => {
    est.pdf = generarPdf();
    assert.equal(est.pdf.length, TAMANO_PDF);
    const { respuesta, status, texto } = await subirComoNavegador(est.urlGrande, est.pdf, 'application/pdf');
    assert.ok(es2xx(status), `El PUT de ${est.pdf.length} bytes debe dar 2xx (dio ${status}): ${texto.slice(0, 200)}`);
    assert.ok(permiteOrigen(respuesta), 'La respuesta del PUT debe llevar access-control-allow-origin: sin ella el navegador no puede leerla y daría error aunque se haya subido');
    t.diagnostic(`PUT ${est.pdf.length} bytes application/pdf → HTTP ${status} · ${texto.slice(0, 120)} · ${JSON.stringify(cabecerasCors(respuesta))}`);
  });

  it('el almacén guarda el objeto con el tamaño EXACTO y el tipo application/pdf', async (t) => {
    const objeto = (await listarCarpeta(est.carpeta)).find((o) => o.nombre === '01.pdf');
    assert.ok(objeto, '01.pdf debe aparecer en el listado de la carpeta');
    assert.equal(objeto.tamano, est.pdf.length, 'El tamaño que ve el almacén debe ser exactamente el que se subió');
    assert.equal(objeto.mime, 'application/pdf');
    t.diagnostic(`listarCarpeta → 01.pdf: ${objeto.tamano} bytes (subidos ${est.pdf.length}) · ${objeto.mime}`);
  });

  it('x-upsert: repetir el PUT (con la misma URL firmada o con una nueva) sobrescribe el objeto en vez de fallar', async (t) => {
    const ruta = `${est.carpeta}/02.pdf`;
    const url = await crearUrlSubida(ruta);
    const resumen = [];

    async function subirYComprobar(urlSubida, bytes, etiqueta) {
      const cuerpo = generarPdf(bytes);
      const { status, texto } = await subirComoNavegador(urlSubida, cuerpo, 'application/pdf');
      assert.ok(es2xx(status), `${etiqueta}: el PUT debe dar 2xx (dio ${status}): ${texto.slice(0, 200)}`);
      const objeto = (await listarCarpeta(est.carpeta)).find((o) => o.nombre === '02.pdf');
      assert.equal(objeto?.tamano, cuerpo.length, `${etiqueta}: el almacén debe tener ya el tamaño nuevo`);
      resumen.push(`${etiqueta} → HTTP ${status}, ahora ${objeto.tamano} B`);
      return cuerpo;
    }

    await subirYComprobar(url, 3000, '1.ª subida');
    await subirYComprobar(url, 1500, 'reintento con LA MISMA URL');
    est.pequeno = await subirYComprobar(await crearUrlSubida(ruta), 2200, 'URL NUEVA sobre el mismo objeto');

    const grande = (await listarCarpeta(est.carpeta)).find((o) => o.nombre === '01.pdf');
    assert.equal(grande?.tamano, est.pdf.length, 'El objeto 01.pdf no debe haberse tocado');
    t.diagnostic(`02.pdf: ${resumen.join(' · ')}`);
  });

  it('un PUT con Content-Type: text/plain se rechaza (tipo no permitido) y no se guarda nada', async (t) => {
    const url = await crearUrlSubida(`${est.carpeta}/03.pdf`);
    const { respuesta, status, json } = await subirComoNavegador(url, Buffer.from('esto no es un documento'), 'text/plain');
    assert.ok(!es2xx(status), `Un text/plain no debe aceptarse (dio ${status})`);
    assert.ok(es4xx(status), `Se espera un rechazo 4xx (dio ${status})`);
    assert.equal(json?.code, 'InvalidMimeType', `El rechazo debe ser por tipo no permitido (code=${json?.code}, statusCode=${json?.statusCode})`);
    assert.ok(!(await nombresEnLaCarpeta()).includes('03.pdf'), 'Lo rechazado no debe quedar guardado en el almacén');
    t.diagnostic(`PUT text/plain → HTTP ${status} (el cuerpo dice statusCode=${json?.statusCode}, code=${json?.code}) · ${JSON.stringify(cabecerasCors(respuesta))}`);
  });

  it('un PUT de 26 MiB (por encima de los 25 MiB del bucket) se rechaza y no se guarda nada', async (t) => {
    // OJO: 26 MiB, no «26 MB» decimales. 26.000.000 B es MENOR que el límite (26.214.400 B) y se acepta.
    const enorme = generarPdfDemasiadoGrande();
    assert.ok(enorme.length > LIMITE_ALMACEN, `El archivo de prueba (${enorme.length} B) debe superar el límite del bucket (${LIMITE_ALMACEN} B)`);
    const url = await crearUrlSubida(`${est.carpeta}/04.pdf`);
    const { respuesta, status, json } = await subirComoNavegador(url, enorme, 'application/pdf');
    assert.ok(!es2xx(status), `Un archivo de ${enorme.length} bytes no debe aceptarse (dio ${status})`);
    assert.ok(es4xx(status), `Se espera un rechazo 4xx (dio ${status})`);
    assert.equal(json?.code, 'EntityTooLarge', `El rechazo debe ser por tamaño (code=${json?.code}, statusCode=${json?.statusCode})`);
    assert.ok(!(await nombresEnLaCarpeta()).includes('04.pdf'), 'Lo rechazado no debe quedar guardado en el almacén');
    t.diagnostic(`PUT ${enorme.length} bytes → HTTP ${status} (el cuerpo dice statusCode=${json?.statusCode}, code=${json?.code}) · ${JSON.stringify(cabecerasCors(respuesta))}`);
  });

  it('firma de descarga por lote y GET con Origin: 200, cuerpo idéntico (hash) y CORS', async (t) => {
    const rutas = [`${est.carpeta}/01.pdf`, `${est.carpeta}/02.pdf`, `${est.carpeta}/no-existe.pdf`];
    const firmas = await firmarDescargas(rutas, 600);
    assert.deepEqual(firmas.map((f) => f.ruta), rutas, 'Debe haber una firma por ruta y en el mismo orden');
    const prefijo = `${supabaseUrl()}/storage/v1/object/sign/${BUCKET}/`;
    for (const f of firmas.slice(0, 2)) {
      assert.ok(f.url?.startsWith(prefijo), `La URL de descarga de ${f.ruta} debe ser absoluta: <SUPABASE_URL>/storage/v1/object/sign/tramitaciones/<ruta>?token=…`);
      assert.equal(f.error, null);
    }
    assert.ok(firmas[2].url === null, 'Un objeto que no existe no debe recibir URL');
    assert.ok(firmas[2].error, 'Un objeto que no existe debe traer el motivo, sin hacer fallar al resto del lote');

    const diag = [];
    for (const [i, esperado] of [est.pdf, est.pequeno].entries()) {
      const respuesta = await comoNavegador(firmas[i].url);
      const cuerpo = Buffer.from(await respuesta.arrayBuffer());
      assert.equal(respuesta.status, 200, `El GET de ${rutas[i].split('/').pop()} debe dar 200`);
      assert.ok(permiteOrigen(respuesta), 'La respuesta del GET debe llevar access-control-allow-origin (lo necesitan «Descargar» y el ZIP, que usan fetch)');
      assert.equal(cuerpo.length, esperado.length, 'El GET debe devolver todos los bytes');
      assert.equal(sha256(cuerpo), sha256(esperado), 'El contenido descargado debe ser idéntico al subido');
      assert.ok((respuesta.headers.get('content-type') ?? '').startsWith('application/pdf'), 'El tipo del objeto debe conservarse');
      diag.push(`${rutas[i].split('/').pop()}: HTTP ${respuesta.status}, ${cuerpo.length} B, sha256 ${sha256(cuerpo).slice(0, 12)}…, ${respuesta.headers.get('content-type')}, content-disposition=${respuesta.headers.get('content-disposition')}, ${JSON.stringify(cabecerasCors(respuesta))}`);
    }
    t.diagnostic(`Descarga firmada (${sinToken(firmas[0].url)}) · ${diag.join(' | ')} · objeto inexistente: url=null, error="${firmas[2].error}"`);
  });
});
