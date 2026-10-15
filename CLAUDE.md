# CLAUDE.md - Grupo New Energy Landing

**Landing pages de tramitación de contratos de luz y gas. Contiene dos formularios independientes:**
- **GNEW** (gnew.html, ruta `/gnew`) — Grupo New Energy, asesoría/brokerage energético, múltiples compañías
- **MEGA** (mega.html, ruta `/mega`) — Mega Energía, comercializadora directa, solo contratos Mega

Además, `index.html` es una **landing de captación** independiente (formulario de email → webhook Make) para vender la plataforma; NO es el formulario de tramitación. La raíz `/` redirige a `/gnew` (ver vercel.json).

> **Tramitación v2 es el camino principal** (base y almacén propios en Supabase + aviso por Altavoz + bandeja de backoffice + vigilante): lee primero la sección **«Tramitación v2»** de abajo y `docs/tramitacion-v2.md`. **Todo lo de Google Apps Script, Drive, hoja de registro, Gmail y Brevo que aparece más abajo es el RESPALDO TEMPORAL** (se usa solo si la API nueva no contesta, la primera semana; después `RESPALDO_APPS_SCRIPT = false`) **y, mientras la v2 esté apagada, el camino normal del formulario**. Estado: construida y probada en la rama `tramitacion-v2` (órdenes 1-6 y 6b). **Encendida desde el 12-oct-2026 (`V2_ACTIVO = true` en `gnew.html` y `mega.html`); se desplegó DORMIDA con `V2_ACTIVO = false`** (el formulario envía exactamente como antes y no llama a `/api/tramitacion/*`; la v2 se ensaya en producción con `?v2=1`); se enciende en la puesta en marcha.

## Tramitación v2

**Documentos:** [`docs/tramitacion-v2.md`](docs/tramitacion-v2.md) (cómo funciona, vigilante, pruebas y **puesta en marcha paso a paso**) · [`docs/diseno-tramitacion-v2.md`](docs/diseno-tramitacion-v2.md) (el diseño cerrado y las alternativas descartadas; si algo difiere, mandan el código y `docs/tramitacion-v2.md`).

### Arquitectura
1. El navegador (`gnew.html`/`mega.html`) manda los datos y la lista de archivos a **`POST /api/tramitacion/iniciar`**: el servidor apunta el contrato (`tramitaciones`, estado `subiendo`), guarda la firma y devuelve una **URL firmada de subida por archivo**.
2. El navegador sube **cada archivo directo al almacén** (bucket privado `tramitaciones`), uno a uno, con barra de progreso y 3 intentos por archivo. No pasa por Vercel (corta a 4,5 MB).
3. **`POST /api/tramitacion/confirmar`** comprueba que cada archivo está en el almacén con el tamaño declarado. Solo entonces la fila pasa a `recibida`, se crean el **aviso** a backoffice y el **acuse** al comercial (cola `tramitacion_correos`) y se intentan por **Altavoz**: el aviso con tope de 15 s **y la documentación adjunta** (se vuelve a descargar del almacén en cada intento), el acuse (sin adjuntos) con 6 s y solo si han pasado menos de 20 s. El comercial ve «Contrato enviado» **solo con `listo:true`**.
4. Si Altavoz no responde, los correos quedan `pendiente` con espera creciente. El **vigilante** (cron del VPS cada 5 min → `POST /api/tramitacion/vigilante` con `Bearer`) concilia, libera cerrojos, reintenta (el aviso vuelve a adjuntar los documentos), abandona lo viejo y limpia; y `scripts/vigilante-tramitacion.mjs` avisa a Victor por Telegram, una vez por incidencia.
5. **Backoffice** entra en `/bandeja` (código de 6 cifras por email, solo para `BANDEJA_EMAILS`), ve lista y ficha (IBAN completo), descarga (uno a uno o ZIP montado en el navegador), marca «tramitada» y puede «volver a enviar» un correo (el aviso, con adjuntos otra vez). La lista dice de un vistazo qué contratos ha abierto ya alguien («Abierta por … hace 5 min», en cualquier estado) y qué pendientes no ha mirado nadie («Sin abrir», **solo en las pendientes**: una tramitada, incompleta o descartada sin abrir no lo enseña, se contradiría con su estado): cada apertura real de una ficha queda como evento `ficha_abierta` (actor = el correo de la sesión); la página manda `GET /api/bandeja/ficha?ref=…&abrir=1` solo en la carga de verdad (no en sus refrescos en silencio) y el servidor no apunta otra del mismo correo hasta pasados 15 minutos (`MINUTOS_ENTRE_APERTURAS` en `api/_lib/bandeja.js`); `lista` devuelve en cada item `vistas:[{por, en}]` (una por persona, su apertura más reciente, hasta 5). La lista se puede ver como **Tarjetas** (por defecto) o como **Lista** (una tabla: referencia, titular, compañía, CUPS, comercial, recibida, docs, abierta y estado): un interruptor a la derecha de los filtros, la elección se recuerda en el navegador (`localStorage` `bandeja.vista`) y la regla «Sin abrir» vale igual en los dos modos (es solo la vista de `bandeja.html`: la API es la misma).
6. Si `iniciar` falla 3 veces por red/tiempo/404/5xx **y** `RESPALDO_APPS_SCRIPT = true`, el formulario usa el camino antiguo (Apps Script) con la **misma referencia**. Con la v2 apagada (`V2_ACTIVO = false`, sin `?v2=1`) el formulario ya va directo por ese camino (`enviarComoAntes`), sin pasar por 1-5.

