// Pruebas de api/_lib/cartero.js con adjuntos (orden 6): el cuerpo que se manda a Altavoz, los topes que se comprueban antes,
// la simulación (sin red) con su modo «rechazo por adjuntos» y el camino de verdad contra un Altavoz FALSO en 127.0.0.1.
//
// Nada sale a internet: la simulación no llama a nadie y el camino real habla con un servidor que levanta esta misma
// prueba en un puerto local. Cada fichero de prueba corre en su propio proceso: las variables de entorno que se tocan
// aquí no afectan a los demás.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  ErrorSimulacion, TOPE_AVISO_MS, TOPE_ENVIO_MS, cuerpoDe, defectoDeAdjuntos, defectoDelCorreo, enviarAviso,
} from '../../api/_lib/cartero.js';

const md5 = (datos) => createHash('md5').update(datos).digest('hex');
const adjunto = (nombre, bytes = 100) => ({ nombre, contenido: randomBytes(bytes) });
const CORREO = Object.freeze({
  marca: 'GNEW',
  para: 'escaneos@gruponew.energy',
  asunto: 'Nuevo Contrato - Prueba',
  html: '<p>Hola</p>',
  texto: 'Hola',
  etiqueta: 'tramitacion-aviso',
  responder_a: 'comercial@ejemplo.es',
});

const VARIABLES = ['TRAMITACION_PRUEBA', 'ALTAVOZ_SIMULAR', 'ALTAVOZ_SIMULAR_FALLO', 'ALTAVOZ_URL', 'ALTAVOZ_API_KEY'];
let copia;
beforeEach(() => {
  copia = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
  for (const v of VARIABLES) delete process.env[v];
});
afterEach(() => {
  for (const v of VARIABLES) {
    if (copia[v] === undefined) delete process.env[v];
    else process.env[v] = copia[v];
  }
});

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

describe('tiempos del cartero', () => {
  it('un aviso (con descarga de adjuntos incluida) tiene 15 s y lo demás 8 s', () => {
    assert.equal(TOPE_AVISO_MS, 15_000);
    assert.equal(TOPE_ENVIO_MS, 8_000);
  });
});

// ---------------------------------------------------------------------------
// Los adjuntos que se comprueban antes de mandar (los mismos topes que Altavoz)
// ---------------------------------------------------------------------------

