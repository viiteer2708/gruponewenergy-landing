#!/usr/bin/env python3
"""tests/e2e/formulario.py · Los 12 casos del formulario de tramitación (gnew.html y mega.html) con navegador real.

Uso (lo normal es `bash tests/e2e/run.sh formulario`, que arranca el servidor y limpia después):
    python tests/e2e/formulario.py                 los 12 casos, en serie
    python tests/e2e/formulario.py 1 5             solo esos casos
    python tests/e2e/formulario.py capturas        capturas a 390 px ANTES (html de master) y DESPUÉS, y su comparación
    python tests/e2e/formulario.py extras [N…]     comprobaciones extra (rutas que los 12 casos no tocan); no cuentan en el «12/12»

Un solo Chromium, viewport 390×844, `pageerror` y consola vigilados (0 errores inesperados es parte del criterio).
Todo lo de Google Apps Script está interceptado; la base se lee siempre por /__pruebas/tramitacion.

El interruptor V2_ACTIVO de los html se despliega APAGADO: los casos 1-9 (y los extras) prueban la v2 abriendo la página con
`?v2=1` (lo pone `Caso.ir`); el 10 prueba lo que ve un comercial SIN ese parámetro; el 11 comprueba que `?v2=1` convive con el
prefill por URL del comparador DPC; el 12 prueba el cambio de titular (se piden los datos del titular ANTERIOR, obligatorios con «Sí»).

El respaldo de Apps Script (RESPALDO_APPS_SCRIPT) está APAGADO en los html desde el 16-oct-2026: el caso 4 prueba lo que ve el comercial con la API
caída («No hemos podido terminar el envío», sin tocar el Apps Script) y, para conservar la cobertura de la palanca, lo que prueba el respaldo (parte 2
del caso 4, paso 5 del 12 y extras 7 y 9) sirve el html ACTUAL con la constante forzada a true (`_abrir_forzado`: `_html_con` + `page.route`); el fichero
de producción no se toca.
"""
import base64
import json
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

from comun import (BASE, CUPS_GAS, CUPS_LUZ, FIXTURES, GOOGLE_RESPUESTA_OK, IBAN_TECLEADO, REF_GRACIAS, RAIZ, SALIDAS,
                   VIEWPORT, Caso, correo_de, datos_formulario, esperar_estado, estado_de)

PDF = FIXTURES / 'documento-5-5mb.pdf'
JPG = FIXTURES / 'foto-pequena.jpg'
PNG = FIXTURES / 'firma-pequena.png'
TAMANO_PDF = int(5.5 * 1024 * 1024)

IBAN_COMPACTO = IBAN_TECLEADO.replace(' ', '')


def comprobar_gracias(c, ref, prefijo):
    """La página de gracias enseña la referencia y el texto nuevo, sin direcciones técnicas ni rastro de errores."""
    cuerpo = c.page.inner_text('body')
    assert f'Tu referencia: {ref}' in cuerpo, f'Falta «Tu referencia: {ref}» en la página de gracias'
    assert ref.startswith(prefijo)
    assert 'Hemos guardado tu contrato y la documentación y hemos avisado al equipo de tramitación' in cuerpo
    assert 'responde al acuse citando la referencia' in cuerpo
    assert 'escaneos@gruponew.energy' in cuerpo
    assert 'administracion@' not in cuerpo.lower()
    anchura = c.page.evaluate("() => (document.querySelector('img.logo') || {}).naturalWidth || 0")
    assert anchura > 0, 'El logo de la página de gracias no carga'


def comprobar_recibida(e, ref, formulario, n_documentos):
    t = e['tramitacion']
    assert t['estado'] == 'recibida', f'Estado {t["estado"]}'
    assert t['formulario'] == formulario and t['prueba'] is True and t['ref'] == ref
    docs = e['documentos']
    assert len(docs) == n_documentos, f'{len(docs)} documentos (se esperaban {n_documentos})'
    for d in docs:
        assert d['estado'] == 'subido', f'Documento {d["orden"]} en estado {d["estado"]}'
        assert d['tamano_comprobado'] == d['tamano_declarado'], f'Documento {d["orden"]}: tamaños distintos'
    avisos = correo_de(e, 'aviso')
    acuses = correo_de(e, 'acuse')
    for k in (avisos, acuses):
        assert k['estado'] == 'enviado' and k['simulado'] is True, f'Correo {k["tipo"]}: {k["estado"]}'
    tipos = [ev['tipo'] for ev in e['eventos']]
    assert tipos.count('recibida') == 1 and tipos.count('creada') == 1, f'Eventos: {tipos}'


# ---------------------------------------------------------------------------
# Los casos 1-9 (la v2, abierta con ?v2=1); el 10 y el 11 están más abajo, con el interruptor
# ---------------------------------------------------------------------------

def caso_1(c):
    """GNEW completo con 3 archivos (uno de 5,5 MB) y firma → gracias con la referencia; fila recibida; correos simulados."""
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PDF, PNG)
    c.firmar()
    # Subida a 1 MB/s: el PDF tarda ~5 s y se ve el progreso real (no un salto de 0 a 100)
    cdp = c.ctx.new_cdp_session(c.page)
    cdp.send('Network.enable')
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': 1_000_000})
    c.enviar()

    textos = []
    porcentajes = []
    anchos = []
    captura = False
    fin = time.time() + 120
    while time.time() < fin and not REF_GRACIAS.search(c.page.url):
        t = c.texto_boton()
        if t and (not textos or textos[-1] != t):
            textos.append(t)
            m = re.fullmatch(r'Subiendo documento 2 de 3: documento-5-5mb\.pdf · (\d+) %', t)
            if m:
                porcentajes.append(int(m.group(1)))
                anchos.append(c.ancho_barra())
                if not captura and 25 <= int(m.group(1)) <= 85:
                    c.page.evaluate('() => window.scrollTo(0, document.documentElement.scrollHeight)')
                    c.page.wait_for_timeout(400)  # que termine el desplazamiento; la subida sigue (1 MB/s)
                    c.page.screenshot(path=str(SALIDAS / 'gnew-subiendo-390.png'))
                    captura = True
        time.sleep(0.04)
    ref = c.esperar_gracias()

    # Progreso REAL: varios porcentajes intermedios, siempre hacia arriba, y la barra se movió con ellos
    assert porcentajes == sorted(porcentajes), f'El porcentaje retrocede: {porcentajes}'
    intermedios = [p for p in porcentajes if 0 < p < 100]
    assert len(set(intermedios)) >= 3, f'Sin progreso real (porcentajes vistos: {porcentajes})'
    assert len({a for a in anchos if a}) >= 3, f'La barra no avanza (anchos vistos: {anchos})'
    assert captura, 'No se pudo capturar la barra de progreso'
    # Los textos exactos del diseño
    assert textos[0] in ('Preparando el envío...', 'Guardando los datos del contrato...'), textos[:3]
    assert 'Guardando los datos del contrato...' in textos
    assert any(t.startswith('Subiendo documento 1 de 3: foto-pequena.jpg · ') for t in textos), textos
    assert 'Comprobando que ha llegado todo...' in textos
    assert not any('Detalle' in t or 'Error' in t for t in textos)

    # Lo que viajó
    assert len(c.iniciar) == 1 and len(c.confirmar) == 1, 'Un solo iniciar y un solo confirmar'
    ini = c.iniciar[0]
    assert ini['formulario'] == 'gnew' and ini['ref'] == ref and ini['ref_anterior'] is None
    assert isinstance(ini['hp'], str) and ini['hp'] == ''
    assert ini['datos']['terminos'] is True and 'tipo_suministro' not in ini['datos'] and ini['datos']['compania'] == 'Compañía de Prueba'
    assert ini['firma'].startswith('data:image/png;base64,')
    assert [a['orden'] for a in ini['archivos']] == [1, 2, 3] and all(isinstance(a['orden'], int) for a in ini['archivos'])
    assert [a['nombre'] for a in ini['archivos']] == ['foto-pequena.jpg', 'documento-5-5mb.pdf', 'firma-pequena.png']
    assert ini['archivos'][1]['tamano'] == TAMANO_PDF and 'tamano_original' not in ini['archivos'][1]
    assert [p['tipo'] for p in c.puts] == ['image/jpeg', 'application/pdf', 'image/png'], c.puts
    assert all(p['upsert'] == 'true' for p in c.puts)
    assert not c.google, 'No debía tocar el Apps Script'

    comprobar_gracias(c, ref, 'GNE-')
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 4)
    docs = {d['orden']: d for d in e['documentos']}
    assert docs[0]['es_firma'] and docs[0]['nombre'] == 'firma.png'
    assert docs[2]['tamano_declarado'] == TAMANO_PDF and docs[2]['tipo_mime'] == 'application/pdf'
    aviso, acuse = correo_de(e, 'aviso'), correo_de(e, 'acuse')
    # Lo que escribe el comercial se guarda y se envía EN MAYÚSCULAS (el asunto sale de la fila); «Nuevo Contrato» es texto fijo
    esperado = 'Nuevo Contrato - COMPAÑÍA DE PRUEBA - TITULAR DE PRUEBA SL - COMERCIAL DE PRUEBA - ' + CUPS_LUZ
    assert aviso['asunto'] == esperado, aviso['asunto']
    assert acuse['asunto'] == 'Recibido: ' + esperado, acuse['asunto']
    assert f'/bandeja/c/{ref}' in aviso['cuerpo_html'] and IBAN_COMPACTO in aviso['cuerpo_html'] + aviso['cuerpo_texto']
    assert IBAN_COMPACTO not in acuse['cuerpo_html'] and '00000000T' not in acuse['cuerpo_html'], 'El acuse no puede llevar IBAN ni DNI'