Funciones en `api/` (Node 22, **sin dependencias npm**, ESM; `api/_lib/` no se sirve): `tramitacion/{iniciar,confirmar,vigilante}.js`, `bandeja/{codigo,entrar,salir,yo,lista,ficha,estado,reenviar}.js`. Lógica en `api/_lib/{config,http,validadores,nombres,estados,correos,sesion,supabase,cartero,cola,tramitacion,bandeja,vigilante}.js`. SQL en `supabase/tramitacion.sql` (**ya aplicado** en `gnew-plataforma` el 9-oct-2026; idempotente; con `execute_sql`, nunca `apply_migration`).

### Reglas de la v2
| Regla | Por qué |
|-------|---------|
| **Interruptor `V2_ACTIVO`** (constante de `gnew.html` y `mega.html`, hoy `true` desde el 12-oct-2026 (encendida con OK de Victor), el mismo valor en los dos). Con `false` el formulario envía **exactamente como antes** (Apps Script: reducirFoto + base64, 120 s + 8 s/MB, 4 intentos, mismos textos, misma gracias) y NO llama a `/api/tramitacion/*`; la v2 solo con `?v2=1` en la dirección (esa carga de la página; no se guarda en ningún sitio). Con `true` la v2 es el camino normal y `?v2=1` da igual | Desplegar la v2 dormida, ensayarla en producción y encenderla después: sin el interruptor, el ensayo con los avisos a un alias de Victor habría mandado los contratos reales de los comerciales al alias en vez de a `escaneos@` |
| «Contrato enviado» solo con `listo:true`; la referencia (`GNE-…`/`MEGA-…`, la genera el navegador) es la clave de idempotencia | Un fallo de red no es un envío; repetir `iniciar`/`confirmar` nunca duplica filas ni correos |
| Un correo nunca se pierde en silencio: cola + cerrojo + vigilante + conciliación + aviso a Telegram | El 7/8-oct se perdieron 31 avisos porque el proveedor aceptaba y no enviaba |
| El aviso a backoffice **lleva la documentación ADJUNTA** (documentos por su orden y la firma al final; ≤ 10 ficheros EN TOTAL y ≤ 3.000.000 bytes reales entre todos, los topes de Altavoz). Lo que no cabe, o no se puede descargar, queda «en la bandeja» y el correo lo dice; el botón «Abrir en la bandeja» va SIEMPRE. El acuse al comercial no lleva adjuntos, IBAN, DNI ni enlace a la bandeja | Decisión de Victor del 10-oct-2026 (sustituye a «correo sin adjuntos» del 8-oct): backoffice recibe cada contrato con la documentación, como antes; la bandeja es la copia segura |
| Si falla la descarga de un adjunto, o Altavoz rechaza por los adjuntos (422 sin `codigo` o 413), el aviso **sale igualmente**: con lo que se descargó, o en el mismo intento sin adjuntos. Eventos `adjuntos_no_descargados` / `adjuntos_rechazados` (sin nombres de documentos) | Que backoffice SIEMPRE reciba el aviso es la prioridad; api.md §5 no da `codigo` a los 422 de los adjuntos |
| Los adjuntos **no se guardan en la base ni en la cola**: cada intento (confirmar, vigilante, «volver a enviar») los vuelve a descargar del almacén y comprueba que pesan lo comprobado | Sin datos personales duplicados; el cuerpo y los adjuntos se regeneran |
| El cuerpo de los correos se **regenera** desde la fila; solo en simulación se guarda | No hay datos personales duplicados en la cola |
| Todo lo que escribe el comercial se guarda y se envía EN MAYÚSCULAS (en `mapearDatos`), menos los correos electrónicos (`email_comercial`, `email_cliente`), que van en minúsculas | Decisión de Victor del 15-oct-2026: en el CRM se escribe todo en mayúsculas y así backoffice copia y pega sin retocar. Solo en la v2: el respaldo de Apps Script envía tal cual se escribió; los contratos de antes del cambio siguen como se escribieron |
| Nada de datos personales en registros, eventos, avisos de Telegram ni en la respuesta del vigilante (`console.*` solo con frases fijas) | IBAN, DNI y correos son datos personales |
| La web **nunca enseña mensajes técnicos**: frases en llano; el detalle técnico no existe en pantalla | Regla de la casa |
| **Nunca comisiones** en la web pública | Regla de la casa |
| Todo lo que toca una tramitación filtra por `prueba = esPrueba()` (cola, vigilante, bandeja) | El servidor de pruebas habla con la base real: jamás ve ni toca producción, y producción nunca ve lo de prueba |
| El vigilante abandona y mide «subidas a medias» por **`actualizada_en`**, no por `creada_en` | Reanudar una abandonada hace un UPDATE (trigger); con `creada_en` se volvería a abandonar |
| Quién abre una ficha se apunta como **evento** (`ficha_abierta` en `tramitacion_eventos`), nunca como columna ni con un UPDATE de `tramitaciones` | Un UPDATE dispara el trigger `tramitacion_tocar` (`actualizada_en`) y el vigilante abandona las `subiendo` por esa fecha: mirar una subida a medias la mantendría viva |
| El vigilante **no empieza envíos pasados 25 s** de la pasada; el script corta a **55 s** y la función vive 60 s | Un aviso con adjuntos tiene 15 s (+4 s de reintento sin adjuntos): peor pasada = 25 + 15 + 4 + 2 + 5 = 51 s. `tests/unit/tiempos.test.mjs` ata estos números |
| Sin dependencias npm; `fetch` a las API REST de Supabase y un ZIP «stored» de ~80 líneas | Menos superficie y despliegue trivial |
| `.vercelignore` deja fuera `supabase/`, `scripts/`, `tests/`, `docs/`, `.env*`, `CLAUDE.md` y los `Code.gs` | No se publica nada interno |

