// api/_lib/cola.js · Cola de correos de la tramitación: crear, enviar con cerrojo, reintentar y conciliar.
//
// Un contrato recibido genera DOS filas en `tramitacion_correos` (el aviso a backoffice y el acuse al comercial)
// y cada una se intenta por Altavoz. Si Altavoz no contesta, la fila se queda `pendiente` con espera creciente y
// el vigilante la reintenta cada 5 minutos: un correo nunca se pierde en silencio (diseño §2.2).
//
// Reglas de este módulo:
//  - CERROJO OPTIMISTA. Antes de enviar: PATCH estado=enviando WHERE estado=pendiente con return=representation.
//    Si no devuelve fila, otro proceso lo tiene y no se envía. El cerrojo vale 60 s; uno vencido vuelve a
//    `pendiente` (cuenta como intento) en liberarCerrojos().
//  - Riesgo asumido: si la función muere entre el 2xx de Altavoz y el PATCH `enviado`, el vigilante reenvía al
//    minuto (un correo duplicado, nunca uno perdido).
//  - El cuerpo del correo NO se guarda: se regenera cada vez desde la fila y sus documentos (correos.js). Solo en
//    simulación (pruebas) se guardan cuerpo_html y cuerpo_texto, para que las pruebas puedan leerlos.
//  - ADJUNTOS DEL AVISO (orden 6, decisión de Victor del 10-oct-2026). Cada intento de enviar un AVISO (al confirmar, el
//    vigilante o «Volver a enviar» en la bandeja) elige qué documentos van adjuntos (correos.seleccionarAdjuntos: topes de
//    Altavoz), los DESCARGA otra vez del almacén (nunca se guardan en la base), regenera el cuerpo y lo manda. Lo que
//    no cabe, o no se ha podido descargar, queda «en la bandeja». Prioridad absoluta: que backoffice RECIBA el aviso.
//      · si falla la descarga de algún adjunto (error, tiempo o tamaño distinto del comprobado) el aviso sale con los
//        que sí se han descargado y se apunta el evento `adjuntos_no_descargados`;
//      · si Altavoz rechaza por los adjuntos (422 sin `codigo` o 413) se reintenta EN EL MISMO intento sin adjuntos
//        (todo «en la bandeja») y se apunta `adjuntos_rechazados`: sigue siendo UN intento en la cuenta de la fila;
//      · cualquier otro fallo sigue como siempre (cola, esperas, vigilante).
//    El acuse al comercial no lleva adjuntos.
//  - `prueba`: todo lo que procesa el robot (reintentar, liberar, conciliar, atascados) mira SOLO las tramitaciones
//    cuyo `prueba` coincide con el modo del servidor (esPrueba()). Así el vigilante de producción jamás envía los
//    correos de una tramitación de prueba, y el servidor de pruebas jamás toca los de producción.
//  - Los eventos no llevan datos personales (solo tipo, estado, código e intentos).
//  - Sin console.* salvo dos console.error con frases fijas (textoSeguroDeError): nunca contenido ni direcciones.
import { enviarAviso, ErrorSimulacion, TOPE_AVISO_MS, TOPE_ENVIO_MS } from './cartero.js';
import { MARCAS, avisoDestino, esPrueba, sitioUrl } from './config.js';
import { armarAcuse, armarAviso, ETIQUETA_CORREO, seleccionarAdjuntos, urlFichaDe } from './correos.js';
import { MAX_INTENTOS, esperaMinutos } from './estados.js';
import { ErrorSupabase, actualizar, descargarObjeto, insertar, seleccionar } from './supabase.js';

/** Tipos de correo que gestiona el robot (el código de acceso a la bandeja nunca se reintenta solo). */
export const TIPOS_DE_COLA = Object.freeze(['aviso', 'acuse']);

/** Lo que vale un cerrojo: pasado este tiempo, el correo en `enviando` se da por abandonado. */
export const CERROJO_MS = 60_000;

/**
 * Tiempos de confirmar. El AVISO tiene 15 s EN TOTAL (descargar los documentos del almacén y entregarlos a Altavoz; era
 * 6 s cuando no llevaba adjuntos). El ACUSE, que no lleva adjuntos, sigue con 6 s, y solo se intenta si desde el inicio
 * de `confirmar` han pasado menos de 20 s (era 12): si el aviso ha tardado más, el acuse lo manda el vigilante.
 */
