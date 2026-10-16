#!/usr/bin/env python3
"""tests/e2e/bandeja.py · La bandeja de backoffice con navegador real (orden 4): acceso con código, lista, ficha,
descargas (una a una y en ZIP), cambio de estado, volver a enviar y las capturas a 390 y 1440 px; (14-oct-2026) quién ha
abierto cada ficha («Sin abrir» solo en las pendientes / «Abierta por …» en la lista y en la ficha: casos 14, 15 y 16); y
(15-oct-2026) el interruptor Tarjetas / Lista y la tabla (caso 17; las capturas de la tabla, en el caso 8); y (16-oct-2026)
«Marcar como sin abrir» (caso 18: devolver una pendiente a «Sin abrir» para que la coja otro compañero) y el NOMBRE de quien entra
(caso 19: cada persona lo escribe la primera vez y es el «quién» de abrir, marcar y tramitar; sin nombre no se apunta ninguna apertura).

Uso (lo normal es `bash tests/e2e/run.sh bandeja`, que arranca el servidor y limpia después):
    python tests/e2e/bandeja.py              todos los casos, en serie
    python tests/e2e/bandeja.py 3 4          solo esos casos

Un solo Chromium, viewport 390×844, `pageerror` y consola vigilados (0 errores inesperados es parte del criterio:
los 401 y 404 que un caso provoca a propósito se anotan con `c.rota(...)`). Altavoz está SIMULADO: el código de acceso
se lee del correo simulado (/__pruebas/correos) y la base se lee por /__pruebas/tramitacion. Las tramitaciones de
partida se crean por HTTP contra el servidor local (iniciar → subir al almacén → confirmar), siempre con prueba=true
y bajo pruebas/. Solo alias de Victor (victor.molins.10+algo@gmail.com).
"""
import base64
import json
import re
import secrets
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

from comun import BASE, FIXTURES, RAIZ, SALIDAS, Caso, datos_formulario, estado_de, esperar_estado

PDF = FIXTURES / 'documento-5-5mb.pdf'
JPG = FIXTURES / 'foto-pequena.jpg'
PNG = FIXTURES / 'firma-pequena.png'

TOKENS = {'gnew': 'GNE-2026-w7k4q9x2', 'mega': 'MEGA-2026-h3p8k5z1q6'}  # los FORM_TOKEN de los html (no son secretos)
ALIAS = re.compile(r'victor\.molins\.10\+[a-z0-9._-]+@gmail\.com')
FUERA = 'victor.molins.10+fuera@gmail.com'  # alias SIN acceso a la bandeja

FRASE_CODIGO = 'Si tu correo tiene acceso, te hemos enviado un código de 6 cifras. Caduca en 10 minutos. Revisa también el spam.'
FRASE_CODIGO_MALO = 'El código no es correcto o ha caducado. Pide uno nuevo.'
FRASE_NOMBRE = 'Escribe tu nombre (solo letras, de 2 a 40).'
FRASE_SESION = 'Tu sesión ha caducado o no es válida. Vuelve a entrar.'

# El nombre con el que entran las sesiones de estos casos (se escribe con POST /api/bandeja/yo): es el «quién» de todo lo que se apunta.
# Los casos que prueban el paso del nombre, o quieren una sesión SIN nombre (como las de antes del nombre), lo piden con `nombre=None`.
NOMBRE_PRUEBA = 'PRUEBA BANDEJA'

# Texto que nunca puede ver backoffice: nada de jerga técnica, de valores vacíos de JavaScript ni de nombres de sistemas
JERGA = re.compile(
    r'undefined|\bnull\b|\bNaN\b|\[object|Invalid Date|\bHTTP\b|\bJSON\b|supabase|altavoz|\btoken\b|\bstack\b|exception|codigo_respuesta|error \d{3}',
    re.I,
)

# Lo que Victor veía CORTADO en la tabla (modo Lista) a 1440 px —«JOSE MANUEL FERNA…», «NET FIJO BOE · …», «ISABEL HER…»—, completo: el caso 8 lo
# deja en las capturas y el caso 17 comprueba que a 1440 px se lee ENTERO (el servidor lo guarda en MAYÚSCULAS; la tarifa, 2.0TD, la pone el formulario)
LARGOS = {'titular': 'Jose Manuel Fernandez', 'compania': 'Net Fijo BOE', 'quien_eres': 'Isabel Hernandez'}

XSS_TITULAR = '<img src=x onerror="window.__xss=1"> Titular & Co <script>window.__xss=2</script>'
XSS_COMERCIAL = '<b onmouseover="window.__xss=3">Comercial</b> "Peligroso"'
XSS_OBSERVACIONES = '<svg onload="window.__xss=4"> línea uno\n<iframe src="javascript:window.__xss=5"></iframe> línea dos'
XSS_DIRECCION = "Calle <u>Rara</u> 1 & 'comillas'"

# El servidor guarda lo que escribe el comercial EN MAYÚSCULAS: `onerror="window.__xss=1"` llega como `ONERROR="WINDOW.__XSS=1"`, que no haría
# nada aunque se colara (JavaScript distingue mayúsculas y `WINDOW` no existe), y entonces «no se ha ejecutado nada» no probaría nada. Por eso
# en los casos de XSS la página tiene un `WINDOW` que ES `window`: si algo se colara y se ejecutara, dejaría `window.__XSS` y se vería.
JS_ALIAS_EN_MAYUSCULAS = 'window.WINDOW = window;'


# ---------------------------------------------------------------------------
# HTTP contra el servidor local (como un navegador, pero sin navegador)
# ---------------------------------------------------------------------------

def http(metodo, ruta, cuerpo=None, cabeceras=None, crudo=None, tipo='application/json', timeout=120):
    """Devuelve (status, cabeceras, bytes) sin lanzar por un 4xx/5xx."""
    url = ruta if ruta.startswith('http') else BASE + ruta
    datos = crudo if crudo is not None else (json.dumps(cuerpo).encode() if cuerpo is not None else None)
    cab = dict(cabeceras or {})
    if datos is not None:
        cab.setdefault('Content-Type', tipo)
    peticion = urllib.request.Request(url, data=datos, method=metodo, headers=cab)
    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def como_json(cuerpo):
    return json.loads(cuerpo.decode('utf-8'))


def correo_con_acceso():
    """El primer correo de BANDEJA_EMAILS en .env.local (un alias de Victor). Nunca se imprime."""
    for linea in (RAIZ / '.env.local').read_text(encoding='utf-8').splitlines():
        if linea.startswith('BANDEJA_EMAILS='):
            correo = linea.split('=', 1)[1].split(',')[0].strip().strip('"\'').lower()
            assert ALIAS.fullmatch(correo), 'BANDEJA_EMAILS debe empezar por un alias de Victor en las pruebas'
            return correo
    raise AssertionError('Falta BANDEJA_EMAILS en .env.local')


EMAIL = correo_con_acceso()


def ultimo_codigo(email):
    """El último código enviado a `email`, leído del correo SIMULADO."""
    st, _, cuerpo = http('GET', '/__pruebas/correos?tipo=codigo_acceso&para=' + urllib.parse.quote(email))
    assert st == 200, f'El gancho de correos dio {st}'
    enviados = sorted(
        (c for c in como_json(cuerpo)['correos'] if c['estado'] == 'enviado' and c.get('cuerpo_texto')),
        key=lambda c: c['enviado_en'], reverse=True,
    )
    assert enviados, 'No hay ningún correo de código simulado para ese alias'
    return re.search(r'es (\d{6})\.', enviados[0]['cuerpo_texto']).group(1)


def codigos_enviados_a(email):
    st, _, cuerpo = http('GET', '/__pruebas/correos?tipo=codigo_acceso&para=' + urllib.parse.quote(email))
    assert st == 200
    return como_json(cuerpo)['correos']


def _cookie_de(cab):
    for valor in cab.get_all('Set-Cookie') or []:
        if valor.startswith('bandeja_sesion='):
            return valor.split(';')[0].split('=', 1)[1]
    raise AssertionError('No ha llegado la cookie de sesión')


def cookie_de_sesion(email=EMAIL, nombre=NOMBRE_PRUEBA):
    """Entra por la API (pide el código, lo lee del correo simulado y lo teclea) y devuelve el valor de la cookie. Con `nombre` (por
    defecto el de las pruebas) escribe también el nombre —POST /api/bandeja/yo— y devuelve la cookie NUEVA, la que lo lleva: es lo que ya
    han hecho las personas de backoffice cuando una página les deja pasar. Con `nombre=None` devuelve la de `entrar`, sin nombre (como las de
    antes del nombre): las páginas mandan a escribirlo."""
    st, _, cuerpo = http('POST', '/api/bandeja/codigo', {'email': email})
    assert st == 200, cuerpo
    st, cab, cuerpo = http('POST', '/api/bandeja/entrar', {'email': email, 'codigo': ultimo_codigo(email)})
    assert st == 200, cuerpo
    valor = _cookie_de(cab)
    if nombre is None:
        return valor
    st, cab, cuerpo = http('POST', '/api/bandeja/yo', {'nombre': nombre}, cabeceras={'Cookie': f'bandeja_sesion={valor}'})
    assert st == 200, cuerpo
    return _cookie_de(cab)


# ---------------------------------------------------------------------------
# Tramitaciones de partida (por HTTP, como las enviaría el formulario)
# ---------------------------------------------------------------------------

