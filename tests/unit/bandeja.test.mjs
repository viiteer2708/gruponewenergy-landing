// Pruebas de api/_lib/bandeja.js que no necesitan base ni entorno: la regla de «quién ha abierto una ficha» con la marca
// «sin abrir» (16-oct-2026). `vistasDe` arma el `vistas` de la lista y `hayQueApuntarApertura` decide el freno de 15 minutos
// al abrir una ficha; las dos obedecen a lo mismo: una apertura solo cuenta si es MÁS NUEVA que la última `marcada_sin_abrir`.
// Y (16-oct-2026) el «quién» de la bandeja: el nombre que cada persona escribe la primera vez (`actorDe`, `exigirSesion`,
// `ponerNombre`; solo necesitan dos variables de entorno falsas, que la propia prueba pone y quita).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MENSAJES, MINUTOS_ENTRE_APERTURAS, actorDe, exigirSesion, hayQueApuntarApertura, ponerNombre, vistasDe,
} from '../../api/_lib/bandeja.js';
import { NOMBRE_COOKIE, cookieSesion, firmarSesion, verificarSesion } from '../../api/_lib/sesion.js';

const AHORA = Date.UTC(2026, 9, 16, 12, 0, 0); // 16-oct-2026 12:00 UTC
const ANA = 'victor.molins.10+ana@gmail.com';
const BEA = 'victor.molins.10+bea@gmail.com';
const CARLOS = 'victor.molins.10+carlos@gmail.com';

/** Un evento de hace `minutos` minutos. Las listas de abajo van SIEMPRE de más nuevo a más antiguo, como las del servidor. */
const evento = (tipo, actor, minutos) => ({ tipo, actor, creado_en: new Date(AHORA - minutos * 60_000).toISOString() });
const abre = (actor, minutos) => evento('ficha_abierta', actor, minutos);
const marca = (actor, minutos) => evento('marcada_sin_abrir', actor, minutos);
const quien = (vistas) => vistas.map((v) => v.por);

// ---------------------------------------------------------------------------
// vistasDe
// ---------------------------------------------------------------------------

test('vistasDe sin ninguna marca: como siempre (una apertura por persona, la más reciente, de más nueva a más antigua)', () => {
  const vistas = vistasDe([abre(ANA, 5), abre(BEA, 30), abre(ANA, 60), abre(CARLOS, 90)]);
  assert.deepEqual(quien(vistas), [ANA, BEA, CARLOS]);
  assert.equal(vistas[0].en, abre(ANA, 5).creado_en, 'De Ana sale su apertura MÁS reciente, no la de hace 60 min');
  assert.deepEqual(Object.keys(vistas[0]).sort(), ['en', 'por']);
  assert.deepEqual(vistasDe([]), [], 'Nadie la ha abierto: lista vacía, no ausente');
});

test('vistasDe: si la marca es lo más nuevo, nadie la ha abierto', () => {
  assert.deepEqual(vistasDe([marca(ANA, 1), abre(ANA, 5), abre(BEA, 30)]), []);
  assert.deepEqual(vistasDe([marca(BEA, 0)]), [], 'Una marca sola tampoco es una apertura');
});

test('vistasDe: con aperturas DESPUÉS de la marca, solo cuentan esas', () => {
  const vistas = vistasDe([abre(CARLOS, 2), abre(ANA, 4), marca(BEA, 10), abre(BEA, 20), abre(ANA, 30)]);
  assert.deepEqual(quien(vistas), [CARLOS, ANA]);
  assert.equal(vistas[1].en, abre(ANA, 4).creado_en, 'De Ana, su apertura de DESPUÉS de la marca (no la de hace 30 min)');
});

test('vistasDe: una marca que es lo más antiguo deja pasar todas las aperturas', () => {
  assert.deepEqual(quien(vistasDe([abre(ANA, 1), abre(BEA, 2), marca(CARLOS, 50)])), [ANA, BEA]);
});

test('vistasDe: con varias marcas se para en la más nueva', () => {
  const eventos = [abre(ANA, 1), marca(BEA, 5), abre(BEA, 10), marca(CARLOS, 15), abre(CARLOS, 20)];
  assert.deepEqual(quien(vistasDe(eventos)), [ANA]);
  assert.deepEqual(vistasDe([marca(ANA, 1), abre(BEA, 2), marca(BEA, 3)]), [], 'La más nueva manda aunque haya aperturas entre las dos marcas');
});

test('vistasDe: la misma persona antes y después de la marca sale una sola vez, con su apertura de después', () => {
  const vistas = vistasDe([abre(ANA, 3), marca(BEA, 6), abre(ANA, 9)]);
  assert.deepEqual(quien(vistas), [ANA]);
  assert.equal(vistas[0].en, abre(ANA, 3).creado_en);
});