export const TOPE_CONFIRMAR_AVISO_MS = TOPE_AVISO_MS;
export const TOPE_CONFIRMAR_ACUSE_MS = 6_000;
export const PRESUPUESTO_ACUSE_MS = 20_000;

/**
 * De esos 15 s, la descarga de los adjuntos (todos, de 2 en 2) usa como mucho el 40 % y nunca más de 6 s: lo que queda es
 * para Altavoz (que recibe hasta ~4 MB en base64). Si un documento tarda más, se manda el aviso sin él.
 */
export const TOPE_DESCARGAS_MS = 6_000;
const PARTE_PARA_DESCARGAS = 0.4;
export const CONCURRENCIA_DESCARGAS = 2;

/** El reintento SIN adjuntos tras un rechazo tiene como mínimo esto, aunque el primer envío se haya gastado el plazo. */
export const MINIMO_REINTENTO_SIN_ADJUNTOS_MS = 4_000;

// Columnas de una fila de correo sin los cuerpos (que pueden pesar decenas de KB).
const COLUMNAS_CORREO = 'id,tramitacion_id,tipo,marca,para,responder_a,asunto,etiqueta,estado,codigo_respuesta,intentos,'
  + 'proximo_intento,bloqueado_hasta,ultimo_error,altavoz_id,simulado,creado_en,enviado_en';

const iso = (ms) => new Date(ms).toISOString();

/**
 * Una frase para el registro del servidor que NO lleva datos personales: la de un ErrorSupabase (frase fija sin
 * datos), la de falta de configuración (solo el nombre de la variable), la de la guarda de simulación, o, para
 * cualquier otro error, solo su tipo. Con TRAMITACION_DEBUG=1 (el servidor local de pruebas, datos de mentira)
 * se escribe también el mensaje.
 */
