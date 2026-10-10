// tests/servidor-local.mjs · Servidor de pruebas en 127.0.0.1:8765 (Tramitación v2).
//
// Hace de Vercel en local: sirve los estáticos del proyecto con los `redirects`, `rewrites` y `headers` de
// vercel.json (con :parámetros), y ejecuta las funciones de api/ pasándoles una `req` y una `res` como las de
// Vercel (`req.body` ya leído —con el mismo getter que LANZA si el JSON está roto—, `req.query`, `req.cookies`;
// `res.status().json()`).
//
//   node tests/servidor-local.mjs &        (guarda el PID; se para con kill <PID>, nunca con pkill -f)
//
// SEGURIDAD. Este servidor habla con la base REAL de Supabase («gnew-plataforma»), así que:
//  · se niega a arrancar si .env.local no pone TRAMITACION_PRUEBA=1 y ALTAVOZ_SIMULAR=1: todo lo que se escribe
//    lleva prueba=true y vive bajo pruebas/ en el almacén, y NUNCA se envía un correo de verdad;
//  · se ata solo a 127.0.0.1 y rechaza cualquier cabecera Host que no sea la suya;
//  · los ganchos /__pruebas/* existen SOLO aquí (nunca en api/), y sacan solo filas prueba=true y correos simulados;
//  · si el gancho de entorno apaga TRAMITACION_PRUEBA, el servidor solo atiende lecturas (GET/HEAD) de api/: ninguna escritura sin marca;
//  · el gancho de entorno solo deja tocar unas pocas variables de prueba y jamás la simulación, las claves ni
//    las direcciones: ver VARIABLES_PERMITIDAS.
//
// Ganchos (los usan los tests; la base se lee siempre por aquí, nunca directamente):
//   GET  /__pruebas/correos?para=&tipo=&asunto=   {correos, envios, espia}: `correos` = últimos 5 correos simulados de la base,
//                                                 con su cuerpo y, si el espía los vio, sus `adjuntos` [{nombre, bytes, md5}];
//                                                 `envios` = lo que el espía anotó EN MEMORIA de cada llamada a Altavoz (incluidas
//                                                 las rechazadas): para, asunto, adjuntos con su md5 y el resultado
//   GET  /__pruebas/tramitacion?ref=              {tramitacion, documentos, correos, eventos} de una tramitación de prueba
//   POST /__pruebas/altavoz {caido: bool}         simula Altavoz caído (503) o lo recupera
//   POST /__pruebas/altavoz {rechazo_adjuntos: bool}  simula que Altavoz rechaza los avisos que llevan adjuntos (422) o lo quita
//   POST /__pruebas/env {VARIABLE: 'x'|null}      pone o quita una variable de proceso (cuotas…); devuelve los valores previos
//
// EL ESPÍA (orden 6). En simulación no sale ningún correo, pero las pruebas tienen que poder ver qué adjuntos llevaría cada
// aviso. Eso se apunta en MEMORIA aquí, no en la base ni en api/: al arrancar, este servidor cambia el cartero por
// tests/cartero-espia.mjs (que envuelve al de verdad) con un gancho de resolución de módulos de Node (module.registerHooks,
// Node 22.15 o más). Solo vale para las funciones que corren DENTRO de este servidor: las pruebas que llaman a cola.js o a
// vigilante.js en su propio proceso no pasan por él (para ver los adjuntos, hay que llamar a la API por HTTP).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as modulos from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PUERTO = 8765;
const LIMITE_CUERPO = 6 * 1024 * 1024; // un poco más que los 4,5 MB de Vercel

const TIPOS = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

// Variables que el gancho /__pruebas/env puede tocar. Todo lo demás (ALTAVOZ_*, SUPABASE_*, *_SECRETO,
// AVISO_DESTINO, SITIO_URL…) está prohibido: la simulación es obligatoria en todo este trabajo.
const VARIABLES_PERMITIDAS = /^(CUOTA_[A-Z_]+_HORA|TRAMITACION_PRUEBA|ALTAVOZ_SIMULAR_FALLO)$/;