def nueva_ref(formulario):
    azar = ''.join(secrets.choice('ABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(6))
    return f"{'GNE' if formulario == 'gnew' else 'MEGA'}-{date.today():%Y%m%d}-{azar}"


def crear(formulario, archivos, extra=None, firma=True, completo=True, hp=''):
    """iniciar → subir cada archivo al almacén → confirmar. `archivos` = [(orden, nombre, bytes)]. Devuelve la referencia."""
    ref = nueva_ref(formulario)
    datos = datos_formulario(formulario, **(extra or {}))
    datos['terminos'] = True
    entrada = {
        'formulario': formulario, 'token': TOKENS[formulario], 'ref': ref, 'ref_anterior': None, 'hp': hp, 'datos': datos,
        'firma': ('data:image/png;base64,' + base64.b64encode(PNG.read_bytes()).decode()) if firma else '',
        'archivos': [{'orden': o, 'nombre': n, 'tamano': len(b)} for o, n, b in archivos],
    }
    st, _, cuerpo = http('POST', '/api/tramitacion/iniciar', entrada)
    assert st == 200, f'iniciar dio {st}: {cuerpo[:200]}'
    if hp or not completo:
        return ref
    for subida in como_json(cuerpo)['subidas']:
        datos_archivo = next(b for o, _, b in archivos if o == subida['orden'])
        st, _, texto = http('PUT', subida['url'], crudo=datos_archivo,
                            cabeceras={'Content-Type': subida['tipo_mime'], 'x-upsert': 'true', 'Origin': BASE})
        assert 200 <= st < 300, f'La subida dio {st}: {texto[:120]}'
    st, _, cuerpo = http('POST', '/api/tramitacion/confirmar', {'formulario': formulario, 'token': TOKENS[formulario], 'ref': ref})
    assert st == 200 and como_json(cuerpo)['listo'] is True, cuerpo[:200]
    return ref


SEMILLAS = {}  # referencias de las tramitaciones de partida, rellenadas por preparar()


def preparar():
    """Dos contratos recibidos: A (GNEW, con el PDF de 5,5 MB, una foto y un PNG, más la firma) y B (MEGA)."""
    SEMILLAS['A'] = crear('gnew', [(1, 'contrato.pdf', PDF.read_bytes()), (2, 'dni.jpg', JPG.read_bytes()), (3, 'factura.png', PNG.read_bytes())])
    SEMILLAS['B'] = crear('mega', [(1, 'contrato mega.jpg', JPG.read_bytes())])


# ---------------------------------------------------------------------------
# El caso: un contexto de navegador limpio, con ayudas para la bandeja
# ---------------------------------------------------------------------------

class CasoBandeja(Caso):
    def __init__(self, navegador, titulo):
        super().__init__(navegador, titulo)
        self.permite_5xx = False      # un caso que simula un servidor caído (page.route con 503) lo pone a True
        self.respuestas_almacen = []  # peticiones a las URLs firmadas del almacén (para comprobar que no llevan datos)
        self.ctx.on('request', self._peticion_almacen)

    def _peticion_almacen(self, req):
        if (urllib.parse.urlparse(req.url).hostname or '').endswith('.supabase.co') and '/object/sign/' in req.url:
            self.respuestas_almacen.append(req.url)

    # -- navegación ----------------------------------------------------------------------------------
    def con_sesion(self, email=EMAIL, nombre=NOMBRE_PRUEBA):
        """Mete la cookie de una sesión abierta por la API (los casos que no prueban el acceso no repiten el login), con el nombre de las
        pruebas (`nombre=None`: sin nombre, como las sesiones de antes del nombre)."""
        self.ctx.add_cookies([{'name': 'bandeja_sesion', 'value': cookie_de_sesion(email, nombre), 'url': BASE}])

    def ver(self, ruta, selector=None):
        self.page.goto(BASE + ruta, wait_until='load')
        if selector:
            self.page.wait_for_selector(selector)

    def esperar_lista(self):
        """Espera a que la lista termine de cargar (tarjetas o el mensaje de «no hay»)."""
        self.page.wait_for_function("() => { const m = document.getElementById('estadoLista'); return m.hidden || !/Cargando/.test(m.textContent); }")

    def refs_en_lista(self):
        return [a.get_attribute('href').rsplit('/', 1)[1] for a in self.page.locator('a.tarjeta').all()]

    def refs_en_filas(self):
        """Lo mismo que refs_en_lista(), pero con la lista en modo Lista (tabla): las filas son `a.fila`."""
        return [a.get_attribute('href').rsplit('/', 1)[1] for a in self.page.locator('a.fila').all()]

    def elegir_filtro(self, nombre):
        self.page.get_by_role('button', name=nombre, exact=True).click()
        self.esperar_lista()

    def buscar(self, texto):
        self.page.fill('#q', texto)
        self.page.press('#q', 'Enter')
        self.esperar_lista()

    def abrir_ficha(self, ref):
        self.ver(f'/bandeja/c/{ref}', '#ficha:not([hidden])')

    def entrar_por_pantalla(self, email=EMAIL, volver=None, nombre=NOMBRE_PRUEBA):
        """Teclea el correo y el código en la pantalla de acceso (el código se lee del correo simulado) y, después, el nombre en el paso 3
        (con `nombre=None` se queda en ese paso, sin escribirlo)."""
        p = self.page
        p.fill('#email', email)
        p.click('#btnCodigo')
        p.wait_for_selector('#formCodigo:not([hidden])')
        p.fill('#codigo', ultimo_codigo(email))
        p.click('#btnEntrar')
        p.wait_for_selector('#formNombre:not([hidden])')
        if nombre is not None:
            p.fill('#nombre', nombre)
            p.click('#btnNombre')

    # -- comprobaciones ------------------------------------------------------------------------------
    def sin_jerga(self):
        cuerpo = self.page.inner_text('body')
        m = JERGA.search(cuerpo)
        assert not m, f'Texto técnico a la vista: «{m.group(0)}»'

    def sin_desbordes(self, ancho=390):
        mayor = self.page.evaluate('() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)')
        assert mayor <= ancho, f'La página se sale por los lados: {mayor} px en un viewport de {ancho}'

    def comprobar_limpio(self):
        super().comprobar_limpio()
        cincos = [r for r in self.respuestas if r['status'] >= 500]
        assert self.permite_5xx or not cincos, f'Respuestas 5xx de la API: {cincos}'


# ---------------------------------------------------------------------------
# Casos
# ---------------------------------------------------------------------------

def caso_1(c):
    """Sin sesión, /bandeja lleva al acceso (con «volver»); el código llega por correo (simulado), uno malo da su frase en llano, el bueno entra; la cookie es HttpOnly."""
    c.rota('/api/bandeja/')
    p = c.page
    respuesta = p.goto(BASE + '/bandeja', wait_until='load')
    cab = respuesta.headers
    assert 'noindex' in cab.get('x-robots-tag', '') and cab.get('referrer-policy') == 'no-referrer', cab
    # El servidor local sirve los html con `Cache-Control: no-cache` (pisa el de vercel.json); en Vercel valen las reglas de vercel.json:
    reglas = {h['source']: {x['key']: x['value'] for x in h['headers']} for h in json.loads((RAIZ / 'vercel.json').read_text(encoding='utf-8'))['headers']}
    for ruta in ('/bandeja', '/bandeja/:path*'):
        assert reglas[ruta] == {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer'}, (ruta, reglas.get(ruta))
    assert reglas['/api/:path*'] == {'Cache-Control': 'no-store'}
    p.wait_for_url(re.compile(r'/bandeja/entrar\?volver=%2Fbandeja$'))
    assert 'Acceso a la bandeja de tramitación' in p.inner_text('h1')
    assert p.is_visible('#formCorreo') and not p.is_visible('#formCodigo')
    c.sin_desbordes()

    # un correo que no es un correo no llega al servidor
    p.fill('#email', 'esto-no-es-un-correo')
    p.click('#btnCodigo')
    assert p.inner_text('#errorCorreo') == 'Escribe un correo electrónico válido.'
    assert not [r for r in c.respuestas if r['ruta'].endswith('/codigo')]

    # el correo bueno: la misma frase de siempre y el formulario del código
    p.fill('#email', EMAIL)
    p.click('#btnCodigo')
    p.wait_for_selector('#formCodigo:not([hidden])')
    assert p.inner_text('#avisoCodigo') == FRASE_CODIGO
    assert p.is_hidden('#formCorreo')
    real = ultimo_codigo(EMAIL)

    # un código que no es: su frase, y la pantalla sigue ahí
    malo = '000000' if real != '000000' else '111111'
    p.fill('#codigo', malo)
    p.click('#btnEntrar')
    p.wait_for_selector('#errorCodigo:not([hidden])')
    assert p.inner_text('#errorCodigo') == FRASE_CODIGO_MALO
    assert '/bandeja/entrar' in p.url
    # lo que no tiene 6 cifras ni sale del navegador
    antes = len([r for r in c.respuestas if r['ruta'].endswith('/entrar')])
    p.fill('#codigo', '123')
    p.click('#btnEntrar')
    assert p.inner_text('#errorCodigo') == 'El código tiene 6 cifras.'
    assert len([r for r in c.respuestas if r['ruta'].endswith('/entrar')]) == antes

    # el bueno (con un espacio en medio, como lo agrupan algunos teclados) abre la puerta, pero falta decir QUIÉN es (paso 3: el nombre)
    p.fill('#codigo', real[:3] + ' ' + real[3:])
    p.click('#btnEntrar')
    p.wait_for_selector('#formNombre:not([hidden])')
    assert p.is_hidden('#formCodigo') and p.is_hidden('#formCorreo')
    assert '/bandeja/entrar' in p.url, 'Todavía no ha entrado en la bandeja: falta el nombre'
    assert p.inner_text('label[for="nombre"]') == '¿Cómo te llamas?'
    assert p.inner_text('#ayudaNombre') == 'Así el equipo sabe quién ha abierto cada contrato. Si hay otro compañero con tu nombre, añade el apellido.'
    assert p.get_attribute('#nombre', 'placeholder') == 'Ej.: LAURA GARCÍA' and p.get_attribute('#nombre', 'autocapitalize') == 'characters'
    assert p.evaluate("() => getComputedStyle(document.getElementById('nombre')).fontSize") == '16px', 'A 16 px el móvil no hace zoom al escribir'
    assert p.inner_text('#btnNombre') == 'Guardar y entrar'
    c.sin_jerga()
    c.sin_desbordes()
    # un nombre que no vale (vacío, de una letra, con cifras o con @) no entra: su frase en llano y la pantalla sigue ahí
    for malo in ['', 'a', 'Juan2', 'ana@gmail.com']:
        p.fill('#nombre', malo)
        p.click('#btnNombre')
        p.wait_for_selector('#errorNombre:not([hidden])')
        assert p.inner_text('#errorNombre') == FRASE_NOMBRE, malo
        assert '/bandeja/entrar' in p.url and p.is_visible('#formNombre')
    # el bueno se guarda en MAYÚSCULAS y entra, volviendo a donde iba
    p.fill('#nombre', 'laura garcía')
    p.click('#btnNombre')
    p.wait_for_url(BASE + '/bandeja')
    p.wait_for_selector('a.tarjeta')
    p.wait_for_function("() => document.getElementById('correo').textContent.length > 0")
    assert p.inner_text('#correo') == EMAIL
    assert p.inner_text('#nombre') == 'LAURA GARCÍA', 'La cabecera enseña el nombre, y el correo detrás'

    # la cookie: HttpOnly (el JavaScript no la ve), SameSite=Lax y para toda la web
    galletas = [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion']
    assert len(galletas) == 1, galletas
    g = galletas[0]
    assert g['httpOnly'] is True and g['sameSite'] == 'Lax' and g['path'] == '/' and g['secure'] is False, g
    assert 'bandeja_sesion' not in p.evaluate('() => document.cookie')
    c.sin_jerga()


def caso_2(c):
    """Un correo SIN acceso ve exactamente lo mismo que uno con acceso, no recibe ningún correo y con ningún código entra; «Usar otro correo» vuelve atrás."""
    c.rota('/api/bandeja/')
    p = c.page
    c.ver('/bandeja/entrar', '#formCorreo')
    p.fill('#email', FUERA)
    p.click('#btnCodigo')
    p.wait_for_selector('#formCodigo:not([hidden])')
    assert p.inner_text('#avisoCodigo') == FRASE_CODIGO, 'La misma frase que si tuviera acceso'
    assert codigos_enviados_a(FUERA) == [], 'Y ningún correo sale'
    p.fill('#codigo', '123456')
    p.click('#btnEntrar')
    p.wait_for_selector('#errorCodigo:not([hidden])')
    assert p.inner_text('#errorCodigo') == FRASE_CODIGO_MALO
    assert '/bandeja/entrar' in p.url
    assert not [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion']
    p.get_by_role('button', name='Usar otro correo', exact=True).click()
    assert p.is_visible('#formCorreo') and p.is_hidden('#formCodigo')
    c.sin_jerga()


def caso_3(c):
    """La lista: tarjetas con su contenido, filtros (Pendientes, Tramitadas, Incompletas, Todas, Descartadas bajo «Más»), búsqueda y «Cargar más»."""
    ref_a, ref_b = SEMILLAS['A'], SEMILLAS['B']
    ref_c = crear('gnew', [(1, 'pendiente.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra={'titular': 'Titular Subiendo SL'}, completo=False)  # Incompletas
    ref_d = crear('gnew', [(1, 'bot.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra={'titular': 'Titular Bot SL'}, hp='soy un robot')  # Descartadas
    c.con_sesion()
    p = c.page
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    assert 'Tramitaciones' in p.inner_text('h1')
    assert p.get_attribute('#q', 'placeholder') == 'Buscar por titular, CUPS, referencia o comercial'
    assert p.get_by_role('button', name='Pendientes', exact=True).get_attribute('aria-pressed') == 'true'

    # Pendientes (por defecto): A y B, de más reciente a más antigua, sin las incompletas ni las descartadas
    refs = c.refs_en_lista()
    assert ref_a in refs and ref_b in refs and ref_c not in refs and ref_d not in refs, refs
    assert refs.index(ref_b) < refs.index(ref_a), 'Más recientes primero'
    tarjeta_a = p.locator(f'a.tarjeta[href$="{ref_a}"]')
    texto = tarjeta_a.inner_text()
    # (lo que escribe el comercial sale en MAYÚSCULAS, como se guarda; las etiquetas de la tarjeta, como siempre)
    for esperado in ['TITULAR DE PRUEBA SL', 'Pendiente', 'GNEW', 'COMPAÑÍA DE PRUEBA · 2.0TD', 'ES0021000000000001RK', 'Comercial: COMERCIAL DE PRUEBA', '4 documentos']:
        assert esperado in texto, f'Falta «{esperado}» en la tarjeta: {texto!r}'
    assert re.search(r'hace (unos segundos|\d+ min)', texto), texto
    assert tarjeta_a.get_attribute('href') == f'/bandeja/c/{ref_a}'
    assert 'MEGA' in p.locator(f'a.tarjeta[href$="{ref_b}"]').inner_text() and '2 documentos' in p.locator(f'a.tarjeta[href$="{ref_b}"]').inner_text()
    c.sin_jerga()
    c.sin_desbordes()

    # los filtros
    c.elegir_filtro('Tramitadas')
    assert ref_a not in c.refs_en_lista()
    assert p.get_by_role('button', name='Tramitadas', exact=True).get_attribute('aria-pressed') == 'true'
    assert p.get_by_role('button', name='Pendientes', exact=True).get_attribute('aria-pressed') == 'false'
    c.elegir_filtro('Incompletas')
    assert ref_c in c.refs_en_lista() and ref_a not in c.refs_en_lista()
    assert 'Subiendo' in p.locator(f'a.tarjeta[href$="{ref_c}"]').inner_text()
    c.elegir_filtro('Todas')
    todas = c.refs_en_lista()
    assert ref_a in todas and ref_b in todas and ref_c in todas and ref_d not in todas, 'Todas no incluye las descartadas'
    assert p.is_hidden('#chipDescartadas')
    p.get_by_role('button', name='Más', exact=True).click()
    assert p.is_visible('#chipDescartadas')
    c.elegir_filtro('Descartadas')
    assert ref_d in c.refs_en_lista()
    assert 'Descartada' in p.locator(f'a.tarjeta[href$="{ref_d}"]').inner_text()
    # el filtro elegido se recuerda al volver desde una ficha
    p.locator(f'a.tarjeta[href$="{ref_d}"]').click()
    p.wait_for_selector('#ficha:not([hidden])')
    p.get_by_role('link', name='Volver a las tramitaciones').click()
    p.wait_for_url(re.compile(r'/bandeja$'))
    c.esperar_lista()
    assert p.get_by_role('button', name='Descartadas', exact=True).get_attribute('aria-pressed') == 'true'
    c.elegir_filtro('Pendientes')

    # la búsqueda: titular, CUPS, referencia, comercial y compañía; sin tildes ni mayúsculas; varias palabras en cualquier orden
    for consulta, debe, no_debe in [
        ('titular mega', [ref_b], [ref_a]),
        ('ES0021000000000001rk', [ref_a, ref_b], []),
        (ref_a, [ref_a], [ref_b]),
        ('prueba titular', [ref_a, ref_b], []),
        ('comercial de prueba', [ref_a, ref_b], []),
        ('COMPAÑÍA', [ref_a], [ref_b]),
        ('mega energia', [ref_b], [ref_a]),
    ]:
        c.buscar(consulta)
        encontradas = c.refs_en_lista()
        assert all(r in encontradas for r in debe), f'«{consulta}» debería traer {debe}: {encontradas}'
        assert not any(r in encontradas for r in no_debe), f'«{consulta}» no debería traer {no_debe}: {encontradas}'
    c.buscar('zzzinexistente')
    assert p.inner_text('#estadoLista') == 'No hay tramitaciones que coincidan.'
    assert p.locator('a.tarjeta').count() == 0
    c.buscar('')
    assert ref_a in c.refs_en_lista()

    # «Cargar más»: con una respuesta con `siguiente` y una página más (sin tener 31 contratos de verdad en la base)
    visto = {'antes': None}

    def paginar(route, request):
        url = urllib.parse.urlparse(request.url)
        consulta = urllib.parse.parse_qs(url.query)
        if 'antes' in consulta:
            visto['antes'] = consulta['antes'][0]
            falsa = {'ref': 'GNE-20260101-PAGINA', 'formulario': 'gnew', 'estado': 'recibida', 'compania': 'Compañía de otra página', 'titular_nombre': 'Titular de la segunda página',
                     'cups': 'ES0021000000000001RK', 'comercial_nombre': 'Comercial', 'tarifa': '2.0TD', 'creada_en': '2026-01-01T10:00:00.000000+00:00',
                     'recibida_en': '2026-01-01T10:00:00.000000+00:00', 'n_documentos': 1, 'vistas': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'items': [falsa], 'siguiente': None}))
        else:
            real = route.fetch()
            cuerpo = real.json()
            cuerpo['siguiente'] = '2026-10-09T20:11:12.123456+00:00'
            route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/lista**', paginar)
    c.elegir_filtro('Todas')
    assert p.is_visible('#mas'), '«Cargar más» aparece cuando hay página siguiente'
    antes_n = p.locator('a.tarjeta').count()
    p.get_by_role('button', name='Cargar más', exact=True).click()
    p.wait_for_function(f"() => document.querySelectorAll('a.tarjeta').length === {antes_n + 1}")
    assert visto['antes'] == '2026-10-09T20:11:12.123456+00:00', f'El cursor viaja entero (con el +): {visto["antes"]!r}'
    assert 'Titular de la segunda página' in p.inner_text('#lista')
    assert p.is_hidden('#mas'), 'Sin siguiente, el botón desaparece'
    p.unroute('**/api/bandeja/lista**')
    c.sin_jerga()


def caso_4(c):
    """La ficha de A: todos los datos (IBAN completo), documentos; «Ver» abre 200, «Descargar» baja el archivo con su nombre y «Descargar todo (ZIP)» da un ZIP válido."""
    ref = SEMILLAS['A']
    c.con_sesion()
    p = c.page
    c.ver('/bandeja', 'a.tarjeta')
    p.locator(f'a.tarjeta[href$="{ref}"]').click()  # se llega a la ficha desde la lista
    p.wait_for_selector('#ficha:not([hidden])')
    assert p.url == f'{BASE}/bandeja/c/{ref}'
    assert p.inner_text('#ref') == ref
    assert 'Pendiente' in p.inner_text('#insignias') and 'GNEW' in p.inner_text('#insignias')
    cuerpo = p.inner_text('#ficha')
    for esperado in ['COMERCIAL', 'CONTRATO', 'TITULAR', 'SUMINISTRO', 'CONTACTO', 'CAMBIO DE TITULAR', 'OBSERVACIONES', 'DOCUMENTOS (4)', 'CORREOS', 'HISTORIAL',
                     'COMERCIAL DE PRUEBA', 'victor.molins.10+comercial@gmail.com', 'COMPAÑÍA DE PRUEBA', 'ES0021000000000001RK', 'FIJO 12 MESES', '2.0TD',
                     'P1: 4.6 kW · P2: 4.6 kW', 'TITULAR DE PRUEBA SL', '00000000T', 'FIRMANTE DE PRUEBA', '12345678Z',
                     'ES91 2100 0418 4502 0005 1332',  # el IBAN COMPLETO (para backoffice), en grupos de cuatro
                     'CALLE DE PRUEBA 1, 2.º A', '28001', 'MADRID', '600000000', 'victor.molins.10+cliente@gmail.com', 'PRUEBA AUTOMÁTICA DE TRAMITACIÓN V2']:
        assert esperado in cuerpo, f'Falta «{esperado}» en la ficha'
    # Con el contenido en MAYÚSCULAS, «COMERCIAL» o «TITULAR» ya salen en cualquier valor («COMERCIAL DE PRUEBA»): los títulos de las secciones, aparte
    assert [x.inner_text() for x in p.locator('#colDatos h2').all()] == ['COMERCIAL', 'CONTRATO', 'TITULAR', 'SUMINISTRO', 'CONTACTO', 'CAMBIO DE TITULAR', 'OBSERVACIONES']
    assert 'ES9121000418450200051332' not in p.url
    assert p.get_attribute('#irDocs', 'href') == '#bloqueDocs'
    nombres = [x.inner_text() for x in p.locator('.doc-nombre').all()]
    assert nombres == ['firma.png', 'contrato.pdf', 'dni.jpg', 'factura.png'], nombres
    c.sin_jerga()
    c.sin_desbordes()

    # «Ver»: se abre en una pestaña nueva y la URL firmada responde 200 (con una imagen que se ve de verdad)
    fila_foto = p.locator('li.doc', has_text='dni.jpg')
    enlace_ver = fila_foto.get_by_role('link', name='Ver', exact=True)
    assert enlace_ver.get_attribute('target') == '_blank' and 'noopener' in enlace_ver.get_attribute('rel')
    href = enlace_ver.get_attribute('href')
    with c.ctx.expect_page() as nueva:
        enlace_ver.click()
    popup = nueva.value
    popup.wait_for_load_state('load')
    assert '/storage/v1/object/sign/tramitaciones/pruebas/gnew/' in popup.url, popup.url
    assert popup.evaluate('() => document.images.length > 0 && document.images[0].naturalWidth > 0'), 'La imagen no se ve en la pestaña nueva'
    popup.close()
    for fila, etiqueta, tipo_esperado, bytes_esperados in [(fila_foto, 'dni.jpg', 'image/jpeg', JPG.stat().st_size),
                                                           (p.locator('li.doc', has_text='contrato.pdf'), 'contrato.pdf', 'application/pdf', PDF.stat().st_size)]:
        url = fila.get_by_role('link', name='Ver', exact=True).get_attribute('href')
        r = c.ctx.request.get(url)
        assert r.status == 200, f'«Ver» {etiqueta}: {r.status}'
        assert r.headers['content-type'].startswith(tipo_esperado), r.headers['content-type']
        assert len(r.body()) == bytes_esperados, f'«Ver» {etiqueta}: {len(r.body())} bytes'
    # el nombre del archivo y el IBAN no viajan en ninguna URL: ni en los enlaces de la página ni en la barra de direcciones
    enlaces = p.locator('li.doc a').evaluate_all('els => els.map(e => e.href)')
    assert len(enlaces) == 4 and all('/object/sign/tramitaciones/pruebas/gnew/' in u and re.search(r'/0\d\.(png|pdf|jpg)\?token=', u) for u in enlaces), enlaces
    assert href in enlaces
    for url in enlaces + [p.url]:
        assert not re.search(r'contrato|dni|factura|firma\.png|ES91|victor\.molins', url, re.I), f'Datos en una URL: {url[:90]}'

    with tempfile.TemporaryDirectory() as carpeta:
        # «Descargar» uno a uno, con su nombre bonito
        for nombre, original in [('dni.jpg', JPG), ('contrato.pdf', PDF), ('factura.png', PNG)]:
            boton = p.locator('li.doc', has_text=nombre).get_by_role('button', name='Descargar', exact=True)
            with p.expect_download(timeout=90_000) as bajada:
                boton.click()
            descarga = bajada.value
            assert descarga.suggested_filename == nombre, descarga.suggested_filename
            destino = Path(carpeta) / nombre
            descarga.save_as(str(destino))
            assert destino.read_bytes() == original.read_bytes(), f'{nombre}: el archivo bajado no es el original'

        # «Descargar todo (ZIP)»
        with p.expect_download(timeout=120_000) as bajada:
            p.get_by_role('button', name='Descargar todo (ZIP)', exact=True).click()
        descarga = bajada.value
        assert descarga.suggested_filename == f'{ref} - TITULAR DE PRUEBA SL.zip', descarga.suggested_filename
        zip_ruta = Path(carpeta) / 'bandeja.zip'
        descarga.save_as(str(zip_ruta))
        prueba = subprocess.run(['python3', '-m', 'zipfile', '-t', str(zip_ruta)], capture_output=True, text=True)
        assert prueba.returncode == 0 and 'Done testing' in prueba.stdout, prueba.stdout + prueba.stderr
        with zipfile.ZipFile(zip_ruta) as z:
            assert z.testzip() is None
            assert z.namelist() == ['00-firma.png', '01-contrato.pdf', '02-dni.jpg', '03-factura.png'], z.namelist()
            assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()), 'El ZIP es «stored»'
            assert z.read('00-firma.png') == PNG.read_bytes() and z.read('03-factura.png') == PNG.read_bytes()
            assert z.read('02-dni.jpg') == JPG.read_bytes()
            assert z.read('01-contrato.pdf') == PDF.read_bytes()
    assert p.get_by_role('button', name='Descargar todo (ZIP)', exact=True).is_enabled(), 'El botón vuelve a su texto'
    for url in c.respuestas_almacen:
        assert not re.search(r'contrato|dni|factura|firma\.png|ES91|victor\.molins', url, re.I), 'Ninguna descarga lleva el nombre del archivo en la URL'
    c.sin_jerga()


def caso_5(c):
    """Marcar como tramitada (con confirmación) y Volver a pendiente: insignia, línea «Tramitada por …», botón, base y lista."""
    ref = SEMILLAS['B']
    c.con_sesion()
    p = c.page
    c.abrir_ficha(ref)
    assert 'Pendiente' in p.inner_text('#insignias')
    assert p.is_hidden('#tramitadaPor') and p.is_hidden('#confirmar')

    # cancelar no cambia nada
    p.get_by_role('button', name='Marcar como tramitada', exact=True).click()
    assert p.is_visible('#confirmar') and p.inner_text('#confirmarTexto') == '¿Marcar esta tramitación como tramitada?'
    p.get_by_role('button', name='Cancelar', exact=True).click()
    assert p.is_hidden('#confirmar') and p.get_by_role('button', name='Marcar como tramitada', exact=True).is_visible()
    assert estado_de(ref)['tramitacion']['estado'] == 'recibida'

    # confirmar: la insignia, la línea de quién y cuándo, y el botón contrario
    p.get_by_role('button', name='Marcar como tramitada', exact=True).click()
    p.screenshot(path=str(SALIDAS / 'bandeja-ficha-confirmar-390.png'), full_page=False)
    p.get_by_role('button', name='Sí, marcar como tramitada', exact=True).click()
    p.wait_for_function("() => /Tramitada/.test(document.getElementById('insignias').textContent)")
    p.wait_for_selector('#tramitadaPor:not([hidden])')
    linea = p.inner_text('#tramitadaPor')
    assert re.fullmatch(rf'Tramitada por {re.escape(NOMBRE_PRUEBA)} el \d{{1,2}}-\d{{1,2}}-\d{{4}} a las \d{{2}}:\d{{2}}', linea), linea
    assert p.inner_text('#okAccion') == 'Marcada como tramitada.'
    assert p.get_by_role('button', name='Volver a pendiente', exact=True).is_visible()
    assert p.get_by_role('button', name='Marcar como tramitada', exact=True).count() == 0
    e = estado_de(ref)
    assert e['tramitacion']['estado'] == 'tramitada' and e['tramitacion']['tramitada_por'] == NOMBRE_PRUEBA and e['tramitacion']['tramitada_en']
    assert [x['actor'] for x in e['eventos'] if x['tipo'] == 'tramitada'] == [NOMBRE_PRUEBA]
    assert 'Marcada como tramitada por ' + NOMBRE_PRUEBA in p.inner_text('#bloqueHistorial')

    # la lista lo refleja: ya no está en Pendientes y sí en Tramitadas
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    c.elegir_filtro('Pendientes')
    assert ref not in c.refs_en_lista()
    c.elegir_filtro('Tramitadas')
    assert ref in c.refs_en_lista() and 'Tramitada' in p.locator(f'a.tarjeta[href$="{ref}"]').inner_text()

    # volver a pendiente
    c.abrir_ficha(ref)
    p.get_by_role('button', name='Volver a pendiente', exact=True).click()
    assert p.inner_text('#confirmarTexto') == '¿Volver a poner esta tramitación como pendiente?'
    p.get_by_role('button', name='Sí, volver a pendiente', exact=True).click()
    p.wait_for_function("() => /Pendiente/.test(document.getElementById('insignias').textContent)")
    assert p.is_hidden('#tramitadaPor')
    assert p.get_by_role('button', name='Marcar como tramitada', exact=True).is_visible()
    assert p.inner_text('#okAccion') == 'Vuelve a estar pendiente.'
    e = estado_de(ref)
    assert e['tramitacion']['estado'] == 'recibida' and e['tramitacion']['tramitada_por'] is None and e['tramitacion']['tramitada_en'] is None
    assert [x['actor'] for x in e['eventos'] if x['tipo'] == 'reabierta'] == [NOMBRE_PRUEBA]

    # alguien se adelantó (la tramitó desde otra pestaña): la página lo dice en llano y se pone al día
    http_estado = lambda accion: http('POST', '/api/bandeja/estado', {'ref': ref, 'accion': accion}, cabeceras={'Cookie': f'bandeja_sesion={cookie_de_sesion()}'})
    p.get_by_role('button', name='Marcar como tramitada', exact=True).click()
    st, _, _ = http_estado('tramitar')
    assert st == 200
    c.rota('/api/bandeja/estado')
    p.get_by_role('button', name='Sí, marcar como tramitada', exact=True).click()
    p.wait_for_selector('#errorAccion:not([hidden])')
    assert p.inner_text('#errorAccion') == 'Esta tramitación ya no está como creías. Recarga la página para ver cómo está ahora.'
    p.wait_for_function("() => /Tramitada/.test(document.getElementById('insignias').textContent)")
    assert p.get_by_role('button', name='Volver a pendiente', exact=True).is_visible()
    http_estado('reabrir')
    c.sin_jerga()


def caso_6(c):
    """Correos de la ficha: «enviado a las HH:MM», «Volver a enviar» (con su evento) y, con Altavoz caído, «pendiente (se reintenta solo)»; y las frases del historial para los eventos de adjuntos."""
    ref = SEMILLAS['A']
    c.con_sesion()
    p = c.page
    c.abrir_ficha(ref)
    bloque = p.locator('#bloqueCorreos')
    texto = bloque.inner_text()
    assert re.search(r'Aviso a tramitación: enviado a las \d{2}:\d{2}', texto), texto
    assert re.search(r'Acuse al comercial: enviado a las \d{2}:\d{2}', texto), texto
    antes = estado_de(ref)
    aviso_antes = [x for x in antes['correos'] if x['tipo'] == 'aviso'][0]
    bloque.locator('.correo').nth(0).get_by_role('button', name='Volver a enviar', exact=True).click()
    p.wait_for_selector('.correo-resultado')
    assert p.inner_text('.correo-resultado') == 'Correo enviado.'
    despues = estado_de(ref)
    aviso = [x for x in despues['correos'] if x['tipo'] == 'aviso'][0]
    assert aviso['estado'] == 'enviado' and aviso['intentos'] == 1 and aviso['altavoz_id'] != aviso_antes['altavoz_id']
    nuevos = despues['eventos'][len(antes['eventos']):]
    assert [(x['tipo'], x['actor']) for x in nuevos] == [('aviso_reenviado', NOMBRE_PRUEBA), ('aviso_enviado', NOMBRE_PRUEBA)], nuevos
    assert 'Aviso reenviado por ' + NOMBRE_PRUEBA in p.inner_text('#bloqueHistorial')

    # con Altavoz caído el acuse no sale: pendiente, con su explicación, y sin ningún mensaje técnico
    http('POST', '/__pruebas/altavoz', {'caido': True})
    try:
        bloque.locator('.correo').nth(1).get_by_role('button', name='Volver a enviar', exact=True).click()
        p.wait_for_function("() => /pendiente \\(se reintenta solo\\)/.test(document.getElementById('bloqueCorreos').textContent)")
    finally:
        http('POST', '/__pruebas/altavoz', {'caido': False})
    texto = bloque.inner_text()
    assert 'Acuse al comercial: pendiente (se reintenta solo)' in texto, texto
    assert 'El correo no ha podido salir ahora; se reintentará solo.' in texto
    acuse = [x for x in estado_de(ref)['correos'] if x['tipo'] == 'acuse'][0]
    assert acuse['estado'] == 'pendiente' and acuse['intentos'] == 1
    # y al volver Altavoz, otro «Volver a enviar» lo deja enviado
    bloque.locator('.correo').nth(1).get_by_role('button', name='Volver a enviar', exact=True).click()
    p.wait_for_function("() => /Acuse al comercial: enviado a las/.test(document.getElementById('bloqueCorreos').textContent)")
    c.sin_jerga()

    # Los dos eventos de los adjuntos (solo aparecen cuando algo falla; aquí se añaden a la respuesta de la ficha, sin estropear el
    # almacén): frases en llano, no «Cambio registrado». Va DESPUÉS de sin_jerga(): la de `adjuntos_rechazados` nombra a Altavoz
    # (así está pedida) y el regex JERGA de este fichero no admite ese nombre en un texto que ve backoffice.
    def con_eventos_de_adjuntos(route, request):
        real = route.fetch()
        cuerpo = real.json()
        momento = cuerpo['eventos'][-1]['creado_en']
        cuerpo['eventos'] += [
            {'tipo': 'adjuntos_no_descargados', 'actor': 'sistema', 'detalle': {'n': 1, 'ordenes': [2], 'causas': ['tiempo']}, 'creado_en': momento},
            {'tipo': 'adjuntos_rechazados', 'actor': 'sistema', 'detalle': {'http': 422, 'n': 3}, 'creado_en': momento},
        ]
        route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/ficha**', con_eventos_de_adjuntos)
    c.abrir_ficha(ref)
    historial = p.inner_text('#bloqueHistorial')
    assert 'Algún documento no se pudo adjuntar al aviso; está en la bandeja' in historial, historial
    assert 'Altavoz no aceptó los adjuntos: el aviso salió sin ellos; los documentos están en la bandeja' in historial, historial
    assert 'Cambio registrado' not in historial, historial
    p.unroute('**/api/bandeja/ficha**')


def caso_7(c):
    """Un enlace directo a una ficha, sin sesión, lleva al acceso; tras entrar se vuelve a ESA ficha. Un «volver» que no es de la bandeja se ignora."""
    ref = SEMILLAS['A']
    c.rota('/api/bandeja/')
    p = c.page
    p.goto(BASE + f'/bandeja/c/{ref}', wait_until='load')
    p.wait_for_url(re.compile(r'/bandeja/entrar\?volver=%2Fbandeja%2Fc%2F' + re.escape(ref) + '$'))
    c.entrar_por_pantalla()
    p.wait_for_url(f'{BASE}/bandeja/c/{ref}')
    p.wait_for_selector('#ficha:not([hidden])')
    assert p.inner_text('#ref') == ref
    c.sin_jerga()

    # «volver» solo vale si es una página de la bandeja: nunca otra web ni una dirección sin esquema
    for peligro in ['https://evil.example/robo', '//evil.example/robo', '/otra-cosa', '/bandejaX', '/bandeja/../gnew', 'javascript:alert(1)']:
        c.ctx.clear_cookies()
        p.goto(BASE + '/bandeja/entrar?volver=' + urllib.parse.quote(peligro, safe=''), wait_until='load')
        c.entrar_por_pantalla()
        p.wait_for_url(BASE + '/bandeja')
        assert p.url == BASE + '/bandeja', f'«{peligro}» no puede sacar de la bandeja'
    # y uno bueno con parámetros sí se respeta
    c.ctx.clear_cookies()
    p.goto(BASE + '/bandeja/entrar?volver=' + urllib.parse.quote('/bandeja?estado=tramitadas', safe=''), wait_until='load')
    c.entrar_por_pantalla()
    p.wait_for_url(BASE + '/bandeja?estado=tramitadas')
    c.esperar_lista()
    assert p.get_by_role('button', name='Tramitadas', exact=True).get_attribute('aria-pressed') == 'true'


def caso_8(c):
    """Capturas a 390 y 1440 px de las tres pantallas (acceso, lista —en Tarjetas y en Lista— y ficha), sin desbordes y con 0 errores de consola."""
    ref = SEMILLAS['A']
    SALIDAS.mkdir(parents=True, exist_ok=True)
    p = c.page

    def capturar(nombre, tabla=False):
        for ancho, alto in ((390, 844), (1440, 900)):
            p.set_viewport_size({'width': ancho, 'height': alto})
            p.mouse.move(2, 2)  # el puntero fuera de la página: ninguna fila ni botón sale con el aspecto de «ratón encima»
            p.wait_for_timeout(300)
            assert p.evaluate('() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)') <= ancho, f'{nombre}: desborde a {ancho} px'
            if tabla and ancho == 1440:  # en ordenador ancho la tabla cabe entera: la caja no necesita deslizarse
                caja = p.evaluate("() => { const e = document.getElementById('cajaLista'); return [e.scrollWidth, e.clientWidth]; }")
                assert caja[0] <= caja[1], f'{nombre}: a {ancho} px la tabla se desliza dentro de su caja ({caja[0]} > {caja[1]})'
            p.screenshot(path=str(SALIDAS / f'bandeja-{nombre}-{ancho}.png'), full_page=True, animations='disabled')
        p.set_viewport_size({'width': 390, 'height': 844})

    c.ver('/bandeja/entrar', '#formCorreo')
    capturar('entrar')
    p.fill('#email', FUERA)  # el paso del código (con una dirección sin acceso: no sale ningún correo)
    p.click('#btnCodigo')
    p.wait_for_selector('#formCodigo:not([hidden])')
    capturar('entrar-codigo')

    c.con_sesion()
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    p.wait_for_function("() => document.getElementById('correo').textContent.length > 0")
    capturar('lista')

    # El modo Lista (tabla): con una pendiente que nadie ha abierto (su raya azul) además de las de antes; las capturas de arriba no cambian
    crear('gnew', [(1, 'captura.jpg', JPG.read_bytes())], extra={'titular': 'Titular Sin Abrir de Prueba SL'})
    largos = crear('gnew', [(1, 'captura-largos.jpg', JPG.read_bytes())], extra=LARGOS)  # y una con los textos largos: a 1440 px se leen enteros (caso 17)
    galleta = {'Cookie': 'bandeja_sesion=' + [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'][0]['value']}
    st, _, cuerpo = http('GET', f'/api/bandeja/ficha?ref={largos}&abrir=1', cabeceras=galleta)  # abierta: su titular va con el peso normal (en las «Sin abrir», negrita: más ancho)
    assert st == 200, cuerpo
    p.get_by_role('button', name='Actualizar la lista').click()
    c.esperar_lista()
    p.get_by_role('button', name='Lista', exact=True).click()
    p.wait_for_selector('a.fila')
    assert p.locator('a.fila.sin-abrir').count() >= 1, 'La tabla enseña la pendiente sin abrir'
    capturar('lista-tabla', tabla=True)

    c.abrir_ficha(ref)
    capturar('ficha')
    c.sin_jerga()


def caso_9(c):
    """Todo lo que escribe el comercial se ve como TEXTO: ni HTML, ni scripts, ni manejadores de eventos, en la lista y en la ficha.
    (Se guarda en MAYÚSCULAS: lo que se ve es la versión en mayúsculas de lo escrito, y de ella tampoco puede salir nada ejecutable.)"""
    c.ctx.add_init_script(JS_ALIAS_EN_MAYUSCULAS)  # ver JS_ALIAS_EN_MAYUSCULAS
    ref = crear('gnew', [(1, 'escaneo.jpg', JPG.read_bytes())], extra={
        'titular': XSS_TITULAR, 'quien_eres': XSS_COMERCIAL, 'observaciones': XSS_OBSERVACIONES, 'dir_suministro': XSS_DIRECCION,
        'cambio_titular': 'Si', 'nuevo_titular': '<script>window.__xss=6</script> Nuevo SL'})
    c.con_sesion()
    p = c.page
    c.ver('/bandeja', 'a.tarjeta')
    c.buscar('titular co')
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    assert XSS_TITULAR.upper() in tarjeta.inner_text(), tarjeta.inner_text()
    assert XSS_COMERCIAL.upper() in tarjeta.inner_text()
    assert tarjeta.locator('img, script, svg, iframe, b, u').count() == 0, 'La tarjeta no ha creado ningún elemento con lo que escribió el comercial'
    # (en el resto de la lista puede haber ojos: las tarjetas «Abierta por …» llevan un SVG propio, siempre el mismo)
    assert p.locator('#lista img, #lista script, #lista iframe, #lista b, #lista u').count() == 0, 'La lista no ha creado ningún elemento con lo que escribió el comercial'
    assert p.locator('#lista svg:not(.t-ojo)').count() == 0, 'En la lista no hay más SVG que los ojos de las tarjetas'
    c.sin_desbordes()
    tarjeta.click()
    p.wait_for_selector('#ficha:not([hidden])')
    c.sin_desbordes()
    ficha = p.inner_text('#ficha')
    for texto in [XSS_TITULAR, XSS_COMERCIAL, XSS_DIRECCION, 'línea uno', '<iframe src="javascript:window.__xss=5"></iframe> línea dos', '<script>window.__xss=6</script> Nuevo SL']:
        assert texto.upper() in ficha, f'La ficha debe enseñar «{texto.upper()[:40]}» (en mayúsculas) como texto'
    # (`i`: el valor de `src` sale en mayúsculas —`X`— y el selector tiene que seguir detectando una imagen colada)
    assert p.locator('#ficha img[src="x" i], #ficha iframe, #ficha svg[onload], #ficha b[onmouseover], #ficha u').count() == 0
    assert p.evaluate("() => typeof window.__xss") == 'undefined' and p.evaluate("() => typeof window.__XSS") == 'undefined', 'Se ha ejecutado algo del contenido del comercial'
    assert p.evaluate("() => document.querySelectorAll('script').length") == 1, 'La página tiene su único script y ninguno colado'
    assert p.title().startswith(ref)
    c.sin_jerga()


def caso_10(c):
    """Fichas especiales: incompleta (sin «Marcar como tramitada», documentos sin subir), descartada, una que no existe y una referencia que no es referencia."""
    ref_c = crear('gnew', [(1, 'pendiente.pdf', b'%PDF-1.4\n' + b'x' * 2048), (2, 'otro.png', PNG.read_bytes())], extra={'titular': 'Titular Subiendo SL'}, completo=False)
    ref_d = crear('gnew', [(1, 'bot.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra={'titular': 'Titular Bot SL'}, hp='soy un robot')
    c.con_sesion()
    p = c.page
    c.abrir_ficha(ref_c)
    assert 'Subiendo' in p.inner_text('#insignias')
    assert 'El comercial todavía está subiendo la documentación.' in p.inner_text('#banner')
    assert p.get_by_role('button', name='Marcar como tramitada', exact=True).count() == 0 and p.get_by_role('button', name='Volver a pendiente', exact=True).count() == 0
    docs = p.inner_text('#bloqueDocs')
    assert 'firma.png' in docs and 'pendiente.pdf' in docs and 'Todavía sin subir' in docs
    assert p.locator('li.doc', has_text='pendiente.pdf').get_by_role('link', name='Ver').count() == 0, 'Lo que no ha subido no tiene enlaces'
    assert p.locator('li.doc', has_text='firma.png').get_by_role('link', name='Ver').count() == 1
    assert 'Todavía no se han enviado correos: el envío no está completo.' in p.inner_text('#bloqueCorreos')
    c.sin_jerga()

    c.abrir_ficha(ref_d)
    assert 'Descartada' in p.inner_text('#insignias')
    assert 'filtro antibots' in p.inner_text('#banner') and 'rojo' in p.get_attribute('#banner', 'class')
    assert 'Este envío no tiene documentos.' in p.inner_text('#bloqueDocs')
    assert p.get_by_role('button', name='Descargar todo (ZIP)').count() == 0
    c.sin_jerga()

    # una referencia con forma de referencia pero que no existe: el servidor dice 404 y la página lo cuenta en llano
    c.rota('/api/bandeja/ficha')
    p.goto(BASE + '/bandeja/c/GNE-20261009-ZZZZZZ', wait_until='load')
    p.wait_for_selector('#estadoCarga.error')
    assert 'No encontramos esta tramitación.' in p.inner_text('#estadoCarga')
    assert p.is_hidden('#ficha')
    # y una que ni lo parece: ni siquiera se pregunta al servidor
    antes = len([r for r in c.respuestas if r['ruta'].endswith('/ficha')])
    p.goto(BASE + '/bandeja/c/esto-no-es-una-referencia', wait_until='load')
    p.wait_for_selector('#estadoCarga.error')
    assert 'No encontramos esta tramitación.' in p.inner_text('#estadoCarga')
    assert len([r for r in c.respuestas if r['ruta'].endswith('/ficha')]) == antes
    c.sin_jerga()


def caso_11(c):
    """«Salir» cierra la sesión: se borra la cookie y la bandeja vuelve a pedir el acceso."""
    c.rota('/api/bandeja/')
    c.con_sesion()
    p = c.page
    c.ver('/bandeja', 'a.tarjeta')
    assert [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion']
    p.get_by_role('button', name='Salir', exact=True).click()
    p.wait_for_url(BASE + '/bandeja/entrar')
    assert not [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'], 'La cookie debe borrarse'
    p.goto(BASE + '/bandeja', wait_until='load')
    p.wait_for_url(re.compile(r'/bandeja/entrar\?volver='))
    # desde la ficha también
    c.con_sesion()
    c.abrir_ficha(SEMILLAS['A'])
    p.get_by_role('button', name='Salir', exact=True).click()
    p.wait_for_url(BASE + '/bandeja/entrar')
    assert not [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion']


def caso_12(c):
    """Los enlaces valen 10 minutos: la ficha los renueva sola antes de que caduquen, y también justo al pulsar «Descargar» o «Ver» si se le pasó."""
    ref = SEMILLAS['A']
    c.con_sesion()
    p = c.page
    p.clock.install()  # reloj falso: se instala ANTES de cargar la página para poder adelantar minutos sin esperarlos
    c.abrir_ficha(ref)
    fichas = lambda: len([r for r in c.respuestas if r['ruta'].endswith('/ficha')])
    assert fichas() == 1
    enlaces = lambda: p.locator('li.doc a').evaluate_all('els => els.map(e => e.href)')
    primeros = enlaces()
    assert len(primeros) == 4

    def esperar_fichas(n, segundos=15):
        fin = time.time() + segundos
        while time.time() < fin and fichas() < n:
            p.wait_for_timeout(200)  # (no time.sleep: la API síncrona solo entrega los eventos de red mientras Playwright espera)
        assert fichas() >= n, f'La página debía haber vuelto a pedir la ficha ({fichas()} peticiones, se esperaban {n})'

    # 1) a los 8 minutos, antes de que caduquen, la página pide la ficha sola y los enlaces cambian
    p.wait_for_timeout(1300)  # para que el segundo de caducidad de la firma nueva sea otro
    p.clock.fast_forward('08:10')
    esperar_fichas(2)
    p.wait_for_function('(antes) => document.querySelector("li.doc a").href !== antes', arg=primeros[0], polling=250)  # con reloj falso, sin rAF
    segundos = enlaces()
    assert segundos != primeros and len(segundos) == 4

    # 2) se le pasa el tiempo (11 minutos de golpe, sin que salte ningún temporizador): al pulsar «Descargar» renueva y baja bien
    adelantar = lambda minutos: p.clock.set_system_time((p.evaluate('() => Date.now()') + minutos * 60 * 1000) / 1000)  # (la API de Python pide SEGUNDOS)
    adelantar(11)
    with p.expect_download(timeout=60_000) as bajada:
        p.locator('li.doc', has_text='dni.jpg').get_by_role('button', name='Descargar', exact=True).click()
    descarga = bajada.value
    assert descarga.suggested_filename == 'dni.jpg'
    with tempfile.TemporaryDirectory() as carpeta:
        destino = Path(carpeta) / 'dni.jpg'
        descarga.save_as(str(destino))
        assert destino.read_bytes() == JPG.read_bytes()
    esperar_fichas(3)

    # 3) y lo mismo con «Ver»: se abre la pestaña al momento y se rellena con el enlace nuevo
    p.wait_for_timeout(1300)
    adelantar(11)
    with c.ctx.expect_page() as nueva:
        p.locator('li.doc', has_text='dni.jpg').get_by_role('link', name='Ver', exact=True).click()
    popup = nueva.value
    popup.wait_for_url(re.compile(r'/storage/v1/object/sign/tramitaciones/pruebas/gnew/'), timeout=30_000)
    popup.wait_for_load_state('load')
    assert popup.evaluate('() => document.images.length > 0 && document.images[0].naturalWidth > 0'), 'La imagen no se ve'
    popup.close()
    esperar_fichas(4)
    c.sin_jerga()


def caso_13(c):
    """Cuando algo falla, la página lo cuenta en llano (sin códigos) y deja reintentar: lista, ficha, cambio de estado, volver a enviar y descargas."""
    ref = SEMILLAS['A']
    c.rota('/api/bandeja/', '.supabase.co/storage')
    c.permite_5xx = True  # los 503 de este caso los fabrica el propio caso con page.route
    c.con_sesion()
    p = c.page
    sin_red = lambda route, request: route.abort('connectionreset')
    caido = lambda route, request: route.fulfill(
        status=503, content_type='application/json',
        body=json.dumps({'ok': False, 'codigo': 'temporal', 'mensaje': 'No hemos podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.', 'retryable': True}))
    FRASE_RED = 'No hemos podido conectar. Comprueba tu conexión e inténtalo de nuevo.'
    FRASE_503 = 'No hemos podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.'

    # la lista sin red → frase + «Reintentar»; con el servidor caído → su frase en llano
    p.route('**/api/bandeja/lista**', sin_red)
    c.ver('/bandeja')
    p.wait_for_function("() => /No hemos podido conectar/.test(document.getElementById('estadoLista').textContent)")
    assert FRASE_RED in p.inner_text('#estadoLista')
    p.unroute('**/api/bandeja/lista**')
    p.get_by_role('button', name='Reintentar', exact=True).click()
    p.wait_for_selector('a.tarjeta')
    p.route('**/api/bandeja/lista**', caido)
    p.get_by_role('button', name='Actualizar la lista').click()
    p.wait_for_function("() => /Inténtalo de nuevo en un momento/.test(document.getElementById('estadoLista').textContent)")
    assert FRASE_503 in p.inner_text('#estadoLista') and p.get_by_role('button', name='Reintentar', exact=True).is_visible()
    p.unroute('**/api/bandeja/lista**')
    p.get_by_role('button', name='Reintentar', exact=True).click()
    p.wait_for_selector('a.tarjeta')
    c.sin_jerga()

    # la ficha sin red → frase + «Reintentar»
    p.route('**/api/bandeja/ficha**', sin_red)
    c.ver(f'/bandeja/c/{ref}')
    p.wait_for_function("() => /No hemos podido conectar/.test(document.getElementById('estadoCarga').textContent)")
    assert p.is_hidden('#ficha')
    p.unroute('**/api/bandeja/ficha**')
    p.get_by_role('button', name='Reintentar', exact=True).click()
    p.wait_for_selector('#ficha:not([hidden])')
    assert p.inner_text('#ref') == ref

    # marcar como tramitada sin red: lo dice, no cambia nada y deja volver a intentarlo
    p.route('**/api/bandeja/estado', sin_red)
    p.get_by_role('button', name='Marcar como tramitada', exact=True).click()
    p.get_by_role('button', name='Sí, marcar como tramitada', exact=True).click()
    p.wait_for_selector('#errorAccion:not([hidden])')
    assert p.inner_text('#errorAccion') == FRASE_RED
    assert p.get_by_role('button', name='Marcar como tramitada', exact=True).is_visible() and p.is_hidden('#confirmar')
    assert estado_de(ref)['tramitacion']['estado'] == 'recibida'
    p.unroute('**/api/bandeja/estado')

    # volver a enviar con el servidor caído: su frase, junto al botón
    p.route('**/api/bandeja/reenviar', caido)
    p.locator('#bloqueCorreos .correo').nth(0).get_by_role('button', name='Volver a enviar', exact=True).click()
    p.wait_for_selector('.correo-resultado')
    assert p.inner_text('.correo-resultado') == FRASE_503
    p.unroute('**/api/bandeja/reenviar')

    # descargas que fallan: «No hemos podido descargar «dni.jpg»…» y el botón vuelve a servir; igual con el ZIP
    almacen = lambda url: '.supabase.co/storage/' in url
    p.route(almacen, sin_red)
    boton = p.locator('li.doc', has_text='dni.jpg').get_by_role('button', name='Descargar', exact=True)
    boton.click()
    p.wait_for_selector('#errorDocs:not([hidden])')
    assert p.inner_text('#errorDocs') == 'No hemos podido descargar «dni.jpg». Inténtalo de nuevo.'
    assert boton.is_enabled()
    p.get_by_role('button', name='Descargar todo (ZIP)', exact=True).click()
    p.wait_for_function("() => /No hemos podido preparar el ZIP/.test(document.getElementById('errorDocs').textContent)")
    assert p.get_by_role('button', name='Descargar todo (ZIP)', exact=True).is_enabled()
    p.unroute(almacen, sin_red)
    c.sin_jerga()


def caso_14(c):
    """Quién ha abierto cada ficha: una pendiente que nadie ha mirado enseña «Sin abrir» (raya azul y pastilla); al abrir su ficha sale «Abierta por …» arriba y «Ficha abierta por …» en el historial, UNA vez (ni una carga que falla ni el refresco en silencio apuntan de más); y al volver atrás la tarjeta enseña «Abierta por» y ya no «Sin abrir»."""
    ref = crear('gnew', [(1, 'visto.jpg', JPG.read_bytes())], extra={'titular': 'Titular Visto SL'})
    aperturas = lambda: [x for x in estado_de(ref)['eventos'] if x['tipo'] == 'ficha_abierta']
    c.con_sesion()
    p = c.page
    pedidas = []  # direcciones (enteras) de las peticiones a la ficha: se mira cuáles llevan abrir=1
    p.on('request', lambda r: pedidas.append(r.url) if '/api/bandeja/ficha' in r.url else None)

    # 1) en la lista, una pendiente que nadie ha abierto: «Sin abrir», con su raya azul de 4 px y su pastilla azul, y ningún «Abierta por»
    c.ver('/bandeja', 'a.tarjeta')
    c.buscar(ref)
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    assert tarjeta.count() == 1
    assert 'sin-abrir' in tarjeta.get_attribute('class').split()
    texto = tarjeta.inner_text()
    assert 'Sin abrir' in texto and 'Abierta por' not in texto, texto
    assert tarjeta.evaluate("e => { const s = getComputedStyle(e); return [s.borderLeftWidth, s.borderLeftColor]; }") == ['4px', 'rgb(37, 99, 235)']
    assert tarjeta.locator('.t-vista .ins-sin-abrir').evaluate("e => { const s = getComputedStyle(e); return [s.color, s.backgroundColor]; }") == ['rgb(29, 78, 216)', 'rgb(219, 234, 254)']
    assert tarjeta.locator('svg').count() == 0
    assert aperturas() == []
    c.sin_jerga()
    c.sin_desbordes()

    # 2) se abre la ficha, pero la carga falla (sin red): no cuenta como abrirla; con «Reintentar» sí, y manda abrir=1
    c.rota('/api/bandeja/ficha')
    p.route('**/api/bandeja/ficha**', lambda route, request: route.abort('connectionreset'))
    tarjeta.click()
    p.wait_for_function("() => /No hemos podido conectar/.test(document.getElementById('estadoCarga').textContent)")
    assert aperturas() == [], 'Una carga que no llega no es una apertura'
    p.unroute('**/api/bandeja/ficha**')
    p.get_by_role('button', name='Reintentar', exact=True).click()
    p.wait_for_selector('#ficha:not([hidden])')
    assert len(pedidas) == 2 and all(u.endswith(f'ref={ref}&abrir=1') for u in pedidas), pedidas
    linea = p.inner_text('#abiertaPor')
    assert p.is_visible('#abiertaPor')
    assert re.fullmatch(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} \(\d{{1,2}}-\d{{1,2}}-\d{{4}} a las \d{{2}}:\d{{2}}\)', linea), linea
    assert f'Ficha abierta por {NOMBRE_PRUEBA}' in p.inner_text('#bloqueHistorial')
    hechas = aperturas()
    assert len(hechas) == 1 and hechas[0]['actor'] == NOMBRE_PRUEBA and hechas[0]['detalle'] == {}, hechas
    c.sin_jerga()
    c.sin_desbordes()

    # 3) el refresco en silencio de después de una acción («Volver a enviar» vuelve a pedir la ficha) NO manda abrir=1 ni apunta otra
    p.locator('#bloqueCorreos .correo').nth(0).get_by_role('button', name='Volver a enviar', exact=True).click()
    p.wait_for_selector('.correo-resultado')
    assert len(pedidas) == 3 and 'abrir' not in pedidas[-1], pedidas
    assert len(aperturas()) == 1
    assert p.inner_text('#bloqueHistorial').count('Ficha abierta por') == 1

    # 4) volver atrás: la tarjeta ya no es «Sin abrir», sino «Abierta por …» con el ojo y el «hace …»
    p.go_back()
    p.wait_for_url(re.compile(r'/bandeja$'))
    c.esperar_lista()
    c.buscar(ref)
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    texto = tarjeta.inner_text()
    assert re.search(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} · hace (unos segundos|\d+ min)', texto), texto
    assert 'Sin abrir' not in texto
    assert 'sin-abrir' not in tarjeta.get_attribute('class').split()
    assert tarjeta.evaluate("e => getComputedStyle(e).borderLeftWidth") == '1px', 'Sin la raya azul'
    assert tarjeta.locator('.t-vista svg[aria-hidden="true"]').count() == 1
    assert tarjeta.locator('.t-vista strong').inner_text() == NOMBRE_PRUEBA
    assert len(aperturas()) == 1
    c.sin_jerga()
    c.sin_desbordes()


def caso_15(c):
    """Varias personas y caché de «atrás»: una tarjeta con 4 aperturas enseña las 3 más recientes (ojo, correo en negrita y «hace …» al día cada minuto); y al volver desde la caché del navegador (pageshow) la lista se vuelve a pedir con el mismo filtro y búsqueda y deja de decir «Sin abrir»."""
    ref = crear('gnew', [(1, 'visto.jpg', JPG.read_bytes())], extra={'titular': 'Titular Varias Personas SL'})
    ref2 = crear('gnew', [(1, 'cache.jpg', JPG.read_bytes())], extra={'titular': 'Titular Cache SL'})
    c.con_sesion()
    p = c.page
    otra = 'victor.molins.10+otra-persona@gmail.com'
    larga = 'victor.molins.10+una-persona-de-backoffice-con-un-correo-bastante-largo-de-verdad@gmail.com'
    cuarta = 'victor.molins.10+cuarta-persona@gmail.com'

    def hace(**tiempo):
        return (datetime.now(timezone.utc) - timedelta(**tiempo)).strftime('%Y-%m-%dT%H:%M:%S.%f') + '+00:00'

    def con_cuatro_personas(route, request):
        real = route.fetch()
        cuerpo = real.json()
        for item in cuerpo['items']:
            if item['ref'] == ref:
                item['vistas'] = [{'por': EMAIL, 'en': hace(minutes=4)}, {'por': otra, 'en': hace(hours=2)},
                                  {'por': larga, 'en': hace(days=3)}, {'por': cuarta, 'en': hace(days=9)}]
        route.fulfill(response=real, json=cuerpo)

    # 1) cuatro personas: se enseñan las tres más recientes, una línea cada una, y la cuarta no
    p.clock.install()  # reloj falso (antes de cargar la página) para adelantar minutos sin esperarlos
    p.route('**/api/bandeja/lista**', con_cuatro_personas)
    c.ver('/bandeja', 'a.tarjeta')
    c.buscar(ref)
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    lineas = tarjeta.locator('.t-abierta')
    assert lineas.count() == 3, lineas.count()
    assert [x.inner_text() for x in tarjeta.locator('.t-abierta strong').all()] == [EMAIL, otra, larga]
    assert cuarta not in tarjeta.inner_text() and 'Sin abrir' not in tarjeta.inner_text()
    assert tarjeta.locator('.t-abierta svg.t-ojo[aria-hidden="true"]').count() == 3
    primera = lineas.nth(0).inner_text()
    assert re.fullmatch(rf'Abierta por {re.escape(EMAIL)} · hace 4 min', primera), primera
    assert re.fullmatch(rf'Abierta por {re.escape(otra)} · hace 2 h', lineas.nth(1).inner_text())
    assert re.fullmatch(rf'Abierta por {re.escape(larga)} · hace 3 días', lineas.nth(2).inner_text())
    assert 'sin-abrir' not in tarjeta.get_attribute('class').split()
    # el correo largo se parte en vez de salirse de la tarjeta
    c.sin_desbordes()
    assert tarjeta.evaluate("e => e.scrollWidth <= e.clientWidth + 1"), 'La tarjeta no desborda'
    c.sin_jerga()
    # el «hace …» se mantiene al día solo (cada minuto): pasados 3 minutos, de 4 a 7
    p.clock.fast_forward('03:00')
    p.wait_for_function("() => /hace 7 min/.test(document.querySelector('.t-abierta .t-cuando').textContent)", polling=250)
    assert re.fullmatch(rf'Abierta por {re.escape(EMAIL)} · hace 7 min', lineas.nth(0).inner_text())

    # 2) la lista que se quedó en la caché de «atrás»: la tarjeta sigue diciendo «Sin abrir» hasta que llega un pageshow de caché
    p.unroute('**/api/bandeja/lista**')
    c.elegir_filtro('Todas')
    c.buscar(ref2)
    tarjeta2 = p.locator(f'a.tarjeta[href$="{ref2}"]')
    assert 'Sin abrir' in tarjeta2.inner_text()
    galleta = [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'][0]['value']
    st, _, _ = http('GET', f'/api/bandeja/ficha?ref={ref2}&abrir=1', cabeceras={'Cookie': f'bandeja_sesion={galleta}'})  # alguien la abre «en otra pestaña»
    assert st == 200
    listas = lambda: len([r for r in c.respuestas if r['ruta'].endswith('/lista')])
    antes = listas()
    p.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))")  # una carga normal: no hace nada
    p.wait_for_timeout(600)
    assert listas() == antes and 'Sin abrir' in tarjeta2.inner_text(), 'Un pageshow normal no recarga la lista'
    p.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))")  # volver desde la caché del navegador
    p.wait_for_function("(r) => /Abierta por/.test(document.querySelector(`a.tarjeta[href$='${r}']`)?.textContent || '')", arg=ref2, polling=250)
    assert listas() == antes + 1
    texto = tarjeta2.inner_text()
    assert re.search(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} · hace (unos segundos|\d+ min)', texto) and 'Sin abrir' not in texto, texto
    assert p.input_value('#q') == ref2, 'La búsqueda se conserva'
    assert p.get_by_role('button', name='Todas', exact=True).get_attribute('aria-pressed') == 'true', 'El filtro se conserva'
    c.sin_jerga()


def caso_16(c):
    """«Sin abrir» solo en las pendientes: una pendiente que nadie ha abierto la lleva (raya azul y pastilla); una tramitada, una incompleta y una descartada que nadie ha abierto NO enseñan «Sin abrir», ni raya, ni fila de «quién»; y si alguien las abre, «Abierta por …» sale igual (en cualquier estado) y sin la raya."""
    extra = lambda titular: {'titular': titular, 'quien_eres': 'Comercial Marcador16'}  # la búsqueda `marcador16` encuentra solo estas cuatro
    pendiente = crear('gnew', [(1, 'pendiente.jpg', JPG.read_bytes())], extra=extra('Titular Solo Pendiente SL'))
    tramitada = crear('gnew', [(1, 'tramitada.jpg', JPG.read_bytes())], extra=extra('Titular Ya Tramitada SL'))
    incompleta = crear('gnew', [(1, 'incompleta.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra=extra('Titular Incompleto SL'), completo=False)
    descartada = crear('gnew', [(1, 'bot.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra=extra('Titular Bot SL'), hp='soy un robot')
    c.con_sesion()
    p = c.page
    galleta = {'Cookie': 'bandeja_sesion=' + [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'][0]['value']}
    # la tramitada se marca por la API: así NADIE abre su ficha (por la pantalla habría que abrirla)
    st, _, cuerpo = http('POST', '/api/bandeja/estado', {'ref': tramitada, 'accion': 'tramitar'}, cabeceras=galleta)
    assert st == 200, cuerpo
    aperturas = lambda ref: [x for x in estado_de(ref)['eventos'] if x['tipo'] == 'ficha_abierta']
    assert all(aperturas(r) == [] for r in (pendiente, tramitada, incompleta, descartada)), 'Nadie ha abierto ninguna'
    tarjeta = lambda ref: p.locator(f'a.tarjeta[href$="{ref}"]')
    raya = lambda ref: tarjeta(ref).evaluate("e => { const s = getComputedStyle(e); return [s.borderLeftWidth, s.borderLeftColor]; }")

    def sin_la_marca(ref):
        """La tarjeta no dice «Sin abrir»: ni el texto, ni la raya azul, ni la fila de «quién» (ni ojo)."""
        t = tarjeta(ref)
        assert t.count() == 1, f'{ref} debería estar en la lista'
        assert 'Sin abrir' not in t.inner_text() and 'Abierta por' not in t.inner_text(), t.inner_text()
        assert 'sin-abrir' not in t.get_attribute('class').split()
        assert t.locator('.t-vista').count() == 0 and t.locator('.ins-sin-abrir').count() == 0 and t.locator('svg').count() == 0
        assert raya(ref)[0] == '1px', 'Sin la raya azul'

    def abierta_por_sin_raya(ref):
        t = tarjeta(ref)
        assert t.count() == 1, f'{ref} debería estar en la lista'
        assert re.search(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} · hace (unos segundos|\d+ min)', t.inner_text()), t.inner_text()
        assert 'Sin abrir' not in t.inner_text() and 'sin-abrir' not in t.get_attribute('class').split()
        assert t.locator('.t-vista svg[aria-hidden="true"]').count() == 1
        assert raya(ref)[0] == '1px', 'Abierta no lleva la raya azul'

    # 1) «Todas» (sin las descartadas): la pendiente sin abrir lleva su raya azul y su pastilla; la tramitada y la incompleta, nada
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    c.elegir_filtro('Todas')
    c.buscar('marcador16')
    assert sorted(c.refs_en_lista()) == sorted([pendiente, tramitada, incompleta]), c.refs_en_lista()
    t = tarjeta(pendiente)
    assert 'sin-abrir' in t.get_attribute('class').split() and 'Sin abrir' in t.inner_text(), t.inner_text()
    assert raya(pendiente) == ['4px', 'rgb(37, 99, 235)']
    assert t.locator('.t-vista .ins-sin-abrir').count() == 1
    sin_la_marca(tramitada)
    sin_la_marca(incompleta)
    c.sin_jerga()
    c.sin_desbordes()

    # 2) cada pestaña con su estado: Tramitadas, Incompletas y Descartadas sin abrir no enseñan «Sin abrir»
    c.elegir_filtro('Tramitadas')
    assert c.refs_en_lista() == [tramitada], c.refs_en_lista()
    sin_la_marca(tramitada)
    c.elegir_filtro('Incompletas')
    assert c.refs_en_lista() == [incompleta], c.refs_en_lista()
    sin_la_marca(incompleta)
    p.get_by_role('button', name='Más', exact=True).click()
    c.elegir_filtro('Descartadas')
    assert c.refs_en_lista() == [descartada], c.refs_en_lista()
    sin_la_marca(descartada)
    assert all(aperturas(r) == [] for r in (tramitada, incompleta, descartada)), 'Mirar la lista no abre ninguna ficha'

    # 3) alguien abre la descartada y la tramitada: «Abierta por …» sale igual aunque no estén pendientes, y sin la raya
    for ref in (descartada, tramitada):
        st, _, cuerpo = http('GET', f'/api/bandeja/ficha?ref={ref}&abrir=1', cabeceras=galleta)
        assert st == 200, cuerpo
    c.elegir_filtro('Descartadas')
    abierta_por_sin_raya(descartada)
    c.elegir_filtro('Tramitadas')
    abierta_por_sin_raya(tramitada)
    c.sin_jerga()
    c.sin_desbordes()


def caso_17(c):
    """El modo Lista (tabla): el interruptor Tarjetas / Lista (por defecto Tarjetas; se recuerda al recargar), la cabecera y las filas con todas sus columnas, «Sin abrir» con su raya azul, «Abierta por …» con +N, «Cargar más» en la tabla, volver a Tarjetas sin pedir otra vez la lista, clic en una fila y «atrás», lo que escribe el comercial como texto, sin jerga, sin desbordes a 390 px y, a 1440 px, la tabla entera sin deslizarse, con las columnas estrechas (referencia, CUPS, recibida, docs, abierta y estado) enteras y lo que Victor veía cortado (titular, compañía y comercial: LARGOS, y «MEGA ENERGIA · 2.0TD») leyéndose entero."""
    c.ctx.add_init_script(JS_ALIAS_EN_MAYUSCULAS)  # ver JS_ALIAS_EN_MAYUSCULAS
    ref_a, ref_b = SEMILLAS['A'], SEMILLAS['B']
    marcador = lambda titular: {'titular': titular, 'quien_eres': 'Comercial Marcador17'}  # la búsqueda `marcador17` encuentra solo estas dos
    sin_abrir = crear('gnew', [(1, 'lista-sin-abrir.jpg', JPG.read_bytes())], extra=marcador('Titular Lista Sin Abrir SL'))
    abierta = crear('mega', [(1, 'lista-abierta.jpg', JPG.read_bytes()), (2, 'lista-abierta.png', PNG.read_bytes())], extra=marcador('Titular Lista Abierta SL'))
    peligro = crear('gnew', [(1, 'lista-peligro.jpg', JPG.read_bytes())], extra={'titular': XSS_TITULAR, 'quien_eres': XSS_COMERCIAL})
    largos = crear('gnew', [(1, 'lista-largos.jpg', JPG.read_bytes())], extra=LARGOS)
    c.con_sesion()
    p = c.page
    galleta = {'Cookie': 'bandeja_sesion=' + [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'][0]['value']}
    st, _, cuerpo = http('GET', f'/api/bandeja/ficha?ref={abierta}&abrir=1', cabeceras=galleta)  # alguien abre esa ficha: saldrá «Abierta por …»
    assert st == 200, cuerpo
    st, _, cuerpo = http('GET', f'/api/bandeja/ficha?ref={largos}&abrir=1', cabeceras=galleta)  # los textos largos, en una fila abierta: su titular va con el peso normal
    assert st == 200, cuerpo  # (en las «Sin abrir» el titular va en negrita, que es más ancha: caben ~2 caracteres menos)
    pedidas = []  # peticiones a la lista (las de «quién soy» no cuentan)
    p.on('request', lambda r: pedidas.append(r.url) if '/api/bandeja/lista' in r.url else None)
    boton = lambda nombre: p.get_by_role('button', name=nombre, exact=True)
    fila = lambda ref: p.locator(f'a.fila[href$="{ref}"]')
    en_lista = lambda: p.evaluate("() => document.body.classList.contains('vista-lista')")
    guardado = lambda: p.evaluate("() => localStorage.getItem('bandeja.vista')")
    caja_se_desliza = lambda: p.evaluate("() => { const e = document.getElementById('cajaLista'); return [e.scrollWidth, e.clientWidth]; }")
    p.set_viewport_size({'width': 1440, 'height': 900})

    # 1) por defecto, Tarjetas (como siempre): el interruptor a la derecha de los filtros, sin cabecera de tabla y sin guardar nada
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    assert p.get_by_role('group', name='Filtrar por estado').count() == 1 and p.get_by_role('group', name='Modo de visualización').count() == 1
    assert boton('Tarjetas').get_attribute('aria-pressed') == 'true' and boton('Lista').get_attribute('aria-pressed') == 'false'
    assert not en_lista() and guardado() is None, 'Sin elegir nada: Tarjetas, y no se guarda nada'
    assert p.locator('a.fila').count() == 0 and p.is_hidden('.tabla-cabecera'), 'En Tarjetas no hay filas ni cabecera de tabla'
    barra, vistas, mas = p.locator('.barra').bounding_box(), p.locator('.vistas').bounding_box(), p.locator('#chipMas').bounding_box()
    assert abs((vistas['x'] + vistas['width']) - (barra['x'] + barra['width'])) <= 1, 'El interruptor, pegado a la derecha'
    assert vistas['x'] >= mas['x'] + mas['width'] and abs((vistas['y'] + vistas['height'] / 2) - (mas['y'] + mas['height'] / 2)) <= 6, 'A la derecha de los filtros, en su misma franja'
    assert boton('Tarjetas').inner_text().strip() == 'Tarjetas' and boton('Lista').inner_text().strip() == 'Lista', 'En ordenador, icono y texto'
    refs_tarjetas = c.refs_en_lista()
    assert ref_a in refs_tarjetas and ref_b in refs_tarjetas

    # 2) pasar a Lista: cabecera, filas con los mismos contratos y sin pedir nada más; se guarda la elección
    antes = len(pedidas)
    boton('Lista').click()
    p.wait_for_selector('a.fila')
    p.wait_for_timeout(400)
    assert len(pedidas) == antes, 'Cambiar de modo repinta lo ya cargado: no vuelve a pedir la lista'
    assert boton('Lista').get_attribute('aria-pressed') == 'true' and boton('Tarjetas').get_attribute('aria-pressed') == 'false'
    assert en_lista() and guardado() == 'lista' and p.locator('a.tarjeta').count() == 0
    assert c.refs_en_filas() == refs_tarjetas, 'Los mismos contratos, en el mismo orden'
    cabecera = p.locator('#cajaLista .tabla-cabecera')
    assert cabecera.is_visible() and cabecera.get_attribute('aria-hidden') == 'true'
    assert [x.inner_text() for x in cabecera.locator('span').all()] == ['Referencia', 'Titular', 'Compañía', 'CUPS', 'Comercial', 'Recibida', 'Docs', 'Abierta', 'Estado', '']
    assert p.evaluate("() => document.querySelector('.contenedor').getBoundingClientRect().width") == 1400, 'En modo Lista la página se ensancha a 1400 px'

    # 3) una fila de GNEW y una de MEGA: todas sus columnas (lo que escribe el comercial, como texto)
    fa = fila(ref_a)
    assert fa.get_attribute('href') == f'/bandeja/c/{ref_a}', 'Toda la fila es un enlace a su ficha'
    assert fa.locator('.c-ref').inner_text() == ref_a
    assert fa.locator('.pildora-nombre').inner_text() == 'TITULAR DE PRUEBA SL'
    assert fa.locator('.avatar').inner_text() == 'TP' and 'avatar-gnew' in fa.locator('.avatar').get_attribute('class').split()
    assert fa.locator('.c-compania .marca-gnew').inner_text() == 'GNEW' and fa.locator('.c-compania .c-txt').inner_text() == 'COMPAÑÍA DE PRUEBA · 2.0TD'
    assert fa.locator('.c-cups').inner_text() == 'ES0021000000000001RK' and 'monospace' in fa.locator('.c-cups').evaluate("e => getComputedStyle(e).fontFamily")
    assert fa.locator('.c-comercial').inner_text() == 'COMERCIAL DE PRUEBA'
    assert re.fullmatch(r'hace (unos segundos|\d+ min|\d+ h)', fa.locator('.c-recibida').inner_text()), fa.locator('.c-recibida').inner_text()
    assert re.match(r'\d{4}-\d{2}-\d{2}T', fa.locator('.c-recibida.t-cuando').get_attribute('data-fecha') or ''), 'El «hace …» lleva su fecha: se mantiene al día solo'
    assert fa.locator('.c-docs').inner_text() == '4' and fa.locator('.c-docs').evaluate("e => getComputedStyle(e).fontWeight") == '700'
    assert fa.locator('.c-estado .estado-recibida').inner_text() == 'Pendiente'
    assert fa.locator('.c-estado .estado-recibida').evaluate("e => getComputedStyle(e).borderTopWidth") == '1px', 'La pastilla del estado lleva su borde fino'
    fb = fila(ref_b)
    assert fb.locator('.marca-mega').inner_text() == 'MEGA' and '2.0TD' in fb.locator('.c-compania').inner_text()
    assert fb.locator('.avatar').inner_text() == 'TM' and 'avatar-mega' in fb.locator('.avatar').get_attribute('class').split()
    assert fb.locator('.c-docs').inner_text() == '2'

    # 4) «Sin abrir» (raya azul de 4 px, pastilla, titular en negrita) y «Abierta por …» (ojo, correo, «hace …»), con la misma regla que las tarjetas
    c.buscar('marcador17')
    assert sorted(c.refs_en_filas()) == sorted([sin_abrir, abierta]), c.refs_en_filas()
    fs, fo = fila(sin_abrir), fila(abierta)
    assert 'sin-abrir' in fs.get_attribute('class').split()
    assert fs.evaluate("e => { const s = getComputedStyle(e); return [s.borderLeftWidth, s.borderLeftColor]; }") == ['4px', 'rgb(37, 99, 235)']
    pastilla = fs.locator('.c-abierta .ins-sin-abrir')
    assert pastilla.inner_text() == 'Sin abrir'
    assert pastilla.evaluate("e => { const s = getComputedStyle(e); return [s.color, s.backgroundColor]; }") == ['rgb(29, 78, 216)', 'rgb(219, 234, 254)']
    assert fs.locator('.c-abierta svg').count() == 0 and fs.locator('.pildora-nombre').evaluate("e => getComputedStyle(e).fontWeight") == '700'
    assert 'sin-abrir' not in fo.get_attribute('class').split() and fo.locator('.ins-sin-abrir').count() == 0
    assert fo.evaluate("e => getComputedStyle(e).borderLeftColor") == 'rgba(0, 0, 0, 0)', 'Abierta no lleva la raya azul'
    assert fo.locator('.pildora-nombre').evaluate("e => getComputedStyle(e).fontWeight") == '500'
    celda = fo.locator('.c-abierta')
    assert celda.locator('svg.t-ojo[aria-hidden="true"]').count() == 1 and celda.locator('.a-correo').inner_text() == NOMBRE_PRUEBA
    assert re.fullmatch(r'hace (unos segundos|\d+ min)', celda.locator('.a-linea').inner_text().strip()), celda.locator('.a-linea').inner_text()
    assert celda.locator('.a-linea .t-cuando').get_attribute('data-fecha') and celda.locator('.a-mas').count() == 0
    assert celda.get_attribute('title') == f'Abierta por {NOMBRE_PRUEBA}'
    # varias personas: la más reciente en la celda, «+N» y todas en el title
    otra, larga = 'victor.molins.10+otra-persona@gmail.com', 'victor.molins.10+una-persona-de-backoffice-con-un-correo-bastante-largo-de-verdad@gmail.com'

    def hace(**tiempo):
        return (datetime.now(timezone.utc) - timedelta(**tiempo)).strftime('%Y-%m-%dT%H:%M:%S.%f') + '+00:00'

    def con_tres_personas(route, request):
        real = route.fetch()
        cuerpo = real.json()
        for item in cuerpo['items']:
            if item['ref'] == abierta:
                item['vistas'] = [{'por': EMAIL, 'en': hace(minutes=4)}, {'por': otra, 'en': hace(hours=2)}, {'por': larga, 'en': hace(days=3)}]
        route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/lista**', con_tres_personas)
    c.buscar('marcador17')
    celda = fila(abierta).locator('.c-abierta')
    assert celda.locator('.a-correo').inner_text() == EMAIL, 'La persona más reciente'
    assert celda.locator('.a-linea .t-cuando').inner_text() == 'hace 4 min' and celda.locator('.a-mas').inner_text() == '+2'
    assert celda.get_attribute('title') == f'Abierta por {EMAIL}, {otra}, {larga}'
    p.unroute('**/api/bandeja/lista**')
    c.buscar('')

    # 5) «Cargar más» en la tabla añade filas; y volver a Tarjetas (y otra vez a Lista) conserva TODOS los contratos sin pedir nada
    visto = {'antes': None}

    def paginar(route, request):
        consulta = urllib.parse.parse_qs(urllib.parse.urlparse(request.url).query)
        if 'antes' in consulta:
            visto['antes'] = consulta['antes'][0]
            falsa = {'ref': 'GNE-20260101-PAGINA', 'formulario': 'gnew', 'estado': 'recibida', 'compania': 'Compañía de otra página', 'titular_nombre': 'Titular de la segunda página',
                     'cups': 'ES0021000000000001RK', 'comercial_nombre': 'Comercial', 'tarifa': '2.0TD', 'creada_en': '2026-01-01T10:00:00.000000+00:00',
                     'recibida_en': '2026-01-01T10:00:00.000000+00:00', 'n_documentos': 1, 'vistas': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'items': [falsa], 'siguiente': None}))
        else:
            real = route.fetch()
            cuerpo = real.json()
            cuerpo['siguiente'] = '2026-10-09T20:11:12.123456+00:00'
            route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/lista**', paginar)
    c.elegir_filtro('Todas')
    assert p.is_visible('#mas'), '«Cargar más» aparece también con la tabla'
    antes_n = p.locator('a.fila').count()
    boton('Cargar más').click()
    p.wait_for_function(f"() => document.querySelectorAll('a.fila').length === {antes_n + 1}")
    assert visto['antes'] == '2026-10-09T20:11:12.123456+00:00', f'El cursor viaja entero (con el +): {visto["antes"]!r}'
    nueva = fila('GNE-20260101-PAGINA')
    assert nueva.locator('.pildora-nombre').inner_text() == 'Titular de la segunda página' and nueva.locator('.c-docs').inner_text() == '1'
    assert p.is_hidden('#mas'), 'Sin siguiente, el botón desaparece'
    p.unroute('**/api/bandeja/lista**')
    refs_filas = c.refs_en_filas()
    assert 'GNE-20260101-PAGINA' in refs_filas and len(refs_filas) == antes_n + 1
    antes = len(pedidas)
    boton('Tarjetas').click()
    p.wait_for_selector('a.tarjeta')
    p.wait_for_timeout(400)
    assert len(pedidas) == antes, 'Volver a Tarjetas no vuelve a pedir la lista'
    assert c.refs_en_lista() == refs_filas, 'Los mismos contratos, con las dos páginas de «Cargar más»'
    assert not en_lista() and guardado() == 'tarjetas' and boton('Tarjetas').get_attribute('aria-pressed') == 'true'
    assert p.locator('a.fila').count() == 0 and p.is_hidden('.tabla-cabecera') and p.locator('#lista svg:not(.t-ojo)').count() == 0
    assert 'Titular de la segunda página' in p.inner_text('#lista') and p.is_hidden('#mas')
    assert p.get_by_role('button', name='Todas', exact=True).get_attribute('aria-pressed') == 'true', 'El filtro se conserva'
    boton('Lista').click()
    p.wait_for_selector('a.fila')
    assert c.refs_en_filas() == refs_filas and len(pedidas) == antes, 'Y otra vez a Lista, sin pedir nada'

    # 6) recargar la página: sigue en Lista (y con el mismo filtro)
    p.reload(wait_until='load')
    p.wait_for_selector('a.fila')
    c.esperar_lista()
    assert en_lista() and guardado() == 'lista' and boton('Lista').get_attribute('aria-pressed') == 'true' and p.locator('a.tarjeta').count() == 0
    assert p.get_by_role('button', name='Todas', exact=True).get_attribute('aria-pressed') == 'true'

    # 7) clic en una fila → su ficha; «atrás» → la Lista
    c.buscar(ref_a)
    fila(ref_a).click()
    p.wait_for_selector('#ficha:not([hidden])')
    assert p.url == f'{BASE}/bandeja/c/{ref_a}', p.url
    assert p.inner_text('#ref') == ref_a
    p.go_back()
    p.wait_for_url(re.compile(r'/bandeja(\?estado=todas)?$'))
    c.esperar_lista()
    c.buscar(ref_a)
    assert en_lista() and fila(ref_a).count() == 1 and p.locator('a.tarjeta').count() == 0, 'Atrás vuelve a la Lista'

    # 8) lo que escribe el comercial se pinta como TEXTO también en la fila (ni HTML ni scripts ni más SVG que los ojos)
    c.buscar(peligro)
    fp = fila(peligro)
    assert fp.count() == 1
    assert XSS_TITULAR.upper() in fp.locator('.pildora-nombre').inner_text() and XSS_COMERCIAL.upper() in fp.locator('.c-comercial').inner_text()
    assert fp.locator('img, script, svg, iframe, b, u').count() == 0, 'La fila no ha creado ningún elemento con lo que escribió el comercial'
    assert p.locator('#lista img, #lista script, #lista iframe, #lista b, #lista u').count() == 0
    assert p.locator('#lista svg:not(.t-ojo)').count() == 0, 'En la tabla no hay más SVG que los ojos'
    assert p.evaluate("() => typeof window.__xss") == 'undefined' and p.evaluate("() => typeof window.__XSS") == 'undefined', 'Se ha ejecutado algo del contenido del comercial'
    assert re.fullmatch(r'[A-Z0-9]{1,2}', fp.locator('.avatar').inner_text()), 'Las iniciales salen de las letras del nombre, no de los signos'
    c.sin_jerga()

    # 9) sin filas no hay tabla ni cabecera: solo el mensaje
    c.buscar('zzzinexistente')
    assert p.inner_text('#estadoLista') == 'No hay tramitaciones que coincidan.'
    assert p.locator('a.fila').count() == 0 and p.is_hidden('#cajaLista') and p.is_hidden('.tabla-cabecera')
    c.buscar('')
    p.wait_for_selector('a.fila')
    assert p.is_visible('#cajaLista .tabla-cabecera')

    # 10) a 1440 px la tabla cabe ENTERA (la caja no se desliza), cada celda bajo su cabecera y lo corto no se recorta. Para mirar también «Incompleta» y
    #     «Descartada» (las pastillas más anchas de Estado) se añaden filas de cada estado a la respuesta de la lista (la base no se toca)
    def con_todos_los_estados(route, request):
        real = route.fetch()
        cuerpo = real.json()
        base = dict(cuerpo['items'][0])
        cuerpo['items'] += [dict(base, ref=f'GNE-20260101-ESTADO{n}', estado=estado, vistas=[])
                            for n, estado in enumerate(('abandonada', 'descartada', 'tramitada', 'subiendo'))]
        route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/lista**', con_todos_los_estados)
    c.buscar('')
    p.wait_for_selector('a.fila[href$="ESTADO3"]')
    assert caja_se_desliza()[0] <= caja_se_desliza()[1], f'A 1440 px la tabla se desliza dentro de su caja: {caja_se_desliza()}'
    c.sin_desbordes(1440)
    columnas = p.evaluate("""() => {
        const izq = (e) => e.getBoundingClientRect().left;
        const cabecera = [...document.querySelectorAll('.tabla-cabecera > span')].map(izq);
        const desalineadas = [], recortadas = [], pastillas = new Set();
        const filas = document.querySelectorAll('a.fila');
        // una pastilla cabe si no se sale de su celda por la derecha
        const cabe = (pastilla, celda) => pastilla.getBoundingClientRect().right <= celda.getBoundingClientRect().right + 1 && celda.scrollWidth <= celda.clientWidth + 1;
        filas.forEach((fila) => {
            [...fila.children].forEach((celda, i) => { if (Math.abs(izq(celda) - cabecera[i]) > 1) desalineadas.push(i); });
            ['.c-ref', '.c-cups', '.c-recibida', '.c-docs', '.c-estado'].forEach((s) => {
                const e = fila.querySelector(s);
                if (e && e.scrollWidth > e.clientWidth + 1) recortadas.push(s);
            });
            const estado = fila.querySelector('.c-estado .ins');
            pastillas.add(estado.textContent);
            if (!cabe(estado, fila.querySelector('.c-estado'))) recortadas.push('pastilla ' + estado.textContent);
            const sinAbrir = fila.querySelector('.c-abierta .ins-sin-abrir');
            if (sinAbrir && !cabe(sinAbrir, fila.querySelector('.c-abierta'))) recortadas.push('pastilla Sin abrir');
        });
        return { columnas: cabecera.length, filas: filas.length, desalineadas, recortadas, pastillas: [...pastillas].sort() };
    }""")
    assert columnas['columnas'] == 10 and columnas['filas'] >= 5, columnas
    assert columnas['desalineadas'] == [], 'Cada celda, bajo su cabecera (también en las filas con raya azul)'
    assert columnas['recortadas'] == [], 'Referencia, CUPS, «hace …», docs y las pastillas de estado y de «Sin abrir» caben enteros (solo se recortan titular, compañía, comercial y quién)'
    assert columnas['pastillas'] == ['Descartada', 'Incompleta', 'Pendiente', 'Subiendo', 'Tramitada'], f'Hay una fila de cada estado: {columnas["pastillas"]}'

    # lo que Victor veía cortado a 1440 px se lee ENTERO: el titular, la compañía con su tarifa y el comercial de LARGOS, y «MEGA ENERGIA · 2.0TD»
    def leido_entero(ref):
        return fila(ref).evaluate("""f => {
            const q = (s) => f.querySelector(s);
            const corto = (e) => e.scrollWidth > e.clientWidth + 1;
            return { titular: [q('.pildora-nombre').innerText, corto(q('.pildora-nombre'))],
                     compania: [q('.c-compania .c-txt').innerText, corto(q('.c-compania .c-txt'))],
                     comercial: [q('.c-comercial').innerText, corto(q('.c-comercial'))] };
        }""")

    assert leido_entero(largos) == {'titular': ['JOSE MANUEL FERNANDEZ', False], 'compania': ['NET FIJO BOE · 2.0TD', False], 'comercial': ['ISABEL HERNANDEZ', False]}, leido_entero(largos)
    assert leido_entero(ref_b)['compania'] == ['MEGA ENERGIA · 2.0TD', False], leido_entero(ref_b)
    p.unroute('**/api/bandeja/lista**')
    c.buscar('')
    c.sin_jerga()

    # 11) a 390 px la PÁGINA no se sale por los lados: es la tabla la que se desliza, dentro de su caja; y el interruptor, solo con iconos (con su nombre)
    p.set_viewport_size({'width': 390, 'height': 844})
    p.wait_for_timeout(300)
    c.sin_desbordes()
    assert caja_se_desliza()[0] > caja_se_desliza()[1], 'En el móvil la tabla se desliza de lado dentro de su caja'
    assert boton('Lista').inner_text().strip() == '' and boton('Tarjetas').inner_text().strip() == '', 'En el móvil, solo iconos'
    assert boton('Lista').get_attribute('aria-label') == 'Lista' and boton('Tarjetas').get_attribute('aria-label') == 'Tarjetas'
    c.sin_jerga()

    # 12) sin almacenamiento (modo privado o datos bloqueados) funciona igual: Tarjetas al abrir, y el interruptor sirve en esa visita
    c.ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('bloqueado', 'SecurityError'); } });")
    p.reload(wait_until='load')
    p.wait_for_selector('a.tarjeta')
    c.esperar_lista()
    assert not en_lista() and boton('Tarjetas').get_attribute('aria-pressed') == 'true'
    boton('Lista').click()
    p.wait_for_selector('a.fila')
    assert en_lista() and boton('Lista').get_attribute('aria-pressed') == 'true' and p.locator('a.tarjeta').count() == 0
    boton('Tarjetas').click()
    p.wait_for_selector('a.tarjeta')
    assert not en_lista() and p.locator('a.fila').count() == 0
    c.sin_jerga()


def caso_18(c):
    """«Marcar como sin abrir»: botón secundario junto a «Marcar como tramitada» solo en las pendientes (hueco entre los dos, sin diálogo de confirmación, «Marcando…» mientras va); al ir bien vuelve a la lista y esa ficha sale «Sin abrir» (raya azul) en Tarjetas y en Lista, sin borrar la apertura ni tocar la fila; abrirla otra vez enseguida la deja leída («Abierta por …» arriba; historial con apertura, marca y apertura); «Abierta por» solo con las aperturas posteriores a la última marca; si falla (sin red, o alguien la tramitó antes) frase en llano y botón usable; marcar dos veces seguidas es marcar una."""
    marcador = lambda titular: {'titular': titular, 'quien_eres': 'Comercial Marcador18'}
    ref = crear('gnew', [(1, 'sin-abrir.jpg', JPG.read_bytes())], extra=marcador('Titular Sin Abrir Marcado SL'))
    ref2 = crear('gnew', [(1, 'dos-marcas.jpg', JPG.read_bytes())], extra=marcador('Titular Dos Marcas SL'))
    tramitada = crear('gnew', [(1, 'ya-tramitada.jpg', JPG.read_bytes())], extra=marcador('Titular Ya Tramitado SL'))
    incompleta = crear('gnew', [(1, 'incompleta.pdf', b'%PDF-1.4\n' + b'x' * 2048)], extra=marcador('Titular Incompleto SL'), completo=False)
    adelantada = crear('gnew', [(1, 'adelantada.jpg', JPG.read_bytes())], extra=marcador('Titular Adelantado SL'))
    c.con_sesion()
    p = c.page
    galleta = {'Cookie': 'bandeja_sesion=' + [x for x in c.ctx.cookies() if x['name'] == 'bandeja_sesion'][0]['value']}
    st, _, cuerpo = http('POST', '/api/bandeja/estado', {'ref': tramitada, 'accion': 'tramitar'}, cabeceras=galleta)  # por la API: nadie abre su ficha
    assert st == 200, cuerpo
    eventos = lambda r, tipo: [x for x in estado_de(r)['eventos'] if x['tipo'] == tipo]
    boton = lambda nombre: p.get_by_role('button', name=nombre, exact=True)
    marcar_por_api = lambda r: http('POST', '/api/bandeja/estado', {'ref': r, 'accion': 'sin_abrir'}, cabeceras=galleta)
    texto_abierta = lambda: re.fullmatch(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} \(\d{{1,2}}-\d{{1,2}}-\d{{4}} a las \d{{2}}:\d{{2}}\)', p.inner_text('#abiertaPor'))

    def hace(**tiempo):
        return (datetime.now(timezone.utc) - timedelta(**tiempo)).strftime('%Y-%m-%dT%H:%M:%S.%f') + '+00:00'

    # 1) la ficha de una pendiente: «Marcar como sin abrir» junto a «Marcar como tramitada», como botón secundario, con hueco entre los dos
    fila_antes = estado_de(ref)['tramitacion']
    c.abrir_ficha(ref)
    assert len(eventos(ref, 'ficha_abierta')) == 1 and eventos(ref, 'marcada_sin_abrir') == []
    assert texto_abierta(), p.inner_text('#abiertaPor')
    assert [b.inner_text() for b in p.locator('#acciones button').all()] == ['Marcar como tramitada', 'Marcar como sin abrir']
    tramitar, sin_abrir = boton('Marcar como tramitada'), boton('Marcar como sin abrir')
    assert 'primario' in tramitar.get_attribute('class').split() and 'primario' not in sin_abrir.get_attribute('class').split(), 'Es el botón secundario'
    estilo = sin_abrir.evaluate("e => { const s = getComputedStyle(e); return [s.backgroundColor, s.color, s.borderTopWidth]; }")
    assert estilo[:2] == ['rgb(255, 255, 255)', 'rgb(11, 110, 79)'] and estilo[2] != '0px', estilo  # fondo blanco, texto verde y su borde (el navegador redondea 1,5 px)
    a, b = tramitar.bounding_box(), sin_abrir.bounding_box()
    assert b['y'] >= a['y'] + a['height'] + 4 and abs(a['width'] - b['width']) <= 1, f'En el móvil, uno debajo del otro y con hueco: {a} {b}'
    assert p.is_hidden('#confirmar'), 'Sin diálogo de confirmación'
    c.sin_jerga()
    c.sin_desbordes()
    # en ordenador, uno al lado del otro y con hueco; y la captura de la ficha con el botón
    p.set_viewport_size({'width': 1440, 'height': 900})
    p.mouse.move(2, 2)  # el puntero fuera de la página: ningún botón sale con el aspecto de «ratón encima»
    p.wait_for_timeout(300)
    a, b = tramitar.bounding_box(), sin_abrir.bounding_box()
    assert abs(a['y'] - b['y']) <= 1 and b['x'] >= a['x'] + a['width'] + 4, f'En ordenador, en la misma fila y con hueco: {a} {b}'
    c.sin_desbordes(1440)
    SALIDAS.mkdir(parents=True, exist_ok=True)
    p.screenshot(path=str(SALIDAS / 'bandeja-ficha-sin-abrir-1440.png'), full_page=True, animations='disabled')
    p.set_viewport_size({'width': 390, 'height': 844})
    p.wait_for_timeout(300)

    # 2) sin red: frase en llano en la propia ficha, el botón vuelve a poder usarse y no se apunta nada
    c.rota('/api/bandeja/estado')
    p.route('**/api/bandeja/estado', lambda route, request: route.abort('connectionreset'))
    sin_abrir.click()
    p.wait_for_selector('#errorAccion:not([hidden])')
    assert p.inner_text('#errorAccion') == 'No se ha podido marcar. Inténtalo de nuevo.'
    assert boton('Marcar como sin abrir').is_enabled() and boton('Marcar como tramitada').is_enabled() and p.is_hidden('#confirmar')
    assert p.url == f'{BASE}/bandeja/c/{ref}', 'Si falla, se queda en la ficha'
    assert eventos(ref, 'marcada_sin_abrir') == [] and len(eventos(ref, 'ficha_abierta')) == 1
    c.sin_jerga()
    c.sin_desbordes()
    p.unroute('**/api/bandeja/estado')

    # 3) mientras va: «Marcando…» y los dos botones deshabilitados (un segundo clic no manda otra petición); al terminar, vuelve a la lista
    retenidas = []
    p.route('**/api/bandeja/estado', lambda route, request: retenidas.append(route))
    boton('Marcar como sin abrir').click()
    p.wait_for_function("() => document.getElementById('btnSinAbrir')?.textContent === 'Marcando…'")
    assert p.is_disabled('#btnSinAbrir') and p.is_disabled('#btnEstado'), 'Mientras va, los dos botones deshabilitados'
    assert p.is_hidden('#confirmar') and p.is_hidden('#errorAccion'), 'Ni diálogo ni mensaje de error'
    p.locator('#btnSinAbrir').dispatch_event('click')
    p.wait_for_timeout(300)
    assert len(retenidas) == 1, f'Un segundo clic no manda otra petición ({len(retenidas)})'
    retenidas[0].continue_()
    p.wait_for_url(re.compile(r'/bandeja(\?estado=\w+)?$'))
    p.unroute('**/api/bandeja/estado')
    p.wait_for_selector('a.tarjeta')
    c.esperar_lista()

    # 4) en la lista: esa ficha vuelve a ser «Sin abrir» (raya azul y pastilla) en Tarjetas y en Lista; en la base, UNA marca con el correo de la
    #    sesión, la apertura sigue y la fila de la tramitación no se ha tocado (ni su `actualizada_en`)
    c.buscar(ref)
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    assert tarjeta.count() == 1
    assert 'sin-abrir' in tarjeta.get_attribute('class').split() and 'Sin abrir' in tarjeta.inner_text() and 'Abierta por' not in tarjeta.inner_text(), tarjeta.inner_text()
    assert tarjeta.evaluate("e => { const s = getComputedStyle(e); return [s.borderLeftWidth, s.borderLeftColor]; }") == ['4px', 'rgb(37, 99, 235)']
    assert tarjeta.locator('.t-vista .ins-sin-abrir').inner_text() == 'Sin abrir' and tarjeta.locator('svg').count() == 0
    marcas = eventos(ref, 'marcada_sin_abrir')
    assert len(marcas) == 1 and marcas[0]['actor'] == NOMBRE_PRUEBA and marcas[0]['detalle'] == {}, marcas
    assert len(eventos(ref, 'ficha_abierta')) == 1, 'La apertura NO se borra'
    assert estado_de(ref)['tramitacion'] == fila_antes, 'La fila de tramitaciones no se toca'
    c.sin_jerga()
    c.sin_desbordes()
    boton('Lista').click()
    p.wait_for_selector('a.fila')
    fila = p.locator(f'a.fila[href$="{ref}"]')
    assert fila.count() == 1 and 'sin-abrir' in fila.get_attribute('class').split()
    assert fila.evaluate("e => { const s = getComputedStyle(e); return [s.borderLeftWidth, s.borderLeftColor]; }") == ['4px', 'rgb(37, 99, 235)']
    assert fila.locator('.c-abierta .ins-sin-abrir').inner_text() == 'Sin abrir' and fila.locator('.c-abierta svg').count() == 0
    c.sin_jerga()
    c.sin_desbordes()

    # 5) volver a abrirla ENSEGUIDA (la misma persona, a los pocos segundos de su primera apertura) la deja leída: «Abierta por …» arriba y,
    #    en la base, apertura + marca + apertura (el freno de 15 minutos no la deja «Sin abrir» estando leída)
    fila.click()
    p.wait_for_selector('#ficha:not([hidden])')
    assert p.is_visible('#abiertaPor') and texto_abierta(), p.inner_text('#abiertaPor')
    assert [x['tipo'] for x in estado_de(ref)['eventos'] if x['tipo'] in ('ficha_abierta', 'marcada_sin_abrir')] == ['ficha_abierta', 'marcada_sin_abrir', 'ficha_abierta']
    assert all(x['actor'] == NOMBRE_PRUEBA for x in estado_de(ref)['eventos'] if x['tipo'] in ('ficha_abierta', 'marcada_sin_abrir'))
    historial = [x for x in p.locator('#bloqueHistorial .texto').all_inner_texts() if 'abierta' in x or 'sin abrir' in x]
    assert historial == [f'Ficha abierta por {NOMBRE_PRUEBA}', f'Marcada como sin abrir por {NOMBRE_PRUEBA}', f'Ficha abierta por {NOMBRE_PRUEBA}'], historial
    c.ver('/bandeja', 'a.fila')
    c.esperar_lista()
    c.buscar(ref)
    fila = p.locator(f'a.fila[href$="{ref}"]')
    assert 'sin-abrir' not in fila.get_attribute('class').split() and fila.locator('.ins-sin-abrir').count() == 0
    assert fila.locator('.c-abierta .a-correo').inner_text() == NOMBRE_PRUEBA
    boton('Tarjetas').click()
    p.wait_for_selector('a.tarjeta')
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    assert re.search(rf'Abierta por {re.escape(NOMBRE_PRUEBA)} · hace (unos segundos|\d+ min)', tarjeta.inner_text()) and 'Sin abrir' not in tarjeta.inner_text()
    c.sin_jerga()

    # 6) marcar dos veces seguidas es marcar una: otro compañero la deja «sin abrir» mientras esta persona tiene la ficha abierta; el refresco
    #    en silencio (sin apertura nueva) ya no enseña «Abierta por»; y pulsar el botón da el mismo resultado sin una segunda marca
    c.abrir_ficha(ref2)
    assert p.is_visible('#abiertaPor') and texto_abierta()
    st, _, cuerpo = marcar_por_api(ref2)
    assert st == 200, cuerpo
    p.locator('#bloqueCorreos .correo').nth(0).get_by_role('button', name='Volver a enviar', exact=True).click()
    p.wait_for_selector('.correo-resultado')
    assert p.is_hidden('#abiertaPor'), 'Solo cuentan las aperturas posteriores a la última marca: no queda ninguna, la línea no se enseña'
    assert f'Marcada como sin abrir por {NOMBRE_PRUEBA}' in p.inner_text('#bloqueHistorial')
    assert boton('Marcar como sin abrir').is_enabled(), 'Sigue siendo una pendiente: el botón sigue ahí'
    boton('Marcar como sin abrir').click()
    p.wait_for_url(re.compile(r'/bandeja(\?estado=\w+)?$'))
    assert len(eventos(ref2, 'marcada_sin_abrir')) == 1, 'La segunda marca seguida no apunta otra'
    assert len(eventos(ref2, 'ficha_abierta')) == 1
    p.wait_for_selector('a.tarjeta')
    c.esperar_lista()
    c.buscar(ref2)
    assert 'Sin abrir' in p.locator(f'a.tarjeta[href$="{ref2}"]').inner_text()

    # 7) una tramitada no tiene el botón (y «Abierta por» de la ficha respeta la marca con varias personas: solo la apertura posterior a ella);
    #    una que sigue subiendo, tampoco
    otra = 'victor.molins.10+otra-persona@gmail.com'
    larga = 'victor.molins.10+una-persona-de-backoffice-con-un-correo-bastante-largo-de-verdad@gmail.com'
    cuarta = 'victor.molins.10+cuarta-persona@gmail.com'

    def con_marca_en_medio(route, request):
        real = route.fetch()
        cuerpo = real.json()
        cuerpo['eventos'] = [
            {'tipo': 'ficha_abierta', 'actor': otra, 'detalle': {}, 'creado_en': hace(minutes=60)},
            {'tipo': 'ficha_abierta', 'actor': larga, 'detalle': {}, 'creado_en': hace(minutes=45)},
            {'tipo': 'marcada_sin_abrir', 'actor': EMAIL, 'detalle': {}, 'creado_en': hace(minutes=30)},
            {'tipo': 'ficha_abierta', 'actor': cuarta, 'detalle': {}, 'creado_en': hace(minutes=5)},
        ]
        route.fulfill(response=real, json=cuerpo)

    p.route('**/api/bandeja/ficha**', con_marca_en_medio)
    c.abrir_ficha(tramitada)
    p.unroute('**/api/bandeja/ficha**')
    assert boton('Marcar como sin abrir').count() == 0 and boton('Volver a pendiente').is_visible(), 'En una tramitada no hay botón de «sin abrir»'
    linea = p.inner_text('#abiertaPor')
    assert p.is_visible('#abiertaPor') and linea.startswith(f'Abierta por {cuarta} (') and otra not in linea and larga not in linea, linea
    assert linea.count(' · ') == 0, 'Una sola persona: la que abrió DESPUÉS de la marca'
    historial = [x for x in p.locator('#bloqueHistorial .texto').all_inner_texts() if 'abierta' in x or 'sin abrir' in x]
    assert historial == [f'Ficha abierta por {otra}', f'Ficha abierta por {larga}', f'Marcada como sin abrir por {EMAIL}', f'Ficha abierta por {cuarta}'], historial
    c.sin_jerga()
    c.abrir_ficha(incompleta)
    assert boton('Marcar como sin abrir').count() == 0 and boton('Marcar como tramitada').count() == 0, 'Una que sigue subiendo no tiene acciones'

    # 8) alguien la tramitó antes de que esta persona pulsara: la frase en llano del servidor, la ficha se pone al día y el botón desaparece
    c.abrir_ficha(adelantada)
    assert boton('Marcar como sin abrir').is_visible()
    st, _, cuerpo = http('POST', '/api/bandeja/estado', {'ref': adelantada, 'accion': 'tramitar'}, cabeceras=galleta)  # otra persona, desde otra pestaña
    assert st == 200, cuerpo
    boton('Marcar como sin abrir').click()
    p.wait_for_selector('#errorAccion:not([hidden])')
    assert p.inner_text('#errorAccion') == 'Solo se puede dejar sin abrir un contrato pendiente.'
    p.wait_for_function("() => /Tramitada/.test(document.getElementById('insignias').textContent)")
    assert boton('Marcar como sin abrir').count() == 0 and boton('Volver a pendiente').is_visible()
    assert eventos(adelantada, 'marcada_sin_abrir') == []
    c.sin_jerga()
    c.sin_desbordes()


def caso_19(c):
    """El nombre de quien entra: una sesión SIN nombre (como las de antes) no puede abrir la lista ni una ficha sin pasar por el paso del
    nombre, y mientras tanto NO se pide la ficha (ni con abrir=1) ni se apunta ninguna apertura; un nombre que no vale da su frase en llano; el
    bueno («laura garcía») se guarda en MAYÚSCULAS, vuelve a la ficha y es el «quién» (arriba, en el historial y en la lista, en Tarjetas y
    en Lista); «Cambiar nombre» (otra persona en el mismo ordenador) deja el nombre de ahora escrito y la siguiente apertura sale con el nombre
    nuevo; con la sesión caducada a medias, vuelta al correo; y a 390 y 1440 px, sin jerga ni desbordes (capturas del paso del nombre)."""
    c.rota('/api/bandeja/')  # los 400 de los nombres malos y los 401 de una sesión sin sesión son a propósito
    ref = crear('gnew', [(1, 'nombre.jpg', JPG.read_bytes())], extra={'titular': 'Titular Con Nombre SL', 'quien_eres': 'Comercial Marcador19'})
    aperturas = lambda: [x for x in estado_de(ref)['eventos'] if x['tipo'] == 'ficha_abierta']
    yo = lambda: c.ctx.request.get(BASE + '/api/bandeja/yo').json()  # «quién soy» según el servidor, con la cookie de este navegador
    c.con_sesion(nombre=None)
    p = c.page
    pedidas = []  # direcciones (enteras) de las peticiones a la ficha
    p.on('request', lambda r: pedidas.append(r.url) if '/api/bandeja/ficha' in r.url else None)
    assert yo() == {'ok': True, 'email': EMAIL, 'nombre': None}, 'La sesión entra, pero sin nombre'

    # 1) la lista, sin nombre: al paso del nombre (directo: ya hay sesión, no vuelve a pedir el correo ni el código) y con «volver» a la lista
    p.goto(BASE + '/bandeja', wait_until='load')
    p.wait_for_url(re.compile(r'/bandeja/entrar\?paso=nombre&volver=%2Fbandeja$'))
    p.wait_for_selector('#formNombre:not([hidden])')
    assert p.is_hidden('#formCorreo') and p.is_hidden('#formCodigo'), 'Con sesión, solo el paso del nombre'
    assert p.input_value('#nombre') == '', 'Sin nombre todavía, el campo vacío'

    # 2) la ficha, sin nombre: aterriza en el paso del nombre SIN haber pedido la ficha (ni con abrir=1 ni sin él) y sin apuntar nada
    p.goto(BASE + f'/bandeja/c/{ref}', wait_until='load')
    p.wait_for_url(re.compile(r'/bandeja/entrar\?paso=nombre&volver=%2Fbandeja%2Fc%2F' + re.escape(ref) + '$'))
    p.wait_for_selector('#formNombre:not([hidden])')
    assert pedidas == [], f'Antes de tener el nombre no se pide la ficha: {pedidas}'
    assert aperturas() == [], 'Y no se apunta ninguna apertura'
    assert p.inner_text('label[for="nombre"]') == '¿Cómo te llamas?'
    assert p.get_attribute('#nombre', 'placeholder') == 'Ej.: LAURA GARCÍA' and p.get_attribute('#nombre', 'autocapitalize') == 'characters'
    assert p.evaluate("() => getComputedStyle(document.getElementById('nombre')).fontSize") == '16px'
    assert p.inner_text('#btnNombre') == 'Guardar y entrar'
    c.sin_jerga()
    c.sin_desbordes()
    SALIDAS.mkdir(parents=True, exist_ok=True)
    for ancho, alto in ((390, 844), (1440, 900)):  # las capturas del paso del nombre
        p.set_viewport_size({'width': ancho, 'height': alto})
        p.mouse.move(2, 2)
        p.wait_for_timeout(300)
        c.sin_desbordes(ancho)
        p.screenshot(path=str(SALIDAS / f'bandeja-entrar-nombre-{ancho}.png'), full_page=True, animations='disabled')
    p.set_viewport_size({'width': 390, 'height': 844})
    p.wait_for_timeout(300)

    # 3) un nombre que no vale: su frase en llano, sigue en el mismo paso, la sesión no cambia y no se apunta nada
    p.fill('#nombre', 'y' * 50)
    assert len(p.input_value('#nombre')) == 40, 'El campo no deja escribir más de 40 letras'
    for malo in ['', 'a', 'Juan2', 'ana@gmail.com', 'x' * 41]:
        if len(malo) > 40:  # a mano no se puede escribir: se fuerza el valor para que sea el servidor quien diga que no
            p.evaluate("(valor) => { document.getElementById('nombre').value = valor; }", malo)
        else:
            p.fill('#nombre', malo)
        p.click('#btnNombre')
        p.wait_for_selector('#errorNombre:not([hidden])')
        assert p.inner_text('#errorNombre') == FRASE_NOMBRE, malo
        assert p.is_visible('#formNombre') and '/bandeja/entrar' in p.url
        assert p.is_enabled('#btnNombre'), 'El botón vuelve a servir'
    c.sin_jerga()
    c.sin_desbordes()
    assert [r['status'] for r in c.respuestas if r['ruta'] == '/api/bandeja/yo' and r['status'] != 200] == [400] * 4, 'El vacío ni sale del navegador; los otros cuatro, 400'
    assert yo()['nombre'] is None and aperturas() == [] and pedidas == []

    # 4) el nombre bueno (con espacios de más y en minúsculas) vuelve a LA FICHA, que ahora SÍ se pide con abrir=1, y apunta ese nombre
    p.fill('#nombre', '  laura   garcía ')
    p.click('#btnNombre')
    p.wait_for_url(f'{BASE}/bandeja/c/{ref}')
    p.wait_for_selector('#ficha:not([hidden])')
    assert len(pedidas) == 1 and pedidas[0].endswith(f'ref={ref}&abrir=1'), pedidas
    assert yo() == {'ok': True, 'email': EMAIL, 'nombre': 'LAURA GARCÍA'}
    assert re.fullmatch(r'Abierta por LAURA GARCÍA \(\d{1,2}-\d{1,2}-\d{4} a las \d{2}:\d{2}\)', p.inner_text('#abiertaPor')), p.inner_text('#abiertaPor')
    assert 'Ficha abierta por LAURA GARCÍA' in p.inner_text('#bloqueHistorial')
    hechas = aperturas()
    assert len(hechas) == 1 and hechas[0]['actor'] == 'LAURA GARCÍA' and hechas[0]['detalle'] == {}, hechas
    assert EMAIL not in p.inner_text('#ficha'), 'El correo común no sale en ningún sitio de la ficha: el «quién» es el nombre'
    assert p.inner_text('#quien') == 'LAURA GARCÍA' and p.inner_text('#cambiarNombre') == 'Cambiar nombre'
    c.sin_jerga()
    c.sin_desbordes()

    # 5) la lista: «Abierta por LAURA GARCÍA» en Tarjetas y en Lista; la cabecera, «NOMBRE · correo» y «Cambiar nombre»
    c.ver('/bandeja', 'a.tarjeta')
    c.esperar_lista()
    c.buscar(ref)
    tarjeta = p.locator(f'a.tarjeta[href$="{ref}"]')
    assert re.search(r'Abierta por LAURA GARCÍA · hace (unos segundos|\d+ min)', tarjeta.inner_text()), tarjeta.inner_text()
    assert 'Sin abrir' not in tarjeta.inner_text() and tarjeta.locator('.t-vista strong').inner_text() == 'LAURA GARCÍA'
    p.wait_for_function("() => document.getElementById('correo').textContent.length > 0")
    assert p.inner_text('#nombre') == 'LAURA GARCÍA' and p.inner_text('#correo') == EMAIL
    assert p.inner_text('#quien') == f'LAURA GARCÍA · {EMAIL}'
    assert p.inner_text('#cambiarNombre') == 'Cambiar nombre' and p.is_visible('#cambiarNombre')
    assert p.get_attribute('#cambiarNombre', 'href') == '/bandeja/entrar?paso=nombre&volver=%2Fbandeja'
    c.sin_jerga()
    c.sin_desbordes()  # a 390 px la línea del nombre se recorta con «…» y el enlace baja a su línea: la página no se sale
    p.get_by_role('button', name='Lista', exact=True).click()
    p.wait_for_selector('a.fila')
    celda = p.locator(f'a.fila[href$="{ref}"] .c-abierta')
    assert celda.locator('.a-correo').inner_text() == 'LAURA GARCÍA' and celda.get_attribute('title') == 'Abierta por LAURA GARCÍA'
    c.sin_desbordes()
    p.get_by_role('button', name='Tarjetas', exact=True).click()
    p.wait_for_selector('a.tarjeta')
    # al cambiar el filtro, «Cambiar nombre» vuelve a la lista con ESE filtro
    c.elegir_filtro('Todas')
    assert p.get_attribute('#cambiarNombre', 'href') == '/bandeja/entrar?paso=nombre&volver=%2Fbandeja%3Festado%3Dtodas'

    # 6) «Cambiar nombre», desde la ficha: solo el paso del nombre, con el de ahora escrito; con otro, vuelve a la ficha y la apertura sale con el nuevo
    c.abrir_ficha(ref)
    assert len(aperturas()) == 1, 'La misma persona, a los pocos segundos: no se apunta otra (la ventana de 15 minutos)'
    p.get_by_role('link', name='Cambiar nombre', exact=True).click()
    p.wait_for_url(re.compile(r'/bandeja/entrar\?paso=nombre&volver=%2Fbandeja%2Fc%2F' + re.escape(ref) + '$'))
    p.wait_for_selector('#formNombre:not([hidden])')
    assert p.is_hidden('#formCorreo') and p.is_hidden('#formCodigo')
    assert p.input_value('#nombre') == 'LAURA GARCÍA', 'El nombre de ahora, ya escrito, para cambiarlo'
    p.fill('#nombre', 'pedro ñandú')
    p.click('#btnNombre')
    p.wait_for_url(f'{BASE}/bandeja/c/{ref}')
    p.wait_for_selector('#ficha:not([hidden])')
    assert yo()['nombre'] == 'PEDRO ÑANDÚ'
    assert [x['actor'] for x in aperturas()] == ['LAURA GARCÍA', 'PEDRO ÑANDÚ'], 'Otra persona: se apunta al momento, y lo de antes no se reescribe'
    linea = p.inner_text('#abiertaPor')
    assert re.fullmatch(r'Abierta por PEDRO ÑANDÚ \(.+\) · LAURA GARCÍA \(.+\)', linea), linea
    assert p.inner_text('#quien') == 'PEDRO ÑANDÚ'
    historial = [x for x in p.locator('#bloqueHistorial .texto').all_inner_texts() if 'abierta' in x]
    assert historial == ['Ficha abierta por LAURA GARCÍA', 'Ficha abierta por PEDRO ÑANDÚ'], historial
    c.sin_jerga()
    c.sin_desbordes()

    # 7) la sesión caduca con el nombre a medio escribir: vuelta al paso del correo con su frase en llano; y sin sesión, ?paso=nombre empieza por el correo
    p.goto(BASE + '/bandeja/entrar?paso=nombre&volver=%2Fbandeja', wait_until='load')
    p.wait_for_selector('#formNombre:not([hidden])')
    c.ctx.clear_cookies()
    p.fill('#nombre', 'ana lópez')
    p.click('#btnNombre')
    p.wait_for_selector('#formCorreo:not([hidden])')
    assert p.inner_text('#errorCorreo') == FRASE_SESION and p.is_hidden('#formNombre')
    p.goto(BASE + '/bandeja/entrar?paso=nombre&volver=%2Fbandeja', wait_until='load')
    p.wait_for_selector('#formCorreo:not([hidden])')
    assert p.is_hidden('#formNombre') and p.is_hidden('#formCodigo'), 'Sin sesión, el recorrido de siempre: correo → código → nombre'
    c.sin_jerga()
    c.sin_desbordes()


CASOS = [
    (1, 'Acceso: de /bandeja al login con «volver», código por correo simulado, código malo, código bueno y cookie HttpOnly', caso_1),
    (2, 'Un correo sin acceso ve lo mismo que uno con acceso, sin correo y sin entrar', caso_2),
    (3, 'Lista: tarjetas, filtros, búsqueda y «Cargar más»', caso_3),
    (4, 'Ficha: datos con IBAN completo, «Ver» da 200, «Descargar» y ZIP válido', caso_4),
    (5, 'Marcar como tramitada / Volver a pendiente, con confirmación y quién lo hizo', caso_5),
    (6, 'Correos: «Volver a enviar» (también con Altavoz caído)', caso_6),
    (7, 'Enlace directo a una ficha sin sesión → login → vuelve a la ficha; «volver» ajeno ignorado', caso_7),
    (8, 'Capturas a 390 y 1440 px de acceso, lista (tarjetas y tabla) y ficha', caso_8),
    (9, 'Lo que escribe el comercial se pinta como texto (nada de HTML)', caso_9),
    (10, 'Fichas incompleta, descartada, inexistente y mal escrita', caso_10),
    (11, 'Salir cierra la sesión', caso_11),
    (12, 'Enlaces de 10 minutos: se renuevan solos y al pulsar «Descargar» / «Ver» si se pasaron', caso_12),
    (13, 'Cuando algo falla: frases en llano y reintentar (lista, ficha, estado, correos, descargas)', caso_13),
    (14, 'Quién ha abierto cada ficha: «Sin abrir» → ficha → «Abierta por …» (arriba y en el historial) → de vuelta en la lista', caso_14),
    (15, 'Varias personas (3 líneas, «hace …» al día) y lista que se pone al día al volver desde la caché de «atrás»', caso_15),
    (16, '«Sin abrir» solo en las pendientes: tramitada, incompleta y descartada sin abrir no lo enseñan; abiertas, «Abierta por …» en cualquier estado', caso_16),
    (17, 'Modo Lista (tabla): interruptor Tarjetas / Lista que se recuerda, filas con todas las columnas, «Sin abrir», «Cargar más», volver a Tarjetas sin pedir otra vez, clic y «atrás», sin HTML, sin desbordes y a 1440 px sin deslizarse', caso_17),
    (18, '«Marcar como sin abrir»: botón solo en las pendientes → vuelve a la lista como «Sin abrir» (Tarjetas y Lista) → abrirla otra vez la deja leída; «Abierta por» respeta la marca; si falla, frase en llano', caso_18),
    (19, 'El nombre de quien entra: sin nombre, al paso del nombre sin apuntar nada; nombre malo, su frase; nombre bueno → «Abierta por NOMBRE» (ficha y lista) → «Cambiar nombre» → la siguiente apertura con el nombre nuevo', caso_19),
]


def correr(numeros):
    SALIDAS.mkdir(parents=True, exist_ok=True)
    elegidos = [c for c in CASOS if not numeros or c[0] in numeros]
    print('Preparando las tramitaciones de partida (por HTTP, en modo prueba)…')
    preparar()
    ok = 0
    inesperados_total = 0
    esperados_total = 0
    with sync_playwright() as pw:
        navegador = pw.chromium.launch(headless=True)
        for numero, titulo, funcion in elegidos:
            caso = CasoBandeja(navegador, titulo)
            inicio = time.time()
            try:
                funcion(caso)
                caso.comprobar_limpio()
                ok += 1
                extra = len(caso.errores_consola)
                esperados_total += extra
                print(f'  OK   caso {numero}: {titulo}  ({time.time() - inicio:.1f} s; consola: 0 errores inesperados'
                      f'{f", {extra} «Failed to load resource» de los 401/404 provocados" if extra else ""})')
            except Exception as error:  # un caso que falla no impide correr los demás
                print(f'  FALLO caso {numero}: {titulo}')
                print(f'       {type(error).__name__}: {str(error)[:700]}')
                tb = traceback.extract_tb(error.__traceback__)
                if tb:
                    print(f'       en {tb[-1].filename.split("/")[-1]}:{tb[-1].lineno}: {tb[-1].line}')
                if caso.errores_pagina:
                    print(f'       errores de página: {caso.errores_pagina[:3]}')
                inesperados = caso.consola_inesperada()
                if inesperados:
                    print(f'       consola: {[e["texto"][:150] for e in inesperados[:3]]}')
                if caso.violaciones:
                    print(f'       violaciones: {caso.violaciones}')
                try:
                    caso.page.screenshot(path=str(SALIDAS / f'fallo-bandeja-{numero}.png'), full_page=True)
                except Exception:
                    pass
            finally:
                inesperados_total += len(caso.consola_inesperada())
                caso.cerrar()
        navegador.close()
    print(f'\n{ok}/{len(elegidos)} OK · errores de consola inesperados: {inesperados_total} · '
          f'«Failed to load resource» esperados por los 401/404 provocados: {esperados_total}')
    return ok == len(elegidos)


if __name__ == '__main__':
    numeros = {int(a) for a in sys.argv[1:] if a.isdigit()}
    sys.exit(0 if correr(numeros) else 1)