export function textoSeguroDeError(error) {
  if (error instanceof ErrorSupabase || error instanceof ErrorSimulacion) return error.message;
  const mensaje = typeof error?.message === 'string' ? error.message : '';
  if (mensaje.startsWith('Falta la variable de entorno') || process.env.TRAMITACION_DEBUG === '1') return mensaje;
  return error?.name ?? 'Error';
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

/**
 * Apunta un evento en el historial de una tramitación. Es información de apoyo: si no se puede
 * escribir, NO hace fallar lo que se estaba haciendo (el contrato o el correo ya están a salvo).
 * `detalle` no puede llevar datos personales.
 */
export async function registrarEvento(tramitacionId, tipo, actor = 'sistema', detalle = {}) {
  if (!tramitacionId) return;
  try {
    await insertar('tramitacion_eventos', { tramitacion_id: tramitacionId, tipo, actor, detalle }, { devolver: false });
  } catch {
    // sin historial no se para nada
  }
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Los correos de una tramitación (sin cuerpos). */
export async function correosDe(tramitacionId) {
  return seleccionar('tramitacion_correos', { select: COLUMNAS_CORREO, tramitacion_id: `eq.${tramitacionId}`, order: 'tipo.asc' });
}

/** La tramitación con sus documentos, por id: {tramitacion, documentos} o null. */
async function cargarTramitacion(id) {
  const filas = await seleccionar('tramitaciones', { select: '*,tramitacion_documentos(*)', id: `eq.${id}`, limit: 1 });
  if (filas.length === 0) return null;
  const { tramitacion_documentos: documentos, ...tramitacion } = filas[0];
  return { tramitacion, documentos: documentos ?? [] };
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

/**
 * Crea el aviso a backoffice y el acuse al comercial de una tramitación recibida. Es idempotente:
 * `unique (tramitacion_id, tipo)` + «ignorar duplicados» hace que llamarla otra vez no cree nada ni
 * duplique ningún correo. Devuelve {creados, correos}: cuántos correos nuevos se han insertado y
 * TODOS los de la tramitación (nuevos y viejos), sin cuerpos.
 */
export async function crearCorreos(tramitacion, documentos = []) {
  const destino = avisoDestino(tramitacion.formulario);
  const marca = MARCAS[tramitacion.formulario].marca;
  // Se arman aquí solo para fijar el asunto; el cuerpo se regenera cuando toca enviar.
  const aviso = armarAviso({ tramitacion, documentos, urlFicha: urlFichaDe(sitioUrl(), tramitacion.ref), destino });
  const acuse = armarAcuse({ tramitacion, documentos, destino });
  // proximo_intento con el reloj de ESTE servidor (no el `now()` de la base): si los dos relojes difieren unos
  // milisegundos, el correo recién creado no puede quedar «en el futuro» y saltarse el primer intento.
  const ahora = iso(Date.now());
  const filas = [
    {
      tramitacion_id: tramitacion.id,
      tipo: 'aviso',
      marca,
      para: destino,
      responder_a: tramitacion.comercial_email,
      asunto: aviso.asunto,
      etiqueta: ETIQUETA_CORREO.aviso,
      proximo_intento: ahora,
    },
    {
      tramitacion_id: tramitacion.id,
      tipo: 'acuse',
      marca,
      para: tramitacion.comercial_email,
      responder_a: destino,
      asunto: acuse.asunto,
      etiqueta: ETIQUETA_CORREO.acuse,
      proximo_intento: ahora,
    },
  ];
  const nuevos = await insertar('tramitacion_correos', filas, { onConflict: ['tramitacion_id', 'tipo'], duplicados: 'ignorar' });
  return { creados: nuevos.length, correos: await correosDe(tramitacion.id) };
}

// ---------------------------------------------------------------------------
// Enviar
// ---------------------------------------------------------------------------

/** Cuerpo del acuse, regenerado desde la fila de la tramitación y sus documentos (nunca lleva adjuntos). */
function contenidoDeAcuse({ tramitacion, documentos }) {
  return armarAcuse({ tramitacion, documentos, destino: avisoDestino(tramitacion.formulario) });
}

/** Cuerpo del aviso para una selección de adjuntos (ver correos.seleccionarAdjuntos). */
function contenidoDeAviso({ tramitacion, documentos }, seleccion) {
  return armarAviso({
    tramitacion,
    documentos,
    seleccion,
    urlFicha: urlFichaDe(sitioUrl(), tramitacion.ref),
    destino: avisoDestino(tramitacion.formulario),
  });
}

/** Por qué ha fallado una descarga, en una palabra fija (nunca el mensaje de error: podría llevar rutas del almacén). */
function causaDeDescarga(error) {
  if (error instanceof ErrorSupabase) {
    if (error.codigo === 'tiempo') return 'tiempo';
    if (error.codigo === 'red') return 'red';
    if (error.codigo === 'tamano') return 'tamano';
    if (error.status === 404 || error.statusInterno === 404 || error.codigo === 'NoSuchKey') return 'no_existe';
  }
  return 'otro';
}

/**
 * Descarga del almacén los documentos que la selección dice que van adjuntos y comprueba que cada uno pesa EXACTAMENTE
 * lo comprobado al confirmar. Nunca lanza: un documento que falla (error, tiempo o tamaño distinto) pasa a `fuera`
 * (motivo 'descarga') y el aviso sale con los demás.
 *   tope          tiempo TOTAL para bajarlos todos (un plazo común: lo que no llegue a tiempo falla con 'tiempo')
 *   concurrencia  cuántos se bajan a la vez (2): el almacén de Supabase responde 429 «SlowDown / Too many connections»
 *                 cuando va justo de conexiones; con pocas a la vez no se le añade presión a las subidas de los comerciales
 *   descargar     solo para las pruebas: otra función en lugar de supabase.descargarObjeto
 * Devuelve {seleccion, ficheros, fallos}:
 *   seleccion  la selección ya corregida: lo que de verdad se ha descargado en `adjuntos`, el resto en `fuera`
 *   ficheros   [{nombre, contenido: Buffer}] en el orden de los adjuntos, listos para el cartero
 *   fallos     [{orden, causa}] de los que han fallado (sin nombres: el historial no lleva datos personales)
 */
export async function descargarAdjuntos(seleccion, { tope, concurrencia = CONCURRENCIA_DESCARGAS, descargar = descargarObjeto }) {
  const elegidos = seleccion.adjuntos;
  const hasta = Date.now() + tope;
  const resultados = new Array(elegidos.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < elegidos.length) {
      const i = siguiente++;
      const { doc, bytes } = elegidos[i];
      try {
        const queda = hasta - Date.now();
        if (queda <= 0) throw new ErrorSupabase('Se ha acabado el tiempo para bajar los documentos', { status: 0, codigo: 'tiempo' });
        const datos = await descargar(doc.ruta, { tope: queda, maxBytes: bytes });
        if (!Buffer.isBuffer(datos) || datos.length !== bytes) throw new ErrorSupabase('El documento descargado no pesa lo comprobado', { status: 200, codigo: 'tamano' });
        resultados[i] = { datos };
      } catch (error) {
        resultados[i] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrencia), elegidos.length) }, trabajador));

  const adjuntos = [];
  const ficheros = [];
  const fuera = [...seleccion.fuera];
  const fallos = [];
  resultados.forEach((r, i) => {
    const elegido = elegidos[i];
    if (r.datos) {
      adjuntos.push(elegido);
      ficheros.push({ nombre: elegido.nombre, contenido: r.datos });
    } else {
      fuera.push({ ...elegido, motivo: 'descarga' });
      fallos.push({ orden: elegido.doc.orden, causa: causaDeDescarga(r.error) });
    }
  });
  fuera.sort((a, b) => a.pos - b.pos); // el orden de siempre: documentos 1..N y la firma al final
  return { seleccion: { adjuntos, fuera }, ficheros, fallos };
}

