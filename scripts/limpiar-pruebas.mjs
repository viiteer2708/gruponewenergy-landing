#!/usr/bin/env node
// scripts/limpiar-pruebas.mjs · Borra TODO lo que dejan las pruebas de Tramitación v2 en la base real.
//
//   node scripts/limpiar-pruebas.mjs --todo          todo lo de prueba, sea cuando sea
//   node scripts/limpiar-pruebas.mjs --horas 2       solo lo de prueba creado hace MÁS de 2 horas
//
// Qué borra (y NADA más):
//   · las tramitaciones con prueba=true (y, en cascada, sus documentos, correos y eventos) y sus objetos en el almacén
//   · con --todo, además, TODO lo que cuelgue de «pruebas/» en el almacén (también huérfanos y la carpeta del spike),
//     recorriéndolo carpeta a carpeta y borrando objeto a objeto (borrar por prefijo no borra nada en Storage)
//   · los códigos de acceso (tramitacion_accesos) de los alias de prueba victor.molins.10+…@gmail.com
//   · los correos de código de acceso simulados a esos alias (tramitacion_correos sin tramitación)
//   · las cuotas cuya clave empieza por «pruebas:» (las de producción no llevan ese prefijo y no se tocan nunca)
// Con --horas los objetos que se borran son los de las tramitaciones que se borran; los huérfanos solo caen con --todo.
//
// Se niega a correr si .env.local no pone TRAMITACION_PRUEBA=1. No imprime ningún dato: solo recuentos.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS_PRUEBA = 'like.victor.molins.10+*@gmail.com'; // «*» es el comodín de like en PostgREST
const PREFIJO_ALMACEN = 'pruebas';

function uso() {
  console.log([
    'Uso:',
    '  node scripts/limpiar-pruebas.mjs --todo',
    '  node scripts/limpiar-pruebas.mjs --horas N      (solo lo creado hace más de N horas)',
  ].join('\n'));
}

function leerArgumentos(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--todo') return { todo: true, horas: null };
  if (args.length === 2 && args[0] === '--horas' && /^\d+(\.\d+)?$/.test(args[1]) && Number(args[1]) > 0) {
    return { todo: false, horas: Number(args[1]) };
  }
  return null;
}

const argumentos = leerArgumentos(process.argv);
if (!argumentos) {
  uso();
  process.exit(2);
}

try {
  process.loadEnvFile(join(RAIZ, '.env.local'));
} catch (error) {
  console.error(error?.code === 'ENOENT' ? 'Falta .env.local en la raíz del proyecto.' : 'No se ha podido leer .env.local.');
  process.exit(1);
}
if (process.env.TRAMITACION_PRUEBA !== '1') {
  console.error('Me niego a borrar: .env.local no pone TRAMITACION_PRUEBA=1 (este script solo es para el entorno de pruebas).');
  process.exit(1);
}

const { borrar, borrarObjetos, listarCarpeta, seleccionar } = await import('../api/_lib/supabase.js');

const corte = argumentos.todo ? null : new Date(Date.now() - argumentos.horas * 60 * 60 * 1000).toISOString();
const filtroEdad = (columna) => (corte ? { [columna]: `lt.${corte}` } : {});

/** Todas las rutas de objetos bajo un prefijo, recorriendo las subcarpetas. */
async function objetosBajo(prefijo, salida = []) {
  for (const entrada of await listarCarpeta(prefijo, { incluirCarpetas: true })) {
    const ruta = `${prefijo}/${entrada.nombre}`;
    if (entrada.carpeta) await objetosBajo(ruta, salida);
    else salida.push(ruta);
  }
  return salida;
}

/** Borra objetos de 100 en 100, comprobando que todos cuelgan de «pruebas/»: nada de producción se toca jamás. */
async function borrarEnLotes(rutas) {
  const fuera = rutas.filter((r) => !r.startsWith(`${PREFIJO_ALMACEN}/`));
  if (fuera.length > 0) throw new Error('Se ha intentado borrar un objeto fuera de «pruebas/»: se cancela.');
  let borrados = 0;
  for (let i = 0; i < rutas.length; i += 100) borrados += (await borrarObjetos(rutas.slice(i, i + 100))).length;
  return borrados;
}

try {
  // 1. Almacén
  let rutas;
  if (argumentos.todo) {
    rutas = await objetosBajo(PREFIJO_ALMACEN);
  } else {
    const filas = await seleccionar('tramitaciones', { select: 'carpeta', prueba: 'eq.true', ...filtroEdad('creada_en') });
    rutas = [];
    for (const { carpeta } of filas) {
      if (typeof carpeta !== 'string' || !carpeta.startsWith(`${PREFIJO_ALMACEN}/`)) continue; // una fila de prueba siempre vive bajo pruebas/
      for (const objeto of await listarCarpeta(carpeta)) rutas.push(`${carpeta}/${objeto.nombre}`);
    }
  }
  const objetos = await borrarEnLotes(rutas);

  // 2. Base de datos (las filas hijas caen en cascada)
  const tramitaciones = await borrar('tramitaciones', { prueba: 'eq.true', ...filtroEdad('creada_en') }, { devolver: true });
  const correos = await borrar(
    'tramitacion_correos',
    { tramitacion_id: 'is.null', simulado: 'eq.true', para: ALIAS_PRUEBA, ...filtroEdad('creado_en') },
    { devolver: true },
  );
  const accesos = await borrar('tramitacion_accesos', { email: ALIAS_PRUEBA, ...filtroEdad('creado_en') }, { devolver: true });
  const cuotas = await borrar('tramitacion_cuotas', { clave: 'like.pruebas:*', ...filtroEdad('ventana_inicio') }, { devolver: true });

  console.log(
    `Limpieza de pruebas${corte ? ` (anteriores a ${corte})` : ' (todo)'}: `
    + `${tramitaciones.length} tramitaciones, ${objetos} objetos del almacén, ${correos.length} correos de código, `
    + `${accesos.length} accesos y ${cuotas.length} cuotas.`,
  );
} catch (error) {
  // ErrorSupabase lleva una frase fija sin datos; cualquier otro error, solo su tipo
  console.error(`La limpieza ha fallado: ${error?.name === 'ErrorSupabase' ? error.message : (error?.message ?? error?.name ?? 'error')}`);
  process.exit(1);
}