describe('defectoDeAdjuntos · los topes de Altavoz (api.md §5)', () => {
  it('sin adjuntos, o una lista vacía, está bien', () => {
    assert.equal(defectoDeAdjuntos(undefined), '');
    assert.equal(defectoDeAdjuntos(null), '');
    assert.equal(defectoDeAdjuntos([]), '');
  });

  it('hasta 10 ficheros: 10 valen, 11 no', () => {
    const diez = Array.from({ length: 10 }, (_, i) => adjunto(`d${i}.pdf`, 10));
    assert.equal(defectoDeAdjuntos(diez), '');
    const once = [...diez, adjunto('d10.pdf', 10)];
    assert.match(defectoDeAdjuntos(once), /^adjuntos: hay más de 10$/);
  });

  it('3.000.000 bytes reales entre todos: exactamente eso vale, un byte más no', () => {
    assert.equal(defectoDeAdjuntos([adjunto('a.pdf', 1_500_000), adjunto('b.pdf', 1_500_000)]), '');
    assert.match(defectoDeAdjuntos([adjunto('a.pdf', 1_500_000), adjunto('b.pdf', 1_500_001)]), /^adjuntos: pasan del máximo de bytes$/);
    assert.match(defectoDeAdjuntos([adjunto('a.pdf', 3_000_001)]), /pasan del máximo/);
  });

  it('el nombre: de 1 a 200 caracteres (tras cambiar saltos de línea, tabuladores y comillas por espacios) y con extensión admitida', () => {
    for (const bueno of ['a.pdf', 'A.PDF', 'f.jpg', 'f.JPEG', 'f.png', 'f.doc', 'f.DocX', `${'x'.repeat(196)}.pdf`, 'sin  comillas "a".png']) {
      assert.equal(defectoDeAdjuntos([adjunto(bueno, 5)]), '', bueno);
    }
    for (const [malo, frase] of [
      ['', 'el nombre de uno no vale'],
      ['   ', 'el nombre de uno no vale'],
      ['"\r\n\t".pdf'.replace('.pdf', ''), 'el nombre de uno no vale'],
      [`${'x'.repeat(197)}.pdf`, 'el nombre de uno no vale'],
      ['notas.txt', 'uno no es de un tipo admitido'],
      ['sin-extension', 'uno no es de un tipo admitido'],
      ['archivo.pdf.exe', 'uno no es de un tipo admitido'],
      ['zip.zip', 'uno no es de un tipo admitido'],
    ]) {
      assert.equal(defectoDeAdjuntos([adjunto(malo, 5)]), `adjuntos: ${frase}`, JSON.stringify(malo));
    }
  });

  it('el contenido: bytes y no vacío; lo que no es una lista de objetos no vale', () => {
    assert.equal(defectoDeAdjuntos([{ nombre: 'a.pdf', contenido: new Uint8Array([1]) }]), '');
    assert.match(defectoDeAdjuntos([{ nombre: 'a.pdf', contenido: new Uint8Array(0) }]), /uno está vacío/);
    assert.match(defectoDeAdjuntos([{ nombre: 'a.pdf', contenido: 'JVBERi0=' }]), /uno está vacío/, 'el contenido va como bytes, no como texto');
    assert.match(defectoDeAdjuntos([{ nombre: 'a.pdf' }]), /uno está vacío/);
    assert.match(defectoDeAdjuntos(['a.pdf']), /forma esperada/);
    assert.match(defectoDeAdjuntos([null]), /forma esperada/);
    assert.match(defectoDeAdjuntos({ nombre: 'a.pdf' }), /no van como lista/);
  });

  it('defectoDelCorreo lo incluye: un correo con adjuntos que no valen no es válido (y lo demás se mira antes)', () => {
    assert.equal(defectoDelCorreo({ ...CORREO, adjuntos: [adjunto('a.pdf')] }), '');
    assert.match(defectoDelCorreo({ ...CORREO, adjuntos: [adjunto('a.txt')] }), /^adjuntos: /);
    assert.equal(defectoDelCorreo({ ...CORREO, para: 'Nombre <a@b.es>', adjuntos: [adjunto('a.txt')] }), 'dirección de destino no válida');
  });

  it('las frases de defecto no llevan nombres de ficheros ni datos', () => {
    const frase = defectoDeAdjuntos([adjunto('Juan García DNI.txt', 5)]);
    assert.ok(!frase.includes('Juan') && !frase.includes('DNI'), frase);
  });
});

// ---------------------------------------------------------------------------
// El cuerpo JSON que se manda a Altavoz
// ---------------------------------------------------------------------------

describe('cuerpoDe · lo que recibe Altavoz', () => {
  it('sin adjuntos no lleva el campo `adjuntos`; con una lista vacía, tampoco', () => {
    assert.equal(Object.hasOwn(cuerpoDe(CORREO), 'adjuntos'), false);
    assert.equal(Object.hasOwn(cuerpoDe({ ...CORREO, adjuntos: [] }), 'adjuntos'), false);
  });

  it('los adjuntos van como [{nombre, contenido}] en base64 ESTÁNDAR y ESTRICTO, y decodificados son los mismos bytes', () => {
    const originales = [adjunto('contrato.pdf', 1000), adjunto('dni.jpg', 1001), adjunto('firma.png', 1002), adjunto('raro.docx', 1)];
    const cuerpo = cuerpoDe({ ...CORREO, adjuntos: originales });
    assert.equal(cuerpo.adjuntos.length, 4);
    cuerpo.adjuntos.forEach((enviado, i) => {
      assert.deepEqual(Object.keys(enviado).sort(), ['contenido', 'nombre'], 'solo nombre y contenido (el tipo sale de la extensión)');
      assert.equal(enviado.nombre, originales[i].nombre);
      // las dos comprobaciones de Altavoz: longitud múltiplo de 4 y solo letras, números, «+», «/» y de 0 a 2 «=» al final
      assert.equal(enviado.contenido.length % 4, 0);
      assert.match(enviado.contenido, /^[A-Za-z0-9+/]+={0,2}$/);
      assert.equal(md5(Buffer.from(enviado.contenido, 'base64')), md5(originales[i].contenido));
    });
  });

  it('el resto del cuerpo es el de siempre (marca en mayúsculas, un destinatario, asunto en una línea, responder_a) y no hay remitente', () => {
    const cuerpo = cuerpoDe({ ...CORREO, marca: 'gnew', asunto: 'Uno\ndos', adjuntos: [adjunto('a.pdf')] });
    assert.equal(cuerpo.marca, 'GNEW');
    assert.equal(cuerpo.asunto, 'Uno dos');
    assert.equal(cuerpo.para, 'escaneos@gruponew.energy');
    assert.equal(cuerpo.responder_a, 'comercial@ejemplo.es');
    assert.equal(cuerpo.etiqueta, 'tramitacion-aviso');
    assert.equal(cuerpo.html, '<p>Hola</p>');
    for (const prohibido of ['de', 'from', 'remitente', 'tipo']) assert.equal(Object.hasOwn(cuerpo, prohibido), false, prohibido);
  });

  it('acepta un Uint8Array que no es un Buffer (con su desplazamiento) sin mezclar bytes de otro sitio', () => {
    const grande = randomBytes(64);
    const trozo = new Uint8Array(grande.buffer, grande.byteOffset + 10, 20);
    const cuerpo = cuerpoDe({ ...CORREO, adjuntos: [{ nombre: 'a.pdf', contenido: trozo }] });
    assert.equal(md5(Buffer.from(cuerpo.adjuntos[0].contenido, 'base64')), md5(grande.subarray(10, 30)));
  });
});