/** El correo no se ha podido ni armar: cuenta como intento fallido (si no, se quedaría reintentando para siempre). */
const falloDePreparacion = (intentos) => (intentos >= MAX_INTENTOS
  ? { estado: 'agotado', codigo: 'preparacion', motivo: 'No se ha podido preparar el correo (se han agotado los intentos)', simulado: false, altavoz_id: null }
  : { estado: 'pendiente', codigo: 'preparacion', motivo: 'No se ha podido preparar el correo', simulado: false, altavoz_id: null });

/**
 * Prepara y manda UN correo. El acuse es lo de siempre (sin adjuntos). El aviso: elige, descarga, arma el cuerpo, lo
 * manda y, si Altavoz rechaza por los adjuntos, lo manda otra vez sin ellos (ver la cabecera). `topeEnvio` es el
 * tiempo total del aviso (descargas incluidas). Devuelve {resultado, contenido, adjuntos, enBandeja, eventos}: `eventos`
 * son los apuntes del historial por lo ocurrido con los adjuntos (sin datos personales). Lanza lo que lance el cartero
 * (ErrorSimulacion).
 */
async function enviarCorreo(correo, contexto, { intentos, topeEnvio }) {
  const base = { marca: correo.marca, para: correo.para, asunto: correo.asunto, etiqueta: correo.etiqueta, responder_a: correo.responder_a };
  const eventos = [];
  if (!contexto) return { resultado: falloDePreparacion(intentos), contenido: null, adjuntos: 0, enBandeja: 0, eventos };

  if (correo.tipo !== 'aviso') {
    let contenido = null;
    try {
      contenido = correo.tipo === 'acuse' ? contenidoDeAcuse(contexto) : null; // otro tipo: no se regenera
    } catch {
      contenido = null;
    }
    if (!contenido) return { resultado: falloDePreparacion(intentos), contenido: null, adjuntos: 0, enBandeja: 0, eventos };
    const resultado = await enviarAviso({ ...base, html: contenido.html, texto: contenido.texto }, { tope: topeEnvio, intentos });
    return { resultado, contenido, adjuntos: 0, enBandeja: 0, eventos };
  }

  const plazo = Date.now() + topeEnvio;
  const quedan = (minimo) => Math.max(plazo - Date.now(), Math.min(topeEnvio, minimo));

  // 1. Qué va adjunto y descargarlo (si nada de eso funciona, el aviso sale igual, con todo «en la bandeja»)
  let seleccion = seleccionarAdjuntos(contexto.documentos);
  let ficheros = [];
  if (seleccion.adjuntos.length > 0) {
    try {
      const descargado = await descargarAdjuntos(seleccion, { tope: Math.min(TOPE_DESCARGAS_MS, Math.round(topeEnvio * PARTE_PARA_DESCARGAS)) });
      seleccion = descargado.seleccion;
      ficheros = descargado.ficheros;
      if (descargado.fallos.length > 0) {
        eventos.push({
          tipo: 'adjuntos_no_descargados',
          detalle: { n: descargado.fallos.length, ordenes: descargado.fallos.map((f) => f.orden), causas: [...new Set(descargado.fallos.map((f) => f.causa))] },
        });
      }
    } catch {
      seleccion = seleccionarAdjuntos(contexto.documentos, { maxAdjuntos: 0 });
      ficheros = [];
    }
  }

  // 2. El cuerpo y el envío
  const armar = (sel) => {
    try {
      return contenidoDeAviso(contexto, sel);
    } catch {
      return null;
    }
  };
  let contenido = armar(seleccion);
  if (!contenido) return { resultado: falloDePreparacion(intentos), contenido: null, adjuntos: 0, enBandeja: 0, eventos };
  let resultado = await enviarAviso(
    { ...base, html: contenido.html, texto: contenido.texto, adjuntos: ficheros },
    { tope: quedan(1_000), intentos },
  );

  // 3. Altavoz no quiere los adjuntos: el mismo intento, sin ellos. Backoffice tiene que recibir el aviso.
  if (resultado.rechazo_adjuntos === true && ficheros.length > 0) {
    eventos.push({ tipo: 'adjuntos_rechazados', detalle: { http: resultado.http, n: ficheros.length } });
    seleccion = seleccionarAdjuntos(contexto.documentos, { maxAdjuntos: 0 });
    ficheros = [];
    contenido = armar(seleccion);
    if (!contenido) return { resultado: falloDePreparacion(intentos), contenido: null, adjuntos: 0, enBandeja: 0, eventos };
    resultado = await enviarAviso(
      { ...base, html: contenido.html, texto: contenido.texto },
      { tope: quedan(MINIMO_REINTENTO_SIN_ADJUNTOS_MS), intentos },
    );
  }
  return { resultado, contenido, adjuntos: seleccion.adjuntos.length, enBandeja: seleccion.fuera.length, eventos };
}