### Estados
- **Tramitación:** `subiendo` → `recibida` («Pendiente») ⇄ `tramitada`; `subiendo` → `abandonada` («Incompleta»; 24 h sin movimiento, o `ref_anterior` al cambiar la lista) → `subiendo` (se reanuda con la misma referencia); `descartada` (honeypot: éxito falso, sin documentos ni correos, visible en la bandeja).
- **Correo:** `pendiente` → `enviando` (cerrojo de 60 s) → `enviado` · `agotado` (8.º fallo) · `suprimido` (409 `destinatario_suprimido`) · `incierto` (502 `envio_incierto`, lo decide una persona) · `error_configuracion` (401/403/422). Esperas tras el fallo n: 1, 3, 10, 30, 60, 120, 240 min. `409 modo_prueba` se reintenta (Altavoz tiene el candado encendido).
- **Documento:** `pendiente` → `subido`. Claves del almacén: `[pruebas/]<formulario>/<yyyy>/<mm>/<ref>-<nonce>/NN.ext` (`00` = firma). Límites: 15 archivos, 25 MB por archivo, 60 MB en total.

### Variables de entorno
En Vercel (Production): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALTAVOZ_URL`, `ALTAVOZ_API_KEY`, `ALTAVOZ_SIMULAR` (`0` en producción), `AVISO_DESTINO` (+ `AVISO_DESTINO_MEGA` opcional), `BANDEJA_EMAILS` (ambas, **durante el ensayo, un alias de Victor**: puesta en marcha 1-3), `BANDEJA_SECRETO` (≥ 32), `VIGILANTE_SECRETO` (≥ 32), `SITIO_URL`. En el VPS (`/root/.tramitacion-vigilante.env`, 0600): `VIGILANTE_URL`, `VIGILANTE_SECRETO` (+ opcionales `NOTIFICAR`, `ESTADO`, `TESTIGO`). **Solo pruebas, nunca en Vercel:** `TRAMITACION_PRUEBA=1`, `ALTAVOZ_SIMULAR_FALLO` (`1` = Altavoz caído; `adjuntos` = «rechazo por adjuntos», 422 sin `codigo`), `CUOTA_*_HORA`, `TRAMITACION_DEBUG`. En local viven en `.env.local` (git-ignorado, 0600): no se imprime ni se lee en voz alta. Valores definitivos y secretos: en `docs/tramitacion-v2.md` §6 y §9 (sin secretos).

### Pruebas (todo contra la base REAL: `prueba = true`, `pruebas/` en el almacén, Altavoz SIMULADO, solo alias `victor.molins.10+algo@gmail.com`)
```bash
node --test "tests/unit/*.test.mjs"                           # unitarias, sin internet ni base (incluye el script del vigilante como caja negra)
node tests/servidor-local.mjs &                               # 127.0.0.1:8765; guarda el PID y párala por PID (nunca pkill -f)
node --test "tests/api/*.test.mjs"                            # 00 almacén · 10 iniciar/confirmar/cola · 20 bandeja · 30 vigilante · 40 adjuntos del aviso
node scripts/limpiar-pruebas.mjs --todo                       # repetido debe decir 0 tramitaciones, 0 objetos…
bash tests/e2e/run.sh formulario                              # 11 casos con Playwright (venv de scrapling): 1-9 con ?v2=1, 10 = interruptor apagado idéntico al html de producción, 11 = ?v2=1 + prefill; también: bandeja (17), extras (10), capturas
node scripts/limpiar-ensayo.mjs [--aplicar] GNE-… MEGA-…      # borra un ENSAYO en producción por referencia (solo envíos de un alias de Victor; sin --aplicar no borra nada)
```
Los ficheros de `tests/api/` se lanzan a la vez y comparten el servidor y su entorno: `20`, `30` y `40` esperan a los de número menor (`tests/api/hermanos.mjs`); un fichero nuevo que toque ese entorno hace lo mismo. **Para ver los adjuntos de cada aviso en simulación** (nombre, bytes, md5) el servidor local cambia el cartero por el «espía» `tests/cartero-espia.mjs` (`module.registerHooks`, Node ≥ 22.15), que los anota en memoria y los enseña en `GET /__pruebas/correos` (nada de esto está en `api/`): las pruebas tienen que llamar a la API por HTTP, no a `cola.js` desde su proceso. El almacén sirve las descargas por un CDN (≈ 60 s de caché aunque se borre un objeto): las pruebas «estropean» lo que la base cree del objeto, no el objeto. **Ruido del almacén:** el almacén de Supabase da a ratos `429 SlowDown / Too many connections` (visto en `00` y `10`, también con el código de antes de los adjuntos; `docs/tramitacion-v2.md` §8): si una pasada falla solo por eso, espera un par de minutos y repítela. Las filas `subiendo` viejas de `30` se **insertan** con su fecha (un UPDATE no sirve: el trigger pone `actualizada_en = now()`). `run.sh` se niega a arrancar si el puerto 8765 está ocupado. Servidor local y Playwright en 127.0.0.1 están autorizados por Victor para este trabajo (en serie, un navegador, `nice -n 10`).

### Puesta en marcha (resumen; el detalle y cada comando, en `docs/tramitacion-v2.md` §9 — cada punto que toca producción REQUIERE OK DE VICTOR)
La v2 se despliega **dormida** (`V2_ACTIVO = false`), se ensaya en producción con `?v2=1` y se enciende después.
0. Comprobar plan de Vercel (Hobby/Pro, Fluid) y con Altavoz: `responder_a` **y `adjuntos` (10 ficheros, 3 MB)** desplegados, `modo_prueba` apagado, clave «formulario-tramitacion»; y `V2_ACTIVO = false` en los dos html.
1. Variables en Vercel Production: `AVISO_DESTINO=victor.molins.10+tramitacion@gmail.com` y `BANDEJA_EMAILS=victor.molins.10+bandeja@gmail.com` (alias, solo durante el ensayo) y el resto definitivas (`ALTAVOZ_API_KEY` = la clave «formulario-tramitacion»; dos secretos nuevos).
2. Merge a `master` + push con `V2_ACTIVO = false` → el formulario de producción sigue igual; comprobar que un envío normal sigue yendo al Apps Script y la página no llama a `/api/tramitacion` (sin hacer un envío real) + `/api/_lib/config.js` → 404, vigilante sin secreto → 401, `/CLAUDE.md` y `/supabase/…` → 404.
3. Ensayo en producción por `/gnew?v2=1` y `/mega?v2=1` con alias de Victor y datos ficticios: aviso con adjuntos (y uno de más de 3 MB), acuse, bandeja (entrar, ver, ZIP, tramitar). Después, borrarlo a cero con `node scripts/limpiar-ensayo.mjs --aplicar <REF>…` (borra las filas y los objetos del almacén). Si el botón dice «Enviando contrato... No cierres esta página», el ensayo cayó al respaldo de Apps Script y ese contrato salió a `escaneos@`.
4. Valores definitivos (`AVISO_DESTINO=escaneos@gruponew.energy`, `BANDEJA_EMAILS=escaneos@gruponew.energy,victor.molins.10@gmail.com`) + redeploy. **No más ensayos con `?v2=1` a partir de aquí** (irían a `escaneos@`).
5. Encender: `V2_ACTIVO = true` en los dos html, commit + push (marcha atrás: `false` y otro push).
6. Vigilar el primer contrato real: bandeja + aviso con adjuntos en `escaneos@` + acuse.
7. VPS: `/root/.tramitacion-vigilante.env` (0600), pasada con `--dry`, cron `*/5` con la **ruta ABSOLUTA de node** (`/usr/local/bin/node`).
8. Testigo `/root/.tramitacion-vigilante-last` en `latido-crons.sh` (CIEGO si falta o > 15 min).
9. Ensayo de alarma (estropear el secreto del VPS → Telegram avisa a los 10 min).
10. Una semana con el respaldo activo (`RESPALDO_APPS_SCRIPT = true`); 11. `RESPALDO_APPS_SCRIPT = false` (commit + push) y Apps Script como archivo.

### Respaldo temporal (Apps Script)
`google-apps-script*/Code.gs` + Drive + hoja de registro + Gmail siguen intactos y describen el camino antiguo (secciones marcadas «respaldo temporal» más abajo). Se usan como **camino normal mientras la v2 está apagada** (`V2_ACTIVO = false`, sin `?v2=1`) y como respaldo de la v2 solo con `RESPALDO_APPS_SCRIPT = true` cuando `iniciar` falla 3 veces seguidas; esos contratos **no aparecen en la bandeja**. No se tocan en la v2: su despliegue pendiente (ver «Estado 8-oct-2026» más abajo) queda como estaba.

## Reglas de Oro (formulario y RESPALDO TEMPORAL Apps Script)
*Las filas que hablan de Drive, Apps Script, hoja de registro, Brevo o Gmail son del **respaldo temporal**; la «triple seguridad» Drive + Email + Sheet la sustituye en la v2 base + almacén + cola de correos (ver «Tramitación v2»). Las de móvil, validaciones y firma valen para los dos caminos.*

| Regla | Por qué |
|-------|---------|
| Mobile-first siempre | 70%+ usuarios son comerciales desde móvil |
| No duplicar estilos inline | Todo el CSS está en `<style>` dentro de cada html |
| Validación client-side antes de envío | Formatos españoles (CUPS, NIF/NIE/CIF, IBAN mod-97, móvil) validados en gnew.html antes de enviar |
| Mantener triple seguridad: Drive + Email + Sheet de registro | Decisión de arquitectura tras incidentes de pérdida de datos |
| Solo confirmar "enviado" si el backend responde `success:true` | Un fallo de red NO es un envío; el `ref_id` idempotente permite reintentar sin duplicar |
| No romper el flujo de firma digital | Canvas de firma es crítico para la tramitación |
| El candado global del backend solo dura milisegundos; el trabajo pesado (Drive, correos, hoja) va SIN candado | 10-sep-2026: con el candado abarcando todo el proceso, un envío al que se le atascó la hoja de registro (3 min y >6 min) puso en cola a todos los demás comerciales hasta 2 min y acabó en «Servidor ocupado» |
| El front nunca espera sin límite: 120 s + 8 s/MB por intento (antes 60 s + 4 s/MB, que vencía en subidas lentas del móvil y obligaba a subir todo otra vez; 9-oct-2026), 4 intentos, mismo `ref_id` | Un backend colgado dejaba al comercial minutos mirando «Enviando contrato...»; ahora vence, reintenta y el backend responde «ya tramitado» sin duplicar |
| Archivos GNEW: máx 15 archivos y 30MB EN TOTAL (validado en front y back) | Apps Script corta el POST en ~50MB y base64 infla +33%; Code.gs además rechaza >15 archivos y >45M chars base64 (`MAX_FILES`/`MAX_TOTAL_BASE64_CHARS`) |
| Historia (Brevo, dado de baja el 8-oct-2026): su 2xx NO garantizaba que el correo saliera. Hoy el aviso solo cuenta como enviado si Altavoz responde 2xx; si no, sale por Gmail con nota en «Errores / notas» | 7/8-oct-2026: el plan de Brevo no se renovó, la API seguía respondiendo 201 sin enviar («insufficient credits») y la hoja ponía «Email OK»: 27 avisos GNEW + 2 MEGA no llegaron. Ya no hay Brevo en el código (ni `brevoSinCreditos`): ver «Estado 8-oct-2026» abajo |
| Cada carpeta de Drive guarda `datos-formulario.txt` (`textOnlyData`) | Los datos del formulario (IBAN completo, dirección, potencias) solo viajaban en el correo; perdido el correo, no había forma de recuperarlos |
| Antes de pegar un Code.gs en Apps Script: `node --check` y comprobar que TODAS las funciones que llama `doPost` existen | El commit del 10-sep borró por error `sendMail`, `buildEmailHtml`, `buildAcuseHtml`, `getBrevoKey`, `sendViaBrevo`, `gmailFromAlias`, `sendViaGmail` de los dos Code.gs (y en MEGA descuadró la fila del registro); repuestas el 8-oct. El script publicado seguía con la versión anterior |
| `.vercelignore` deja fuera de la web CLAUDE.md y los Code.gs | Hasta el 8-oct se servían en tramitatucontrato.energy/CLAUDE.md |

## Rendimiento y reintentos (camino antiguo / respaldo Apps Script)
*Describe el camino antiguo (el normal mientras `V2_ACTIVO = false`). En la v2 el navegador espera `20 s` por `iniciar`, `45 s + 12 s/MB` por archivo (3 intentos) y `30 s` por `confirmar` (4 intentos; 25 s hasta el 10-oct-2026, el servidor puede tardar hasta ~28 s con los adjuntos); las fotos de más de 1 MB se siguen reduciendo en el navegador.*

- **Fotos reducidas en el navegador (9-oct-2026, aprobado por Victor):** `reducirFoto()` en `gnew.html`/`mega.html` redibuja las JPG/PNG de MÁS de 1 MB (lado largo máx. 2400 px, JPEG al 85 %, fondo blanco) y las manda como `.jpg`; PDF/Word y fotos pequeñas van intactas; ante cualquier fallo (o 30 s colgado) se manda el original. Archivos preparados UNO A UNO (memoria de móviles viejos); estado «Preparando N archivos...». Motivo (medido con «Ejecuciones» + `createdTime` de Drive + eventos de Altavoz): `doPost` tardaba 9-37 s y lo que más pesaba era guardar en Drive las fotos de móvil de 6-8 MB (28 s en un envío con tres); además la subida lenta vencía el tiempo por intento y se volvía a subir todo. Tramitación recibe la foto reducida, no el original (Centinela no está conectado a este formulario).
Por qué está montado así: la escritura en la hoja de registro (`SpreadsheetApp.appendRow`) puede quedarse colgada minutos, hasta que Apps Script mata la ejecución a los 6 min; con la marca de dedup al FINAL, el reintento del navegador duplicaba el contrato (dos carpetas, dos correos), y con el candado global (`LockService`) abarcando todo el proceso los demás envíos esperaban en cola en «Enviando contrato...». Para diagnosticar un envío lento o duplicado: `createdTime` de carpetas/archivos en Drive (paso Drive), la columna «Errores / notas» del Sheet y el registro del servidor de Altavoz filtrando por la etiqueta `tramitacion-*` (paso correo; Altavoz no guarda cada aviso en su base) y la columna Fecha del Sheet (paso registro).

**Cómo funciona (en ambos backends y ambos formularios):**
- `doPost`: `claimRef()` toma el candado solo para comprobar el duplicado y dejar la marca `inflight` (TTL 7 min) → libera → Drive → aviso → **`cache.put('ref:…','done')` YA** → acuse → registro. Un reintento que llega con la primera ejecución en curso espera (`waitForRef`, máx. 45 s) y devuelve `duplicated:true`; si la primera murió (marca caducada/ausente) la retoma.
- Respuestas transitorias llevan `retryable:true` («Servidor ocupado», «todavía se está procesando», fallo de Drive); los rechazos deterministas (token, tamaño, tipo) no. Si algo falla DESPUÉS de marcar `done`, la respuesta sigue siendo `success:true`.
- `logToSheet`: fila por **API REST de Sheets** (`appendRowRest`, `UrlFetchApp` + `ScriptApp.getOAuthToken()`, `valueInputOption=USER_ENTERED`), sin `SpreadsheetApp` salvo para crear la hoja la primera vez. Si falla, la fila se guarda en `ScriptProperties` (`PENDING_LOG_<ts>_<ref>`) y `flushPendingLogRows()` vuelca hasta 5 en el siguiente envío. `diagnosticoRegistro()` (editor) comprueba acceso a la hoja y filas pendientes. Mismos `oauthScopes`: no pide permisos nuevos.
- Front (`gnew.html`/`mega.html`): `AbortController` con `attemptTimeoutMs = 120 s + 8 s por MB` (60 s + 4 s/MB hasta el 9-oct-2026), `maxRetries = 4`, backoff 2,5 s × intento, contador visible «(N s, sigue en marcha)» a partir de 20 s, y reintento también cuando `json.retryable === true` o el error dice «Servidor ocupado»/«procesando» (compatible con el backend antiguo).
- Probado con Playwright en local (`127.0.0.1:8765` + `page.route` sobre `script.google.com`, sin tocar producción): timeout→reintento mismo ref→gracias; «Servidor ocupado»→reintento→gracias; `retryable:true`→reintento; «No autorizado»→overlay sin reintentos; red caída×4→overlay.

## Stack
- **Frontend:** HTML/CSS/JS vanilla (single-page, sin framework)
- **Backend:** funciones de Vercel en `api/` (Node 22, sin dependencias) + Supabase (base y almacén, proyecto `gnew-plataforma`) + Altavoz (correo). *Respaldo temporal:* Google Apps Script (Code.gs) — almacena en Drive + envía email
- **Hosting:** Vercel (archivos estáticos + rewrites)
- **GNEW:** Inter, Verde #0B6E4F, Accent #F9A825
- **MEGA:** Plus Jakarta Sans, Turquesa #14B8A6, Accent #EAB308

## Estructura
```
api/tramitacion/                # iniciar · confirmar · vigilante (funciones de Vercel)
api/bandeja/                    # codigo · entrar · salir · yo · lista · ficha · estado · reenviar
api/_lib/                       # lógica compartida (no se sirve): config, supabase, cartero, cola, vigilante…
bandeja.html · bandeja-entrar.html · bandeja-ficha.html · bandeja-zip.js   # la bandeja de backoffice
supabase/tramitacion.sql        # tablas, RLS, cuotas y bucket (ya aplicado)
scripts/                        # vigilante-tramitacion.mjs (cron del VPS) · limpiar-pruebas.mjs · limpiar-ensayo.mjs (borra un ensayo en producción por referencia)
tests/                          # unit/ · api/ · e2e/ · fixtures/ · servidor-local.mjs
docs/                           # tramitacion-v2.md (cómo funciona y puesta en marcha) · diseno-tramitacion-v2.md
package.json                    # solo type:module y node 22.x (sin dependencias)
gnew.html                       # GNEW: formulario multi-compañía (ruta /gnew)
gracias.html                    # GNEW: confirmación post-envío
logo-gnew.png                   # GNEW: logo (local, ya no depende de Dropbox)
favicon-gnew.png                # GNEW: favicon (64x64)
google-apps-script/
  Code.gs                       # GNEW backend ANTIGUO (respaldo temporal): Drive + Email + Sheet (doPost)