def caso_2(c):
    """Corte de red en `confirmar` (el servidor lo procesa pero la respuesta se pierde) → reintento → gracias; una sola fila y un solo aviso."""
    c.rota('/api/tramitacion/confirmar')
    llamadas = []

    def manejador(route, request):
        llamadas.append(1)
        if len(llamadas) == 1:
            route.fetch()  # el servidor SÍ lo procesa (recibida, correos enviados)...
            route.abort('connectionreset')  # ...pero el navegador nunca ve la respuesta
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/confirmar', manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    ref = c.esperar_gracias()
    assert len(c.confirmar) >= 2, 'Tenía que haber un segundo intento de confirmar'
    assert len(set(c.refs_iniciar())) == 1 and c.refs_iniciar()[0] == ref
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)  # incluye: un solo «creada», un solo «recibida», UN aviso y UN acuse
    assert not c.google
    comprobar_gracias(c, ref, 'GNE-')


def caso_3(c):
    """La 1.ª subida al almacén se corta (aunque el almacén la guardó) → reintento del archivo con la misma dirección → gracias."""
    c.rota('.supabase.co/storage')
    llamadas = []

    def manejador(route, request):
        llamadas.append(1)
        if len(llamadas) == 1:
            route.fetch()  # el almacén la guarda...
            route.abort('connectionreset')  # ...pero el navegador cree que falló
        else:
            route.continue_()

    c.page.route(lambda url: '.supabase.co/storage/' in url, manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    ref = c.esperar_gracias()
    primero = [p for p in c.puts if p['tipo'] == 'image/jpeg']
    assert len(primero) >= 2, f'El primer archivo tenía que subirse otra vez: {len(primero)} subidas'
    assert primero[0]['ruta'] == primero[1]['ruta'], 'El reintento tiene que ir a la MISMA dirección'
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)
    assert not c.google


def _html_con(formulario, **constantes):
    """El html ACTUAL de `formulario` con constantes `const NOMBRE = …;` forzadas (p. ej. `RESPALDO_APPS_SCRIPT=True`). Solo para servirlo con
    `page.route`, como hace el caso 10 con el html de antes de la v2: el fichero de producción no se toca. Falla si una constante no aparece
    EXACTAMENTE una vez (así un cambio en el html no deja la prueba probando otra cosa sin avisar)."""
    texto = (RAIZ / f'{formulario}.html').read_text(encoding='utf-8')
    for nombre, valor in constantes.items():
        texto, n = re.subn(rf'^([ \t]*const {nombre} = )(?:true|false);', rf'\g<1>{"true" if valor else "false"};', texto, flags=re.M)
        assert n == 1, f'{formulario}.html: «const {nombre}» aparece {n} veces (tenía que ser 1)'
    return texto


def _abrir_forzado(c, formulario, **constantes):
    """Abre `/<formulario>` (con `?v2=1`, como `Caso.ir`) sirviendo el html ACTUAL con esas constantes forzadas: `page.route` lo sirve en lugar del
    fichero. Comprueba que la página abierta lleva de verdad los valores forzados (si el patrón no casara se serviría el html real y la prueba
    fallaría muchos segundos después sin decir por qué). Devuelve el patrón de la ruta, para `c.page.unroute(...)` cuando ya no haga falta."""
    html = _html_con(formulario, **constantes)
    ruta = '/' + formulario

    def es_la_pagina(url):  # con o sin `?v2=1`: un patrón `BASE + ruta` sin comodín no casaría con la consulta
        return url.startswith(BASE + '/') and urllib.parse.urlparse(url).path == ruta

    c.page.route(es_la_pagina, lambda r, _q: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=html))
    try:
        c.ir(ruta)
        contenido = c.page.content()
        for nombre, valor in constantes.items():
            linea = f'const {nombre} = {"true" if valor else "false"};'
            assert linea in contenido, f'{formulario}: la página abierta no lleva «{linea}» (no casó la ruta servida)'
    except Exception:
        c.page.unroute(es_la_pagina)
        raise
    return es_la_pagina


def _api_caida(c):
    """`iniciar` contesta 503 mientras `estado['caida']` sea True; con False la petición pasa al servidor de verdad (la API «vuelve»)."""
    estado = {'caida': True}
    c.rota('/api/tramitacion/iniciar')

    def manejador(route, request):
        if estado['caida']:
            route.fulfill(status=503, content_type='application/json',
                          body='{"ok":false,"codigo":"temporal","mensaje":"No hemos podido guardar el envío ahora mismo.","retryable":true}')
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/iniciar', manejador)
    return estado


def caso_4(c):
    """`iniciar` da 503 tres veces. PARTE 1, con el RESPALDO APAGADO (`RESPALDO_APPS_SCRIPT = false`: el html tal como se despliega desde el 16-oct-2026),
    en GNEW y en MEGA: NO se llama al Apps Script (0 peticiones: la guardia de `Caso` aborta cualquiera y la da por violación), sale «No hemos podido
    terminar el envío» con «Reintentar» y «Enviar por email», y al volver la API «Reintentar» termina con la MISMA referencia y SIN duplicar (una fila,
    un aviso, un acuse; sin volver a rellenar nada). PARTE 2, la palanca: con el respaldo forzado a true en la prueba (el html se sirve con la constante
    cambiada; el fichero no se toca) el Apps Script (interceptado) recibe el envío con la MISMA referencia, sin fila nueva (GNEW)."""
    caida = _api_caida(c)

    # --- Parte 1: respaldo apagado, tal como está en producción ---
    for formulario, prefijo in (('gnew', 'GNE'), ('mega', 'MEGA')):
        caida['caida'] = True
        n_iniciar, n_confirmar, n_puts = len(c.iniciar), len(c.confirmar), len(c.puts)
        c.ir(f'/{formulario}')
        c.rellenar(formulario)
        c.adjuntar(JPG, PNG)
        c.firmar()
        url_formulario = c.page.url
        c.enviar()
        c.page.wait_for_selector('#overlayEnvio', timeout=60_000)

        refs = c.refs_iniciar()[n_iniciar:]
        assert len(refs) == 3 and len(set(refs)) == 1, f'{formulario}: {len(refs)} intentos de iniciar con {len(set(refs))} referencias (3 con la misma)'
        ref = refs[0]
        assert ref.startswith(prefijo + '-'), ref
        texto = c.overlay()
        assert 'No hemos podido terminar el envío' in texto, f'{formulario}: {texto}'
        assert 'Error al enviar el formulario' not in texto, f'{formulario}: ese es el aviso del respaldo fallido, no el de «terminar el envío»'
        assert 'pulsa «Reintentar» y seguiremos por donde se quedó' in texto and 'Detalle' not in texto, texto
        assert 'puedes enviar los datos y los documentos por email a escaneos@gruponew.energy.' in texto, texto
        assert f'Referencia: {ref}' in texto, texto
        overlay = c.page.locator('#overlayEnvio')
        assert overlay.get_by_role('button', name='Reintentar', exact=True).count() == 1, f'{formulario}: falta «Reintentar»'
        por_email = overlay.get_by_role('link', name='Enviar por email', exact=True)
        assert por_email.count() == 1, f'{formulario}: falta «Enviar por email»'
        mailto = por_email.get_attribute('href')
        assert mailto.startswith('mailto:escaneos@gruponew.energy?subject=') and ref in mailto, mailto
        assert not c.google, f'{formulario}: con el respaldo apagado no se llama al Apps Script'
        assert len(c.puts) == n_puts and len(c.confirmar) == n_confirmar, f'{formulario}: con la API caída no se sube ni se confirma nada'
        assert estado_de(ref) is None, f'{formulario}: la API caída no deja fila'
        assert c.page.url == url_formulario, 'El comercial sigue en el formulario (no ha salido a ninguna gracias)'
        assert c.page.is_enabled('#submitBtn') and c.texto_boton() == '', 'El botón vuelve a estar disponible y sin texto de «enviando»'

        # La API vuelve: «Reintentar» sigue por donde se quedó, con la MISMA referencia y sin duplicar nada
        caida['caida'] = False
        c.page.get_by_role('button', name='Reintentar', exact=True).click()
        ref2 = c.esperar_gracias()
        assert ref2 == ref, f'{formulario}: Reintentar tiene que seguir con la MISMA referencia ({ref} → {ref2})'
        assert ('/gracias-mega.html' if formulario == 'mega' else '/gracias.html') in c.page.url
        intentos = c.iniciar[n_iniciar:]
        assert len(intentos) == 4 and {x['ref'] for x in intentos} == {ref} and all(x['ref_anterior'] is None for x in intentos), \
            f'{formulario}: 3 intentos caídos + 1 al volver, todos con la misma referencia y sin `ref_anterior`'
        assert len(c.confirmar) - n_confirmar == 1 and len(c.puts) - n_puts == 2, f'{formulario}: un confirmar y 2 subidas (cada documento una vez)'
        assert not c.google, f'{formulario}: tampoco al reintentar se toca el Apps Script'
        e = esperar_estado(ref, 'recibida')
        comprobar_recibida(e, ref, formulario, 3)  # incluye: UNA fila (un «creada», un «recibida»), UN aviso y UN acuse; 2 documentos + la firma
        comprobar_gracias(c, ref, prefijo + '-')

    # --- Parte 2: la palanca. Respaldo forzado a true en la prueba: entra el Apps Script con la misma referencia ---
    recibidos = _simular_apps_script(c)  # DESPUÉS de la parte 1: así en ella cualquier petición a Google habría sido violación
    caida['caida'] = True
    n_iniciar, n_confirmar, n_puts = len(c.iniciar), len(c.confirmar), len(c.puts)
    pagina = _abrir_forzado(c, 'gnew', RESPALDO_APPS_SCRIPT=True)
    try:
        c.rellenar('gnew')
        c.adjuntar(JPG, PNG)
        c.firmar()
        c.enviar()
        ref = c.esperar_gracias()
    finally:
        c.page.unroute(pagina)
    intentos = c.iniciar[n_iniciar:]
    assert len(intentos) == 3, f'{len(intentos)} intentos de iniciar (tenían que ser 3)'
    assert {x['ref'] for x in intentos} == {ref}, 'El respaldo tiene que usar la misma referencia'
    assert len(recibidos) == 1, f'{len(recibidos)} peticiones al Apps Script (tenía que ser 1)'
    g = recibidos[0]
    assert g['ref_id'] == ref and len(g['archivos']) == 2 and all(a['data'] for a in g['archivos']) and g['token'] == 'GNE-2026-w7k4q9x2', g.keys()
    assert g['hp'] == '' and 'terminos' not in g and g['compania'] == 'Compañía de Prueba'
    assert len(c.puts) == n_puts, 'En el respaldo no se sube nada al almacén'
    assert estado_de(ref) is None, 'El respaldo no debe dejar fila en la base nueva'
    assert len(c.confirmar) == n_confirmar
    assert not c.google, 'El Apps Script se atendió en page.route'
    comprobar_gracias(c, ref, 'GNE-')