// ---------------------------------------------------------------------------
// El espía de Altavoz: se pone en lugar del cartero (ver la cabecera)
// ---------------------------------------------------------------------------

const URL_CARTERO = pathToFileURL(join(RAIZ, 'api', '_lib', 'cartero.js')).href;
const URL_ESPIA = pathToFileURL(join(RAIZ, 'tests', 'cartero-espia.mjs')).href;
let espiaInstalado = false;

/** Cambia, para todo lo que se cargue después, api/_lib/cartero.js por tests/cartero-espia.mjs. true si se ha podido. */
function instalarEspia() {
  if (espiaInstalado) return true;
  if (typeof modulos.registerHooks !== 'function') {
    console.warn('AVISO: este Node no tiene module.registerHooks (hace falta 22.15 o más): el servidor no verá los adjuntos de cada aviso.');
    return false;
  }
  modulos.registerHooks({
    resolve(especificador, contexto, siguiente) {
      const resuelto = siguiente(especificador, contexto);
      // Solo el cartero de verdad (sin «?real»): el espía lo carga con «?real» y así llega al de verdad
      return resuelto.url === URL_CARTERO ? { ...resuelto, url: URL_ESPIA, shortCircuit: true } : resuelto;
    },
  });
  espiaInstalado = true;
  return true;
}

const ETIQUETA_DE_TIPO = Object.freeze({ aviso: 'tramitacion-aviso', acuse: 'tramitacion-acuse', codigo_acceso: 'bandeja-codigo' });

/** Lo que el espía ha anotado (del más antiguo al más nuevo); lista vacía si no está instalado. */
async function enviosEspiados(filtros = {}) {
  return espiaInstalado ? (await import('./cartero-espia.mjs')).enviosAnotados(filtros) : [];
}

/** A cada correo de la base, le añade los `adjuntos` [{nombre, bytes, md5}] del envío que lo dejó «enviado» (null si no se sabe). */
function conSusAdjuntos(filas, envios) {
  return filas.map((fila) => {
    const envio = [...envios].reverse().find((e) => e.resultado.altavoz_id !== null && e.resultado.altavoz_id === fila.altavoz_id
      && e.para === String(fila.para).toLowerCase() && e.etiqueta === fila.etiqueta);
    return { ...fila, adjuntos: envio ? envio.adjuntos : null };
  });
}

// ---------------------------------------------------------------------------
// Arranque y comprobaciones
// ---------------------------------------------------------------------------

