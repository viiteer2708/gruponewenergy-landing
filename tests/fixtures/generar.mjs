// tests/fixtures/generar.mjs · Documentos de prueba para los tests de API y de navegador.
//
// Como módulo (los tests de API lo importan): generarPdf(), generarPdfDemasiadoGrande(), generarJpeg() y
// generarPng() devuelven Buffers; no se guarda nada en disco.
//
// Como script (`node tests/fixtures/generar.mjs [--grande]`): escribe en esta carpeta los archivos que
// necesita el navegador para `set_input_files`. Están git-ignorados (ver .gitignore: *.pdf, *.jpg, *.png,
// *.bin): el de 5,5 MB no debe subirse nunca al repositorio.
//
// El «PDF» no es un PDF de verdad: lleva la cabecera `%PDF-1.4` y el resto son bytes aleatorios. Al almacén
// le basta el `Content-Type` que manda el navegador; lo que se prueba es el transporte, no el visor.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIB = 1024 * 1024;

/** El «PDF» de los tests: 5,5 MiB = 5.767.168 bytes. */
export const TAMANO_PDF = 5.5 * MIB;

/** Límite por archivo del bucket «tramitaciones» (file_size_limit): 25 MiB = 26.214.400 bytes. Exactamente eso entra; un byte más no. */
export const LIMITE_ALMACEN = 25 * MIB;

/**
 * El archivo «demasiado grande»: 26 MiB = 27.262.976 bytes. OJO: «26 MB» en decimal (26.000.000 bytes)
 * NO sirve, porque está por DEBAJO del límite de 26.214.400 y el almacén lo acepta (medido el 9-oct-2026).
 */
export const TAMANO_DEMASIADO_GRANDE = 26 * MIB;

const CABECERA_PDF = Buffer.from('%PDF-1.4\n', 'latin1');

/** «PDF» de `bytes` bytes (5,5 MiB por defecto): cabecera %PDF-1.4 + bytes aleatorios. */
export function generarPdf(bytes = TAMANO_PDF) {
  if (!Number.isInteger(bytes) || bytes < CABECERA_PDF.length) throw new RangeError('Tamaño de PDF no válido');
  return Buffer.concat([CABECERA_PDF, randomBytes(bytes - CABECERA_PDF.length)], bytes);
}

/** «PDF» de 26 MiB para probar el rechazo por tamaño. Solo en memoria, salvo con `--grande`. */
export function generarPdfDemasiadoGrande() {
  return generarPdf(TAMANO_DEMASIADO_GRANDE);
}

// JPEG de 48×32 (degradado verde a amarillo) y PNG de 64×24 (trazo de firma sobre fondo transparente).
// Los dos se crearon con Pillow y se comprobaron con Image.verify(): son imágenes válidas de verdad.
const JPEG_BASE64 = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcU',
  'FhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo',
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgADADASIA',
  'AhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABAIG/8QAFhAAAwAAAAAAAAAAAAAAAAAAAAID/8QA',
  'FwEBAQEBAAAAAAAAAAAAAAAABQYEB//EABcRAAMBAAAAAAAAAAAAAAAAAAACAwT/2gAMAwEAAhED',
  'EQA/AMFNBU0ImgqaGWrEpmcuaCpqRNBU1DasUGZy5oJmhM0FTQNqxQ5nMrNBU0JmgmaDtWOa5nLm',
  'gqaETQVNA2rFBmcqaCpqTNBU0DasUOZz/9k=',
].join('');

const PNG_BASE64 = [
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAYCAYAAABKtPtEAAAA4klEQVR42u1XQQ7DIAwrufI4fsJj',
  '9pM9bmd2QkIIRBxn6qbFp6pVYocYSK8rEAgEAv+LZAnKtbT+/Ho80y8vgDDF34WuwUOLsJ1HRHgI',
  'n3PkWhqTTyxBvXjE/ivh7NYb+a2LICj5qugT+e7MsLhnzjHnQxdC2H2PuGDlHI3g06HLuEFY8hPp',
  '7r1WMHLjWNwgHsXvvmk6533dom4QT/IxBo2fhbKzhtYNgiRCCK229Ry0NG5I6ImPdNFyTVrjrdrE',
  'c9Jju/Wp4mc3jLmT577zsG6upd36f8HO19/wrxAIBAJavAGb6NwXdTSVWgAAAABJRU5ErkJggg==',
].join('');

/** JPEG pequeño y válido (368 bytes), siempre el mismo. */
export function generarJpeg() {
  return Buffer.from(JPEG_BASE64, 'base64');
}

/** PNG pequeño y válido (283 bytes), siempre el mismo. */
export function generarPng() {
  return Buffer.from(PNG_BASE64, 'base64');
}

// ---------------------------------------------------------------------------
// Uso como script
// ---------------------------------------------------------------------------

function escribirFixtures({ grande = false } = {}) {
  const carpeta = dirname(fileURLToPath(import.meta.url));
  mkdirSync(carpeta, { recursive: true });
  const archivos = [
    ['documento-5-5mb.pdf', generarPdf()],
    ['foto-pequena.jpg', generarJpeg()],
    ['firma-pequena.png', generarPng()],
  ];
  if (grande) archivos.push(['demasiado-grande.bin', generarPdfDemasiadoGrande()]);
  for (const [nombre, datos] of archivos) {
    writeFileSync(join(carpeta, nombre), datos);
    console.log(`${nombre}: ${datos.length} bytes`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  escribirFixtures({ grande: process.argv.includes('--grande') });
}