// ---------------------------------------------------------------------------
// Simulación (sin red)
// ---------------------------------------------------------------------------

describe('enviarAviso en simulación · sin red, con adjuntos y con el rechazo por adjuntos', () => {
  let fetchOriginal;
  let llamadas;
  beforeEach(() => {
    process.env.TRAMITACION_PRUEBA = '1';
    process.env.ALTAVOZ_SIMULAR = '1';
    fetchOriginal = globalThis.fetch;
    llamadas = 0;
    globalThis.fetch = async () => {
      llamadas += 1;
      throw new Error('No debería haberse llamado a fetch');
    };
  });
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it('un aviso con adjuntos «sale» sin tocar la red, y no es un rechazo', async () => {
    const r = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf', 2000), adjunto('b.jpg', 3000)] });
    assert.deepEqual([r.estado, r.simulado, r.http, r.rechazo_adjuntos], ['enviado', true, 200, false]);
    assert.match(r.altavoz_id, /^simulado-\d+$/);
    assert.equal(llamadas, 0);
  });

  it('ALTAVOZ_SIMULAR_FALLO=adjuntos: 422 SOLO a lo que lleva adjuntos (rechazo_adjuntos); sin adjuntos sale bien', async () => {
    process.env.ALTAVOZ_SIMULAR_FALLO = 'adjuntos';
    const rechazado = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] });
    assert.deepEqual([rechazado.estado, rechazado.terminal, rechazado.http, rechazado.rechazo_adjuntos, rechazado.simulado], ['error_configuracion', true, 422, true, false]);
    assert.equal(rechazado.altavoz_id, null);
    assert.equal(rechazado.codigo, 'http_422', 'sin código propio de Altavoz: api.md solo da `codigo` al 422 marca_sin_remitente');
    for (const sin of [{ ...CORREO }, { ...CORREO, adjuntos: [] }]) {
      const bien = await enviarAviso(sin);
      assert.deepEqual([bien.estado, bien.http, bien.rechazo_adjuntos], ['enviado', 200, false]);
    }
    assert.equal(llamadas, 0);
  });

  it('ALTAVOZ_SIMULAR_FALLO=1 sigue siendo «Altavoz caído» (503) con o sin adjuntos, y no es un rechazo por adjuntos', async () => {
    process.env.ALTAVOZ_SIMULAR_FALLO = '1';
    for (const correo of [{ ...CORREO }, { ...CORREO, adjuntos: [adjunto('a.pdf')] }]) {
      const r = await enviarAviso(correo);
      assert.deepEqual([r.estado, r.http, r.rechazo_adjuntos], ['pendiente', 503, false]);
    }
  });

  it('los modos de fallo solo cuentan en modo prueba', async () => {
    delete process.env.TRAMITACION_PRUEBA;
    process.env.ALTAVOZ_SIMULAR_FALLO = 'adjuntos';
    const r = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] });
    assert.deepEqual([r.estado, r.http], ['enviado', 200]);
  });

  it('adjuntos que no cumplen los topes: ni se intenta enviar — 422 local con rechazo_adjuntos (como lo haría Altavoz)', async () => {
    for (const malos of [
      Array.from({ length: 11 }, (_, i) => adjunto(`d${i}.pdf`, 10)),
      [adjunto('enorme.pdf', 3_000_001)],
      [adjunto('notas.txt')],
      [{ nombre: 'a.pdf', contenido: new Uint8Array(0) }],
    ]) {
      const r = await enviarAviso({ ...CORREO, adjuntos: malos });
      assert.deepEqual([r.estado, r.terminal, r.http, r.rechazo_adjuntos], ['error_configuracion', true, 422, true]);
      assert.match(r.motivo, /^El correo no es válido: adjuntos: /);
    }
    assert.equal(llamadas, 0);
  });

  it('un correo inválido por otra cosa (el destinatario) NO es un rechazo por adjuntos, aunque lleve adjuntos', async () => {
    const r = await enviarAviso({ ...CORREO, para: 'a@b.es, c@d.es', adjuntos: [adjunto('a.pdf')] });
    assert.deepEqual([r.estado, r.http, r.rechazo_adjuntos], ['error_configuracion', 422, false]);
  });

  it('la guarda sigue en pie: en modo prueba sin simulación, con adjuntos, lanza y no llama a la red', async () => {
    process.env.ALTAVOZ_SIMULAR = '0';
    await assert.rejects(() => enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }), ErrorSimulacion);
    assert.equal(llamadas, 0);
  });
});

