// api/_lib/vigilante.js · Lo que hace el vigilante en cada pasada (diseño §2.3 «vigilante» y §2.7).
//
// El vigilante es el seguro de la cola de correos: un cron del VPS llama cada 5 minutos a
// POST /api/tramitacion/vigilante y esta pasada hace, EN ESTE ORDEN:
//   0. conciliar        las recibidas/tramitadas de los últimos 7 días a las que les falta el aviso o el acuse los reciben
//   1. liberar          los correos `enviando` con el cerrojo vencido vuelven a `pendiente` (cuenta como un intento)
//   2. reintentar       hasta 10 correos `pendiente` a los que ya les toca (aviso y acuse; nunca códigos de acceso)
//   3. abandonar        las `subiendo` sin movimiento en 24 h pasan a `abandonada`
//   4. limpiar          cuotas y códigos de acceso de más de un día
// y devuelve el parte: lo que ha hecho y lo que preocupa (correos atascados, subidas a medias).
//
// Reglas de este módulo:
//  - «Sin movimiento» se mide con `actualizada_en`, NO con `creada_en`. Reanudar una `abandonada` hace un UPDATE
//    (el trigger de la tabla actualiza `actualizada_en`), así que una fila reanudada de hace más de 24 h no vuelve a
//    abandonarse. Lo mismo vale para las «subidas a medias» (de 1 h a 24 h sin movimiento).
//  - MODO. Todo lo que mira o toca una tramitación filtra por `prueba = esPrueba()`: el vigilante de producción no ve
//    nada de prueba y el servidor de pruebas (que habla con la misma base real) no ve nada de producción. Las cuotas y
//    los códigos de acceso no cuelgan de una tramitación: en modo prueba solo se limpian los de prueba (claves
//    `pruebas:*` y alias victor.molins.10+…@gmail.com, como scripts/limpiar-pruebas.mjs).
//  - PRESUPUESTO DE TIEMPO. El script del VPS corta a los 25 s y la función vive 60 s como mucho; con Altavoz colgado
//    cada envío tarda hasta 8 s. Por eso no se EMPIEZA ningún envío pasados `limiteEnvioMs` (10 s) desde el inicio de
//    la pasada: lo que no quepa lo recoge la pasada siguiente, 5 minutos después. Así una caída de Altavoz nunca se
//    ve desde el VPS como «la web no responde».
//  - Nada de datos personales: la respuesta lleva referencias, estados y contadores, nunca nombres, correos ni IBAN.
//  - Los fallos de la base suben como excepción (el handler responde 5xx y la siguiente pasada repite todo: cada paso
//    es idempotente). Solo hay un console.error, con una frase fija (textoSeguroDeError).
import { TOPE_ENVIO_MS } from './cartero.js';
import {
  TIPOS_DE_COLA, atascados as correosAtascados, conciliar, liberarCerrojos, registrarEvento, reintentarPendientes, textoSeguroDeError,
} from './cola.js';
import { esPrueba, sitioUrl } from './config.js';
import { urlFichaDe } from './correos.js';
import { ErrorSupabase, actualizar, borrar, rest, seleccionar } from './supabase.js';

export const MAX_CORREOS_POR_PASADA = 10;
export const LIMITE_NUEVO_ENVIO_MS = 10_000;
export const HORAS_PARA_ABANDONAR = 24;
export const MINUTOS_SUBIDA_A_MEDIAS = 60;
export const MINUTOS_ATASCO = 10;
export const DIAS_PARA_LIMPIAR = 1;

const MS_HORA = 60 * 60 * 1000;
const MS_DIA = 24 * MS_HORA;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Pasos 3 y 4, y las listas del parte
// ---------------------------------------------------------------------------

/**
 * Paso 3. Las tramitaciones `subiendo` cuya fila lleva más de `horas` horas sin cambiar (`actualizada_en`) pasan a
 * `abandonada`, con el evento `abandonada` (actor `vigilante`). Un solo UPDATE condicionado: si el comercial la reanuda
 * justo en ese instante, la fila ya no cumple el filtro y no se toca. Devuelve cuántas ha abandonado.
 * Solo se pide el `id` de las filas tocadas: el resto de la fila lleva datos personales que aquí no hacen falta.
 */
