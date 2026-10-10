// Los tiempos de la orden 6 (los avisos llevan los documentos adjuntos y tardan más): cada número del código, de vercel.json y
// del script del vigilante tiene que encajar con los demás. Si alguien cambia uno sin mirar los otros, esta prueba lo dice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { TOPE_AVISO_MS, TOPE_ENVIO_MS } from '../../api/_lib/cartero.js';
import {
  CERROJO_MS, MINIMO_REINTENTO_SIN_ADJUNTOS_MS, PRESUPUESTO_ACUSE_MS, TOPE_CONFIRMAR_ACUSE_MS, TOPE_CONFIRMAR_AVISO_MS, TOPE_DESCARGAS_MS,
} from '../../api/_lib/cola.js';
import { LIMITE_NUEVO_ENVIO_MS, MAX_CORREOS_POR_PASADA } from '../../api/_lib/vigilante.js';

const raiz = new URL('../../', import.meta.url);
const leer = (ruta) => readFileSync(new URL(ruta, raiz), 'utf8');
const vercel = JSON.parse(leer('vercel.json'));
const MAX_FUNCION_TRAMITACION_MS = vercel.functions['api/tramitacion/*.js'].maxDuration * 1000;
const MAX_FUNCION_BANDEJA_MS = vercel.functions['api/bandeja/*.js'].maxDuration * 1000;
const TOPE_SCRIPT_MS = Number(/^const TOPE_LLAMADA_MS = ([\d_]+);/m.exec(leer('scripts/vigilante-tramitacion.mjs'))?.[1].replace(/_/g, ''));
// Lo que espera el navegador por cada intento de `confirmar`: la misma constante en los dos formularios
const CONFIRMAR_NAVEGADOR_MS = ['gnew.html', 'mega.html'].map((html) => Number(/^\s*const CONFIRMAR_TOPE_MS = ([\d_]+);/m.exec(leer(html))?.[1].replace(/_/g, '')));

// Lo que no es el tope de un envío y se da por sentado en las cuentas (ver el comentario de api/_lib/vigilante.js):
const CONSULTAS_DE_LA_PASADA_MS = 5_000; // conciliar, liberar, abandonar, limpiar y el parte: consultas de ~0,2 s cada una
const BASE_Y_ESCRITURAS_MS = 2_000; // coger el cerrojo, leer la tramitación y escribir el resultado alrededor de un envío

test('los topes de los envíos: aviso 15 s (descargas incluidas), resto 8 s; de los 15 s, las descargas usan 6 como mucho', () => {
  assert.equal(TOPE_AVISO_MS, 15_000);
  assert.equal(TOPE_ENVIO_MS, 8_000);
  assert.equal(TOPE_CONFIRMAR_AVISO_MS, 15_000, 'confirmar: tope del aviso 15 s (era 6)');
  assert.equal(TOPE_CONFIRMAR_ACUSE_MS, 6_000, 'el acuse no lleva adjuntos: sigue con 6 s');
  assert.equal(PRESUPUESTO_ACUSE_MS, 20_000, 'confirmar: el acuse solo si han pasado menos de 20 s desde el inicio (era 12)');
  assert.equal(TOPE_DESCARGAS_MS, 6_000);
  assert.ok(TOPE_DESCARGAS_MS < TOPE_AVISO_MS, 'las descargas no pueden comerse todo el tiempo del aviso');
  assert.equal(MINIMO_REINTENTO_SIN_ADJUNTOS_MS, 4_000);
});

test('el vigilante: no empieza envíos pasados 25 s, hasta 10 correos por pasada, y el script corta a 55 s', () => {
  assert.equal(LIMITE_NUEVO_ENVIO_MS, 25_000);
  assert.equal(MAX_CORREOS_POR_PASADA, 10);
  assert.equal(TOPE_SCRIPT_MS, 55_000, 'TOPE_LLAMADA_MS de scripts/vigilante-tramitacion.mjs');
  assert.equal(MAX_FUNCION_TRAMITACION_MS, 60_000, 'maxDuration de api/tramitacion/*.js');
});