/** Quita el cerrojo sin contar intento (para cuando el fallo fue nuestro, antes de hablar con Altavoz). */
async function soltarCerrojo(id) {
  try {
    await actualizar('tramitacion_correos', { id: `eq.${id}`, estado: 'eq.enviando' }, { estado: 'pendiente', bloqueado_hasta: null }, { devolver: false });
  } catch {
    // si tampoco se puede, el cerrojo caduca solo a los 60 s
  }
}

/**
 * Intenta enviar UN correo pendiente. Devuelve
 *   {intentado:false, motivo:'ocupado'}                   si otro proceso lo tiene o ya no está pendiente
 *   {intentado:true, id, tipo, estado, intentos, simulado, cerrojoPerdido}   tras el intento
 * Lanza si la base no responde (el cerrojo se suelta antes) o ErrorSimulacion (enviar de verdad en modo prueba).
 * Un fallo de Altavoz NO lanza: queda en la fila (`pendiente` con la espera siguiente, o un estado terminal).
 * `tope` es el tiempo que se le da al envío: por defecto 15 s para un aviso (descarga de adjuntos incluida) y 8 s para
 * el resto; cada llamada puede fijar el suyo (confirmar usa 15 s para el aviso y 6 s para el acuse).
 */
export async function intentarEnvio(correoId, { tope, actor = 'sistema' } = {}) {
  const bloqueados = await actualizar(
    'tramitacion_correos',
    { id: `eq.${correoId}`, estado: 'eq.pendiente' },
    { estado: 'enviando', bloqueado_hasta: iso(Date.now() + CERROJO_MS) },
  );
  if (bloqueados.length === 0) return { intentado: false, motivo: 'ocupado' };
  const correo = bloqueados[0]; // trae `intentos` tal como estaba al coger el cerrojo: con él no hay carrera

  let contexto = null;
  try {
    if (correo.tramitacion_id) {
      contexto = await cargarTramitacion(correo.tramitacion_id);
      if (!contexto) throw new Error('La tramitación de este correo ya no existe');
    }
  } catch (error) {
    await soltarCerrojo(correo.id);
    throw error;
  }

  const intentos = (correo.intentos ?? 0) + 1;
  const topeEnvio = Number.isFinite(tope) && tope > 0 ? tope : (correo.tipo === 'aviso' ? TOPE_AVISO_MS : TOPE_ENVIO_MS);

  let envio;
  try {
    envio = await enviarCorreo(correo, contexto, { intentos, topeEnvio });
  } catch (error) {
    await soltarCerrojo(correo.id);
    throw error;
  }
  const { resultado, contenido } = envio;

  let cambios;
  if (resultado.estado === 'enviado') {
    cambios = {
      estado: 'enviado',
      intentos,
      enviado_en: iso(Date.now()),
      altavoz_id: resultado.altavoz_id,
      simulado: resultado.simulado === true,
      codigo_respuesta: null,
      ultimo_error: null,
      bloqueado_hasta: null,
    };
    // Solo en simulación se guarda el cuerpo (las pruebas leen de ahí el aviso, el acuse y los códigos de acceso)
    if (resultado.simulado === true) {
      cambios.cuerpo_html = contenido?.html ?? null;
      cambios.cuerpo_texto = contenido?.texto ?? null;
    }
  } else {
    cambios = {
      estado: resultado.estado,
      intentos,
      codigo_respuesta: resultado.codigo ?? null,
      ultimo_error: resultado.motivo || null,
      bloqueado_hasta: null,
    };
    if (resultado.estado === 'pendiente') {
      cambios.proximo_intento = iso(Date.now() + (esperaMinutos(intentos) ?? 240) * 60_000);
    }
  }

  // Solo se guarda si el cerrojo sigue siendo nuestro (un vigilante podría habérnoslo quitado si tardamos más de 60 s)
  const guardado = await actualizar('tramitacion_correos', { id: `eq.${correo.id}`, estado: 'eq.enviando' }, cambios);

  if (correo.tramitacion_id) {
    for (const evento of envio.eventos) await registrarEvento(correo.tramitacion_id, evento.tipo, actor, evento.detalle);
    if (resultado.estado === 'enviado') {
      await registrarEvento(correo.tramitacion_id, `${correo.tipo}_enviado`, actor, {
        intentos,
        simulado: resultado.simulado === true,
        // Del aviso: cuántos documentos han ido adjuntos y cuántos se han quedado solo en la bandeja
        ...(correo.tipo === 'aviso' ? { adjuntos: envio.adjuntos, en_bandeja: envio.enBandeja } : {}),
      });
    } else {
      await registrarEvento(correo.tramitacion_id, 'correo_fallo', actor, {
        tipo: correo.tipo,
        estado: resultado.estado,
        codigo: resultado.codigo ?? null,
        intentos,
      });
    }
  }

  return {
    intentado: true,
    id: correo.id,
    tipo: correo.tipo,
    estado: resultado.estado,
    intentos,
    simulado: resultado.simulado === true,
    cerrojoPerdido: guardado.length === 0,
  };
}