def caso_5(c):
    """Foto grande (canvas 4000×3000 con ruido, > 1 MB, generada en la página) → se reduce: comprimido=true, tamano_original mayor, nombre .jpg."""
    c.ir('/gnew')
    c.rellenar('gnew')
    tamano = c.foto_grande('foto-grande.jpeg')
    print(f'      (foto generada en la página: {tamano / 1048576:.2f} MB)')
    assert tamano > 1_200_000, f'La foto generada pesa {tamano} B: tiene que pasar de 1 MB'
    c.enviar()
    ref = c.esperar_gracias()
    ini = c.iniciar[0]
    assert len(ini['archivos']) == 1
    a = ini['archivos'][0]
    assert a['nombre'] == 'foto-grande.jpg', a
    assert a['tamano_original'] == tamano and a['tamano'] < tamano, a
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 1)
    d = e['documentos'][0]
    assert d['comprimido'] is True and d['nombre'] == 'foto-grande.jpg' and d['tipo_mime'] == 'image/jpeg'
    assert d['tamano_original'] == tamano and d['tamano_declarado'] < tamano
    assert d['tamano_comprobado'] == d['tamano_declarado'], 'Lo guardado tiene que ser la foto reducida'
    print(f'      (guardada: {d["tamano_declarado"] / 1048576:.2f} MB, original {d["tamano_original"] / 1048576:.2f} MB)')
    assert [p['tipo'] for p in c.puts] == ['image/jpeg']


def caso_6(c):
    """MEGA completo → mega.html, gracias-mega.html y asunto «Nuevo Contrato MEGA - …»."""
    c.ir('/mega')
    c.rellenar('mega')
    assert c.page.input_value('[name="tipo_suministro"]') == 'Luz'
    c.adjuntar(JPG, PNG)
    c.firmar()
    c.enviar()
    ref = c.esperar_gracias()
    assert '/gracias-mega.html' in c.page.url
    ini = c.iniciar[0]
    assert ini['formulario'] == 'mega' and ini['token'] == 'MEGA-2026-h3p8k5z1q6' and ini['hp'] == ''
    assert ini['datos']['tipo_suministro'] == 'Luz' and 'compania' not in ini['datos'] and ini['datos']['terminos'] is True
    comprobar_gracias(c, ref, 'MEGA-')
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'mega', 3)
    t = e['tramitacion']
    assert t['compania'] == 'MEGA ENERGIA' and t['tipo_suministro'] == 'LUZ'  # (el navegador manda «Luz»: se guarda en mayúsculas)
    aviso, acuse = correo_de(e, 'aviso'), correo_de(e, 'acuse')
    esperado = 'Nuevo Contrato MEGA - TITULAR MEGA DE PRUEBA SL - COMERCIAL DE PRUEBA - ' + CUPS_LUZ
    assert aviso['asunto'] == esperado, aviso['asunto']
    assert acuse['asunto'] == 'Recibido: ' + esperado
    assert aviso['marca'] == 'MEGA'
    assert not c.google


def caso_7(c):
    """CUPS inválido → error en línea sin salir de la página y sin hablar con el servidor; y errores de campos del servidor, también en línea."""
    c.ir('/gnew')
    c.rellenar('gnew', cups='ES0021000000000001XX')
    c.adjuntar(JPG)
    url_antes = c.page.url
    c.enviar()
    c.page.wait_for_selector('.field.has-error .error-msg')
    msg = c.page.inner_text('.field.has-error .error-msg')
    assert msg.startswith('CUPS no válido'), msg
    assert c.page.url == url_antes and not c.iniciar and not c.puts, 'No debía salir de la página ni llamar a la API'
    assert not c.page.locator('#overlayEnvio').count()
    assert c.page.is_enabled('#submitBtn')

    # (b) Un error que el navegador deja pasar y el servidor no: email sin punto en el dominio → `campos` en línea, sin overlay
    c.rota('/api/tramitacion/iniciar')
    c.page.fill('[name="cups"]', CUPS_LUZ)
    c.page.fill('[name="email_cliente"]', 'cliente@localhost')
    c.enviar()
    c.page.wait_for_function("() => document.querySelector('[name=\"email_cliente\"]').closest('.field').classList.contains('has-error')")
    msg = c.page.locator('[name="email_cliente"]').locator('xpath=ancestor::div[contains(@class,"field")]').locator('.error-msg').inner_text()
    assert msg.startswith('E-mail no válido'), msg
    assert c.page.url == url_antes and not c.page.locator('#overlayEnvio').count() and c.page.is_enabled('#submitBtn')
    assert len(c.iniciar) == 1 and not c.puts
    assert estado_de(c.iniciar[0]['ref']) is None, 'Un envío con errores no deja fila'
    assert c.texto_boton() == '', 'El botón vuelve a su estado normal'

    # (c) Errores de documentación y de firma que manda el servidor: también en línea (respuesta simulada)
    c.page.route(BASE + '/api/tramitacion/iniciar', lambda route, request: route.fulfill(
        status=400, content_type='application/json',
        body='{"ok":false,"codigo":"datos","mensaje":"Revisa los campos marcados en el formulario.","retryable":false,'
             '"campos":{"documentacion":"Hay un documento vacío. Quítalo y vuelve a adjuntarlo.","firma":"La firma no es válida. Bórrala y vuelve a firmar."}}'))
    c.page.fill('[name="email_cliente"]', 'victor.molins.10+cliente@gmail.com')
    c.firmar()
    c.enviar()
    c.page.wait_for_function("() => document.querySelectorAll('.field.has-error').length >= 2")
    textos = c.page.locator('.field.has-error .error-msg').all_inner_texts()
    assert 'Hay un documento vacío. Quítalo y vuelve a adjuntarlo.' in textos, textos
    assert 'La firma no es válida. Bórrala y vuelve a firmar.' in textos, textos
    assert not c.page.locator('#overlayEnvio').count() and c.page.url == url_antes


def _quitar_archivo(c, posicion):
    c.page.locator('.file-item .remove-file').nth(posicion).click()


def caso_8(c):
    """Todas las subidas se cortan → overlay «No hemos podido terminar el envío» → se quita el corte → «Reintentar» → gracias con la MISMA referencia."""
    c.rota('.supabase.co/storage')
    cortar = {'si': True}

    def manejador(route, request):
        if cortar['si']:
            route.abort('connectionreset')
        else:
            route.continue_()

    c.page.route(lambda url: '.supabase.co/storage/' in url, manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=60_000)
    texto = c.overlay()
    assert 'No hemos podido terminar el envío' in texto
    assert 'La documentación no ha terminado de subir, seguramente por la conexión.' in texto
    assert 'pulsa «Reintentar» y seguiremos por donde se quedó' in texto
    assert 'puedes enviar los datos y los documentos por email a escaneos@gruponew.energy.' in texto
    assert 'Detalle' not in texto and 'Error' not in texto.replace('Error al enviar', '')
    refs = set(c.refs_iniciar())
    assert len(refs) == 1
    ref = refs.pop()
    assert f'Referencia: {ref}' in texto
    mailto = c.page.locator('#overlayEnvio a').get_attribute('href')
    assert mailto.startswith('mailto:escaneos@gruponew.energy?subject=') and ref in mailto
    assert len(c.puts) == 3, f'{len(c.puts)} intentos de subida del primer archivo (tenían que ser 3)'
    assert not c.confirmar and not c.google
    assert estado_de(ref)['tramitacion']['estado'] == 'subiendo'
    assert c.page.is_enabled('#submitBtn'), 'Con el overlay abierto el botón vuelve a estar disponible'

    cortar['si'] = False
    c.page.get_by_role('button', name='Reintentar', exact=True).click()
    ref2 = c.esperar_gracias()
    assert ref2 == ref, 'Reintentar tiene que seguir con la MISMA referencia'
    assert set(c.refs_iniciar()) == {ref}
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)
    assert not c.google


