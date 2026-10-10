#!/usr/bin/env node
// scripts/limpiar-ensayo.mjs · Borra los envíos de un ENSAYO en producción (paso 3 de la puesta en marcha, docs/tramitacion-v2.md §9):
// las tramitaciones cuya referencia se indique, con sus documentos, correos y eventos, y sus objetos del almacén.
//
//   node scripts/limpiar-ensayo.mjs GNE-20261011-ABC123 MEGA-20261011-XYZ789             ensayo en seco: dice qué borraría
//   node scripts/limpiar-ensayo.mjs --aplicar GNE-20261011-ABC123 MEGA-20261011-XYZ789   lo borra
//
// Por qué un script y no solo SQL: borrar filas de `storage.objects` con SQL no borra el fichero (o Supabase lo impide), y borrar
// «por carpeta» no borra nada en Storage. Los objetos se borran por la API del almacén, uno a uno por su ruta exacta; la fila de
// `tramitaciones` se borra después y arrastra en cascada `tramitacion_documentos`, `tramitacion_correos` y `tramitacion_eventos`.
// (`limpiar-pruebas.mjs` NO sirve aquí: solo toca prueba = true y «pruebas/»; el ensayo en producción es prueba = false.)
//
// Seguridad (esto borra datos de producción):
//   · Solo borra lo que se le nombra por referencia (nada de patrones ni «todo»); sin --aplicar no borra nada.
//   · Solo borra envíos cuyo comercial sea un alias de Victor (victor.molins.10+algo@gmail.com), que es como se hace un ensayo:
//     si una referencia es de un comercial real —por una errata— se niega y NO borra NADA (ni las demás).
//   · Los objetos que borra son los de la carpeta de la propia fila (comprobada contra su referencia) y los `ruta` de sus documentos.
//   · No imprime ningún dato personal: solo referencias, estados y recuentos.
//
// Las claves (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de gnew-plataforma) salen de .env.local o, si no existe, del entorno.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = /^(GNE|MEGA)-\d{8}-[A-Z0-9]{4,10}$/;
const ALIAS_DE_VICTOR = /^victor\.molins\.10\+[a-z0-9._-]+@gmail\.com$/i;

function uso() {
  console.log([
    'Uso:',
    '  node scripts/limpiar-ensayo.mjs REF [REF…]              ensayo en seco (no borra nada)',
    '  node scripts/limpiar-ensayo.mjs --aplicar REF [REF…]    borra esas tramitaciones y sus objetos del almacén',
    'REF = GNE-AAAAMMDD-XXXXXX (GNEW) o MEGA-AAAAMMDD-XXXXXX (MEGA). Solo envíos de ensayo (comercial = alias de Victor).',
  ].join('\n'));
}

const argumentos = process.argv.slice(2);
const aplicar = argumentos.includes('--aplicar');
const pedidas = argumentos.filter((a) => a !== '--aplicar');
if (pedidas.length === 0 || pedidas.some((a) => !REF.test(a))) {
  uso();
  process.exit(2);
}
const refs = [...new Set(pedidas)];

try {
  process.loadEnvFile(join(RAIZ, '.env.local'));
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error('No se ha podido leer .env.local.');
    process.exit(1);
  }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (en .env.local o en el entorno).');
  process.exit(1);
}

const { borrar, borrarObjetos, listarCarpeta, seleccionar } = await import('../api/_lib/supabase.js');

try {
  // 1. Qué hay (y comprobar que TODO es de ensayo antes de tocar nada)
  const plan = [];
  for (const ref of refs) {
    const filas = await seleccionar('tramitaciones', { select: 'id,estado,prueba,carpeta,comercial_email', ref: `eq.${ref}`, limit: 1 });
    if (filas.length === 0) {
      plan.push({ ref, existe: false });
      continue;
    }
    const fila = filas[0];
    if (!ALIAS_DE_VICTOR.test(String(fila.comercial_email ?? ''))) {
      console.error(`${ref}: el comercial no es un alias de Victor (victor.molins.10+algo@gmail.com), así que no es un envío de ensayo. No se borra NADA.`);
      process.exit(1);
    }
    const formulario = ref.startsWith('GNE-') ? 'gnew' : 'mega';
    const carpeta = String(fila.carpeta ?? '');
    if (!new RegExp(`^(pruebas/)?${formulario}/\\d{4}/\\d{2}/${ref}-[a-z2-7]{6,32}$`).test(carpeta)) {
      console.error(`${ref}: su carpeta del almacén no tiene la forma esperada. No se borra NADA.`);
      process.exit(1);
    }
    const documentos = await seleccionar('tramitacion_documentos', { select: 'ruta', tramitacion_id: `eq.${fila.id}` });
    const rutas = new Set(documentos.map((d) => d.ruta).filter((r) => typeof r === 'string' && r.startsWith(`${carpeta}/`)));
    for (const objeto of await listarCarpeta(carpeta)) rutas.add(`${carpeta}/${objeto.nombre}`);
    plan.push({ ref, existe: true, id: fila.id, estado: fila.estado, prueba: fila.prueba === true, carpeta, rutas: [...rutas], documentos: documentos.length });
  }

  for (const p of plan) {
    console.log(p.existe
      ? `${p.ref}: ${p.estado}${p.prueba ? ' (de prueba)' : ''}, ${p.documentos} documentos, ${p.rutas.length} objetos en el almacén.`
      : `${p.ref}: no existe (ya borrada, o la referencia está mal escrita).`);
  }

  if (!aplicar) {
    console.log('Ensayo en seco: no se ha borrado nada. Para borrar, repite el mismo comando con --aplicar.');
    process.exit(0);
  }

  // 2. Borrar: primero los objetos (por su ruta exacta) y después la fila, que arrastra documentos, correos y eventos
  let tramitaciones = 0;
  let objetos = 0;
  for (const p of plan.filter((x) => x.existe)) {
    for (let i = 0; i < p.rutas.length; i += 100) objetos += (await borrarObjetos(p.rutas.slice(i, i + 100))).length;
    const quedan = (await listarCarpeta(p.carpeta)).length;
    if (quedan > 0) throw new Error(`${p.ref}: quedan ${quedan} objetos en el almacén; no se borra la fila para poder repetirlo`);
    tramitaciones += (await borrar('tramitaciones', { id: `eq.${p.id}` }, { devolver: true })).length;
  }
  console.log(`Borrado: ${tramitaciones} tramitaciones (con sus documentos, correos y eventos) y ${objetos} objetos del almacén. `
    + 'Repite el comando SIN --aplicar: tiene que decir que ya no existen.');
} catch (error) {
  // ErrorSupabase lleva una frase fija sin datos; cualquier otro error, solo su mensaje (que aquí no lleva datos personales)
  console.error(`La limpieza ha fallado: ${error?.name === 'ErrorSupabase' ? error.message : (error?.message ?? error?.name ?? 'error')}`);
  process.exit(1);
}
