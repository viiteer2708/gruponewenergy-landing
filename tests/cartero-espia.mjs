// tests/cartero-espia.mjs · El «espía» de Altavoz del servidor local de pruebas (orden 6).
//
// Qué es. Un envoltorio de api/_lib/cartero.js que SOLO existe dentro del servidor local (tests/servidor-local.mjs lo pone
// en lugar del cartero con un gancho de resolución de módulos de Node). Deja pasar cada llamada al cartero de verdad (que
// en pruebas SIEMPRE está simulado: no sale nada) y apunta EN MEMORIA qué habría salido: a quién, con qué asunto y qué
// adjuntos llevaba (nombre, bytes y md5). Las pruebas lo leen por el gancho GET /__pruebas/correos.
//
// Por qué así. En simulación no se envía nada, pero las pruebas tienen que poder ver qué adjuntos llevaría cada aviso. Eso
// no se guarda en la base (los adjuntos nunca se guardan) ni vive en api/ (nada que solo exista para pruebas se despliega):
// vive aquí, en la memoria del proceso del servidor local, y se pierde al pararlo.
//
// Reglas:
//  · Solo se anota lo mínimo: nunca el cuerpo del correo ni el contenido de los ficheros (solo su md5).
//  · La lista está acotada (MAX_ENVIOS): los más antiguos se olvidan.
//  · El cartero real se carga con «?real» para que sea otro módulo distinto de este (que ocupa su sitio).
import { createHash } from 'node:crypto';

import * as real from '../api/_lib/cartero.js?real';

export * from '../api/_lib/cartero.js?real';

const MAX_ENVIOS = 300;
const envios = [];
let numero = 0;

const md5 = (datos) => createHash('md5').update(datos).digest('hex');

/**
 * Los envíos anotados, del más antiguo al más nuevo. Filtros opcionales:
 *   para       solo los de esa dirección (sin distinguir mayúsculas)
 *   etiqueta   solo los de esa etiqueta de Altavoz (tramitacion-aviso, tramitacion-acuse, bandeja-codigo)
 *   asunto     solo los que contienen ese texto en el asunto
 * Cada uno: {n, cuando, para, etiqueta, asunto, tope, adjuntos:[{nombre, bytes, md5}], bytes_adjuntos,
 *            resultado:{estado, http, simulado, altavoz_id, rechazo_adjuntos}}
 */
export function enviosAnotados({ para, etiqueta, asunto } = {}) {
  return envios
    .filter((e) => (para ? e.para === String(para).trim().toLowerCase() : true))
    .filter((e) => (etiqueta ? e.etiqueta === etiqueta : true))
    .filter((e) => (asunto ? e.asunto.includes(asunto) : true))
    .map((e) => structuredClone(e));
}

/** Igual que el cartero de verdad (devuelve lo mismo, lanza lo mismo), pero apuntando antes qué llevaba el correo. */
export async function enviarAviso(correo, opciones) {
  const adjuntos = (Array.isArray(correo?.adjuntos) ? correo.adjuntos : []).map((a) => {
    const contenido = a?.contenido instanceof Uint8Array ? a.contenido : new Uint8Array(0);
    return { nombre: String(a?.nombre ?? ''), bytes: contenido.length, md5: md5(contenido) };
  });
  const resultado = await real.enviarAviso(correo, opciones);
  envios.push({
    n: ++numero,
    cuando: new Date().toISOString(),
    para: String(correo?.para ?? '').trim().toLowerCase(),
    etiqueta: correo?.etiqueta ?? null,
    asunto: String(correo?.asunto ?? ''),
    tope: Number.isFinite(opciones?.tope) ? opciones.tope : null,
    adjuntos,
    bytes_adjuntos: adjuntos.reduce((suma, a) => suma + a.bytes, 0),
    resultado: {
      estado: resultado.estado,
      http: resultado.http ?? null,
      simulado: resultado.simulado === true,
      altavoz_id: resultado.altavoz_id ?? null,
      rechazo_adjuntos: resultado.rechazo_adjuntos === true,
    },
  });
  if (envios.length > MAX_ENVIOS) envios.splice(0, envios.length - MAX_ENVIOS);
  return resultado;
}