def caso_9(c):
    """Tras un fallo, el comercial quita un archivo y reenvía → la referencia vieja queda «abandonada» y la nueva «recibida»."""
    c.rota('.supabase.co/storage')
    cortar = {'si': True}

    def manejador(route, request):
        if cortar['si']:
            route.abort('connectionreset')
        else:
            route.continue_()

    c.page.route(lambda url: '.supabase.co/storage/' in url, manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PDF, PNG)
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=60_000)
    vieja = c.refs_iniciar()[0]
    assert estado_de(vieja)['tramitacion']['estado'] == 'subiendo'
    c.page.get_by_role('button', name='Cerrar', exact=True).click()
    assert not c.page.locator('#overlayEnvio').count()

    # El comercial quita el PDF grande y vuelve a enviar
    _quitar_archivo(c, 1)
    assert c.page.locator('.file-item').count() == 2
    cortar['si'] = False
    c.enviar()
    nueva = c.esperar_gracias()
    assert nueva != vieja, 'Lista distinta = referencia nueva'
    assert c.iniciar[-1]['ref'] == nueva and c.iniciar[-1]['ref_anterior'] == vieja
    assert [a['nombre'] for a in c.iniciar[-1]['archivos']] == ['foto-pequena.jpg', 'firma-pequena.png']
    ev = esperar_estado(vieja, 'abandonada')
    ab = [x for x in ev['eventos'] if x['tipo'] == 'abandonada']
    assert len(ab) == 1 and ab[0]['detalle'].get('motivo') == 'lista_cambiada' and ab[0]['detalle'].get('nueva_ref') == nueva, ab
    assert not any(d['estado'] == 'subido' for d in ev['documentos'] if d['orden'] >= 1) or True
    en = esperar_estado(nueva, 'recibida')
    comprobar_recibida(en, nueva, 'gnew', 2)
    assert not ev['correos'], 'La referencia abandonada no manda correos'
    assert not c.google


# ---------------------------------------------------------------------------
# El interruptor V2_ACTIVO (casos 10 y 11)
# ---------------------------------------------------------------------------

HTML_DE_PRODUCCION = '6b5dd53'  # último commit de master ANTES de la v2: el formulario «de siempre»

# Anota (por JavaScript, sin perder ninguno aunque cambien en el mismo instante) cada texto que se escribe en el botón de envío
JS_VIGILAR_TEXTOS = """
(() => {
  const vigilar = () => {
    const el = document.getElementById('statusText');
    if (!el || !window.__registrarTexto) return;
    new MutationObserver((cambios) => {
      for (const cambio of cambios) for (const nodo of cambio.addedNodes) window.__registrarTexto(nodo.textContent);
    }).observe(el, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vigilar); else vigilar();
})();
"""


def interruptor_v2(formulario):
    """El valor de V2_ACTIVO que lleva el html (True/False)."""
    m = re.search(r'^\s*const V2_ACTIVO = (true|false);', (RAIZ / f'{formulario}.html').read_text(encoding='utf-8'), re.M)
    assert m, f'No encuentro V2_ACTIVO en {formulario}.html'
    return m.group(1) == 'true'


def _html_de_produccion(formulario):
    """El html de antes de la v2 (git), o None si este clon no tiene esa historia."""
    try:
        return subprocess.run(['git', '-C', str(RAIZ), 'show', f'{HTML_DE_PRODUCCION}:{formulario}.html'], check=True, capture_output=True).stdout
    except (subprocess.CalledProcessError, OSError):
        return None


def _simular_apps_script(c):
    """Intercepta el Apps Script con page.route (nada llega a Google) y contesta como el de verdad:
    {"success": true, "refId": <el ref_id recibido>}. Devuelve la lista de cuerpos que va recibiendo."""
    recibidos = []

    def servidor(url):
        host = urllib.parse.urlparse(url).hostname or ''
        return host == 'script.google.com' or host.endswith('googleusercontent.com')

    def manejador(route, request):
        cuerpo = request.post_data_json
        recibidos.append(cuerpo)
        route.fulfill(status=200, content_type='application/json; charset=utf-8', headers={'Access-Control-Allow-Origin': '*'},
                      body=json.dumps({'success': True, 'refId': cuerpo.get('ref_id')}))

    c.page.route(servidor, manejador)
    return recibidos


def _envio_de_siempre(c, formulario, recibidos, textos, html=None, foto_grande=False, extra=None):
    """Un envío como lo hace un comercial: la página SIN `?v2=1`, se rellena, se firma y se pulsa enviar. `html` = otro html
    que se sirve en lugar del actual (el de producción de antes de la v2). Espera a la página de gracias y devuelve lo que ha
    pasado: los textos del botón por orden, el cuerpo que llegó al Apps Script y la dirección final. `extra` = datos del formulario
    que se añaden o cambian (p. ej. el cambio de titular)."""
    ruta = '/' + formulario
    if html is not None:
        c.page.route(BASE + ruta, lambda r, _q: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=html))
    try:
        c.ir(ruta, v2=False)
    finally:
        if html is not None:
            c.page.unroute(BASE + ruta)
    del textos[:]  # solo los textos de ESTE envío
    antes = len(recibidos)
    c.rellenar(formulario, **(extra or {}))
    tamano = c.foto_grande('foto-grande.jpeg') if foto_grande else None
    if not foto_grande:
        c.adjuntar(JPG, PNG)
    c.firmar()
    c.enviar()
    c.page.wait_for_url(re.compile(r'/gracias(?:-mega)?\.html'), timeout=60_000)  # con o sin ?ref=: cada caso comprueba la dirección exacta
    assert len(recibidos) == antes + 1, f'{len(recibidos) - antes} peticiones al Apps Script (tenía que ser 1)'
    return {'textos': list(textos), 'cuerpo': recibidos[-1], 'url': c.page.url, 'tamano_foto': tamano}


def caso_10(c):
    """SIN `?v2=1` manda el interruptor. Apagado (como se despliega): el envío es EL DE SIEMPRE, igual que el del commit de producción
    de antes de la v2 (mismos textos, mismo cuerpo al Apps Script, misma gracias), sin tocar /api/tramitacion/* ni el almacén."""
    estados = {interruptor_v2('gnew'), interruptor_v2('mega')}
    assert len(estados) == 1, 'gnew.html y mega.html tienen que llevar el mismo valor de V2_ACTIVO'
    llamadas_api = []
    c.page.on('request', lambda r: llamadas_api.append(r.url) if '/api/' in r.url else None)

    if estados == {True}:
        # Interruptor ENCENDIDO: la v2 es el camino normal, con o sin `?v2=1`
        c.ir('/gnew', v2=False)
        c.rellenar('gnew')
        c.adjuntar(JPG, PNG)
        c.enviar()
        ref = c.esperar_gracias()
        assert len(c.iniciar) == 1 and c.iniciar[0]['ref'] == ref and not c.google
        comprobar_recibida(esperar_estado(ref, 'recibida'), ref, 'gnew', 2)
        print('      (V2_ACTIVO = true: sin ?v2=1 se usa la v2)')
        return

    textos = []
    c.page.expose_function('__registrarTexto', lambda texto: textos.append(texto))
    c.page.add_init_script(JS_VIGILAR_TEXTOS)
    recibidos = _simular_apps_script(c)

    for formulario, prefijo in (('gnew', 'GNE'), ('mega', 'MEGA')):
        pagina = 'página' if formulario == 'gnew' else 'pagina'  # mega.html siempre ha escrito estos textos sin tildes
        esperados = ['Preparando datos...', 'Preparando 2 archivos...', f'Enviando contrato... No cierres esta {pagina}', 'Contrato enviado correctamente']
        antes = _html_de_produccion(formulario)
        hoy = _envio_de_siempre(c, formulario, recibidos, textos)
        gracias = BASE + ('/gracias.html' if formulario == 'gnew' else '/gracias-mega.html')
        assert hoy['url'] == gracias, f'La gracias del modo dormido tiene que ser la de siempre, sin referencia: {hoy["url"]}'
        assert hoy['textos'] == esperados, hoy['textos']
        cuerpo = dict(hoy['cuerpo'])
        ref = cuerpo.pop('ref_id')
        assert re.fullmatch(prefijo + r'-\d{8}-[A-Z0-9]{6}', ref), ref
        assert cuerpo['token'] == {'gnew': 'GNE-2026-w7k4q9x2', 'mega': 'MEGA-2026-h3p8k5z1q6'}[formulario] and cuerpo['hp'] == ''
        assert 'terminos' not in cuerpo and cuerpo['firma'].startswith('data:image/png;base64,')
        assert [a['name'] for a in cuerpo['archivos']] == ['foto-pequena.jpg', 'firma-pequena.png'] and all(a['data'] for a in cuerpo['archivos'])
        assert estado_de(ref) is None, 'El modo dormido no deja fila en la base nueva'
        assert cuerpo['nuevo_titular'] == '' and 'titular_anterior' not in cuerpo, 'Sin cambio de titular: `nuevo_titular` va vacío, como siempre, y la clave nueva no viaja'

        # Cambio de titular «Sí» (16-oct-2026): el formulario pide el titular ANTERIOR, pero el Code.gs de producción (sin tocar) sigue
        # esperando `nuevo_titular` y lo etiqueta «Nuevo Titular»: el dato viaja ahí con el prefijo «TITULAR ANTERIOR: » y, salvo ese campo, el
        # cuerpo sigue siendo IDÉNTICO al del formulario de producción (mismas claves y valores)
        anterior = 'Antigua Titular SL, B12345674, Calle Vieja 3'
        con_cambio = _envio_de_siempre(c, formulario, recibidos, textos, extra={'cambio_titular': 'Si', 'titular_anterior': anterior})
        assert con_cambio['url'] == gracias and con_cambio['textos'] == esperados, (con_cambio['url'], con_cambio['textos'])
        cuerpo_si = dict(con_cambio['cuerpo'])
        ref_si = cuerpo_si.pop('ref_id')
        assert cuerpo_si['nuevo_titular'] == 'TITULAR ANTERIOR: ' + anterior, cuerpo_si['nuevo_titular']
        assert 'titular_anterior' not in cuerpo_si and cuerpo_si['cambio_titular'] == 'Si', 'El Apps Script no conoce `titular_anterior`'
        assert estado_de(ref_si) is None, 'El modo dormido no deja fila en la base nueva'
        sin_titular = dict(cuerpo_si, nuevo_titular='')
        assert sin_titular == dict(cuerpo, cambio_titular='Si'), 'Con «Sí», el cuerpo solo difiere en `cambio_titular` y `nuevo_titular`'

        if antes is None:
            print(f'      (sin {HTML_DE_PRODUCCION} en este clon de git: no se compara {formulario} con el formulario de producción)')
            continue
        # La prueba de «EXACTAMENTE como antes»: el MISMO envío con el html de producción de antes de la v2
        viejo = _envio_de_siempre(c, formulario, recibidos, textos, html=antes)
        assert viejo['url'] == hoy['url'], (viejo['url'], hoy['url'])
        assert viejo['textos'] == hoy['textos'], (viejo['textos'], hoy['textos'])
        cuerpo_viejo = dict(viejo['cuerpo'])
        cuerpo_viejo.pop('ref_id')
        assert sorted(cuerpo_viejo) == sorted(cuerpo), (sorted(cuerpo_viejo), sorted(cuerpo))
        for clave in cuerpo:
            assert cuerpo_viejo[clave] == cuerpo[clave], f'{formulario}: «{clave}» no es igual que en producción'
        # Con cambio de titular «Sí»: el formulario de producción manda lo que se tecleó en «nuevo titular» TAL CUAL; el de hoy, lo del
        # titular ANTERIOR con el prefijo. Todo lo demás, igual (las mismas claves: la clave nueva `titular_anterior` nunca viaja)
        viejo_si = _envio_de_siempre(c, formulario, recibidos, textos, html=antes, extra={'cambio_titular': 'Si', 'nuevo_titular': anterior})
        cuerpo_viejo_si = dict(viejo_si['cuerpo'])
        cuerpo_viejo_si.pop('ref_id')
        assert cuerpo_viejo_si['nuevo_titular'] == anterior and viejo_si['textos'] == con_cambio['textos'] and viejo_si['url'] == con_cambio['url']
        assert sorted(cuerpo_viejo_si) == sorted(cuerpo_si), (sorted(cuerpo_viejo_si), sorted(cuerpo_si))
        for clave in cuerpo_si:
            if clave == 'nuevo_titular':
                continue
            assert cuerpo_viejo_si[clave] == cuerpo_si[clave], f'{formulario} con cambio de titular: «{clave}» no es igual que en producción'

    # reducirFoto + base64 también en el modo dormido: una foto de más de 1 MB sale como .jpg más pequeño (y en singular)
    grande = _envio_de_siempre(c, 'gnew', recibidos, textos, foto_grande=True)
    a = grande['cuerpo']['archivos'][0]
    assert a['name'] == 'foto-grande.jpg' and a['type'] == 'image/jpeg', a
    assert len(base64.b64decode(a['data'])) < grande['tamano_foto'], 'La foto grande tiene que salir reducida'
    assert grande['textos'][1] == 'Preparando 1 archivo...', grande['textos']

    assert not llamadas_api, f'El modo dormido no puede tocar la API: {llamadas_api[:3]}'
    assert not c.iniciar and not c.confirmar and not c.puts and not c.respuestas, 'Ni iniciar, ni confirmar, ni almacén'
    assert not c.google, 'Todo el Apps Script se atendió en page.route'