function cargarEntorno() {
  try {
    process.loadEnvFile(join(RAIZ, '.env.local'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Falta .env.local en la raíz del proyecto (punto de control A del diseño).');
    throw error;
  }
  if (process.env.TRAMITACION_PRUEBA !== '1') throw new Error('.env.local debe poner TRAMITACION_PRUEBA=1: este servidor solo corre en modo prueba.');
  if (process.env.ALTAVOZ_SIMULAR !== '1') throw new Error('.env.local debe poner ALTAVOZ_SIMULAR=1: este servidor nunca envía correos de verdad.');
  // Cuotas holgadas por defecto para que las pruebas (muchas, desde la misma IP) no choquen entre sí; el caso del 429
  // las baja a propósito con /__pruebas/env. Si el entorno ya trae alguna, se respeta.
  for (const variable of ['CUOTA_INICIAR_HORA', 'CUOTA_CONFIRMAR_HORA', 'CUOTA_CODIGO_IP_HORA', 'CUOTA_CODIGO_EMAIL_HORA', 'CUOTA_ENTRAR_IP_HORA']) {
    process.env[variable] ??= '1000';
  }
  // Datos de mentira: se puede escribir el mensaje de los errores en el registro (ver textoSeguroDeError)
  process.env.TRAMITACION_DEBUG ??= '1';
}

// ---------------------------------------------------------------------------
// vercel.json: redirects, rewrites y headers
// ---------------------------------------------------------------------------

/** «/bandeja/c/:ref» → expresión regular. :n = un tramo · :n* = cero o más tramos · :n+ = uno o más. */
function compilarPatron(patron) {
  if (patron === '/') return { re: /^\/$/, nombres: [] };
  const nombres = [];
  let re = '';
  for (const tramo of patron.split('/').slice(1)) {
    let m;
    if ((m = /^:(\w+)\*$/.exec(tramo))) {
      nombres.push(m[1]);
      re += '(?:/(.*))?';
    } else if ((m = /^:(\w+)\+$/.exec(tramo))) {
      nombres.push(m[1]);
      re += '/(.+)';
    } else if ((m = /^:(\w+)$/.exec(tramo))) {
      nombres.push(m[1]);
      re += '/([^/]+)';
    } else {
      re += `/${tramo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    }
  }
  return { re: new RegExp(`^${re}/?$`), nombres };
}

function casar(reglas, pathname) {
  for (const regla of reglas) {
    const m = regla.compilada.re.exec(pathname);
    if (!m) continue;
    const valores = Object.fromEntries(regla.compilada.nombres.map((n, i) => [n, m[i + 1] ?? '']));
    return { regla, valores };
  }
  return null;
}

const sustituir = (destino, valores) => destino.replace(/:(\w+)[*+]?/g, (_, nombre) => valores[nombre] ?? '');

function cargarVercel() {
  const config = JSON.parse(readFileSync(join(RAIZ, 'vercel.json'), 'utf8'));
  const compilar = (lista) => (lista ?? []).map((r) => ({ ...r, compilada: compilarPatron(r.source) }));
  return { redirects: compilar(config.redirects), rewrites: compilar(config.rewrites), headers: compilar(config.headers) };
}

/** Lo que NO se sirve como estático: lo que excluye .vercelignore (por su primer tramo) más api/ y node_modules. */
function cargarIgnorados() {
  const patrones = existsSync(join(RAIZ, '.vercelignore'))
    ? readFileSync(join(RAIZ, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const regex = patrones.map((p) => new RegExp(`^${p.replace(/\/+$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`));
  return (primerTramo) => ['api', 'node_modules'].includes(primerTramo) || regex.some((re) => re.test(primerTramo));
}

// ---------------------------------------------------------------------------
// Utilidades de petición y respuesta
// ---------------------------------------------------------------------------

function json(res, status, cuerpo) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(cuerpo));
}

async function leerCuerpo(req) {
  const trozos = [];
  let total = 0;
  for await (const trozo of req) {
    total += trozo.length;
    if (total > LIMITE_CUERPO) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    trozos.push(trozo);
  }
  return Buffer.concat(trozos);
}

/**
 * Pone en `req` lo que Vercel pone: `body` (getter perezoso que LANZA si el JSON está roto), `query` y `cookies`.
 * Como en Vercel: application/json → objeto (vacío → {}) · text/plain o sin tipo → texto · formulario → objeto · resto → Buffer.
 */
function prepararPeticion(req, url, cuerpo) {
  let resultado;
  let fallo = null;
  let hecho = false;
  Object.defineProperty(req, 'body', {
    configurable: true,
    get() {
      if (!hecho) {
        hecho = true;
        const tipo = String(req.headers['content-type'] ?? 'text/plain').split(';')[0].trim().toLowerCase();
        try {
          if (tipo === 'application/json' || tipo === 'application/ld+json') {
            const texto = cuerpo.toString('utf8');
            resultado = texto.length === 0 ? {} : JSON.parse(texto);
          } else if (tipo === 'application/x-www-form-urlencoded') {
            resultado = Object.fromEntries(new URLSearchParams(cuerpo.toString('utf8')));
          } else if (tipo === 'text/plain') {
            resultado = cuerpo.toString('utf8');
          } else {
            resultado = cuerpo;
          }
        } catch (error) {
          fallo = Object.assign(new Error('Invalid JSON'), { statusCode: 400, cause: error });
        }
      }
      if (fallo) throw fallo;
      return resultado;
    },
  });

  const query = {};
  for (const [clave, valor] of url.searchParams) {
    if (clave === '__proto__') continue;
    if (Object.hasOwn(query, clave)) query[clave] = [].concat(query[clave], valor);
    else query[clave] = valor;
  }
  req.query = query;

  const cookies = {};
  for (const par of String(req.headers.cookie ?? '').split(';')) {
    const igual = par.indexOf('=');
    if (igual < 1) continue;
    const nombre = par.slice(0, igual).trim();
    if (nombre === '__proto__' || Object.hasOwn(cookies, nombre)) continue;
    try {
      cookies[nombre] = decodeURIComponent(par.slice(igual + 1).trim());
    } catch {
      cookies[nombre] = par.slice(igual + 1).trim();
    }
  }
  req.cookies = cookies;
}

/** `res.status(n)`, `res.json(x)` y `res.send(x)`, como los de Vercel. */
function prepararRespuesta(res) {
  res.status = (codigo) => {
    res.statusCode = codigo;
    return res;
  };
  res.json = (cuerpo) => json(res, res.statusCode || 200, cuerpo);
  res.send = (cuerpo) => {
    if (res.headersSent) return;
    if (cuerpo !== null && typeof cuerpo === 'object' && !Buffer.isBuffer(cuerpo)) return res.json(cuerpo);
    res.end(cuerpo ?? '');
  };
}

// ---------------------------------------------------------------------------
// Ganchos /__pruebas/*
// ---------------------------------------------------------------------------

// Los ganchos no miran esPrueba() en caliente: este servidor solo ARRANCA en modo prueba, y el gancho de entorno
// puede poner TRAMITACION_PRUEBA=0 un momento (la bandeja lo usa para comprobar el filtro de pruebas) y tiene que
// poder volver a ponerlo. Los datos que sacan están acotados: filas con prueba=true y correos simulados.
async function atenderGancho(req, res, url, { seleccionar }) {
  const ruta = url.pathname.slice('/__pruebas/'.length);

  async function cuerpoJson() {
    try {
      const datos = JSON.parse((await leerCuerpo(req)).toString('utf8'));
      return datos !== null && typeof datos === 'object' && !Array.isArray(datos) ? datos : null;
    } catch {
      return null;
    }
  }

  if (ruta === 'correos' && req.method === 'GET') {
    const para = url.searchParams.get('para');
    const tipo = url.searchParams.get('tipo');
    const asunto = url.searchParams.get('asunto');
    if (tipo !== null && !['aviso', 'acuse', 'codigo_acceso'].includes(tipo)) return json(res, 400, { ok: false, codigo: 'tipo' });
    if (para !== null && !/^[^\s,<>]{3,254}$/.test(para)) return json(res, 400, { ok: false, codigo: 'para' });
    if (asunto !== null && asunto.length > 300) return json(res, 400, { ok: false, codigo: 'asunto' });
    const query = { select: '*', simulado: 'eq.true', order: 'enviado_en.desc', limit: 5 };
    if (para) query.para = `eq.${para.trim().toLowerCase()}`;
    if (tipo) query.tipo = `eq.${tipo}`;
    const filas = await seleccionar('tramitacion_correos', query);
    // Lo que el espía anotó en memoria; cada correo de la base lleva los adjuntos del envío que lo dejó «enviado»
    const envios = await enviosEspiados({ para: para ?? undefined, etiqueta: tipo ? ETIQUETA_DE_TIPO[tipo] : undefined, asunto: asunto ?? undefined });
    return json(res, 200, { ok: true, correos: conSusAdjuntos(filas, envios), envios, espia: espiaInstalado });
  }

  if (ruta === 'tramitacion' && req.method === 'GET') {
    const ref = url.searchParams.get('ref') ?? '';
    if (!/^[A-Z]{3,4}-\d{8}-[A-Z0-9]{4,10}$/.test(ref)) return json(res, 400, { ok: false, codigo: 'ref' });
    const filas = await seleccionar('tramitaciones', { select: '*', ref: `eq.${ref}`, prueba: 'eq.true', limit: 1 });
    if (filas.length === 0) return json(res, 404, { ok: false, codigo: 'no_existe' });
    const id = filas[0].id;
    const [documentos, correos, eventos] = await Promise.all([
      seleccionar('tramitacion_documentos', { tramitacion_id: `eq.${id}`, order: 'orden.asc' }),
      seleccionar('tramitacion_correos', { tramitacion_id: `eq.${id}`, order: 'tipo.asc' }),
      seleccionar('tramitacion_eventos', { tramitacion_id: `eq.${id}`, order: 'id.asc' }),
    ]);
    return json(res, 200, { ok: true, tramitacion: filas[0], documentos, correos: conSusAdjuntos(correos, await enviosEspiados()), eventos });
  }

  if (ruta === 'altavoz' && req.method === 'POST') {
    const datos = await cuerpoJson();
    if (datos && typeof datos.caido === 'boolean') {
      if (datos.caido) process.env.ALTAVOZ_SIMULAR_FALLO = '1';
      else delete process.env.ALTAVOZ_SIMULAR_FALLO;
      return json(res, 200, { ok: true, caido: datos.caido });
    }
    if (datos && typeof datos.rechazo_adjuntos === 'boolean') {
      if (datos.rechazo_adjuntos) process.env.ALTAVOZ_SIMULAR_FALLO = 'adjuntos';
      else delete process.env.ALTAVOZ_SIMULAR_FALLO;
      return json(res, 200, { ok: true, rechazo_adjuntos: datos.rechazo_adjuntos });
    }
    return json(res, 400, { ok: false, codigo: 'caido' });
  }

  if (ruta === 'env' && req.method === 'POST') {
    const datos = await cuerpoJson();
    if (!datos || Object.keys(datos).length === 0) return json(res, 400, { ok: false, codigo: 'env' });
    for (const [variable, valor] of Object.entries(datos)) {
      if (!VARIABLES_PERMITIDAS.test(variable)) return json(res, 403, { ok: false, codigo: 'variable_prohibida' });
      if (valor !== null && !(typeof valor === 'string' && /^[0-9A-Za-z_.-]{0,20}$/.test(valor))) return json(res, 400, { ok: false, codigo: 'valor' });
    }
    const previo = {};
    for (const [variable, valor] of Object.entries(datos)) {
      previo[variable] = process.env[variable] ?? null;
      if (valor === null) delete process.env[variable];
      else process.env[variable] = valor;
    }
    return json(res, 200, { ok: true, previo });
  }

  return json(res, 404, { ok: false, codigo: 'no_encontrado' });
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

export async function crearServidor() {
  cargarEntorno();
  instalarEspia(); // antes de cargar nada de api/: el cartero que se importe ya será el del espía
  const { esPrueba, simulando } = await import('../api/_lib/config.js');
  const { seleccionar } = await import('../api/_lib/supabase.js');
  const vercel = cargarVercel();
  const esIgnorado = cargarIgnorados();

  function rutaEstatica(pathname) {
    let relativa;
    try {
      relativa = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const tramos = relativa.split('/').filter(Boolean);
    if (tramos.length === 0 || relativa.includes('\0')) return null;
    if (tramos.some((t) => t === '..' || t.startsWith('.'))) return null;
    if (esIgnorado(tramos[0])) return null;
    const fichero = resolve(RAIZ, ...tramos);
    return fichero.startsWith(RAIZ + sep) ? fichero : null;
  }

  async function servirFichero(req, res, fichero) {
    let info;
    try {
      info = await stat(fichero);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;
    const datos = await readFile(fichero);
    res.statusCode = 200;
    res.setHeader('Content-Type', TIPOS[extname(fichero).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', datos.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : datos);
    return true;
  }

  async function atenderApi(req, res, url) {
    // La simulación es obligatoria: si alguien la apagó por el medio, ni se ejecuta la función
    if (!simulando()) {
      console.error('ERROR: la simulación de Altavoz está apagada en el servidor local. Se rechaza la petición.');
      return json(res, 500, { ok: false, codigo: 'simulacion_apagada', mensaje: 'La simulación de Altavoz no está activada en el servidor local.' });
    }
    // Con TRAMITACION_PRUEBA distinto de 1 (la bandeja lo apaga un momento para comprobar su filtro de pruebas) solo se
    // sirven lecturas: una escritura saldría SIN marca de prueba y ensuciaría la base real.
    if (!esPrueba() && req.method !== 'GET' && req.method !== 'HEAD') {
      console.error('ERROR: escritura rechazada: TRAMITACION_PRUEBA está apagado en el servidor local.');
      return json(res, 500, { ok: false, codigo: 'modo_prueba_apagado', mensaje: 'El servidor local no está en modo prueba: solo atiende lecturas.' });
    }
    const ruta = url.pathname.slice('/api/'.length);
    // Como Vercel: nada de rutas que empiecen por «_» (api/_lib no es una función), ni por «.», ni con «..»
    if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(ruta)) return json(res, 404, { ok: false, codigo: 'no_encontrado' });
    const fichero = join(RAIZ, 'api', ...ruta.split('/')) + '.js';
    if (!existsSync(fichero)) return json(res, 404, { ok: false, codigo: 'no_encontrado' });

    let cuerpo;
    try {
      cuerpo = await leerCuerpo(req);
    } catch (error) {
      return json(res, error.status ?? 400, { ok: false, codigo: 'peticion', mensaje: 'La petición es demasiado grande.', retryable: false });
    }
    prepararPeticion(req, url, cuerpo);
    prepararRespuesta(res);

    try {
      const modulo = await import(pathToFileURL(fichero).href);
      await modulo.default(req, res);
    } catch (error) {
      console.error(`Error no controlado en /api/${ruta}: ${error?.name ?? 'Error'}`);
      json(res, 500, { ok: false, codigo: 'interno', mensaje: 'Error interno del servidor local.', retryable: true });
    }
  }

  async function atender(req, res) {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PUERTO}`);
    const host = String(req.headers.host ?? '');
    if (host !== `${HOST}:${PUERTO}` && host !== `localhost:${PUERTO}`) {
      return json(res, 403, { ok: false, codigo: 'host' });
    }

    // headers de vercel.json
    for (const regla of vercel.headers) {
      if (regla.compilada.re.test(url.pathname)) for (const { key, value } of regla.headers) res.setHeader(key, value);
    }

    if (url.pathname.startsWith('/__pruebas/')) return atenderGancho(req, res, url, { seleccionar });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return atenderApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return json(res, 405, { ok: false, codigo: 'metodo' });
    }

    const redireccion = casar(vercel.redirects, url.pathname);
    if (redireccion) {
      res.statusCode = redireccion.regla.statusCode ?? 308;
      res.setHeader('Location', sustituir(redireccion.regla.destination, redireccion.valores) + url.search);
      return res.end();
    }

    // Como Vercel: primero el fichero, y solo si no existe, las reescrituras
    const fichero = rutaEstatica(url.pathname);
    if (fichero && await servirFichero(req, res, fichero)) return undefined;
    const reescritura = casar(vercel.rewrites, url.pathname);
    if (reescritura) {
      const destino = rutaEstatica(sustituir(reescritura.regla.destination, reescritura.valores));
      if (destino && await servirFichero(req, res, destino)) return undefined;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('No encontrado');
  }

  const servidor = createServer((req, res) => {
    const inicio = Date.now();
    res.on('finish', () => {
      const ruta = (req.url ?? '').split('?')[0]; // sin la query: puede llevar direcciones de correo de prueba
      console.log(`${req.method} ${ruta} → ${res.statusCode} (${Date.now() - inicio} ms)`);
    });
    atender(req, res).catch((error) => {
      console.error(`Error no controlado: ${error?.name ?? 'Error'}`);
      json(res, 500, { ok: false, codigo: 'interno' });
    });
  });
  return servidor;
}

// ---------------------------------------------------------------------------
// Arranque (solo si se ejecuta este fichero)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const servidor = await crearServidor();
    const parar = () => {
      servidor.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGTERM', parar);
    process.on('SIGINT', parar);
    process.on('unhandledRejection', (motivo) => console.error(`Promesa rechazada sin gestionar: ${motivo?.name ?? 'Error'}`));
    servidor.listen(PUERTO, HOST, () => console.log(`Servidor local de pruebas en http://${HOST}:${PUERTO} (modo prueba, Altavoz simulado)`));
  } catch (error) {
    console.error(`No se puede arrancar el servidor local: ${error.message}`);
    process.exit(1);
  }
}