// Un correo que nunca se ha intentado ya le toca; si no, cuando su proximo_intento haya pasado (con 2 s de margen por
// si el reloj de la base y el del servidor no coinciden al milisegundo).
const estaVencido = (correo, ahora = Date.now()) => (
  correo.estado === 'pendiente' && (correo.intentos === 0 || Date.parse(correo.proximo_intento) <= ahora + 2_000)
);

/**
 * Lo que hace `confirmar` (y el camino «ya recibida» de `confirmar`) al cerrar una tramitación: crea el
 * aviso y el acuse si faltan y los intenta ahora, el aviso con tope de 15 s (descarga de adjuntos incluida) y el acuse
 * con 6 s; el acuse solo si desde `inicio` han pasado menos de 20 s. Solo intenta los que ya les toca (`pendiente`
 * con `proximo_intento` pasado): un
 * reintento del navegador no martillea a Altavoz mientras el correo espera su turno. Si algo falla, el contrato
 * ya está a salvo: lo recoge el vigilante (o la conciliación) en menos de 5 minutos. Nunca lanza, salvo
 * ErrorSimulacion.
 */
export async function despachar(tramitacion, documentos, { inicio = Date.now() } = {}) {
  let correos = [];
  try {
    correos = (await crearCorreos(tramitacion, documentos)).correos;
    const aviso = correos.find((c) => c.tipo === 'aviso');
    const acuse = correos.find((c) => c.tipo === 'acuse');
    if (aviso && estaVencido(aviso)) await intentarEnvio(aviso.id, { tope: TOPE_CONFIRMAR_AVISO_MS });
    if (acuse && estaVencido(acuse) && Date.now() - inicio < PRESUPUESTO_ACUSE_MS) {
      await intentarEnvio(acuse.id, { tope: TOPE_CONFIRMAR_ACUSE_MS });
    }
  } catch (error) {
    if (error instanceof ErrorSimulacion) throw error;
    console.error(`[cola/despachar] ${textoSeguroDeError(error)}`); // el contrato está a salvo; lo recoge el vigilante
  }
  return correos;
}