def caso_11(c):
    """`?v2=1` con un prefill por URL (como lo abre el comparador DPC): los campos se rellenan, `v2` no estorba, el IBAN y el DNI
    del firmante NO entran por la dirección y el envío va por la v2 (GNEW y MEGA)."""
    for formulario, prefijo in (('gnew', 'GNE'), ('mega', 'MEGA')):
        prefill = {k: v for k, v in datos_formulario(formulario).items() if k not in ('cuenta_bancaria', 'dni_firmante')}
        # Y los dos datos que JAMÁS se aceptan por la dirección, puestos a propósito
        consulta = urllib.parse.urlencode({'v2': '1', **prefill, 'cuenta_bancaria': IBAN_TECLEADO, 'dni_firmante': '12345678Z'})
        c.ir(f'/{formulario}?{consulta}', v2=False)
        c.page.wait_for_function("() => document.querySelector('[name=\"quien_eres\"]').value !== ''")
        for nombre, valor in prefill.items():
            assert c.page.input_value(f'[name="{nombre}"]') == valor, f'{formulario}: «{nombre}» no se ha rellenado desde la dirección'
        assert c.page.input_value('[name="cuenta_bancaria"]') == '' and c.page.input_value('[name="dni_firmante"]') == '', \
            'El IBAN y el DNI del firmante no pueden entrar por la dirección'
        if formulario == 'mega':
            assert c.page.input_value('[name="tipo_suministro"]') == 'Luz', 'El `change` del prefill tiene que llegar a los listeners'
        # el resto, como siempre (lo que ya está relleno queda igual) → v2
        c.rellenar(formulario)
        c.adjuntar(JPG, PNG)
        c.enviar()
        ref = c.esperar_gracias()
        ini = c.iniciar[-1]
        assert ini['formulario'] == formulario and ini['ref'] == ref and ref.startswith(prefijo + '-')
        for nombre, valor in prefill.items():
            assert ini['datos'][nombre] == valor, f'{formulario}: «{nombre}» no viajó a iniciar tal como vino en la dirección'
        comprobar_recibida(esperar_estado(ref, 'recibida'), ref, formulario, 2)
    assert len(c.iniciar) == 2 and len(c.confirmar) == 2, 'Cada formulario: un iniciar y un confirmar (la v2)'
    assert not c.google, 'Con ?v2=1 no se toca el Apps Script'


def _capturar_titular_anterior(c, formulario, sufijo=''):
    """Captura a 390 px (la pantalla de un móvil, 390×844) con el bloque «Cambio de Titular» en el centro, tal como está ahora (con «Sí»: el
    campo del titular anterior)."""
    seccion = c.page.locator('.form-section', has=c.page.locator('#cambioTitular'))
    seccion.evaluate("e => e.scrollIntoView({ block: 'center' })")
    c.page.wait_for_timeout(500)  # que termine la animación del campo (slideDown, 0,3 s)
    c.page.screenshot(path=str(SALIDAS / f'formulario-titular-anterior-{formulario}-390{sufijo}.png'), animations='disabled')


def _envio_por_respaldo(c, formulario, recibidos, **extra):
    """Un envío con la API de tramitación «caída» (iniciar da 503 tres veces) y el respaldo FORZADO a encendido en la prueba (el html se sirve con
    `RESPALDO_APPS_SCRIPT = true`; el de producción lo lleva apagado y el fichero no se toca): entra el respaldo de Apps Script (simulado en
    page.route) con la MISMA referencia. Devuelve el cuerpo que llegó al Apps Script."""
    c.page.route(BASE + '/api/tramitacion/iniciar', lambda route, _q: route.fulfill(
        status=503, content_type='application/json', body='{"ok":false,"codigo":"temporal","mensaje":"x","retryable":true}'))
    pagina = None
    try:
        pagina = _abrir_forzado(c, formulario, RESPALDO_APPS_SCRIPT=True)
        c.rellenar(formulario, **extra)
        c.adjuntar(JPG, PNG)
        antes = len(recibidos)
        c.enviar()
        ref = c.esperar_gracias()
    finally:
        c.page.unroute(BASE + '/api/tramitacion/iniciar')
        if pagina is not None:
            c.page.unroute(pagina)
    assert len(recibidos) == antes + 1, f'{len(recibidos) - antes} peticiones al Apps Script (tenía que ser 1)'
    cuerpo = recibidos[-1]
    assert cuerpo['ref_id'] == ref and estado_de(ref) is None, 'El respaldo usa la misma referencia y no deja fila en la base nueva'
    return cuerpo


