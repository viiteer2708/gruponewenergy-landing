// Pruebas de api/_lib/config.js: lectura perezosa, límites, tokens, marcas y cuotas.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import * as config from '../../api/_lib/config.js';

const raiz = new URL('../../', import.meta.url);
const leer = (ruta) => readFileSync(new URL(ruta, raiz), 'utf8');

// Variables que tocan estas pruebas: se guardan y se restauran para no contaminar.
const VARIABLES = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALTAVOZ_URL', 'ALTAVOZ_API_KEY', 'SITIO_URL',
  'AVISO_DESTINO', 'AVISO_DESTINO_MEGA', 'BANDEJA_EMAILS', 'BANDEJA_SECRETO', 'VIGILANTE_SECRETO',
  'TRAMITACION_PRUEBA', 'ALTAVOZ_SIMULAR', 'ALTAVOZ_SIMULAR_FALLO',
  'CUOTA_INICIAR_HORA', 'CUOTA_CONFIRMAR_HORA', 'CUOTA_CODIGO_IP_HORA', 'CUOTA_CODIGO_EMAIL_HORA', 'CUOTA_ENTRAR_IP_HORA',
];
let copia;
beforeEach(() => {
  copia = {};
  for (const v of VARIABLES) { copia[v] = process.env[v]; delete process.env[v]; }
});
afterEach(() => {
  for (const v of VARIABLES) {
    if (copia[v] === undefined) delete process.env[v]; else process.env[v] = copia[v];
  }
});