// ---------------------------------------------------------------------------
// Vigilante: liberar cerrojos, reintentar, conciliar, atascados
// ---------------------------------------------------------------------------

// Une la fila de correo con su tramitación para poder filtrar por `prueba`: «tramitaciones!inner(...)» deja fuera las
// filas cuya tramitación no cumpla el filtro `tramitaciones.prueba=eq.<modo>`.
const SOLO_DE_ESTE_MODO = () => ({ 'tramitaciones.prueba': `eq.${esPrueba()}` });

/**
 * Los correos en `enviando` con el cerrojo vencido vuelven a `pendiente` y cuentan como un intento
 * (si era el último, pasan a `agotado`). Devuelve cuántos ha liberado.
 */
export async function liberarCerrojos({ ahora = Date.now() } = {}) {
  const vencidos = await seleccionar('tramitacion_correos', {
    select: 'id,intentos,tramitaciones!inner(prueba)',
    estado: 'eq.enviando',
    tipo: `in.(${TIPOS_DE_COLA.join(',')})`,
    bloqueado_hasta: `lt.${iso(ahora)}`,
    ...SOLO_DE_ESTE_MODO(),
    limit: 50,
  });
  let liberados = 0;
  for (const correo of vencidos) {
    const intentos = (correo.intentos ?? 0) + 1;
    const cambios = intentos >= MAX_INTENTOS
      ? { estado: 'agotado', intentos, bloqueado_hasta: null, codigo_respuesta: 'cerrojo', ultimo_error: 'Se han agotado los intentos' }
      : { estado: 'pendiente', intentos, bloqueado_hasta: null };
    // El filtro por bloqueado_hasta protege un cerrojo NUEVO que otro proceso haya puesto entre la lectura y esta escritura
    const filas = await actualizar(
      'tramitacion_correos',
      { id: `eq.${correo.id}`, estado: 'eq.enviando', bloqueado_hasta: `lt.${iso(ahora)}` },
      cambios,
    );
    liberados += filas.length;
  }
  return liberados;
}

/**
 * Pasada del vigilante sobre la cola: libera cerrojos vencidos y reintenta hasta `max` correos `pendiente` cuyo
 * `proximo_intento` ya ha pasado (aviso y acuse; nunca códigos de acceso), en serie y con tope por correo.
 * Un correo que falla no frena a los demás. Devuelve {liberados, reintentados, enviados}.
 */
export async function reintentarPendientes({ max = 10, tope, ahora = Date.now(), actor = 'vigilante' } = {}) {
  const liberados = await liberarCerrojos({ ahora });
  const vencidos = await seleccionar('tramitacion_correos', {
    select: 'id,tramitaciones!inner(prueba)',
    estado: 'eq.pendiente',
    tipo: `in.(${TIPOS_DE_COLA.join(',')})`,
    proximo_intento: `lte.${iso(ahora)}`,
    ...SOLO_DE_ESTE_MODO(),
    order: 'proximo_intento.asc',
    limit: max,
  });
  let reintentados = 0;
  let enviados = 0;
  for (const { id } of vencidos) {
    try {
      const r = await intentarEnvio(id, { tope, actor });
      if (r.intentado) {
        reintentados += 1;
        if (r.estado === 'enviado') enviados += 1;
      }
    } catch (error) {
      if (error instanceof ErrorSimulacion) throw error;
      // un correo que no se puede ni intentar (la base falló justo ahora) se queda como estaba; el siguiente pase lo recoge
      console.error(`[cola/reintentar] ${textoSeguroDeError(error)}`);
    }
  }
  return { liberados, reintentados, enviados };
}

/**
 * Conciliación: las tramitaciones `recibida`/`tramitada` de los últimos `dias` días a las que les falta el aviso o
 * el acuse (un corte entre marcarlas recibidas y crear los correos) los reciben ahora, pendientes, y queda
 * el evento `correos_conciliados`. Solo mira las del modo del servidor (producción: no de prueba). Devuelve
 * cuántas ha reparado; el envío lo hace después reintentarPendientes().
 */