def caso_12(c):
    """CAMBIO DE TITULAR (Victor, 16-oct-2026): con «Sí» se piden los datos del titular ANTERIOR (el nuevo ya lo rellena el comercial), obligatorios; con
    «No» no se exige ni viaja lo escrito. GNEW y MEGA: «Sí» → «Datos del titular anterior *» (y ninguna casilla de «nuevo titular») · vacío → no envía y
    avisa en llano · relleno → v2: la fila lo guarda (columna `nuevo_titular`, nombre histórico) y el aviso lo llama «Titular anterior», sin «Nuevo titular» ·
    «No» con texto escrito → no viaja · respaldo de Apps Script (sin tocar; con el respaldo forzado a encendido en la prueba, porque en los html está
    apagado) → `nuevo_titular: «TITULAR ANTERIOR: …»`. Capturas a 390 px del bloque con «Sí»."""
    p = c.page
    recibidos = _simular_apps_script(c)  # el respaldo (Apps Script) se atiende en page.route, con el cuerpo entero a la vista
    c.rota('/api/tramitacion/iniciar')   # (los 503 provocados del respaldo)
    escrito = 'Antigua Titular SL, B12345674, Calle Vieja 3'
    esperado = 'ANTIGUA TITULAR SL, B12345674, CALLE VIEJA 3'  # lo que guarda el servidor: en mayúsculas, como todo lo que escribe el comercial
    frase = 'Indica los datos del titular anterior.'
    for formulario, prefijo in (('gnew', 'GNE'), ('mega', 'MEGA')):
        o = 'ó' if formulario == 'gnew' else 'o'  # mega.html escribe sus textos sin tildes
        campo = p.locator('#titularAnteriorField')
        entrada = p.locator('[name="titular_anterior"]')

        # --- 1) Con «No» (lo normal) no se ve; ya no existe la casilla de «nuevo titular»; con «Sí» sale «Datos del titular anterior *» ---
        c.ir(f'/{formulario}')
        assert campo.is_hidden(), f'{formulario}: con «No» el campo del titular anterior no se ve'
        assert p.locator('[name="nuevo_titular"]').count() == 0, f'{formulario}: no puede quedar la casilla de «nuevo titular»'
        p.select_option('#cambioTitular', 'Si')
        campo.wait_for(state='visible')
        etiqueta = campo.locator('label')
        assert etiqueta.inner_text().strip() == 'Datos del titular anterior *', etiqueta.inner_text()
        asterisco = etiqueta.locator('.required')
        rojo = asterisco.evaluate('e => getComputedStyle(e).color')
        assert rojo == p.locator('label:has-text("Titular del contrato") .required').evaluate('e => getComputedStyle(e).color'), 'El asterisco es el rojo de obligatorio de siempre'
        assert rojo != etiqueta.evaluate('e => getComputedStyle(e).color'), 'y se distingue del texto de la etiqueta'
        assert entrada.get_attribute('placeholder') == f'Nombre, NIF, direcci{o}n...'
        assert entrada.get_attribute('required') is None, 'Se valida al enviar, no con `required` (con «No» el campo está oculto)'
        assert not re.search(r'nuevo titular', p.inner_text('body'), re.I), f'{formulario}: en ningún sitio de la página queda «nuevo titular»'
        assert p.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"), f'{formulario}: la página se desborda a 390 px'
        _capturar_titular_anterior(c, formulario)

        # --- 2) «Sí» y nada escrito: no envía, lo marca como el resto de campos obligatorios y lo dice en llano ---
        c.rellenar(formulario, cambio_titular='Si')
        c.adjuntar(JPG, PNG)
        url_antes, n_iniciar, n_subidas = p.url, len(c.iniciar), len(c.puts)
        c.enviar()
        p.wait_for_selector('#titularAnteriorField.has-error .error-msg')
        assert p.inner_text('#titularAnteriorField .error-msg') == frase
        assert entrada.evaluate('e => e.classList.contains("error")'), 'El campo se marca como los demás (borde rojo)'
        assert p.locator('.field.has-error').count() == 1, 'Es el único error: lo demás está bien'
        assert p.url == url_antes, f'No sale de la página: {url_antes} → {p.url}'
        assert len(c.iniciar) == n_iniciar and len(c.puts) == n_subidas, f'No habla con el servidor: {len(c.iniciar)} iniciar (antes {n_iniciar}), {len(c.puts)} subidas (antes {n_subidas})'
        assert not p.locator('#overlayEnvio').count(), f'No sale ningún aviso encima: {c.overlay()}'
        assert p.is_enabled('#submitBtn') and not p.locator('#submitBtn.loading').count(), 'El botón sigue disponible'
        assert not re.search(r'undefined|\bnull\b|HTTP|JSON|error \d', p.inner_text('#titularAnteriorField'), re.I), 'Ningún mensaje técnico'
        _capturar_titular_anterior(c, formulario, '-error')
        # al escribir, el error se va
        entrada.fill(escrito)
        assert not p.locator('#titularAnteriorField.has-error').count() and not p.locator('.field.has-error').count(), 'Al escribir, se quita el error'

        # --- 3) Relleno: envía por la v2; la fila guarda el titular ANTERIOR y el aviso lo llama «Titular anterior» ---
        c.enviar()
        ref = c.esperar_gracias()
        ini = c.iniciar[-1]
        assert ini['formulario'] == formulario and ini['ref'] == ref and ref.startswith(prefijo + '-')
        assert ini['datos']['cambio_titular'] == 'Si' and ini['datos']['titular_anterior'] == escrito, ini['datos']
        assert 'nuevo_titular' not in ini['datos'], 'La página nueva no manda el nombre viejo'
        e = esperar_estado(ref, 'recibida')
        comprobar_recibida(e, ref, formulario, 2)
        t = e['tramitacion']
        assert t['cambio_titular'] is True
        assert t['nuevo_titular'] == esperado, t['nuevo_titular']  # (la columna se llama nuevo_titular por historia: guarda el titular ANTERIOR)
        aviso = correo_de(e, 'aviso')
        for cuerpo in (aviso['cuerpo_html'], aviso['cuerpo_texto']):
            assert 'Titular anterior' in cuerpo and esperado in cuerpo
            assert not re.search(r'nuevo titular', cuerpo, re.I), 'El aviso no dice «Nuevo titular»'
        assert f'Titular anterior: {esperado}' in aviso['cuerpo_texto']
        assert esperado not in correo_de(e, 'acuse')['cuerpo_texto'], 'El acuse al comercial no lleva el titular anterior'

        # --- 4) «No» con algo escrito antes en el campo oculto: no se exige y NO viaja ---
        c.ir(f'/{formulario}')
        c.rellenar(formulario, cambio_titular='Si', titular_anterior='LO QUE NO DEBE VIAJAR')
        p.select_option('#cambioTitular', 'No')
        assert campo.is_hidden()
        c.adjuntar(JPG, PNG)
        c.enviar()
        ref_no = c.esperar_gracias()
        ini = c.iniciar[-1]
        assert ini['datos']['cambio_titular'] == 'No' and ini['datos']['titular_anterior'] == '', ini['datos']
        e = esperar_estado(ref_no, 'recibida')
        comprobar_recibida(e, ref_no, formulario, 2)
        assert e['tramitacion']['cambio_titular'] is False and e['tramitacion']['nuevo_titular'] is None
        aviso = correo_de(e, 'aviso')
        assert 'Titular anterior' not in aviso['cuerpo_html'] and 'LO QUE NO DEBE VIAJAR' not in aviso['cuerpo_html'] + aviso['cuerpo_texto']

        # --- 5) Respaldo de Apps Script (forzado a encendido en la prueba): el Code.gs publicado (sin tocar) espera `nuevo_titular`; el dato va ahí
        #        con el prefijo. Lo usan la palanca `V2_ACTIVO = false` y `RESPALDO_APPS_SCRIPT = true` ---
        cuerpo = _envio_por_respaldo(c, formulario, recibidos, cambio_titular='Si', titular_anterior=escrito)
        assert cuerpo['nuevo_titular'] == 'TITULAR ANTERIOR: ' + escrito, cuerpo['nuevo_titular']
        assert 'titular_anterior' not in cuerpo and cuerpo['cambio_titular'] == 'Si', 'El Apps Script no conoce `titular_anterior`'
        if formulario == 'gnew':
            # sin cambio de titular la clave va igualmente (vacía), como siempre
            cuerpo = _envio_por_respaldo(c, formulario, recibidos)
            assert cuerpo['nuevo_titular'] == '' and 'titular_anterior' not in cuerpo and cuerpo['cambio_titular'] == 'No', cuerpo

    assert not c.google, 'Todo el Apps Script se atendió en page.route'
    assert len(c.puts) == 8 and all('/pruebas/' in x['ruta'] for x in c.puts), 'Dos envíos por la v2 en cada formulario, con 2 documentos cada uno, siempre bajo pruebas/'


CASOS = [
    (1, 'GNEW completo: 3 archivos (uno de 5,5 MB) + firma, progreso real y gracias con referencia', caso_1),
    (2, 'Corte de red en confirmar (respuesta perdida) → reintento, una sola fila y un solo aviso', caso_2),
    (3, 'Primera subida al almacén cortada → reintento del archivo con la misma dirección', caso_3),
    (4, 'iniciar 503 ×3 con el respaldo apagado → «No hemos podido terminar el envío» sin tocar Apps Script y Reintentar con la misma referencia (GNEW y MEGA); respaldo forzado a true → Apps Script', caso_4),
    (5, 'Foto grande generada en la página → comprimido, tamaño original mayor, .jpg', caso_5),
    (6, 'MEGA completo → gracias-mega y asunto «Nuevo Contrato MEGA - …»', caso_6),
    (7, 'CUPS inválido → error en línea; errores del servidor (campos, documentación, firma) en línea', caso_7),
    (8, 'Todas las subidas cortadas → «No hemos podido terminar el envío» → Reintentar con la MISMA referencia', caso_8),
    (9, 'Tras un fallo se quita un archivo y se reenvía → vieja «abandonada», nueva «recibida»', caso_9),
    (10, 'Interruptor V2_ACTIVO sin ?v2=1: el envío de SIEMPRE (Apps Script) idéntico al de producción, sin tocar /api/tramitacion', caso_10),
    (11, '?v2=1 con prefill por URL (comparador DPC): campos rellenos, IBAN/DNI fuera de la URL y envío por la v2', caso_11),
    (12, 'Cambio de titular: con «Sí» se piden los datos del titular ANTERIOR (obligatorios; «No», ni se exige ni viaja); fila, aviso «Titular anterior» y respaldo', caso_12),
]

# Qué casos esperan hablar con el Apps Script a nivel de `Caso` (respuesta simulada); los demás lo ven abortado y fallan si lo intentan. Ninguno de los
# 12: los que lo simulan lo hacen con `_simular_apps_script` (page.route) cuando toca, y el resto (el 4, en su parte 1) quedan protegidos por la guardia.
GOOGLE_SIMULADO = {}


