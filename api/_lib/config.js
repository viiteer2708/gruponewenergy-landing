// api/_lib/config.js · Variables de entorno, límites, tokens, marcas y cuotas.
//
// REGLA: nada de aquí lee process.env al cargar el módulo. El servidor local de
// pruebas cambia variables en caliente (/__pruebas/env) y Vercel las inyecta por
// despliegue: todo se lee en el momento de usarlo y `requerida('X')` solo lanza
// cuando alguien la pide de verdad. Los valores secretos nunca van en este fichero.
import { igualesSeguro } from './sesion.js';

// ---------------------------------------------------------------------------
// Variables de entorno
// ---------------------------------------------------------------------------

/** Valor de la variable (sin espacios de los lados) o `porDefecto` si no existe o está vacía. */
export function opcional(nombre, porDefecto = undefined) {
  const valor = process.env[nombre];
  if (valor === undefined || valor === null) return porDefecto;
  const limpio = String(valor).trim();
  return limpio === '' ? porDefecto : limpio;
}

/** Valor de la variable; si falta, lanza (solo en el momento de pedirla). */
export function requerida(nombre) {
  const valor = opcional(nombre);
  if (valor === undefined) throw new Error(`Falta la variable de entorno ${nombre}`);
  return valor;
}

/** Modo prueba (solo el servidor local): marca las filas, usa carpeta `pruebas/` y claves de cuota `pruebas:`. */
export function esPrueba() {
  return process.env.TRAMITACION_PRUEBA === '1';
}

/** ALTAVOZ_SIMULAR=1: no se llama a Altavoz, los correos quedan «enviados» simulados. */
export function simulando() {
  return process.env.ALTAVOZ_SIMULAR === '1';
}

/**
 * Modo de fallo que se simula en Altavoz (ALTAVOZ_SIMULAR_FALLO). Solo cuenta en modo prueba: en producción se ignora.
 *   '1'         → 'caido'     Altavoz no contesta bien: 503 en todo
 *   'adjuntos'  → 'adjuntos'  «rechazo por adjuntos»: 422 SOLO a los avisos que llevan adjuntos (como el de Altavoz cuando
 *                             los ficheros no le valen o pasan de 3 MB); un aviso sin adjuntos sale bien
 *   cualquier otra cosa → null (sin fallo)
 */
export function falloSimulado() {
  if (!esPrueba()) return null;
  const valor = process.env.ALTAVOZ_SIMULAR_FALLO;
  if (valor === '1') return 'caido';
  if (valor === 'adjuntos') return 'adjuntos';
  return null;
}

/** ALTAVOZ_SIMULAR_FALLO=1 simula Altavoz caído. Solo cuenta en modo prueba: en producción se ignora. */
export function simularFallo() {
  return falloSimulado() === 'caido';
}

/** Variable que contiene una URL base: obligatoria y sin barra final (para poder concatenar rutas). */
function urlDe(nombre) {
  return requerida(nombre).replace(/\/+$/, '');
}

export const supabaseUrl = () => urlDe('SUPABASE_URL');
export const supabaseClave = () => requerida('SUPABASE_SERVICE_ROLE_KEY');
export const altavozUrl = () => urlDe('ALTAVOZ_URL');
export const altavozClave = () => requerida('ALTAVOZ_API_KEY');
export const sitioUrl = () => urlDe('SITIO_URL');

/** Variable secreta con una longitud mínima (BANDEJA_SECRETO y VIGILANTE_SECRETO: 32 o más). */
export function secreto(nombre, minimo = 32) {
  const valor = requerida(nombre);
  if (valor.length < minimo) throw new Error(`${nombre} debe tener al menos ${minimo} caracteres`);
  return valor;
}

export const secretoBandeja = () => secreto('BANDEJA_SECRETO');
export const secretoVigilante = () => secreto('VIGILANTE_SECRETO');

/** Buzón que recibe el aviso: AVISO_DESTINO, o AVISO_DESTINO_MEGA si existe y el formulario es MEGA. */
export function avisoDestino(formulario) {
  if (formulario === 'mega') {
    const propio = opcional('AVISO_DESTINO_MEGA');
    if (propio) return propio;
  }
  return requerida('AVISO_DESTINO');
}

/** Lista de emails con acceso a la bandeja (BANDEJA_EMAILS, separados por comas), en minúsculas y sin repetidos. */
export function bandejaEmails() {
  const lista = requerida('BANDEJA_EMAILS')
    .split(',')
    .map((correo) => correo.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(lista)];
}