export async function conciliar({ ahora = Date.now(), dias = 7, limite = 500 } = {}) {
  const recientes = await seleccionar('tramitaciones', {
    select: 'id,tramitacion_correos(tipo)',
    estado: 'in.(recibida,tramitada)',
    prueba: `eq.${esPrueba()}`,
    recibida_en: `gte.${iso(ahora - dias * 24 * 60 * 60 * 1000)}`,
    order: 'recibida_en.asc',
    limit: limite,
  });
  const incompletas = recientes
    .filter((t) => {
      const tipos = new Set((t.tramitacion_correos ?? []).map((c) => c.tipo));
      return !TIPOS_DE_COLA.every((tipo) => tipos.has(tipo));
    })
    .map((t) => t.id);
  let conciliadas = 0;
  for (const id of incompletas) {
    const contexto = await cargarTramitacion(id);
    if (!contexto) continue;
    const { creados } = await crearCorreos(contexto.tramitacion, contexto.documentos);
    if (creados > 0) {
      conciliadas += 1;
      await registrarEvento(id, 'correos_conciliados', 'vigilante', { creados });
    }
  }
  return conciliadas;
}

/**
 * Correos que preocupan al vigilante: aviso/acuse de tramitaciones del modo del servidor, sin enviar, y que o bien
 * están en un estado terminal (agotado, suprimido, incierto, error de configuración) o llevan más de `minutos`
 * minutos. Devuelve [{id, tipo, ref, estado, intentos, codigo_respuesta, creado_en, minutos}], los más viejos primero.
 */
export async function atascados({ ahora = Date.now(), minutos = 10 } = {}) {
  const filas = await seleccionar('tramitacion_correos', {
    select: 'id,tipo,estado,intentos,codigo_respuesta,creado_en,tramitaciones!inner(ref,prueba)',
    tipo: `in.(${TIPOS_DE_COLA.join(',')})`,
    estado: 'neq.enviado',
    or: `(estado.in.(agotado,suprimido,incierto,error_configuracion),creado_en.lt.${iso(ahora - minutos * 60_000)})`,
    ...SOLO_DE_ESTE_MODO(),
    order: 'creado_en.asc',
    limit: 100,
  });
  return filas.map((f) => ({
    id: f.id,
    tipo: f.tipo,
    ref: f.tramitaciones?.ref ?? null,
    estado: f.estado,
    intentos: f.intentos,
    codigo_respuesta: f.codigo_respuesta,
    creado_en: f.creado_en,
    minutos: Math.max(0, Math.floor((ahora - Date.parse(f.creado_en)) / 60_000)),
  }));
}

/**
 * «Volver a enviar» (bandeja): deja el correo `pendiente` con los intentos a cero, desde cualquier estado, y lo
 * intenta al momento. Si la tramitación no tenía los correos, los crea antes. Si justo ahora lo está enviando otro
 * proceso (cerrojo vivo) no lo toca y devuelve {ocupado:true}. `actor` es el email de backoffice.
 * Devuelve {ok:false, motivo:'desconocida'} | {ok:true, ocupado:true} | {ok:true, ocupado:false, estado, intentos}.
 */
export async function reenviar(tramitacionId, tipo, { actor = 'sistema', tope } = {}) {
  if (!TIPOS_DE_COLA.includes(tipo)) throw new RangeError('Tipo de correo no válido');
  const contexto = await cargarTramitacion(tramitacionId);
  if (!contexto) return { ok: false, motivo: 'desconocida' };
  await crearCorreos(contexto.tramitacion, contexto.documentos);

  const ahora = Date.now();
  const filas = await actualizar(
    'tramitacion_correos',
    { tramitacion_id: `eq.${tramitacionId}`, tipo: `eq.${tipo}`, or: `(estado.neq.enviando,bloqueado_hasta.lt.${iso(ahora)})` },
    { estado: 'pendiente', intentos: 0, proximo_intento: iso(ahora), bloqueado_hasta: null, codigo_respuesta: null, ultimo_error: null },
  );
  if (filas.length === 0) return { ok: true, ocupado: true };

  await registrarEvento(tramitacionId, `${tipo}_reenviado`, actor, {});
  const r = await intentarEnvio(filas[0].id, { tope, actor });
  return { ok: true, ocupado: false, estado: r.intentado ? r.estado : 'pendiente', intentos: r.intentos ?? 0 };
}
