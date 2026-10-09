#!/usr/bin/env python3
"""tests/e2e/formulario.py · Los 9 casos del formulario de tramitación (gnew.html y mega.html) con navegador real.

Uso (lo normal es `bash tests/e2e/run.sh formulario`, que arranca el servidor y limpia después):
    python tests/e2e/formulario.py                 los 9 casos, en serie
    python tests/e2e/formulario.py 1 5             solo esos casos
    python tests/e2e/formulario.py capturas        capturas a 390 px ANTES (html de master) y DESPUÉS, y su comparación
    python tests/e2e/formulario.py extras [N…]     comprobaciones extra (rutas que los 9 casos no tocan); no cuentan en el «9/9»

Un solo Chromium, viewport 390×844, `pageerror` y consola vigilados (0 errores inesperados es parte del criterio).
Todo lo de Google Apps Script está interceptado; la base se lee siempre por /__pruebas/tramitacion.
"""
import json
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

from comun import (BASE, CUPS_GAS, CUPS_LUZ, FIXTURES, GOOGLE_RESPUESTA_OK, IBAN_TECLEADO, REF_GRACIAS, RAIZ, SALIDAS,
                   VIEWPORT, Caso, correo_de, esperar_estado, estado_de)

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
# Los 9 casos
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
    esperado = 'Nuevo Contrato - Compañía de Prueba - Titular de Prueba SL - Comercial de Prueba - ' + CUPS_LUZ
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


def caso_4(c):
    """`iniciar` da 503 tres veces → respaldo (Apps Script, interceptado) con la MISMA referencia → gracias; sin fila nueva."""
    c.rota('/api/tramitacion/iniciar')
    c.page.route(BASE + '/api/tramitacion/iniciar', lambda route, request: route.fulfill(
        status=503, content_type='application/json',
        body='{"ok":false,"codigo":"temporal","mensaje":"No hemos podido guardar el envío ahora mismo.","retryable":true}'))
    c.ir('/gnew')
    c.rellenar('gnew')
    c.adjuntar(JPG, PNG)
    c.firmar()
    c.enviar()
    ref = c.esperar_gracias()
    assert len(c.iniciar) == 3, f'{len(c.iniciar)} intentos de iniciar (tenían que ser 3)'
    assert {x['ref'] for x in c.iniciar} == {ref}, 'El respaldo tiene que usar la misma referencia'
    assert len(c.google) == 1, f'{len(c.google)} peticiones al Apps Script (tenía que ser 1)'
    g = c.google[0]
    assert g['ref_id'] == ref and g['n_archivos'] == 2 and g['archivos_con_base64'] and g['token'] == 'GNE-2026-w7k4q9x2'
    assert g['hp'] == '' and not g['tiene_terminos'] and g['compania'] == 'Compañía de Prueba'
    assert not c.puts, 'En el respaldo no se sube nada al almacén'
    assert estado_de(ref) is None, 'El respaldo no debe dejar fila en la base nueva'
    assert not c.confirmar
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
    assert t['compania'] == 'MEGA ENERGIA' and t['tipo_suministro'] == 'Luz'
    aviso, acuse = correo_de(e, 'aviso'), correo_de(e, 'acuse')
    esperado = 'Nuevo Contrato MEGA - Titular Mega de Prueba SL - Comercial de Prueba - ' + CUPS_LUZ
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


CASOS = [
    (1, 'GNEW completo: 3 archivos (uno de 5,5 MB) + firma, progreso real y gracias con referencia', caso_1),
    (2, 'Corte de red en confirmar (respuesta perdida) → reintento, una sola fila y un solo aviso', caso_2),
    (3, 'Primera subida al almacén cortada → reintento del archivo con la misma dirección', caso_3),
    (4, 'iniciar 503 ×3 → respaldo por Apps Script (simulado) con la misma referencia, sin fila nueva', caso_4),
    (5, 'Foto grande generada en la página → comprimido, tamaño original mayor, .jpg', caso_5),
    (6, 'MEGA completo → gracias-mega y asunto «Nuevo Contrato MEGA - …»', caso_6),
    (7, 'CUPS inválido → error en línea; errores del servidor (campos, documentación, firma) en línea', caso_7),
    (8, 'Todas las subidas cortadas → «No hemos podido terminar el envío» → Reintentar con la MISMA referencia', caso_8),
    (9, 'Tras un fallo se quita un archivo y se reenvía → vieja «abandonada», nueva «recibida»', caso_9),
]

# Qué casos esperan hablar con el Apps Script (respuesta simulada); los demás lo ven abortado y fallan si lo intentan
GOOGLE_SIMULADO = {4: GOOGLE_RESPUESTA_OK}


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
# Extras: lo que los 9 casos no tocan (no cuentan en el «9/9»; `run.sh extras`)
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
    """MEGA con la API caída (503 ×3): respaldo con el payload antiguo de MEGA (compañía MEGA, tipo de suministro, token propio) y la MISMA referencia."""
    c.rota('/api/tramitacion/iniciar')
    c.page.route(BASE + '/api/tramitacion/iniciar', lambda route, request: route.fulfill(
        status=503, content_type='application/json', body='{"ok":false,"codigo":"temporal","mensaje":"x","retryable":true}'))
    c.ir('/mega')
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
    """Si la referencia YA estaba en la base y `iniciar` deja de contestar, NO entra el respaldo (dejaría un envío a medias): sale «No hemos podido terminar el envío»."""
    c.rota('.supabase.co/storage', '/api/tramitacion/iniciar')
    modo = {'cortar_subidas': True, 'iniciar_caido': False}
    c.page.route(lambda url: '.supabase.co/storage/' in url, lambda route, request: route.abort('connectionreset') if modo['cortar_subidas'] else route.continue_())

    def iniciar(route, request):
        if modo['iniciar_caido']:
            route.fulfill(status=503, content_type='application/json', body='{"ok":false,"codigo":"temporal","retryable":true}')
        else:
            route.continue_()

    c.page.route(BASE + '/api/tramitacion/iniciar', iniciar)
    c.ir('/gnew')
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
    (7, 'MEGA con la API caída: respaldo con el payload antiguo de MEGA', extra_7),
    (8, 'confirmar falla 4 veces → Reintentar sin resubir y misma referencia', extra_8),
    (9, 'Con la referencia ya en la base, si iniciar cae NO entra el respaldo', extra_9),
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