test('una pasada del vigilante nunca supera el maxDuration de la función (60 s) ni el tope del script (55 s), ni con Altavoz colgado', () => {
  // Peor caso: el último envío empieza justo antes del límite y es un aviso que agota su tiempo y, encima, Altavoz rechaza los
  // adjuntos tarde y hace falta el reintento sin ellos.
  const peorEnvio = TOPE_AVISO_MS + MINIMO_REINTENTO_SIN_ADJUNTOS_MS + BASE_Y_ESCRITURAS_MS;
  const peorPasada = LIMITE_NUEVO_ENVIO_MS + peorEnvio + CONSULTAS_DE_LA_PASADA_MS;
  assert.equal(peorPasada, 51_000);
  assert.ok(peorPasada < TOPE_SCRIPT_MS, `${peorPasada} ms < ${TOPE_SCRIPT_MS} ms del script: desde el VPS una caída de Altavoz nunca parece «la web no responde»`);
  assert.ok(TOPE_SCRIPT_MS < MAX_FUNCION_TRAMITACION_MS, 'el script corta antes que la función');
  assert.ok(peorPasada < MAX_FUNCION_TRAMITACION_MS - 5_000, 'y a la función le quedan al menos 5 s de margen');
});

test('confirmar: aviso (15 s) y, si quedan menos de 20 s, acuse (6 s) caben en lo que espera el navegador (30 s por intento)', () => {
  // El formulario espera 30 s por intento de confirmar (4 intentos, idempotentes; antes 25 s). Peor caso: el aviso agota sus 15 s
  // y el acuse todavía entra (empieza antes de los 20 s) y agota los suyos.
  assert.deepEqual(CONFIRMAR_NAVEGADOR_MS, [30_000, 30_000], 'CONFIRMAR_TOPE_MS de gnew.html y de mega.html (tiene que ser el mismo)');
  const navegadorMs = CONFIRMAR_NAVEGADOR_MS[0];
  const trabajoPrevioMs = 3_000; // leer la tramitación, comprobar el almacén, marcar los documentos y cerrarla
  const peor = trabajoPrevioMs + TOPE_CONFIRMAR_AVISO_MS + BASE_Y_ESCRITURAS_MS + TOPE_CONFIRMAR_ACUSE_MS + BASE_Y_ESCRITURAS_MS;
  assert.ok(peor < MAX_FUNCION_TRAMITACION_MS, 'cabe de sobra en la función');
  // Con los 30 s, el peor caso (28 s) ya cabe en lo que espera el navegador: ni siquiera con Altavoz lento hace falta repetir
  // `confirmar` (que, si hiciera falta, es idempotente y responde «listo» al momento sin duplicar nada).
  assert.ok(peor < navegadorMs, `peor caso ${peor} ms frente a los ${navegadorMs} ms del navegador`);
  assert.ok(PRESUPUESTO_ACUSE_MS > TOPE_CONFIRMAR_AVISO_MS, 'si el aviso gasta su tiempo, aún puede entrar el acuse');
});

test('«Volver a enviar» de la bandeja (maxDuration de api/bandeja/*.js) y el cerrojo de la cola aguantan el peor aviso', () => {
  const peorAviso = TOPE_AVISO_MS + MINIMO_REINTENTO_SIN_ADJUNTOS_MS + BASE_Y_ESCRITURAS_MS;
  assert.ok(peorAviso < MAX_FUNCION_BANDEJA_MS, `${peorAviso} ms < ${MAX_FUNCION_BANDEJA_MS} ms de api/bandeja/*.js`);
  assert.ok(CERROJO_MS > peorAviso, 'el cerrojo (60 s) dura más que el peor intento: nadie le quita el correo a quien lo está enviando');
});