/** ¿Este email está en BANDEJA_EMAILS? (sin distinguir mayúsculas ni espacios) */
export function emailAutorizado(email) {
  return bandejaEmails().includes(String(email ?? '').trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------------

export const LIMITES = Object.freeze({
  maxArchivos: 15,
  maxBytesArchivo: 25 * 1024 * 1024, // = file_size_limit del bucket (26214400)
  maxBytesContrato: 60 * 1024 * 1024,
  maxCaracteresFirma: 2 * 1024 * 1024, // la firma es un PNG pequeño; más es abuso
  maxBytesJson: 3 * 1024 * 1024, // cuerpo JSON leído del stream (la firma va dentro)
});

/**
 * Adjuntos del aviso a backoffice: los topes de Altavoz (api.md §5, `leerAdjuntos`). Hasta 10 ficheros y 3.000.000 bytes
 * REALES entre todos (ya decodificados); el nombre, de 1 a 200 caracteres y con una extensión admitida (en mayúsculas o
 * minúsculas). Pasarse da un 422 en Altavoz; una petición de más de ~4,5 MB la corta Vercel con un 413 antes de que llegue.
 */
export const ADJUNTOS_AVISO = Object.freeze({
  max: 10,
  maxBytes: 3_000_000,
  maxNombre: 200,
  extensiones: Object.freeze(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx']),
});

/** Código de acceso a la bandeja: minutos que vale y fallos permitidos antes de quemarlo. */
export const CODIGO_ACCESO = Object.freeze({ caducaMin: 10, maxIntentos: 5 });

// ---------------------------------------------------------------------------
// Formularios, marcas y tokens
// ---------------------------------------------------------------------------

export const FORMULARIOS = Object.freeze(['gnew', 'mega']);

/**
 * Datos de cada marca. `marca` es el nombre con el que Altavoz elige remitente;
 * `compania` es lo que se guarda cuando el formulario no la pregunta (MEGA).
 * Los colores son los de los correos de siempre (Code.gs): cabecera #094D38 GNEW
 * y #0D9488 MEGA.
 */
export const MARCAS = Object.freeze({
  gnew: Object.freeze({
    formulario: 'gnew',
    marca: 'GNEW',
    nombre: 'Grupo New Energy',
    prefijoRef: 'GNE',
    compania: null,
    colores: Object.freeze({
      cabecera: '#094D38',
      etiqueta: '#094D38',
      fondoEtiqueta: '#f0faf6',
      destacado: '#0B6E4F',
      fondoLista: '#f8fffe',
      fondoNota: '#f0faf6',
      bordeNota: '#bbf7d0',
      textoSuave: '#6B7280',
    }),
  }),
  mega: Object.freeze({
    formulario: 'mega',
    marca: 'MEGA',
    nombre: 'Mega Energía',
    prefijoRef: 'MEGA',
    compania: 'MEGA ENERGIA',
    colores: Object.freeze({
      cabecera: '#0D9488',
      etiqueta: '#0D9488',
      fondoEtiqueta: '#f0fdfa',
      destacado: '#0D9488',
      fondoLista: '#f0fdfa',
      fondoNota: '#f0fdfa',
      bordeNota: '#99f6e4',
      textoSuave: '#64748B',
    }),
  }),
});

/**
 * Token anti-spam de cada formulario. No es un secreto: va en el html y solo
 * frena a los bots. Deben coincidir con FORM_TOKEN de gnew.html y mega.html
 * (y con los Code.gs); la prueba tests/unit/config.test.mjs lo comprueba.
 */
export const FORM_TOKENS = Object.freeze({
  gnew: 'GNE-2026-w7k4q9x2',
  mega: 'MEGA-2026-h3p8k5z1q6',
});

/** ¿Es este el token de ese formulario? (comparación en tiempo constante; formulario desconocido: no) */
export function tokenValido(formulario, token) {
  if (!Object.hasOwn(FORM_TOKENS, formulario)) return false;
  return igualesSeguro(token, FORM_TOKENS[formulario]);
}

// ---------------------------------------------------------------------------
// Cuotas (el contador vive en la base: Vercel no tiene memoria compartida)
// ---------------------------------------------------------------------------

const HORA_SEG = 60 * 60;

const CUOTAS_BASE = Object.freeze({
  iniciar: Object.freeze({ prefijo: 'iniciar', limite: 60, ventanaSeg: HORA_SEG, env: 'CUOTA_INICIAR_HORA' }),
  confirmar: Object.freeze({ prefijo: 'confirmar', limite: 120, ventanaSeg: HORA_SEG, env: 'CUOTA_CONFIRMAR_HORA' }),
  codigoIp: Object.freeze({ prefijo: 'codigo', limite: 10, ventanaSeg: HORA_SEG, env: 'CUOTA_CODIGO_IP_HORA' }),
  codigoEmail: Object.freeze({ prefijo: 'codigo', limite: 5, ventanaSeg: HORA_SEG, env: 'CUOTA_CODIGO_EMAIL_HORA' }),
  entrarIp: Object.freeze({ prefijo: 'entrar', limite: 20, ventanaSeg: HORA_SEG, env: 'CUOTA_ENTRAR_IP_HORA' }),
});

export const NOMBRES_CUOTA = Object.freeze(Object.keys(CUOTAS_BASE));

/** Prefijo de las claves de cuota (y de las filas) que crea el servidor de pruebas. */
export const PREFIJO_PRUEBAS = 'pruebas:';

/**
 * Parámetros de una cuota para `valor` (normalmente el hash de la IP o del email):
 * {clave, limite, ventanaSeg}, justo lo que pide la función SQL tramitacion_cuota.
 * La clave lleva el prefijo `pruebas:` en modo prueba, para que las pruebas nunca
 * gasten ni limpien las cuotas de producción. Solo en modo prueba, la variable
 * CUOTA_*_HORA correspondiente puede rebajar (o subir) el límite.
 */
export function cuota(nombre, valor) {
  if (!Object.hasOwn(CUOTAS_BASE, nombre)) throw new Error(`Cuota desconocida: ${nombre}`);
  const base = CUOTAS_BASE[nombre];
  let limite = base.limite;
  if (esPrueba()) {
    const crudo = opcional(base.env);
    if (crudo !== undefined && /^\d+$/.test(crudo) && Number(crudo) > 0) limite = Number(crudo);
  }
  const clave = `${esPrueba() ? PREFIJO_PRUEBAS : ''}${base.prefijo}:${String(valor ?? '')}`;
  return { clave, limite, ventanaSeg: base.ventanaSeg };
}
