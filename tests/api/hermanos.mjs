// tests/api/hermanos.mjs · Ayuda común de las pruebas de API: esperar a los ficheros de pruebas anteriores.
//
// (No termina en «.test.mjs»: `node --test "tests/api/*.test.mjs"` no lo toma por una prueba.)
//
// `node --test "tests/api/*.test.mjs"` lanza los ficheros A LA VEZ, y todos hablan con el MISMO servidor local, cuyo entorno
// cambian los ganchos (/__pruebas/env: cuotas, Altavoz caído, «modo producción»…). Dos ficheros que cambian el entorno a la
// vez se estropean entre sí (con TRAMITACION_PRUEBA=0 el servidor rechaza hasta las escrituras del otro; con Altavoz caído
// los correos del otro se quedan pendientes). Por eso cada fichero que toca ese entorno, o que depende de que nadie más
// lo toque, espera a que terminen los hermanos con número MENOR (00 → 10 → 20 → 30…), cuantos núcleos haya: así el orden es
// siempre el mismo y nunca se esperan dos entre sí. Los hermanos son los procesos con el mismo padre (el lanzador de
// `node --test`). Sin `ps`, o lanzado a mano sin lanzador, no hay a quién esperar y sigue.
//
// Uso, en la cabecera de cada fichero:
//   before(() => esperarAHermanosAnteriores(import.meta.url), { timeout: 10 * 60_000 });
// El número del fichero se saca de SU nombre («30-vigilante.test.mjs» → 30), por eso hay que pasar la URL de quien llama:
// dentro de este módulo, `import.meta.url` sería la de este fichero.
import { execFileSync } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function esperarAHermanosAnteriores(urlDelTest, { maxMs = 8 * 60_000 } = {}) {
  const mio = Number(/(\d+)-[^/\\]*\.test\.mjs$/.exec(fileURLToPath(urlDelTest))?.[1]);
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