// ---------------------------------------------------------------------------
// El camino de verdad, contra un Altavoz FALSO en 127.0.0.1
// ---------------------------------------------------------------------------

describe('enviarAviso de verdad · contra un Altavoz falso local', () => {
  /** Altavoz falso: guarda lo que recibe y contesta lo que diga `respuesta` ({status, cuerpo, texto, retardoMs}). */
  let servidor;
  let url;
  let recibidas;
  let respuesta;

  before(async () => {
    servidor = createServer((req, res) => {
      const trozos = [];
      req.on('data', (t) => trozos.push(t));
      req.on('end', () => {
        recibidas.push({ metodo: req.method, ruta: req.url, cabeceras: req.headers, cuerpo: Buffer.concat(trozos).toString('utf8') });
        const enviar = () => {
          res.statusCode = respuesta.status;
          if (respuesta.cuerpo !== undefined) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(respuesta.cuerpo));
          } else {
            res.setHeader('Content-Type', 'text/plain');
            res.end(respuesta.texto ?? '');
          }
        };
        if (respuesta.retardoMs) setTimeout(enviar, respuesta.retardoMs);
        else enviar();
      });
    });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    url = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(async () => {
    servidor.closeAllConnections();
    await new Promise((listo) => servidor.close(listo));
  });
  beforeEach(() => {
    delete process.env.TRAMITACION_PRUEBA;
    delete process.env.ALTAVOZ_SIMULAR;
    process.env.ALTAVOZ_URL = url;
    process.env.ALTAVOZ_API_KEY = 'clave-de-prueba-local';
    recibidas = [];
    respuesta = { status: 200, cuerpo: { ok: true, id: 'id-de-amazon-1', marca: 'GNEW' } };
  });

  /** Lo mismo que comprueba Altavoz (`leerAdjuntos`) sobre lo que ha llegado. */
  function comoAltavoz(cuerpo) {
    const frases = [];
    if (!Array.isArray(cuerpo.adjuntos)) return frases;
    if (cuerpo.adjuntos.length > 10) frases.push('más de 10');
    let total = 0;
    for (const a of cuerpo.adjuntos) {
      const nombre = String(a.nombre).replace(/[\r\n\t"]+/g, ' ').trim();
      if (nombre === '' || nombre.length > 200) frases.push('nombre');
      const punto = nombre.lastIndexOf('.');
      if (!['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'].includes(nombre.slice(punto + 1).toLowerCase())) frases.push('tipo');
      if (typeof a.contenido !== 'string' || a.contenido === '') frases.push('vacío');
      else if (a.contenido.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(a.contenido)) frases.push('base64');
      else total += (a.contenido.length / 4) * 3 - (a.contenido.endsWith('==') ? 2 : a.contenido.endsWith('=') ? 1 : 0);
    }
    if (total > 3_000_000) frases.push('3 MB');
    return frases;
  }

  it('manda POST /api/v1/avisos con la clave y los adjuntos tal cual, y 200 = enviado (con el id de Amazon)', async () => {
    const originales = [adjunto('contrato.pdf', 4000), adjunto('dni.jpg', 5001), adjunto('firma.png', 283)];
    const r = await enviarAviso({ ...CORREO, adjuntos: originales }, { tope: 5000, intentos: 1 });
    assert.deepEqual([r.estado, r.simulado, r.http, r.altavoz_id, r.rechazo_adjuntos], ['enviado', false, 200, 'id-de-amazon-1', false]);
    assert.equal(recibidas.length, 1);
    const [llamada] = recibidas;
    assert.equal(llamada.metodo, 'POST');
    assert.equal(llamada.ruta, '/api/v1/avisos');
    assert.equal(llamada.cabeceras.authorization, 'Bearer clave-de-prueba-local');
    assert.match(llamada.cabeceras['content-type'], /application\/json/);
    const cuerpo = JSON.parse(llamada.cuerpo);
    assert.deepEqual(comoAltavoz(cuerpo), [], 'Altavoz lo aceptaría');
    assert.deepEqual(cuerpo.adjuntos.map((a) => a.nombre), ['contrato.pdf', 'dni.jpg', 'firma.png']);
    cuerpo.adjuntos.forEach((a, i) => assert.equal(md5(Buffer.from(a.contenido, 'base64')), md5(originales[i].contenido), a.nombre));
    assert.equal(cuerpo.para, 'escaneos@gruponew.energy');
    assert.equal(cuerpo.responder_a, 'comercial@ejemplo.es');
  });

  it('sin adjuntos el cuerpo no lleva el campo `adjuntos`', async () => {
    await enviarAviso({ ...CORREO }, { tope: 5000 });
    assert.equal(Object.hasOwn(JSON.parse(recibidas[0].cuerpo), 'adjuntos'), false);
  });

  it('422 SIN `codigo` (así responde Altavoz a un adjunto que no vale) con adjuntos → rechazo_adjuntos; el estado sigue siendo el de siempre', async () => {
    respuesta = { status: 422, cuerpo: { error: 'Los adjuntos pasan de 3 MB entre todos: manda el resto como enlace.' } };
    const r = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }, { tope: 5000 });
    assert.deepEqual([r.estado, r.terminal, r.http, r.rechazo_adjuntos], ['error_configuracion', true, 422, true]);
    assert.ok(!JSON.stringify(r).includes('3 MB'), 'la frase de Altavoz no se guarda: podría llevar nombres de ficheros');
  });

  it('413 (Vercel corta una petición de más de ~4,5 MB, con su propia respuesta) con adjuntos → rechazo_adjuntos', async () => {
    respuesta = { status: 413, texto: 'Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE' };
    const r = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }, { tope: 5000 });
    assert.deepEqual([r.http, r.rechazo_adjuntos, r.estado], [413, true, 'pendiente']);
  });

  it('un 422 CON `codigo` (marca_sin_remitente) no es culpa de los adjuntos; y un 422 de un correo sin adjuntos tampoco', async () => {
    respuesta = { status: 422, cuerpo: { error: 'Tu clave no tiene remitente para esa marca.', codigo: 'marca_sin_remitente' } };
    const conCodigo = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }, { tope: 5000 });
    assert.deepEqual([conCodigo.http, conCodigo.rechazo_adjuntos, conCodigo.codigo], [422, false, 'marca_sin_remitente']);
    respuesta = { status: 422, cuerpo: { error: 'El asunto no puede estar vacío.' } };
    const sinAdjuntos = await enviarAviso({ ...CORREO }, { tope: 5000 });
    assert.deepEqual([sinAdjuntos.http, sinAdjuntos.rechazo_adjuntos], [422, false]);
  });

  it('el resto de fallos no son rechazos por adjuntos: 503, 502 incierto, 409 suprimido y el tiempo agotado', async () => {
    const casos = [
      [{ status: 503, cuerpo: { error: 'x', codigo: 'envio_no_disponible' } }, 'pendiente'],
      [{ status: 502, cuerpo: { error: 'x', codigo: 'envio_incierto' } }, 'incierto'],
      [{ status: 409, cuerpo: { error: 'x', codigo: 'destinatario_suprimido' } }, 'suprimido'],
    ];
    for (const [r, estado] of casos) {
      respuesta = r;
      const salida = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }, { tope: 5000 });
      assert.deepEqual([salida.estado, salida.rechazo_adjuntos], [estado, false], JSON.stringify(r.status));
    }
    respuesta = { status: 200, cuerpo: { ok: true, id: 'tarde' }, retardoMs: 800 };
    const lento = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.pdf')] }, { tope: 150 });
    assert.deepEqual([lento.estado, lento.codigo, lento.http, lento.rechazo_adjuntos], ['pendiente', 'tiempo', null, false]);
  });

  it('adjuntos que no valen no llegan a Altavoz: no se hace ninguna llamada', async () => {
    const r = await enviarAviso({ ...CORREO, adjuntos: [adjunto('a.txt')] }, { tope: 5000 });
    assert.deepEqual([r.http, r.rechazo_adjuntos], [422, true]);
    assert.equal(recibidas.length, 0);
  });
});