export async function abandonarInactivas({ ahora = Date.now(), horas = HORAS_PARA_ABANDONAR } = {}) {
  const filas = await actualizar(
    'tramitaciones',
    {
      select: 'id',
      estado: 'eq.subiendo',
      prueba: `eq.${esPrueba()}`,
      actualizada_en: `lt.${iso(ahora - horas * MS_HORA)}`,
    },
    { estado: 'abandonada' },
  );
  for (const { id } of filas) await registrarEvento(id, 'abandonada', 'vigilante', { motivo: 'sin_actividad', horas });
  return filas.length;
}

/**
 * Subidas a medias: tramitaciones `subiendo` sin movimiento desde hace entre `desdeMin` minutos y `hastaHoras` horas
 * (las de más de 24 h ya las ha abandonado el paso 3). `minutos` cuenta desde el último movimiento de la fila
 * (`actualizada_en`), no desde que se creó: un envío reanudado cuenta desde que se retomó.
 * Devuelve [{ref, formulario, creada_en, actualizada_en, minutos}], las más antiguas primero.
 */
export async function subidasAMedias({ ahora = Date.now(), desdeMin = MINUTOS_SUBIDA_A_MEDIAS, hastaHoras = HORAS_PARA_ABANDONAR } = {}) {
  const filas = await seleccionar('tramitaciones', {
    select: 'ref,formulario,creada_en,actualizada_en',
    estado: 'eq.subiendo',
    prueba: `eq.${esPrueba()}`,
    actualizada_en: [`lt.${iso(ahora - desdeMin * 60_000)}`, `gte.${iso(ahora - hastaHoras * MS_HORA)}`],
    order: 'actualizada_en.asc',
    limit: 100,
  });
  return filas.map((f) => ({
    ref: f.ref,
    formulario: f.formulario,
    creada_en: f.creada_en,
    actualizada_en: f.actualizada_en,
    minutos: Math.max(0, Math.floor((ahora - Date.parse(f.actualizada_en)) / 60_000)),
  }));
}

/**
 * Paso 4. Borra las cuotas (`tramitacion_cuotas`, cuya ventana empezó hace más de `dias` días) y los códigos de acceso
 * (`tramitacion_accesos`, creados hace más de `dias` días): ya no sirven a nadie (la cuota vale una hora y el código
 * diez minutos). En modo prueba solo toca lo de prueba (ver arriba). Devuelve {cuotas, accesos} con cuántos ha borrado.
 */
export async function limpiarCaducados({ ahora = Date.now(), dias = DIAS_PARA_LIMPIAR } = {}) {
  const corte = iso(ahora - dias * MS_DIA);
  const filtroCuotas = { select: 'clave', ventana_inicio: `lt.${corte}` };
  const filtroAccesos = { select: 'id', creado_en: `lt.${corte}` };
  if (esPrueba()) {
    filtroCuotas.clave = 'like.pruebas:*';
    filtroAccesos.email = 'like.victor.molins.10+*@gmail.com'; // «*» es el comodín de like en PostgREST
  }
  const cuotas = await borrar('tramitacion_cuotas', filtroCuotas, { devolver: true });
  const accesos = await borrar('tramitacion_accesos', filtroAccesos, { devolver: true });
  return { cuotas: cuotas.length, accesos: accesos.length };
}

/**
 * Cuántos correos de aviso/acuse hay sin enviar (`pendiente` o `enviando`) en este modo. Se cuenta en la base
 * (`Prefer: count=exact`), no con `.length` de una lista, que se quedaría en 1000.
 */
export async function contarPendientes() {
  const r = await rest('GET', 'tramitacion_correos', {
    query: {
      select: 'id,tramitaciones!inner(prueba)',
      tipo: `in.(${TIPOS_DE_COLA.join(',')})`,
      estado: 'in.(pendiente,enviando)',
      'tramitaciones.prueba': `eq.${esPrueba()}`,
      limit: 1,
    },
    prefer: 'count=exact',
  });
  const total = /\/(\d+)$/.exec(r.cabeceras.get('content-range') ?? '');
  return total ? Number(total[1]) : (r.datos?.length ?? 0);
}