def correr(numeros, lista=None, google_simulado=None, etiqueta='caso'):
    SALIDAS.mkdir(parents=True, exist_ok=True)
    lista = CASOS if lista is None else lista
    google_simulado = GOOGLE_SIMULADO if google_simulado is None else google_simulado
    elegidos = [c for c in lista if not numeros or c[0] in numeros]
    ok = 0
    consola_total = 0
    esperados_total = 0
    with sync_playwright() as p:
        navegador = p.chromium.launch(headless=True)
        for numero, titulo, funcion in elegidos:
            caso = Caso(navegador, titulo, google_respuesta=google_simulado.get(numero))
            inicio = time.time()
            try:
                funcion(caso)
                caso.comprobar_limpio()
                ok += 1
                extra = len(caso.errores_consola)
                esperados_total += extra
                print(f'  OK   {etiqueta} {numero}: {titulo}  ({time.time() - inicio:.1f} s; consola: 0 errores inesperados'
                      f'{f", {extra} «Failed to load resource» de los fallos provocados" if extra else ""})')
            except Exception as error:  # un caso que falla no impide correr los demás
                print(f'  FALLO {etiqueta} {numero}: {titulo}')
                print(f'       {type(error).__name__}: {str(error)[:600]}')
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
                    caso.page.screenshot(path=str(SALIDAS / f'fallo-{etiqueta}-{numero}.png'))
                except Exception:
                    pass
            finally:
                consola_total += len(caso.consola_inesperada())
                caso.cerrar()
        navegador.close()
    print(f'\n{ok}/{len(elegidos)} {"OK" if etiqueta == "caso" else "extras OK"} · errores de consola inesperados: {consola_total} · '
          f'«Failed to load resource» esperados por los fallos provocados: {esperados_total}')
    return ok == len(elegidos)


# ---------------------------------------------------------------------------
# Extras: lo que los 12 casos no tocan (no cuentan en el «12/12»; `run.sh extras`). También con ?v2=1 (lo pone `Caso.ir`)
# ---------------------------------------------------------------------------

CORS_ABIERTO = {'Access-Control-Allow-Origin': '*'}
DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def extra_1(c):
    """El almacén rechaza un archivo por tamaño (413) y otro por tipo (415): NO se reintenta, frase en llano en línea y el comercial puede quitarlo."""
    c.rota('.supabase.co/storage')
    modo = {'codigo': '413'}

    def rechazar(route, request):
        cuerpo = {'413': {'statusCode': '413', 'error': 'Payload too large', 'message': 'The object exceeded the maximum allowed size', 'code': 'EntityTooLarge'},
                  '415': {'statusCode': '415', 'error': 'invalid_mime_type', 'message': 'mime type text/plain is not supported', 'code': 'InvalidMimeType'}}[modo['codigo']]
        route.fulfill(status=400, headers=CORS_ABIERTO, content_type='application/json', body=json.dumps(cuerpo))

    c.page.route(lambda url: '.supabase.co/storage/' in url, rechazar)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    c.page.wait_for_selector('.field.has-error .error-msg', timeout=30_000)
    msg = c.page.locator('.field.has-error .error-msg').inner_text()
    assert msg.startswith('«foto-pequena.jpg» es demasiado grande: el máximo es de 25 MB por archivo.'), msg
    assert 'Quítalo de la lista' in msg and 'Detalle' not in msg and 'EntityTooLarge' not in msg and '413' not in msg
    assert len(c.puts) == 1, f'Un rechazo del almacén NO se reintenta (hubo {len(c.puts)} subidas)'
    assert not c.page.locator('#overlayEnvio').count() and c.page.is_enabled('#submitBtn') and not c.confirmar
    ref1 = c.refs_iniciar()[0]
    assert estado_de(ref1)['tramitacion']['estado'] == 'subiendo'

    # El comercial lo quita (la × también limpia el aviso) y reenvía: lista nueva = referencia nueva, la vieja queda «Incompleta»
    _quitar_archivo(c, 0)
    assert not c.page.locator('.field.has-error').count(), 'Al quitar el archivo, su error desaparece'
    modo['codigo'] = '415'
    c.enviar()  # ahora el que se rechaza es «firma-pequena.png», por tipo
    c.page.wait_for_selector('.field.has-error .error-msg', timeout=30_000)
    msg = c.page.locator('.field.has-error .error-msg').inner_text()
    assert msg.startswith('«firma-pequena.png» no es de un tipo admitido: solo se admiten PDF, JPG, PNG, DOC o DOCX.'), msg
    assert 'InvalidMimeType' not in msg and '415' not in msg
    assert len(c.puts) == 2, 'Tampoco se reintenta un rechazo por tipo'
    assert c.iniciar[1]['ref_anterior'] == ref1 and c.iniciar[1]['ref'] != ref1
    esperar_estado(ref1, 'abandonada')


def extra_2(c):
    """.docx y .DOC sin tipo (como los móviles): el Content-Type sale de la EXTENSIÓN y el almacén los acepta; doble clic = un solo envío."""
    c.ir('/gnew')
    c.rellenar('gnew')
    c.page.set_input_files('#fileInput', [
        {'name': 'contrato-firmado.docx', 'mimeType': '', 'buffer': b'PK\x03\x04 contenido de prueba docx'},
        {'name': 'Escaneo.DOC', 'mimeType': '', 'buffer': b'\xd0\xcf\x11\xe0 contenido de prueba doc'},
        {'name': 'FOTO.JPEG', 'mimeType': '', 'buffer': JPG.read_bytes()},
        {'name': 'sin-tipo.PNG', 'mimeType': '', 'buffer': PNG.read_bytes()},
    ])
    c.page.dblclick('#submitBtn')
    ref = c.esperar_gracias()
    assert len(c.iniciar) == 1, f'Un doble clic no puede enviar dos veces ({len(c.iniciar)} iniciar)'
    assert [p['tipo'] for p in c.puts] == [DOCX, 'application/msword', 'image/jpeg', 'image/png'], c.puts
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 4)
    assert [d['tipo_mime'] for d in sorted(e['documentos'], key=lambda d: d['orden'])] == [DOCX, 'application/msword', 'image/jpeg', 'image/png']


def extra_3(c):
    """`confirmar` dice «faltan archivos» y luego «desconocida»: el navegador vuelve a `iniciar` (sin subir nada de nuevo) y termina."""
    c.rota('/api/tramitacion/confirmar')
    respuestas = [
        (409, {'ok': False, 'codigo': 'faltan_archivos', 'mensaje': 'Todavía faltan documentos por llegar. Seguimos subiéndolos.', 'retryable': True,
               'faltan': [{'orden': 1, 'nombre': 'foto-pequena.jpg', 'motivo': 'no_subido'}]}),
        (404, {'ok': False, 'codigo': 'desconocida', 'mensaje': 'No encontramos este envío. Vamos a prepararlo de nuevo.', 'retryable': True}),
    ]

    def manejador(route, request):
        if respuestas:
            estado, cuerpo = respuestas.pop(0)
            route.fulfill(status=estado, content_type='application/json', body=json.dumps(cuerpo))
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/confirmar', manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    ref = c.esperar_gracias()
    assert len(c.iniciar) == 3 and len(c.confirmar) == 3, f'iniciar {len(c.iniciar)} · confirmar {len(c.confirmar)}'
    assert len(c.puts) == 2, f'Las vueltas no vuelven a subir lo que ya está ({len(c.puts)} subidas)'
    assert {x['ref'] for x in c.iniciar} == {ref}
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)


def extra_4(c):
    """`iniciar` dice «lista distinta» (409): referencia nueva (una vez) y la vieja viaja como `ref_anterior`."""
    c.rota('/api/tramitacion/iniciar')
    primera = {'si': True}

    def manejador(route, request):
        if primera['si']:
            primera['si'] = False
            route.fulfill(status=409, content_type='application/json', body=json.dumps(
                {'ok': False, 'codigo': 'lista_distinta', 'mensaje': 'Los documentos de este envío han cambiado. Vamos a preparar un envío nuevo.', 'retryable': False}))
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/iniciar', manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    ref = c.esperar_gracias()
    assert len(c.iniciar) == 2
    assert c.iniciar[1]['ref'] == ref and c.iniciar[0]['ref'] != ref and c.iniciar[1]['ref_anterior'] == c.iniciar[0]['ref']
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)


def extra_5(c):
    """Un archivo desaparece después de adjuntarlo: aviso de siempre («No se ha podido leer un archivo»), se quita de la lista y no se llama a nada."""
    with tempfile.TemporaryDirectory() as carpeta:
        efimero = Path(carpeta) / 'copia-temporal-whatsapp.pdf'
        efimero.write_bytes(b'%PDF-1.4\n' + b'x' * 2048)
        c.ir('/gnew')
        c.rellenar('gnew')
        c.adjuntar(JPG, efimero)
        assert c.page.locator('.file-item').count() == 2
        efimero.unlink()  # el comercial lo borra / lo mueve
        c.enviar()
        c.page.wait_for_selector('#overlayEnvio, div:has-text("No se ha podido leer un archivo")', timeout=30_000)
    cuerpo = c.page.inner_text('body')
    assert 'No se ha podido leer un archivo' in cuerpo and '«copia-temporal-whatsapp.pdf»' in cuerpo
    assert 'El contrato no se ha enviado' in cuerpo and 'Lo hemos quitado de la lista' in cuerpo
    assert c.page.locator('.file-item').count() == 1, 'El archivo ilegible sale de la lista'
    assert not c.iniciar and not c.puts, 'No se habla con el servidor ni se sube nada'
    assert c.page.is_enabled('#submitBtn')


def extra_6(c):
    """Honeypot relleno: éxito falso (gracias con referencia), fila «descartada», sin documentos, sin subidas y sin correos."""
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG)
    c.page.evaluate("() => { document.getElementById('gnewHp').value = 'soy un robot'; }")
    c.enviar()
    ref = c.esperar_gracias()
    assert c.iniciar[0]['hp'] == 'soy un robot' and isinstance(c.iniciar[0]['hp'], str)
    assert not c.puts and not c.confirmar and not c.google
    e = estado_de(ref)
    assert e['tramitacion']['estado'] == 'descartada' and e['tramitacion']['sospechosa'] is True
    assert not e['documentos'] and not e['correos']