mega.html                       # MEGA: formulario exclusivo Mega Energía (ruta /mega)
gracias-mega.html               # MEGA: confirmación post-envío
logo-mega-energia.png           # MEGA: logo
favicon-mega.png                # MEGA: favicon
google-apps-script-mega/
  Code.gs                       # MEGA backend ANTIGUO (respaldo temporal): Drive + Email (doPost)
index.html                      # Landing de captación (email → webhook Make)
aviso-legal.html                # Páginas legales (enlazadas desde términos y footer)
privacidad.html
cookies.html
vercel.json                     # Redirect / → /gnew · rewrites /gnew, /mega, /gracias-mega
CLAUDE.md
```

## Archivos clave — GNEW (los `Code.gs` son el respaldo temporal)
| Archivo | Qué contiene |
|---------|-------------|
| `gnew.html` | Hero + formulario multi-sección + validadores españoles + firma canvas + honeypot + JS de envío con confirmación y reintentos idempotentes |
| `google-apps-script/Code.gs` | doPost → valida token/honeypot/límites → `claimRef` (candado breve) → Drive + email a `escaneos@gruponew.energy` → marca `done` → acuse → registro en Sheet por API REST (cola si falla) |
| `gracias.html` | Confirmación con animación de check verde |

### GNEW — Config backend (Apps Script · RESPALDO TEMPORAL)
- **Drive folder ID**: `1bTZhjmR9kPggL40ABS2JoHe3URuLlPim` ("Contratos Grupo New Energy", cuenta victor.molins.10@gmail.com — re-montaje 11/06/2026; la carpeta es PRIVADA, nadie más tiene acceso)
- **Correos (8-oct-2026, tarde)** — capa `sendMail()` con dos vías: **A) Altavoz** (`sendViaAltavoz`: `POST https://altavoz.gruponewenergy.es/api/v1/avisos`, `Authorization: Bearer <clave>`, JSON con `marca` = `GNEW`, `para`, `asunto`, `html` o `texto` y, si los hay, `responder_a`, `etiqueta` y `adjuntos` en base64; el remitente lo pone Altavoz —el de la marca— y no se manda; un 2xx = Amazon lo aceptó, cualquier otro código = no salió); clave `ALTAVOZ_API_KEY` en Propiedades del script **o** en el fichero privado `config-formulario.json` dentro de la carpeta de Drive (`{"ALTAVOZ_API_KEY": "av_…"}`, cacheada 1 h; solo lo ve la cuenta propietaria, NO compartir; **ya creado el 8-oct-2026 en las dos carpetas**); **B) respaldo GmailApp** desde la cuenta que ejecuta (con `GMAIL_ALIAS = tramitaciones@gruponewenergy.es` si está como "Enviar como"; si no, la cuenta por defecto). Sin clave o si Altavoz no devuelve 2xx → Gmail, y queda anotado en la columna "Errores / notas" del Sheet («vía Gmail (respaldo) porque Altavoz: HTTP 409 modo_prueba …» o «vía Gmail (falta ALTAVOZ_API_KEY)»). Con el «modo prueba» de Altavoz encendido TODOS los avisos salen por Gmail (409 `modo_prueba`): es lo correcto. Etiquetas: `tramitacion-aviso` (al buzón), `tramitacion-acuse` (al comercial), `tramitacion-aviso-texto` (aviso de solo texto) y `tramitacion-error` (último recurso). Aviso a escaneos@ con los documentos ADJUNTOS y **sin enlaces de Drive** (eran privados y solo generaban "solicitudes de acceso"), `Reply-To` = comercial. **Acuse de recibo al comercial** (`buildAcuseHtml`, sin IBAN/DNI) con `Reply-To` = escaneos@ y el aviso de dónde enviar la factura. Topes de adjuntos (los de Altavoz): `ATTACH_BUDGET_RAW` = 3.000.000 bytes reales ENTRE TODOS (Vercel corta las peticiones a ~4,5 MB) y `ATTACH_MAX_COUNT` = 10 adjuntos EN TOTAL, firma incluida; un documento o la firma solo va adjunto si cabe en bytes Y quedan plazas, por orden de llegada (documentos primero, firma después). Lo que no va adjunto se queda solo en Drive: la carpeta se comparte con escaneos@ (`shareFolderWithReceiver`) y el correo lleva el enlace (decisión de Victor, 8-oct-2026: «si es demasiado grande, el enlace de Drive»). Acuse al comercial a una dirección BLOQUEADA en Altavoz (409 `destinatario_suprimido`): NO se reintenta por Gmail y queda anotado como «Acuse al comercial: Altavoz: dirección bloqueada (…)» (el contrato sigue siendo success); el aviso al buzón, el aviso de texto y el correo de error sí caen a Gmail. Una sola clave de Altavoz, «formulario-tramitacion», sirve a los dos formularios (su dueño tiene remitente para GNEW y MEGA, probado en producción; si no lo tuviera, 422 `marca_sin_remitente` → Gmail). `diagnosticoAltavoz()` (editor) comprueba clave + permiso y manda una prueba con adjunto a `victor.molins.10+formulario@gmail.com`. Historia: hasta el 8-oct-2026 la vía A era Brevo (`BREVO_API_KEY`, remitente `escaneos@gruponew.energy`). ⚠️ `UrlFetchApp` necesita el scope `script.external_request`. El 17/08/2026 el script fallaba con «You do not have permission to call UrlFetchApp.fetch» aunque el editor NO pedía autorización (ni con Nueva versión, ni con implementación nueva, ni con `oauthScopes` explícitos): la cuenta tenía un permiso ANTIGUO guardado para el proyecto y Google no volvía a mostrar la pantalla de consentimiento. **Fix que funcionó:** myaccount.google.com/connections → «Grupo New Energy - Formulario» / «Mega Energia - Formulario» → Eliminar acceso → en el editor ejecutar cualquier función (`diagnosticoAltavoz` o `doGet`) → aparece el consentimiento con TODAS las casillas → Permitir. No hizo falta nueva versión: la implementación usa el permiso vivo de la cuenta. Los `appsscript.json` del repo declaran los `oauthScopes` explícitos (external_request, drive, mail.google.com, spreadsheets) para que la lista de permisos sea determinista.
- **Estado 8-oct-2026 — Brevo se da de baja** (Victor: el correo del grupo pasa a Altavoz). Brevo se quedó sin créditos el 7-oct 11:32 y desde entonces aceptaba y no enviaba: 31 avisos perdidos (29 GNEW + 2 MEGA), **reenviados el 8-oct desde el VPS por Amazon SES con la cuenta de Altavoz** (remitentes `info@gruponewenergy.es` / `administracion@megaenergia.es`, Reply-To = comercial, copia oculta a Victor; script y registro privados en `/root/datos-privados/reenvio-tramitacion-2026-10-08/`, `hechos.json`). Sin adjuntar por límites del conector: las 8 `firma.png` y la escritura de VELOCITY (13 MB), siguen en Drive. `config-formulario.json` se **renombró** a `config-formulario.DESACTIVADO-brevo-de-baja-2026-10-08.json` en las dos carpetas: sin clave, los avisos salen por la vía B (Gmail de Victor) con nota «vía Gmail (falta BREVO_API_KEY…)». **Migración a Altavoz (8-oct, tarde): hecha en los dos `Code.gs` del repo** (la API de avisos ya admite adjuntos y `responder_a`), probada con una simulación local sin red; **aún NO está desplegada en Apps Script**. La clave ya está dada: una sola, «formulario-tramitacion», para los dos formularios, y ya hay un `config-formulario.json` nuevo con `ALTAVOZ_API_KEY` en cada carpeta de Drive (su dueño tiene remitente para GNEW y MEGA: probado en producción); el fichero renombrado `config-formulario.DESACTIVADO-…` solo lleva la clave vieja de Brevo. **Pendiente (Victor):** (1) pegar los dos Code.gs en sus Apps Script y publicar «Nueva versión»; (2) ejecutar `diagnosticoAltavoz()` en cada proyecto (manda una prueba con adjunto a `victor.molins.10+formulario@gmail.com`; la primera vez Google puede pedir permiso); (3) mientras el «modo prueba» de Altavoz siga encendido los avisos seguirán saliendo por Gmail (409 `modo_prueba`).
- **Ref IDs**: `GNE-YYYYMMDD-XXXXXX` (los genera el cliente; el backend deduplica con CacheService 6h: `inflight` mientras se procesa, `done` en cuanto Drive + aviso están hechos)
- **Token anti-spam**: `FORM_TOKEN` debe coincidir en gnew.html y Code.gs (no es un secreto, solo frena bots)
- **Registro**: Sheet "Registro Tramitaciones GNEW" auto-creado en la carpeta de Drive (ID en ScriptProperties `LOG_SHEET_ID`)
- **Apps Script deployment**: acceso DEBE ser "Cualquier persona" (el front lee la respuesta JSON para confirmar el envío)
- **⚠️ Orden de despliegue** si cambian front y back: primero Vercel (gnew.html), DESPUÉS la nueva versión del Apps Script (el back nuevo rechaza envíos sin token; el back viejo ignora los campos nuevos)
- **Prefill DPC**: el comparador DPC abre `/gnew?quien_eres=...&cups=...` con los `name` de los inputs (`dpc-comparador/src/lib/contracting/build-contract-url.ts`). El prefill NUNCA acepta `cuenta_bancaria` ni `dni_firmante` por URL (PII en historiales/logs)