/** URL pública de la ficha, o null si no se puede armar (falta SITIO_URL: el parte sale igual, sin enlace). */
function fichaDe(ref) {
  if (!ref) return null;
  try {
    return urlFichaDe(sitioUrl(), ref);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// La pasada completa
// ---------------------------------------------------------------------------

/**
 * Una pasada del vigilante (pasos 0-4 y el parte). Devuelve
 *   { conciliadas, liberados, reintentados, enviados, abandonadas, limpiados:{cuotas, accesos},
 *     atascados:[{id, tipo, ref, estado, intentos, codigo_respuesta, creado_en, minutos, ficha}],
 *     subidas_a_medias:[{ref, formulario, creada_en, actualizada_en, minutos}], pendientes_total }
 * `atascados` = correos aviso/acuse sin enviar que están en un estado terminal (agotado, suprimido, incierto, error de
 * configuración) o llevan más de 10 minutos. Parámetros solo para las pruebas: `ahora`, `maxCorreos`, `tope` (por
 * envío) y `limiteEnvioMs` (pasado ese tiempo no se empieza otro envío).
 * Lanza si la base falla (cada paso es idempotente: la pasada siguiente lo repite) y ErrorSimulacion si se intenta
 * enviar de verdad en modo prueba.
 */
export async function ejecutarPasada({
  ahora = Date.now(),
  maxCorreos = MAX_CORREOS_POR_PASADA,
  tope = TOPE_ENVIO_MS,
  limiteEnvioMs = LIMITE_NUEVO_ENVIO_MS,
} = {}) {
  const inicio = Date.now();

  const conciliadas = await conciliar({ ahora }); // 0
  let liberados = await liberarCerrojos({ ahora }); // 1

  // 2. De uno en uno, para poder parar por tiempo. Un envío que falla queda con su espera (proximo_intento en el
  //    futuro) y ya no sale en la siguiente vuelta, así que el bucle avanza solo hasta quedarse sin nada que tocar.
  //    Se para en la primera vuelta que no intenta nada: o no queda nada a lo que le toque, o el correo elegido lo tenía
  //    otra pasada solapada (en ese caso lo que quede lo recoge la pasada siguiente, 5 minutos después).
  let reintentados = 0;
  let enviados = 0;
  for (let vuelta = 0; vuelta < maxCorreos; vuelta++) {
    if (Date.now() - inicio >= limiteEnvioMs) break;
    const r = await reintentarPendientes({ max: 1, tope, ahora: Date.now() });
    liberados += r.liberados; // reintentarPendientes también libera los cerrojos que hayan vencido mientras tanto
    if (r.reintentados === 0) break;
    reintentados += r.reintentados;
    enviados += r.enviados;
  }

  const abandonadas = await abandonarInactivas({ ahora }); // 3
  const limpiados = await limpiarCaducados({ ahora }); // 4

  const [atascados, subidas, pendientesTotal] = await Promise.all([
    correosAtascados({ ahora, minutos: MINUTOS_ATASCO }),
    subidasAMedias({ ahora }),
    contarPendientes(),
  ]);

  return {
    conciliadas,
    liberados,
    reintentados,
    enviados,
    abandonadas,
    limpiados,
    atascados: atascados.map((a) => ({ ...a, ficha: fichaDe(a.ref) })),
    subidas_a_medias: subidas,
    pendientes_total: pendientesTotal,
  };
}

/**
 * Traduce una excepción de la pasada a la respuesta del endpoint y apunta en el registro del servidor SOLO de qué
 * tipo fue (frase fija, nunca datos). Un fallo de Supabase es `503 temporal`; cualquier otra cosa, `500 interno`.
 * Devuelve {status, cuerpo}.
 */
export function respuestaDeError(error) {
  console.error(`[vigilante] ${textoSeguroDeError(error)}`);
  if (error instanceof ErrorSupabase) {
    return { status: 503, cuerpo: { ok: false, codigo: 'temporal', mensaje: 'La base de datos no ha respondido. La pasada se repetirá en la siguiente vuelta.', retryable: true } };
  }
  return { status: 500, cuerpo: { ok: false, codigo: 'interno', mensaje: 'La pasada del vigilante ha fallado. Se repetirá en la siguiente vuelta.', retryable: true } };
}