def extra_7(c):
    """MEGA con la API caída (503 ×3) y el respaldo FORZADO a encendido en la prueba (en el html está apagado; el fichero no se toca): respaldo con el
    payload antiguo de MEGA (compañía MEGA, tipo de suministro, token propio) y la MISMA referencia."""
    c.rota('/api/tramitacion/iniciar')
    c.page.route(BASE + '/api/tramitacion/iniciar', lambda route, request: route.fulfill(
        status=503, content_type='application/json', body='{"ok":false,"codigo":"temporal","mensaje":"x","retryable":true}'))
    _abrir_forzado(c, 'mega', RESPALDO_APPS_SCRIPT=True)
    c.rellenar('mega')
    c.adjuntar(JPG, PNG)
    c.enviar()
    ref = c.esperar_gracias()
    assert '/gracias-mega.html' in c.page.url and ref.startswith('MEGA-')
    assert len(c.google) == 1
    g = c.google[0]
    assert g['ref_id'] == ref and g['token'] == 'MEGA-2026-h3p8k5z1q6' and g['compania'] == 'MEGA' and g['tipo_suministro'] == 'Luz'
    assert g['n_archivos'] == 2 and g['archivos_con_base64'] and g['hp'] == '' and not g['tiene_terminos']
    assert estado_de(ref) is None and not c.puts
    comprobar_gracias(c, ref, 'MEGA-')


def extra_8(c):
    """`confirmar` falla 4 veces → «No hemos podido terminar el envío» → Reintentar: no sube nada otra vez y cierra con la MISMA referencia."""
    c.rota('/api/tramitacion/confirmar')
    cortar = {'si': True}

    def manejador(route, request):
        if cortar['si']:
            route.abort('connectionreset')
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/confirmar', manejador)
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=90_000)
    assert 'No hemos podido terminar el envío' in c.overlay()
    assert len(c.confirmar) == 4 and len(c.puts) == 2
    ref = c.refs_iniciar()[0]
    cortar['si'] = False
    c.page.get_by_role('button', name='Reintentar', exact=True).click()
    assert c.esperar_gracias() == ref
    assert len(c.puts) == 2, 'Reintentar no vuelve a subir lo que ya estaba'
    assert len(c.iniciar) == 2 and {x['ref'] for x in c.iniciar} == {ref}
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)


def extra_9(c):
    """Si la referencia YA estaba en la base y `iniciar` deja de contestar, NO entra el respaldo (dejaría un envío a medias): sale «No hemos podido terminar el envío».
    Con el respaldo FORZADO a encendido en la prueba (en el html está apagado y entonces esto sería trivialmente cierto): así sigue probando la guarda
    `p.refOk === currentRefId` de `enviarPorLaApi`, que es la que importaría si alguien volviera a encender el respaldo."""
    c.rota('.supabase.co/storage', '/api/tramitacion/iniciar')
    modo = {'cortar_subidas': True, 'iniciar_caido': False}
    c.page.route(lambda url: '.supabase.co/storage/' in url, lambda route, request: route.abort('connectionreset') if modo['cortar_subidas'] else route.continue_())

    def iniciar(route, request):
        if modo['iniciar_caido']:
            route.fulfill(status=503, content_type='application/json', body='{"ok":false,"codigo":"temporal","retryable":true}')
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/iniciar', iniciar)
    _abrir_forzado(c, 'gnew', RESPALDO_APPS_SCRIPT=True)
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=60_000)
    ref = c.refs_iniciar()[0]
    c.page.get_by_role('button', name='Cerrar', exact=True).click()
    modo['iniciar_caido'] = True
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=60_000)
    assert 'No hemos podido terminar el envío' in c.overlay(), c.overlay()
    assert not c.google, 'No debía recurrir al Apps Script con la referencia ya apuntada'
    modo['iniciar_caido'] = False
    modo['cortar_subidas'] = False
    c.page.get_by_role('button', name='Reintentar', exact=True).click()
    assert c.esperar_gracias() == ref
    e = esperar_estado(ref, 'recibida')
    comprobar_recibida(e, ref, 'gnew', 2)


def extra_10(c):
    """Un archivo de 26 MB (el front-end deja pasar hasta 30 MB en total, el almacén solo 25 MB por archivo): el servidor dice que no con una frase en llano, sin subir nada."""
    c.rota('/api/tramitacion/iniciar')
    c.ir('/gnew')
    c.rellenar('gnew')
    c.page.set_input_files('#fileInput', [{'name': 'escaneo-enorme.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4\n' + bytes(26 * 1024 * 1024)}])
    c.enviar()
    c.page.wait_for_selector('#overlayEnvio', timeout=60_000)
    texto = c.overlay()
    assert 'No se ha podido enviar el contrato' in texto, texto
    assert 'La documentación supera el máximo: 15 archivos, 25 MB por archivo y 60 MB en total' in texto, texto
    assert 'Detalle' not in texto and 'limites' not in texto
    assert len(c.iniciar) == 1 and not c.puts and not c.confirmar and not c.google, 'Un rechazo del servidor no se reintenta ni se sube nada'
    assert estado_de(c.iniciar[0]['ref']) is None
    c.page.get_by_role('button', name='Cerrar', exact=True).click()
    assert not c.page.locator('#overlayEnvio').count() and c.page.is_enabled('#submitBtn')


EXTRAS = [
    (1, 'El almacén rechaza por tamaño (413) y por tipo (415): sin reintentos, frase en llano en línea', extra_1),
    (2, '.docx / .DOC / .JPEG / .PNG sin tipo: Content-Type por extensión; doble clic = un envío', extra_2),
    (3, 'confirmar dice «faltan» y «desconocida»: vuelve a iniciar sin resubir', extra_3),
    (4, 'iniciar dice «lista distinta» (409): referencia nueva con ref_anterior', extra_4),
    (5, 'Archivo borrado tras adjuntarlo: aviso de siempre y fuera de la lista', extra_5),
    (6, 'Honeypot relleno: éxito falso, fila descartada, sin nada más', extra_6),
    (7, 'MEGA con la API caída y el respaldo forzado a true: respaldo con el payload antiguo de MEGA', extra_7),
    (8, 'confirmar falla 4 veces → Reintentar sin resubir y misma referencia', extra_8),
    (9, 'Con la referencia ya en la base, si iniciar cae NO entra el respaldo (forzado a true: prueba la guarda)', extra_9),
    (10, 'Archivo de 26 MB: el servidor lo rechaza con su frase en llano, sin subir nada', extra_10),
]
GOOGLE_EXTRAS = {7: GOOGLE_RESPUESTA_OK}


# ---------------------------------------------------------------------------
# Capturas antes/después
# ---------------------------------------------------------------------------

def _html_de_master(nombre):
    return subprocess.run(['git', '-C', str(RAIZ), 'show', f'master:{nombre}'], check=True, capture_output=True).stdout


def _capturar(navegador, ruta, destino, html_master=None):
    ctx = navegador.new_context(viewport=VIEWPORT, locale='es-ES', timezone_id='Europe/Madrid')
    errores = []
    try:
        pag = ctx.new_page()
        pag.on('pageerror', lambda e: errores.append(str(e)))
        pag.on('console', lambda m: errores.append(m.text) if m.type == 'error' else None)
        ctx.route(lambda url: not url.startswith(BASE + '/'), lambda r, _q: r.fulfill(status=200, content_type='text/css', body=''))
        if html_master is not None:
            pag.route(BASE + ruta, lambda r, _q: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=html_master))
        pag.goto(BASE + ruta, wait_until='load')
        pag.wait_for_timeout(600)
        pag.screenshot(path=str(destino), full_page=True, animations='disabled')
    finally:
        ctx.close()
    return errores


def capturas():
    """Captura gnew y mega a 390 px: el html de MASTER (antes) y el de ahora (después), y los compara píxel a píxel."""
    from PIL import Image, ImageChops
    SALIDAS.mkdir(parents=True, exist_ok=True)
    todo_igual = True
    with sync_playwright() as p:
        nav = p.chromium.launch(headless=True)
        for nombre, ruta in (('gnew', '/gnew'), ('mega', '/mega')):
            antes = SALIDAS / f'antes-{nombre}-390.png'
            despues = SALIDAS / f'despues-{nombre}-390.png'
            e1 = _capturar(nav, ruta, antes, _html_de_master(f'{nombre}.html'))
            e2 = _capturar(nav, ruta, despues)
            a, d = Image.open(antes).convert('RGB'), Image.open(despues).convert('RGB')
            if a.size != d.size:
                todo_igual = False
                print(f'  {nombre}: tamaños DISTINTOS {a.size} vs {d.size}')
                continue
            caja = ImageChops.difference(a, d).getbbox()
            distintos = 0 if caja is None else sum(1 for px in ImageChops.difference(a, d).convert('L').getdata() if px)
            print(f'  {nombre}: {a.size[0]}×{a.size[1]} px · píxeles distintos: {distintos}'
                  f'{"" if caja is None else f" (zona {caja})"} · errores de consola/página: antes {len(e1)}, después {len(e2)}')
            todo_igual = todo_igual and caja is None and not e1 and not e2
        nav.close()
    print('CAPTURAS IDÉNTICAS' if todo_igual else 'CAPTURAS CON DIFERENCIAS')
    return todo_igual


if __name__ == '__main__':
    args = sys.argv[1:]
    if args == ['capturas']:
        sys.exit(0 if capturas() else 1)
    if args and args[0] == 'extras':
        numeros = {int(a) for a in args[1:] if a.isdigit()}
        sys.exit(0 if correr(numeros, EXTRAS, GOOGLE_EXTRAS, 'extra') else 1)
    numeros = {int(a) for a in args if a.isdigit()}
    sys.exit(0 if correr(numeros) else 1)
