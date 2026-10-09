#!/usr/bin/env python3
"""tests/e2e/comun.py · Utilidades compartidas de las pruebas con navegador (Tramitación v2).

Un solo Chromium, en serie, viewport de móvil (390×844). Cada caso abre su propio contexto limpio y
`Caso` recoge todo lo que pasa en él: errores de la página, mensajes de consola, peticiones a la API y al
almacén, y cualquier intento de salir a internet.

Reglas de seguridad (no negociables):
  · TODA petición a script.google.com / script.googleusercontent.com se intercepta y se responde en local:
    el Apps Script de producción sigue vivo y manda correos de verdad. Si un caso no espera tocar el
    respaldo, la petición se ABORTA y el caso se da por fallido.
  · Nada más sale a internet salvo el almacén de Supabase (las subidas firmadas, siempre bajo «pruebas/»):
    las fuentes de Google se responden vacías y cualquier otro destino se aborta y cuenta como fallo.
  · El estado de la base se lee SIEMPRE por el gancho /__pruebas/tramitacion?ref= del servidor local.
  · Solo alias de Victor (victor.molins.10+algo@gmail.com): nunca personas reales.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
BASE = 'http://127.0.0.1:8765'
VIEWPORT = {'width': 390, 'height': 844}
SALIDAS = RAIZ / 'tests' / 'e2e' / 'salidas'
FIXTURES = RAIZ / 'tests' / 'fixtures'

# Datos de prueba válidos (los mismos que usan las pruebas de API)
EMAIL_COMERCIAL = 'victor.molins.10+comercial@gmail.com'
EMAIL_CLIENTE = 'victor.molins.10+cliente@gmail.com'
CUPS_LUZ = 'ES0021000000000001RK'
CUPS_GAS = 'ES0031000000000003BS'
IBAN_TECLEADO = 'ES91 2100 0418 4502 0005 1332'

REF_GRACIAS = re.compile(r'/gracias(?:-mega)?\.html\?ref=((?:GNE|MEGA)-\d{8}-[A-Z0-9]{4,10})$')
GOOGLE_RESPUESTA_OK = '{"success":true}'


# ---------------------------------------------------------------------------
# Base de datos de pruebas (siempre por el gancho del servidor local)
# ---------------------------------------------------------------------------

def _pedir_json(ruta, intentos=3):
    ultimo = None
    for n in range(intentos):
        try:
            with urllib.request.urlopen(BASE + ruta, timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            ultimo = e
        except Exception as e:  # red local caída un instante, etc.
            ultimo = e
        time.sleep(1 + n)
    raise RuntimeError(f'No se pudo leer {ruta.split("?")[0]}: {type(ultimo).__name__}')


def estado_de(ref):
    """{tramitacion, documentos, correos, eventos} de una tramitación de prueba, o None si no existe."""
    r = _pedir_json('/__pruebas/tramitacion?ref=' + urllib.parse.quote(ref))
    return r if r is None else {k: r[k] for k in ('tramitacion', 'documentos', 'correos', 'eventos')}


def esperar_estado(ref, estado, segundos=20):
    """Espera (sin pasarse) a que la tramitación llegue a ese estado y la devuelve."""
    fin = time.time() + segundos
    e = None
    while time.time() < fin:
        e = estado_de(ref)
        if e and e['tramitacion']['estado'] == estado:
            return e
        time.sleep(0.5)
    raise AssertionError(f'{ref}: no llegó a «{estado}» (está en «{e["tramitacion"]["estado"] if e else "no existe"}»)')


def correo_de(e, tipo):
    filas = [c for c in e['correos'] if c['tipo'] == tipo]
    assert len(filas) == 1, f'Tiene que haber UN correo de tipo {tipo} y hay {len(filas)}'
    return filas[0]


# ---------------------------------------------------------------------------
# Datos del formulario
# ---------------------------------------------------------------------------

def datos_formulario(formulario, **extra):
    d = {
        'quien_eres': 'Comercial de Prueba',
        'email_comercial': EMAIL_COMERCIAL,
        'cups': CUPS_LUZ,
        'oferta': 'Fijo 12 meses',
        'tarifa': '2.0TD',
        'p1': '4,6', 'p2': '4,6',
        'titular': 'Titular de Prueba SL' if formulario == 'gnew' else 'Titular Mega de Prueba SL',
        'cif_nif': '00000000T',
        'nombre_firmante': 'Firmante de Prueba',
        'dni_firmante': '12345678Z',
        'cuenta_bancaria': IBAN_TECLEADO,
        'dir_suministro': 'Calle de Prueba 1, 2.º A',
        'codigo_postal': '28001',
        'poblacion': 'Madrid',
        'provincia': 'Madrid',
        'movil': '600000000',
        'email_cliente': EMAIL_CLIENTE,
        'observaciones': 'Prueba automática de Tramitación v2',
    }
    if formulario == 'gnew':
        d['compania'] = 'Compañía de Prueba'
    d.update(extra)
    return d


# JPEG grande generado EN LA PÁGINA: degradado + ruido de baja resolución ampliado (pesa, pero no se sale de madre
# del tope de 30 MB del formulario). Devuelve el tamaño final del archivo creado.
JS_FOTO_GRANDE = """
async ({ancho, alto, bloque, calidad, nombre}) => {
  const lienzo = document.createElement('canvas');
  lienzo.width = ancho; lienzo.height = alto;
  const g = lienzo.getContext('2d');
  const grad = g.createLinearGradient(0, 0, ancho, alto);
  grad.addColorStop(0, '#2b5876'); grad.addColorStop(1, '#c9a24b');
  g.fillStyle = grad; g.fillRect(0, 0, ancho, alto);
  const w = Math.ceil(ancho / bloque), h = Math.ceil(alto / bloque);
  const ruido = document.createElement('canvas'); ruido.width = w; ruido.height = h;
  const gr = ruido.getContext('2d');
  const img = gr.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 65536) crypto.getRandomValues(img.data.subarray(i, Math.min(i + 65536, img.data.length)));
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  gr.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.globalAlpha = 0.85;
  g.drawImage(ruido, 0, 0, ancho, alto);
  const blob = await new Promise((resolver) => lienzo.toBlob(resolver, 'image/jpeg', calidad));
  const fichero = new File([blob], nombre, { type: 'image/jpeg', lastModified: Date.now() });
  const dt = new DataTransfer();
  dt.items.add(fichero);
  const entrada = document.getElementById('fileInput');
  entrada.files = dt.files;
  entrada.dispatchEvent(new Event('change', { bubbles: true }));
  return { size: blob.size, ancho, alto };
}
"""


# ---------------------------------------------------------------------------
# Un caso de prueba = un contexto de navegador limpio y todo lo que pasa en él
# ---------------------------------------------------------------------------

class Caso:
    def __init__(self, navegador, titulo, google_respuesta=None):
        self.titulo = titulo
        self.google_respuesta = google_respuesta  # None = el respaldo NO debe usarse (se aborta y falla)
        self.ctx = navegador.new_context(viewport=VIEWPORT, locale='es-ES', timezone_id='Europe/Madrid')
        self.ctx.set_default_timeout(30_000)
        self.page = self.ctx.new_page()
        self.errores_pagina = []   # pageerror
        self.errores_consola = []  # console de tipo error: {texto, url}
        self.rotas = []            # trozos de URL que este caso rompe a propósito (sus «Failed to load resource» son esperados)
        self.google = []           # peticiones al Apps Script (siempre interceptadas)
        self.violaciones = []      # lo que NO debe pasar jamás
        self.iniciar = []          # cuerpos JSON de las peticiones a /api/tramitacion/iniciar
        self.confirmar = []        # idem a confirmar
        self.puts = []             # subidas al almacén: {url, tipo, upsert, bytes}
        self.respuestas = []       # {ruta, status} de la API propia
        self._instalar()

    # -- instalación de oyentes y rutas ---------------------------------------------------------------
    def _instalar(self):
        p = self.page
        p.on('pageerror', lambda e: self.errores_pagina.append(str(e)))
        p.on('console', self._consola)
        p.on('request', self._peticion)
        p.on('response', self._respuesta)

        def externo(url):
            host = urllib.parse.urlparse(url).hostname or ''
            return not (url.startswith(BASE + '/') or host.endswith('.supabase.co'))

        self.ctx.route(externo, self._guardia)

    def _consola(self, msg):
        if msg.type == 'error':
            self.errores_consola.append({'texto': msg.text, 'url': (msg.location or {}).get('url', '')})

    def _peticion(self, req):
        url = req.url
        if url.startswith(BASE + '/api/tramitacion/iniciar'):
            self.iniciar.append(req.post_data_json)
        elif url.startswith(BASE + '/api/tramitacion/confirmar'):
            self.confirmar.append(req.post_data_json)
        elif req.method == 'PUT' and (urllib.parse.urlparse(url).hostname or '').endswith('.supabase.co'):
            cab = req.headers
            ruta = urllib.parse.urlparse(url).path
            if '/pruebas/' not in ruta:
                self.violaciones.append('Subida al almacén FUERA de pruebas/')
            self.puts.append({
                'ruta': ruta,
                'tipo': cab.get('content-type'),
                'upsert': cab.get('x-upsert'),
                'bytes': len(req.post_data_buffer or b''),
            })

    def _respuesta(self, resp):
        url = resp.url
        if url.startswith(BASE + '/api/'):
            self.respuestas.append({'ruta': urllib.parse.urlparse(url).path, 'status': resp.status})

    def _guardia(self, route, request):
        host = urllib.parse.urlparse(request.url).hostname or ''
        if host == 'script.google.com' or host.endswith('googleusercontent.com'):
            resumen = {'metodo': request.method}
            try:
                cuerpo = request.post_data_json
                resumen.update({
                    'ref_id': cuerpo.get('ref_id'),
                    'n_archivos': len(cuerpo.get('archivos', [])),
                    'archivos_con_base64': all(bool(a.get('data')) for a in cuerpo.get('archivos', [])),
                    'token': cuerpo.get('token'),
                    'hp': cuerpo.get('hp'),
                    'compania': cuerpo.get('compania'),
                    'tipo_suministro': cuerpo.get('tipo_suministro'),
                    'tiene_terminos': 'terminos' in cuerpo,
                })
            except Exception:
                pass
            self.google.append(resumen)
            if self.google_respuesta is None:
                self.violaciones.append('Petición NO esperada al Apps Script (se ha abortado)')
                return route.abort('blockedbyclient')
            return route.fulfill(status=200, body=self.google_respuesta,
                                 headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8'})
        if host.endswith('fonts.googleapis.com') or host.endswith('fonts.gstatic.com'):
            return route.fulfill(status=200, content_type='text/css', body='')
        self.violaciones.append(f'Petición externa NO esperada a {host}')
        return route.abort('blockedbyclient')

    # -- navegación y formulario ----------------------------------------------------------------------
    def ir(self, ruta):
        self.page.goto(BASE + ruta, wait_until='load')
        self.page.wait_for_selector('#contractForm')

    def rellenar(self, formulario, **extra):
        p = self.page
        for nombre, valor in datos_formulario(formulario, **extra).items():
            sel = f'[name="{nombre}"]'
            if p.locator(sel).evaluate('e => e.tagName') == 'SELECT':
                p.select_option(sel, valor)
            else:
                p.fill(sel, valor)
        p.check('#terminos')

    def adjuntar(self, *rutas):
        self.page.set_input_files('#fileInput', [str(r) for r in rutas])

    def firmar(self):
        """Dibuja una firma con el ratón en el lienzo (no queda en blanco: viaja como firma)."""
        p = self.page
        lienzo = p.locator('#signatureCanvas')
        lienzo.scroll_into_view_if_needed()
        caja = lienzo.bounding_box()
        x0, y0 = caja['x'] + 30, caja['y'] + 70
        p.mouse.move(x0, y0)
        p.mouse.down()
        for i in range(1, 26):
            p.mouse.move(x0 + i * 9, y0 + ((i * 7) % 40) - 20)
        p.mouse.up()

    def enviar(self):
        self.page.click('#submitBtn')

    def foto_grande(self, nombre='foto-grande.jpeg', ancho=4000, alto=3000, bloque=6, calidad=0.92):
        """Genera en la página un JPEG grande y lo adjunta (como si el comercial lo eligiera). Devuelve su tamaño."""
        r = self.page.evaluate(JS_FOTO_GRANDE, {'ancho': ancho, 'alto': alto, 'bloque': bloque, 'calidad': calidad, 'nombre': nombre})
        return r['size']

    # -- esperas y lecturas ---------------------------------------------------------------------------
    def esperar_gracias(self, segundos=90):
        """Espera a la página de gracias y devuelve la referencia que lleva la URL."""
        self.page.wait_for_url(REF_GRACIAS, timeout=segundos * 1000)
        return REF_GRACIAS.search(self.page.url).group(1)

    def texto_boton(self):
        try:
            return self.page.evaluate("() => document.getElementById('statusText').textContent")
        except Exception:
            return None  # la página está cambiando

    def ancho_barra(self):
        try:
            return self.page.evaluate("() => document.getElementById('subidaBarraRelleno').style.width")
        except Exception:
            return None

    def overlay(self):
        loc = self.page.locator('#overlayEnvio')
        return loc.inner_text() if loc.count() else None

    def refs_iniciar(self):
        return [c['ref'] for c in self.iniciar]

    def rota(self, *trozos):
        """Anota que este caso rompe a propósito estas URL: sus «Failed to load resource» no cuentan como error."""
        self.rotas.extend(trozos)

    # -- criterio de «0 errores de consola» -----------------------------------------------------------
    def consola_esperada(self, e):
        texto = e['texto']
        es_de_red = texto.startswith('Failed to load resource') or 'net::ERR_' in texto
        return es_de_red and any(t in e['url'] or t in texto for t in self.rotas)

    def consola_inesperada(self):
        return [e for e in self.errores_consola if not self.consola_esperada(e)]

    def comprobar_limpio(self):
        """Los criterios que valen para TODOS los casos."""
        assert not self.errores_pagina, f'Errores de página: {self.errores_pagina}'
        inesperados = self.consola_inesperada()
        assert not inesperados, f'Errores de consola inesperados: {[(e["texto"][:120]) for e in inesperados]}'
        assert not self.violaciones, f'Violaciones: {self.violaciones}'

    def cerrar(self):
        try:
            self.ctx.close()
        except Exception:
            pass