## Archivos clave — MEGA (los `Code.gs` son el respaldo temporal)
| Archivo | Qué contiene |
|---------|-------------|
| `mega.html` | Formulario branding turquesa Mega, tarifa desplegable, tipo suministro auto, validadores españoles, honeypot, envío con confirmación y reintentos idempotentes |
| `google-apps-script-mega/Code.gs` | doPost → valida token/honeypot/límites → `claimRef` (candado breve) → Drive + email a `escaneos@gruponew.energy` → marca `done` → acuse → registro en Sheet por API REST (cola si falla) |
| `gracias-mega.html` | Confirmación con branding Mega |

### MEGA — Config backend (Apps Script · RESPALDO TEMPORAL)
(mismo hardening que GNEW, aplicado 11/06/2026; ver sección GNEW para el detalle de cada pieza)
- **Drive folder ID**: `1cfxHV8Oz_N9wsG6E9MRM_74dMSiioXUx` ("Contratos Mega Energia")
- **Ref IDs**: `MEGA-YYYYMMDD-XXXXXX` (sufijo de 6 chars; los genera el cliente con crypto.getRandomValues; el backend deduplica con CacheService 6h + LockService)
- **Token anti-spam**: `FORM_TOKEN = 'MEGA-2026-h3p8k5z1q6'` debe coincidir en mega.html y Code.gs (distinto del de GNEW)
- **Honeypot**: campo oculto `mega_hp` (se envía como `hp`); si llega relleno el backend responde éxito falso y deja rastro en la Sheet
- **Límites**: máx 15 archivos (`MAX_FILES`) y 45M chars base64 (`MAX_TOTAL_BASE64_CHARS`), validados en front y back
- **Registro**: Sheet "Registro Tramitaciones MEGA" auto-creado en la carpeta de Drive (ID en ScriptProperties `LOG_SHEET_ID`), con `sheetSafe` (anti-inyección de fórmulas) e IBAN enmascarado
- **Email**: único destinatario `escaneos@gruponew.energy` desde el 8-oct-2026 (decisión de Victor: el backoffice trabaja ahí y es una cuenta de Google, así que abre los enlaces de Drive); hasta entonces iba a `administracion@megaenergia.es` (victormarron@ se quitó a propósito, commit bcc907c). Desde el 8-oct-2026 también `mega.html` (el aviso de error con el enlace `mailto:`) y `gracias-mega.html` apuntan a `escaneos@gruponew.energy`.
- **Correos (8-oct-2026, tarde)**: misma mecánica que GNEW — Altavoz con `ALTAVOZ_MARCA = 'MEGA'` (el remitente de la marca MEGA lo pone Altavoz) y clave `ALTAVOZ_API_KEY` en Propiedades del script o en `config-formulario.json` de la carpeta "Contratos Mega Energia" (`{"ALTAVOZ_API_KEY": "av_…"}`, privado); respaldo GmailApp (`GMAIL_ALIAS = tramitaciones@megaenergia.es`, opcional). Mismos topes de adjuntos (3 MB reales y 10 adjuntos en total, firma incluida → enlace de Drive, con la carpeta compartida con `escaneos@gruponew.energy`), misma regla del acuse a dirección bloqueada, mismas etiquetas `tramitacion-*` y `diagnosticoAltavoz()` (asunto «Prueba del formulario MEGA por Altavoz»). Misma clave «formulario-tramitacion» que GNEW (ya hay un `config-formulario.json` nuevo en la carpeta "Contratos Mega Energia"). Sin enlaces de Drive en el caso normal, acuse de recibo al comercial con `Reply-To` = escaneos@gruponew.energy. Historia: hasta el 8-oct-2026 la vía A era Brevo (`BREVO_SENDER = administracion@megaenergia.es`).
- **Apps Script deployment**: acceso DEBE ser "Cualquier persona" (el front lee la respuesta JSON para confirmar el envío)
- **⚠️ Orden de despliegue** si cambian front y back: primero Vercel (mega.html), DESPUÉS la nueva versión del Apps Script (el back nuevo rechaza envíos sin token; el viejo ignora los campos nuevos)