test('vistasDe: como mucho 5 personas, y la marca corta antes del tope', () => {
  const personas = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `victor.molins.10+vistas-${x}@gmail.com`);
  const siete = personas.map((p, i) => abre(p, i + 1));
  assert.deepEqual(quien(vistasDe(siete)), personas.slice(0, 5), 'Siete personas: se quedan las 5 más recientes');
  assert.deepEqual(quien(vistasDe([...siete.slice(0, 3), marca(ANA, 10), ...siete.slice(3)])), personas.slice(0, 3), 'Con la marca después de la tercera, solo esas tres');
});

test('vistasDe: lo que no es una apertura ni una marca no cuenta, y lo que no tiene persona o no es una lista tampoco rompe nada', () => {
  assert.deepEqual(quien(vistasDe([evento('aviso_enviado', BEA, 1), { actor: CARLOS, creado_en: abre(CARLOS, 2).creado_en }, abre(ANA, 3)])), [ANA]);
  assert.deepEqual(quien(vistasDe([abre('', 1), abre(null, 2), abre(42, 3), null, undefined, abre(ANA, 4)])), [ANA]);
  for (const nada of [undefined, null, 'texto', 7, {}]) assert.deepEqual(vistasDe(nada), []);
});

// ---------------------------------------------------------------------------
// hayQueApuntarApertura
// ---------------------------------------------------------------------------

const apunta = (eventos, actor = ANA) => hayQueApuntarApertura(eventos, actor, AHORA);

test('hayQueApuntarApertura: la ventana es de 15 minutos', () => {
  assert.equal(MINUTOS_ENTRE_APERTURAS, 15, 'Los casos de abajo se calculan con 15 minutos');
});

test('hayQueApuntarApertura sin marca: el freno de siempre, por persona', () => {
  assert.equal(apunta([]), true, 'Nadie la ha abierto: se apunta');
  assert.equal(apunta([abre(ANA, 10)]), false, 'Una apertura tuya de hace 10 min frena');
  assert.equal(apunta([abre(ANA, MINUTOS_ENTRE_APERTURAS - 0.01)]), false);
  assert.equal(apunta([abre(ANA, MINUTOS_ENTRE_APERTURAS)]), true, 'A los 15 min justos ya no frena');
  assert.equal(apunta([abre(ANA, 16)]), true, 'Una de hace 16 min no frena');
  assert.equal(apunta([abre(BEA, 1)]), true, 'La de otra persona no cuenta');
  assert.equal(apunta([abre(BEA, 1), abre(ANA, 10)]), false, 'Pero la tuya, detrás de la de otra, sí');
  assert.equal(apunta([abre(BEA, 1), abre(ANA, 20)]), true);
  assert.equal(apunta([evento('aviso_enviado', ANA, 1), evento('tramitada', ANA, 2)]), true, 'Los eventos que no son aperturas no frenan');
});

test('hayQueApuntarApertura tras una marca: se apunta aunque no hayan pasado 15 minutos', () => {
  assert.equal(apunta([marca(BEA, 3), abre(ANA, 5)]), true, 'Marca más nueva que tu apertura de hace 5 min: se apunta');
  assert.equal(apunta([marca(ANA, 1), abre(ANA, 2)]), true, 'Marcada y vuelta a abrir por la misma persona enseguida');
  assert.equal(apunta([marca(BEA, 1)]), true, 'Marca y ninguna apertura tuya');
  assert.equal(apunta([marca(BEA, 1), abre(BEA, 2), abre(CARLOS, 3)]), true, 'Con aperturas de otros detrás de la marca');
  assert.equal(apunta([abre(BEA, 1), marca(CARLOS, 2), abre(ANA, 3)]), true, 'La marca está antes (más nueva) que tu apertura: se apunta');
  assert.equal(apunta([marca(BEA, 1), abre(ANA, 20)]), true);
});

test('hayQueApuntarApertura: una marca ANTERIOR a tu última apertura no cambia nada (sigue el freno)', () => {
  assert.equal(apunta([abre(ANA, 2), marca(BEA, 5)]), false, 'Marcada hace 5 min y vuelta a abrir hace 2: otra apertura no, todavía vale esa');
  assert.equal(apunta([abre(ANA, 20), marca(BEA, 25)]), true, 'Pasados los 15 min, sí');
  assert.equal(apunta([abre(BEA, 1), abre(ANA, 2), marca(CARLOS, 3), abre(ANA, 4)]), false, 'La marca queda detrás de tu apertura más reciente');
});