test('lectura perezosa: cargar el módulo sin ninguna variable no lanza; requerida lanza solo al usarla', () => {
  // En un proceso aparte y con el entorno VACÍO: si el módulo leyera algo al cargar, fallaría aquí.
  const salida = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import('${new URL('api/_lib/config.js', raiz).href}').then((m) => {
       let lanzo = false;
       try { m.requerida('SUPABASE_URL'); } catch (e) { lanzo = /SUPABASE_URL/.test(e.message); }
       console.log(JSON.stringify({ carga: typeof m.requerida, lanzo, prueba: m.esPrueba() }));
     });`,
  ], { env: {}, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(salida), { carga: 'function', lanzo: true, prueba: false });
});

test('requerida y opcional: leen en el momento, recortan espacios y tratan vacío como ausente', () => {
  assert.throws(() => config.requerida('SUPABASE_URL'), /SUPABASE_URL/);
  process.env.SUPABASE_URL = '  https://x.supabase.co  ';
  assert.equal(config.requerida('SUPABASE_URL'), 'https://x.supabase.co');
  process.env.SUPABASE_URL = 'https://otra.supabase.co';
  assert.equal(config.requerida('SUPABASE_URL'), 'https://otra.supabase.co', 'cambia en caliente');
  process.env.SUPABASE_URL = '   ';
  assert.throws(() => config.requerida('SUPABASE_URL'), /SUPABASE_URL/, 'solo espacios = falta');
  assert.equal(config.opcional('NO_EXISTE_NUNCA', 'por-defecto'), 'por-defecto');
  assert.equal(config.opcional('NO_EXISTE_NUNCA'), undefined);
});

test('interruptores: esPrueba, simulando y simularFallo (este solo cuenta en modo prueba)', () => {
  assert.equal(config.esPrueba(), false);
  assert.equal(config.simulando(), false);
  assert.equal(config.simularFallo(), false);
  process.env.ALTAVOZ_SIMULAR = '1';
  process.env.ALTAVOZ_SIMULAR_FALLO = '1';
  assert.equal(config.simulando(), true);
  assert.equal(config.simularFallo(), false, 'sin TRAMITACION_PRUEBA=1 el fallo simulado se ignora');
  process.env.TRAMITACION_PRUEBA = '1';
  assert.equal(config.esPrueba(), true);
  assert.equal(config.simularFallo(), true);
  process.env.TRAMITACION_PRUEBA = '0';
  assert.equal(config.esPrueba(), false);
  process.env.ALTAVOZ_SIMULAR = '0';
  assert.equal(config.simulando(), false);
});

test('falloSimulado: «1» = caído, «adjuntos» = rechazo por adjuntos; solo en modo prueba y nada más vale', () => {
  assert.equal(config.falloSimulado(), null);
  process.env.ALTAVOZ_SIMULAR_FALLO = '1';
  assert.equal(config.falloSimulado(), null, 'sin TRAMITACION_PRUEBA=1 se ignora (en producción nunca hay fallo simulado)');
  process.env.ALTAVOZ_SIMULAR_FALLO = 'adjuntos';
  assert.equal(config.falloSimulado(), null);
  assert.equal(config.simularFallo(), false);
  process.env.TRAMITACION_PRUEBA = '1';
  assert.equal(config.falloSimulado(), 'adjuntos');
  assert.equal(config.simularFallo(), false, 'el rechazo por adjuntos NO es Altavoz caído');
  process.env.ALTAVOZ_SIMULAR_FALLO = '1';
  assert.equal(config.falloSimulado(), 'caido');
  assert.equal(config.simularFallo(), true);
  for (const otro of ['0', '', 'si', 'ADJUNTOS', 'caido', 'true']) {
    process.env.ALTAVOZ_SIMULAR_FALLO = otro;
    assert.equal(config.falloSimulado(), null, JSON.stringify(otro));
  }
  delete process.env.ALTAVOZ_SIMULAR_FALLO;
  assert.equal(config.falloSimulado(), null);
});

test('ADJUNTOS_AVISO: los topes de Altavoz (10 ficheros, 3.000.000 bytes, nombre de 200, seis extensiones) y congelados', () => {
  assert.equal(config.ADJUNTOS_AVISO.max, 10);
  assert.equal(config.ADJUNTOS_AVISO.maxBytes, 3_000_000);
  assert.equal(config.ADJUNTOS_AVISO.maxNombre, 200);
  assert.deepEqual([...config.ADJUNTOS_AVISO.extensiones], ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx']);
  assert.ok(Object.isFrozen(config.ADJUNTOS_AVISO) && Object.isFrozen(config.ADJUNTOS_AVISO.extensiones));
});

test('URLs base: sin barra final, para poder concatenar rutas', () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co//';
  process.env.ALTAVOZ_URL = 'https://altavoz.gruponewenergy.es/';
  process.env.SITIO_URL = 'https://tramitatucontrato.energy';
  assert.equal(config.supabaseUrl(), 'https://x.supabase.co');
  assert.equal(config.altavozUrl(), 'https://altavoz.gruponewenergy.es');
  assert.equal(config.sitioUrl(), 'https://tramitatucontrato.energy');
  assert.throws(() => config.supabaseClave(), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => config.altavozClave(), /ALTAVOZ_API_KEY/);
});

test('secretos: exigen 32 caracteres o más', () => {
  assert.throws(() => config.secretoBandeja(), /BANDEJA_SECRETO/);
  process.env.BANDEJA_SECRETO = 'corto';
  assert.throws(() => config.secretoBandeja(), /al menos 32/);
  process.env.BANDEJA_SECRETO = 'x'.repeat(32);
  assert.equal(config.secretoBandeja(), 'x'.repeat(32));
  process.env.VIGILANTE_SECRETO = 'y'.repeat(31);
  assert.throws(() => config.secretoVigilante(), /al menos 32/);
  process.env.VIGILANTE_SECRETO = 'y'.repeat(40);
  assert.equal(config.secretoVigilante(), 'y'.repeat(40));
});

test('avisoDestino: AVISO_DESTINO para todos, AVISO_DESTINO_MEGA solo para MEGA y solo si existe', () => {
  assert.throws(() => config.avisoDestino('gnew'), /AVISO_DESTINO/);
  process.env.AVISO_DESTINO = 'escaneos@gruponew.energy';
  assert.equal(config.avisoDestino('gnew'), 'escaneos@gruponew.energy');
  assert.equal(config.avisoDestino('mega'), 'escaneos@gruponew.energy', 'sin variable propia, MEGA usa la general');
  process.env.AVISO_DESTINO_MEGA = 'mega@ejemplo.es';
  assert.equal(config.avisoDestino('mega'), 'mega@ejemplo.es');
  assert.equal(config.avisoDestino('gnew'), 'escaneos@gruponew.energy', 'GNEW no cambia');
});

test('BANDEJA_EMAILS: lista en minúsculas, sin vacíos ni repetidos; emailAutorizado ignora mayúsculas y espacios', () => {
  assert.throws(() => config.bandejaEmails(), /BANDEJA_EMAILS/);
  process.env.BANDEJA_EMAILS = ' Ana@Ejemplo.es, luis@ejemplo.es ,, ana@ejemplo.es ';
  assert.deepEqual(config.bandejaEmails(), ['ana@ejemplo.es', 'luis@ejemplo.es']);
  assert.equal(config.emailAutorizado('ANA@ejemplo.es'), true);
  assert.equal(config.emailAutorizado('  luis@ejemplo.es '), true);
  assert.equal(config.emailAutorizado('intruso@ejemplo.es'), false);
  assert.equal(config.emailAutorizado(''), false);
  assert.equal(config.emailAutorizado(undefined), false);
});

test('límites: 15 archivos, 25 MB por archivo, 60 MB por contrato, y el de 25 MB coincide con el bucket del SQL', () => {
  assert.equal(config.LIMITES.maxArchivos, 15);
  assert.equal(config.LIMITES.maxBytesArchivo, 25 * 1024 * 1024);
  assert.equal(config.LIMITES.maxBytesContrato, 60 * 1024 * 1024);
  assert.equal(config.LIMITES.maxBytesJson, 3 * 1024 * 1024);
  assert.equal(config.LIMITES.maxCaracteresFirma, 2 * 1024 * 1024);
  assert.ok(Object.isFrozen(config.LIMITES));
  const sql = leer('supabase/tramitacion.sql');
  const m = sql.match(/values \('tramitaciones', 'tramitaciones', false, (\d+),/);
  assert.ok(m, 'el SQL define el bucket con su límite');
  assert.equal(Number(m[1]), config.LIMITES.maxBytesArchivo, 'el límite por archivo del código es el del bucket');
});

test('tokens: coinciden con los de gnew.html, mega.html y los dos Code.gs', () => {
  const tokenDe = (texto) => texto.match(/FORM_TOKEN\s*=\s*'([^']+)'/)?.[1];
  assert.equal(config.FORM_TOKENS.gnew, 'GNE-2026-w7k4q9x2');
  assert.equal(config.FORM_TOKENS.mega, 'MEGA-2026-h3p8k5z1q6');
  assert.equal(tokenDe(leer('gnew.html')), config.FORM_TOKENS.gnew, 'gnew.html');
  assert.equal(tokenDe(leer('mega.html')), config.FORM_TOKENS.mega, 'mega.html');
  assert.equal(tokenDe(leer('google-apps-script/Code.gs')), config.FORM_TOKENS.gnew, 'Code.gs GNEW');
  assert.equal(tokenDe(leer('google-apps-script-mega/Code.gs')), config.FORM_TOKENS.mega, 'Code.gs MEGA');
});

test('tokenValido: solo el token de ese formulario (el del otro, uno falso o ninguno, no)', () => {
  assert.equal(config.tokenValido('gnew', 'GNE-2026-w7k4q9x2'), true);
  assert.equal(config.tokenValido('mega', 'MEGA-2026-h3p8k5z1q6'), true);
  assert.equal(config.tokenValido('gnew', 'MEGA-2026-h3p8k5z1q6'), false);
  assert.equal(config.tokenValido('mega', 'GNE-2026-w7k4q9x2'), false);
  assert.equal(config.tokenValido('gnew', 'GNE-2026-w7k4q9x'), false);
  assert.equal(config.tokenValido('gnew', ''), false);
  assert.equal(config.tokenValido('gnew', undefined), false);
  assert.equal(config.tokenValido('otro', 'GNE-2026-w7k4q9x2'), false);
  assert.equal(config.tokenValido('constructor', 'x'), false);
  assert.equal(config.tokenValido('__proto__', 'x'), false);
});

test('marcas: nombres de marca para Altavoz, prefijos de referencia, compañía fija de MEGA y colores de cabecera', () => {
  assert.deepEqual([...config.FORMULARIOS], ['gnew', 'mega']);
  assert.equal(config.MARCAS.gnew.marca, 'GNEW');
  assert.equal(config.MARCAS.mega.marca, 'MEGA');
  assert.equal(config.MARCAS.gnew.prefijoRef, 'GNE');
  assert.equal(config.MARCAS.mega.prefijoRef, 'MEGA');
  assert.equal(config.MARCAS.gnew.compania, null);
  assert.equal(config.MARCAS.mega.compania, 'MEGA ENERGIA');
  assert.equal(config.MARCAS.gnew.colores.cabecera, '#094D38');
  assert.equal(config.MARCAS.mega.colores.cabecera, '#0D9488');
  assert.ok(Object.isFrozen(config.MARCAS) && Object.isFrozen(config.MARCAS.gnew) && Object.isFrozen(config.MARCAS.mega.colores));
});

test('cuotas: valores del diseño por defecto y la clave que espera la función SQL', () => {
  assert.deepEqual(config.cuota('iniciar', 'abc'), { clave: 'iniciar:abc', limite: 60, ventanaSeg: 3600 });
  assert.deepEqual(config.cuota('confirmar', 'abc'), { clave: 'confirmar:abc', limite: 120, ventanaSeg: 3600 });
  assert.deepEqual(config.cuota('codigoIp', 'abc'), { clave: 'codigo:abc', limite: 10, ventanaSeg: 3600 });
  assert.deepEqual(config.cuota('codigoEmail', 'a@b.es'), { clave: 'codigo:a@b.es', limite: 5, ventanaSeg: 3600 });
  assert.deepEqual(config.cuota('entrarIp', 'abc'), { clave: 'entrar:abc', limite: 20, ventanaSeg: 3600 });
  assert.throws(() => config.cuota('inventada', 'x'), /desconocida/i);
  assert.throws(() => config.cuota('constructor', 'x'), /desconocida/i);
});

test('cuotas: en modo prueba la clave lleva «pruebas:» y la variable CUOTA_* cambia el límite', () => {
  process.env.TRAMITACION_PRUEBA = '1';
  assert.equal(config.cuota('iniciar', 'abc').clave, 'pruebas:iniciar:abc');
  assert.equal(config.cuota('iniciar', 'abc').limite, 60, 'sin variable, el de siempre');
  process.env.CUOTA_INICIAR_HORA = '3';
  assert.equal(config.cuota('iniciar', 'abc').limite, 3);
  process.env.CUOTA_CODIGO_EMAIL_HORA = '2';
  assert.equal(config.cuota('codigoEmail', 'a@b.es').limite, 2);
  assert.equal(config.cuota('codigoIp', 'x').limite, 10, 'las demás no se tocan');
  // Valores que no sirven se ignoran
  for (const malo of ['0', '-5', 'tres', '3.5', '']) {
    process.env.CUOTA_INICIAR_HORA = malo;
    assert.equal(config.cuota('iniciar', 'abc').limite, 60, `valor ${JSON.stringify(malo)}`);
  }
});

test('cuotas: fuera del modo prueba, ni prefijo «pruebas:» ni cambios por variable', () => {
  process.env.CUOTA_INICIAR_HORA = '3';
  process.env.CUOTA_ENTRAR_IP_HORA = '1';
  assert.deepEqual(config.cuota('iniciar', 'abc'), { clave: 'iniciar:abc', limite: 60, ventanaSeg: 3600 });
  assert.equal(config.cuota('entrarIp', 'abc').limite, 20);
  process.env.TRAMITACION_PRUEBA = '0';
  assert.equal(config.cuota('iniciar', 'abc').clave, 'iniciar:abc');
});