## Flujo de trabajo
1. Editar `gnew.html` / `mega.html` (CSS en `<style>`, JS en `<script>` al final)
2. Para backend, editar `api/` (funciones de Vercel; sin build, sin dependencias). El `Code.gs` solo se toca si hace falta el respaldo (luego desplegar manualmente en Google Apps Script — ver orden de despliegue arriba)
3. Testear: unitarias, API con el servidor local y e2e con Playwright (ver «Tramitación v2 → Pruebas»); abrir el html en el navegador no basta
4. Victor hace `git push` manualmente

## Design system
| Token | Valor |
|-------|-------|
| `--primary` | `#0B6E4F` (verde oscuro) |
| `--primary-light` | `#0D8A63` |
| `--accent` | `#F9A825` (amarillo) |
| `--bg` | `#F5F7FA` |
| `--radius` | `12px` / `--radius-sm: 8px` |
| Tipografía | Inter 300-800, system-ui fallback |

## Reglas de Ejecución
**PROHIBIDO sin pedir permiso:**
- git push (Victor hace push manualmente)
- rm -rf / borrar archivos
- Playwright / browser testing
- npm run dev / levantar servidores
- *Excepción (Victor, 8-oct-2026): para Tramitación v2 están autorizados el servidor local `tests/servidor-local.mjs` (127.0.0.1:8765) y Playwright en 127.0.0.1, en serie, un navegador, con `nice -n 10`, parando el servidor por PID (nunca `pkill -f`).*
- Producción (Vercel, variables, correo real, el cron del VPS, `/root/latido-crons.sh`): solo con el OK de Victor (ver la puesta en marcha)

**PERMITIDO sin preguntar:**
- Leer/escribir cualquier archivo de código
- git add, git commit
- Cualquier operación local de lectura/análisis

---

## Vault de Obsidian (contexto transversal)
Este proyecto está conectado con mi vault de Obsidian en `C:\Users\Victor\Documents\VITER VAULT`
(en WSL: `/mnt/c/Users/Victor/Documents/VITER VAULT`).

Si el vault no está cargado como directorio adicional, cárgalo con `/add-dir <ruta>`.

### Contexto de negocio
Este repo contiene dos formularios: **GNEW** (brokerage, múltiples compañías) y **MEGA** (comercializadora directa, solo Mega Energía). Son negocios distintos con flujos separados. En el vault busca:

- **Mega Energía**: tarifas, comisiones, estructura de red comercial, incentivos
- **API SICOM**: integración con comercializadoras, flujos de contratación
- **ATR / regulación**: cambios regulatorios que afecten al formulario
- **Equipo comercial**: jerarquía de agentes, onboarding, materiales de venta
- **GNEW CRM**: si hay interacción con el CRM (Supabase, roles, RLS)

### Regla
Antes de tomar decisiones de arquitectura o negocio en este proyecto, consulta el vault para verificar decisiones previas o contexto relevante.