test('hayQueApuntarApertura: una fecha ilegible no frena (se apunta, como antes)', () => {
  assert.equal(apunta([{ tipo: 'ficha_abierta', actor: ANA, creado_en: 'no es una fecha' }]), true);
  assert.equal(apunta([{ tipo: 'ficha_abierta', actor: ANA, creado_en: null }]), true);
});

// ---------------------------------------------------------------------------
// El «quién» de la bandeja: actorDe, exigirSesion y ponerNombre
// ---------------------------------------------------------------------------

const SECRETO = 'secreto-de-prueba-de-la-bandeja-con-mas-de-32-caracteres';
const CORREO = 'victor.molins.10+nombre@gmail.com';
const CORREO_FUERA = 'victor.molins.10+sin-acceso@gmail.com';

const entornoPrevio = {};
before(() => {
  for (const nombre of ['BANDEJA_SECRETO', 'BANDEJA_EMAILS']) entornoPrevio[nombre] = process.env[nombre];
  process.env.BANDEJA_SECRETO = SECRETO;
  process.env.BANDEJA_EMAILS = `${CORREO}, otro@ejemplo.es`;
});
after(() => {
  for (const [nombre, valor] of Object.entries(entornoPrevio)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

/** Una respuesta de mentira (lo justo de http.ServerResponse) y una petición con esa cookie. */
const respuestaFalsa = () => ({
  statusCode: 200, cabeceras: {}, cuerpo: undefined, headersSent: false,
  setHeader(nombre, valor) { this.cabeceras[nombre.toLowerCase()] = valor; },
  end(texto) { this.cuerpo = texto; this.headersSent = true; },
});
const peticionCon = (valor) => ({ headers: valor === undefined ? {} : { cookie: `${NOMBRE_COOKIE}=${valor}` } });
/** El valor de la cookie que un `Set-Cookie` manda guardar. */
const valorDe = (setCookie) => setCookie.split(';')[0].split('=').slice(1).join('=');

test('actorDe: el nombre de la sesión; sin nombre, el correo (en minúsculas), como antes del nombre', () => {
  assert.equal(actorDe({ email: CORREO, nombre: 'LAURA GARCÍA' }), 'LAURA GARCÍA');
  assert.equal(actorDe({ email: CORREO, nombre: null }), CORREO);
  assert.equal(actorDe({ email: CORREO }), CORREO);
  assert.equal(actorDe({ email: '  Victor.Molins.10+Nombre@GMAIL.com ', nombre: null }), CORREO, 'El correo, normalizado');
  for (const sinNombre of ['', '   ', undefined, 5, [], {}]) assert.equal(actorDe({ email: CORREO, nombre: sinNombre }), CORREO, JSON.stringify(sinNombre));
  assert.equal(actorDe({ email: CORREO, nombre: '  ANA  ' }), 'ANA', 'Sin espacios de los lados');
});

test('actorDe: es el nombre O el correo, nunca los dos juntos ni un formato inventado', () => {
  const quien = actorDe({ email: CORREO, nombre: 'LAURA GARCÍA' });
  assert.ok(!quien.includes('@') && !quien.includes('<') && !quien.includes(CORREO), quien);
  assert.equal(actorDe({ email: CORREO, nombre: null }).includes('LAURA'), false);
});

test('actorDe: una sesión sin correo ni nombre es un fallo de quien llama (lanza, no inventa un actor)', () => {
  for (const mala of [undefined, null, {}, { nombre: null }, { email: '', nombre: '' }, { email: '   ' }, 'texto', 5]) {
    assert.throws(() => actorDe(mala), /sesi/i, JSON.stringify(mala));
  }
});

test('exigirSesion: con nombre devuelve {email, nombre}; con una cookie de antes del nombre, {email, nombre: null}', () => {
  const res = respuestaFalsa();
  assert.deepEqual(exigirSesion(peticionCon(firmarSesion(CORREO, SECRETO, { nombre: 'LAURA GARCÍA' })), res), { email: CORREO, nombre: 'LAURA GARCÍA' });
  assert.deepEqual(exigirSesion(peticionCon(firmarSesion(CORREO, SECRETO)), res), { email: CORREO, nombre: null });
  assert.equal(res.headersSent, false, 'Una sesión buena no toca la respuesta');
});

test('exigirSesion: sin cookie, con una rota o de un correo que ya no tiene acceso → 401 «sesion» y devuelve null', () => {
  for (const [motivo, valor] of [
    ['sin cookie', undefined],
    ['basura', 'esto.no.vale'],
    ['firmada con otro secreto', firmarSesion(CORREO, 'otro-secreto-de-prueba-distinto-y-con-mas-de-32-caracteres', { nombre: 'LAURA' })],
    ['un correo sin acceso (bien firmada y con nombre)', firmarSesion(CORREO_FUERA, SECRETO, { nombre: 'LAURA' })],
  ]) {
    const res = respuestaFalsa();
    assert.equal(exigirSesion(peticionCon(valor), res), null, motivo);
    assert.equal(res.statusCode, 401, motivo);
    assert.deepEqual(JSON.parse(res.cuerpo), { ok: false, codigo: 'sesion', mensaje: MENSAJES.sesion, retryable: false }, motivo);
    assert.equal('set-cookie' in res.cabeceras, valor !== undefined, `${motivo}: se borra la cookie rota solo si había una`);
  }
});

test('ponerNombre: limpia el nombre, firma la cookie con él (365 días nuevos) y responde {ok, email, nombre}', () => {
  const r = ponerNombre({ nombre: '  laura   garcía ' }, { email: CORREO, nombre: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo, { ok: true, email: CORREO, nombre: 'LAURA GARCÍA' });
  const galleta = r.cabeceras['Set-Cookie'];
  assert.ok(galleta.startsWith(`${NOMBRE_COOKIE}=`));
  for (const atributo of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) assert.ok(galleta.split('; ').includes(atributo), `${atributo}: ${galleta}`);
  assert.ok(!galleta.includes('Secure'), 'Sin https no lleva Secure');
  assert.ok(ponerNombre({ nombre: 'ana' }, { email: CORREO }, { https: true }).cabeceras['Set-Cookie'].endsWith('; Secure'));
  const sesion = verificarSesion(valorDe(galleta), SECRETO);
  assert.equal(sesion.email, CORREO);
  assert.equal(sesion.nombre, 'LAURA GARCÍA');
  assert.ok(sesion.exp - Math.floor(Date.now() / 1000) > 364 * 24 * 3600, '365 días nuevos');
  // la cookie nueva pasa por exigirSesion como la de cualquiera
  assert.deepEqual(exigirSesion(peticionCon(valorDe(galleta)), respuestaFalsa()), { email: CORREO, nombre: 'LAURA GARCÍA' });
});

test('ponerNombre: se puede cambiar el nombre (otra persona en el mismo ordenador): la cookie nueva lleva el nombre nuevo', () => {
  const primera = ponerNombre({ nombre: 'laura garcía' }, { email: CORREO, nombre: null });
  const segunda = ponerNombre({ nombre: 'pedro ñandú' }, exigirSesion(peticionCon(valorDe(primera.cabeceras['Set-Cookie'])), respuestaFalsa()));
  assert.equal(segunda.status, 200);
  assert.equal(segunda.cuerpo.nombre, 'PEDRO ÑANDÚ');
  assert.equal(verificarSesion(valorDe(segunda.cabeceras['Set-Cookie']), SECRETO).nombre, 'PEDRO ÑANDÚ');
  assert.equal(verificarSesion(valorDe(primera.cabeceras['Set-Cookie']), SECRETO).nombre, 'LAURA GARCÍA', 'La anterior sigue siendo la que era (se firma otra, no se toca la vieja)');
});

test('ponerNombre: un nombre que no vale → 400 «nombre» con su frase en llano, sin cookie', () => {
  for (const malo of ['', '   ', 'a', 'ana2', 'ana@gmail.com', 'a'.repeat(41), '<b>', undefined, null, 5, ['ana'], { nombre: 'ana' }]) {
    const r = ponerNombre({ nombre: malo }, { email: CORREO, nombre: null });
    assert.equal(r.status, 400, JSON.stringify(malo));
    assert.deepEqual(r.cuerpo, { ok: false, codigo: 'nombre', mensaje: 'Escribe tu nombre (solo letras, de 2 a 40).', retryable: false });
    assert.equal(r.cabeceras, undefined, 'Un fallo no manda cookie');
  }
  for (const sinCuerpo of [undefined, null, [], 'texto', 5]) assert.equal(ponerNombre(sinCuerpo, { email: CORREO }).status, 400, 'Sin un cuerpo con `nombre`');
  assert.equal(MENSAJES.nombre, 'Escribe tu nombre (solo letras, de 2 a 40).');
});

test('ponerNombre: el correo de la cookie nueva es el de la sesión, no el que mande el cliente', () => {
  const r = ponerNombre({ nombre: 'ana', email: 'otro@ejemplo.es' }, { email: CORREO, nombre: null });
  assert.equal(r.cuerpo.email, CORREO);
  assert.equal(verificarSesion(valorDe(r.cabeceras['Set-Cookie']), SECRETO).email, CORREO);
});

test('cookieSesion acepta la cookie con nombre (solo caracteres seguros aunque el nombre lleve tildes y Ñ)', () => {
  const valor = firmarSesion(CORREO, SECRETO, { nombre: 'JOSÉ MARÍA PEÑA NÚÑEZ' });
  assert.doesNotThrow(() => cookieSesion(valor));
});
