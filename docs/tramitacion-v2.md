# Tramitación v2 — cómo funciona y cómo se pone en marcha

Formulario de tramitación de contratos (`tramitatucontrato.energy`: `/gnew` y `/mega`) con almacén propio, aviso a backoffice **con la documentación adjunta** por Altavoz, bandeja de backoffice y vigilante. Sustituye al camino «Apps Script + Drive + Sheet», que queda como **respaldo temporal** durante la primera semana.

**Se despliega DORMIDA.** Un interruptor, la constante `V2_ACTIVO` de `gnew.html` y `mega.html` (hoy `false`), decide qué camino usa el formulario: con `false` envía **exactamente como antes** (Apps Script) y no llama a `/api/tramitacion/*`; la v2 solo se usa abriendo la página con `?v2=1`. Se ensaya así en producción y, cuando está lista, se enciende poniendo `true` (§9).

Este documento es la referencia de lo **construido** (órdenes 1 a 6 y 6b, el interruptor). El razonamiento y las alternativas descartadas están en [`diseno-tramitacion-v2.md`](./diseno-tramitacion-v2.md); si algo difiere, manda este documento y el código. No lleva ningún secreto: las variables se nombran, nunca se dan.

---

## 1. En llano

El comercial rellena el formulario como siempre. Cambia lo que pasa por detrás:

1. **Primero se apunta el contrato en nuestra base** (la Supabase de la plataforma, proyecto `gnew-plataforma`).
2. **Después cada documento se sube directamente al almacén**, de uno en uno, con barra de progreso y reintentos. No pasa por Vercel (que corta a 4,5 MB por petición).
3. **Solo cuando el servidor comprueba que todos los archivos están y pesan lo que deben**, el comercial ve «Contrato enviado». Desde ese instante el contrato está a salvo aunque el correo tarde.
4. **El aviso a backoffice y el acuse al comercial** salen por Altavoz. Si Altavoz no responde, se quedan en una cola y un **vigilante** (un cron del VPS, cada 5 minutos) los reintenta; y avisa a Victor por Telegram si algo lleva más de 10 minutos atascado.
5. **Backoffice trabaja desde una bandeja** en la misma web (`/bandeja`, entrada con un código que llega por email): ve cada contrato, descarga los documentos (uno a uno o todo en un ZIP) y lo marca como tramitado.
6. **El aviso a backoffice lleva la documentación ADJUNTA** (decisión de Victor, 10-oct-2026, como con el sistema anterior): los documentos por su orden y la firma al final, hasta 10 ficheros y 3.000.000 bytes reales entre todos (los topes de Altavoz). Lo que no cabe se queda «en la bandeja» y el correo lo dice. El botón «Abrir en la bandeja» va siempre: la bandeja sigue siendo la copia segura y donde se marca «tramitada». El acuse al comercial no cambia: sin adjuntos, sin IBAN ni DNI.

La primera semana, si la API nueva no contesta al empezar, el formulario usa el camino antiguo (Apps Script) como respaldo.

Todo lo anterior vale **cuando la v2 está encendida**. Hasta entonces (`V2_ACTIVO = false`) el comercial rellena el formulario y se envía por el camino de siempre, sin ninguna diferencia que pueda notar; solo quien abre la página con `?v2=1` (el ensayo de la puesta en marcha) pasa por la v2.

## 2. El recorrido de un contrato

```
 navegador (gnew.html / mega.html)                 Vercel (api/)                         Supabase                Altavoz
 ─────────────────────────────────                 ─────────────                         ────────                ───────
 1. POST /api/tramitacion/iniciar ───────────────► valida, apunta el contrato ─────────► fila «subiendo»
    (datos + lista de archivos + firma)            firma el PNG de la firma              + una URL firmada
 ◄──────────────── una URL firmada por archivo ◄───                                       por archivo
 2. PUT de cada archivo ─────────────────────────────────────────────────────────────────► almacén (bucket privado)
 3. POST /api/tramitacion/confirmar ─────────────► comprueba el almacén (existe y pesa    fila «recibida»
                                                   lo declarado) ───────────────────────► crea aviso + acuse
 ◄──────────── «Contrato enviado» (listo:true) ◄───  intenta enviar (aviso 15 s, acuse 6 s) ──────────────────► aviso a escaneos@ CON los documentos
                                                     (el aviso baja antes los documentos del almacén;                       adjuntos; acuse al comercial (sin adjuntos)
                                                      lo repite en cada intento: confirmar, vigilante, bandeja)
 4. cada 5 min, desde el VPS: POST /api/tramitacion/vigilante ► reintenta lo pendiente, concilia, abandona…
 5. backoffice: /bandeja  ► ficha ► descarga ► «Marcar como tramitada»
```

Nada de esto duplica si el navegador reintenta: `ref` (la referencia `GNE-…`/`MEGA-…` que genera el navegador) es la clave de idempotencia. Repetir `iniciar` o `confirmar` con la misma referencia nunca crea otra fila ni otro correo.

## 3. Piezas

| Dónde | Qué es |
|---|---|
| `gnew.html`, `mega.html`, `gracias.html`, `gracias-mega.html` | El formulario y las páginas de gracias. Constantes `API_BASE`, `FORMULARIO`, **`V2_ACTIVO`** (el interruptor de la v2; `USAR_V2` = `V2_ACTIVO` o `?v2=1` en la dirección de esta carga) y `RESPALDO_APPS_SCRIPT` (solo cuenta cuando se usa la v2). Con la v2 apagada `ejecutarEnvio` llama a `enviarComoAntes`, que reutiliza `enviarPorRespaldo` sin pasar por la API. |
| `api/tramitacion/iniciar.js`, `confirmar.js` | Registrar el contrato y cerrarlo. Lógica en `api/_lib/tramitacion.js`. |
| `api/tramitacion/vigilante.js` | Una pasada del vigilante (con `Authorization: Bearer`). Lógica en `api/_lib/vigilante.js` y `api/_lib/cola.js`. |
| `api/bandeja/*.js` | Acceso con código, lista, ficha, cambio de estado y «volver a enviar». Lógica en `api/_lib/bandeja.js`. |
| `bandeja.html`, `bandeja-entrar.html`, `bandeja-ficha.html`, `bandeja-zip.js` | La bandeja (móvil primero). El ZIP se monta en el navegador. |
| `api/_lib/` | `config` (variables y límites), `http`, `validadores`, `nombres`, `estados`, `correos` (asuntos, cuerpos y qué documentos van adjuntos), `sesion`, `supabase` (cliente con `fetch`, también descarga del almacén), `cartero` (Altavoz, con adjuntos), `cola`, `tramitacion`, `bandeja`, `vigilante`. Los ficheros `_*` y `api/_lib` no son funciones: Vercel no los sirve. |
| `supabase/tramitacion.sql` | Tablas, función de cuotas, RLS y bucket. **Ya aplicado** en `gnew-plataforma` el 9-oct-2026. Es idempotente; se aplica con `execute_sql`, nunca con `apply_migration`. |
| `scripts/vigilante-tramitacion.mjs` | El vigilante del VPS (cron). |
| `scripts/limpiar-pruebas.mjs` | Borra todo lo que dejan las pruebas en la base y el almacén (solo `prueba = true` y `pruebas/`). |
| `scripts/limpiar-ensayo.mjs` | Borra, **por referencia**, los envíos del ensayo en producción (paso 3 de §9) con sus objetos del almacén. Solo envíos cuyo comercial sea un alias de Victor; sin `--aplicar` no borra nada. |
| `tests/` | Unitarias, de API, con navegador y el servidor local (con su «espía» de Altavoz, `tests/cartero-espia.mjs`). Ver §8. |
| `google-apps-script/`, `google-apps-script-mega/` | **Respaldo temporal** (ver §10). |

**Quién ha abierto cada ficha** (14-oct-2026). Cada apertura real de una ficha queda como **evento** `ficha_abierta` (`actor` = el correo de la sesión): `GET /api/bandeja/ficha?ref=…&abrir=1` lo apunta, y la página manda `abrir=1` solo en la carga de verdad (la primera y la de «Reintentar»), nunca en sus refrescos en silencio (enlaces a los ~9 min, volver a la pestaña, tras una acción); además el servidor no apunta otra del mismo correo hasta pasados 15 minutos (`MINUTOS_ENTRE_APERTURAS`). `GET /api/bandeja/lista` añade a cada item `vistas:[{por, en}]` (una entrada por persona con su apertura más reciente, hasta 5; `[]` si nadie la ha abierto) y la lista lo pinta como «Abierta por … hace 5 min» (en cualquier estado) o, si es una **pendiente** que nadie ha abierto, «Sin abrir» (raya azul y pastilla); la ficha, como «Abierta por …» bajo la insignia y «Ficha abierta por …» en el historial. **Evento y no columna** porque un UPDATE en `tramitaciones` dispara el trigger `tramitacion_tocar` y el vigilante abandona las `subiendo` por `actualizada_en`: mirar una subida a medias la mantendría viva. Sin SQL nuevo (solo se anotó el tipo en el comentario de `supabase/tramitacion.sql`). **«Sin abrir» solo en las pendientes** (`estado === 'recibida'`): una tramitada, incompleta o descartada que nadie ha abierto no lleva esa fila ni la raya, porque se contradiría con su estado; las pendientes de antes de esta versión sí la llevan hasta que alguien las abra.

Sin dependencias npm: todo es `fetch` y Node 22. `.vercelignore` deja fuera de la web `supabase/`, `scripts/`, `tests/`, `docs/`, `.env*`, `CLAUDE.md` y los `Code.gs`.

## 4. Estados

### Tramitación (`tramitaciones.estado`)

| Estado | En la bandeja | Cómo se llega |
|---|---|---|
| `subiendo` | Subiendo | `iniciar` crea la fila. |
| `recibida` | **Pendiente** | `confirmar`: todo está en el almacén con el tamaño declarado. |
| `tramitada` | Tramitada | Backoffice: «Marcar como tramitada». Con «Volver a pendiente» vuelve a `recibida`. |
| `abandonada` | Incompleta | `subiendo` sin movimiento durante 24 h (vigilante), o `iniciar` con `ref_anterior` porque el comercial cambió la lista de archivos. `iniciar` con esa misma referencia la reanuda (`subiendo`). |
| `descartada` | Descartada | Honeypot relleno: nace terminal, sin documentos ni correos. Se ve en «Descartadas» por si fuera un falso positivo. |

Las filas de prueba llevan `prueba = true` y viven bajo `pruebas/` en el almacén; el servidor de producción nunca las ve y el de pruebas nunca ve las de producción.

### Correo (`tramitacion_correos.estado`), decidido por el `codigo` que devuelve Altavoz

| Altavoz | Estado | ¿Avisa el vigilante? |
|---|---|---|
| 2xx | `enviado` | no |
| 409 `destinatario_suprimido` | `suprimido` (final) | **sí, al momento**: si es el aviso, el buzón de backoffice ha rebotado y NADA llega |
| 409 `modo_prueba` | `pendiente` (reintenta) | sí, a los 10 min: no se arregla solo |
| 401 / 403 / 422 | `error_configuracion` (final) | sí, al momento |
| 502 `envio_incierto` | `incierto` (final: «no se repite solo») | sí, al momento: lo decide una persona con «Volver a enviar» |
| 502, 503, 500, red, tiempo | `pendiente` con espera creciente | sí, a los 10 min |
| 8.º fallo | `agotado` (final) | sí, al momento |

Espera tras el fallo n (minutos): 1, 3, 10, 30, 60, 120, 240; el 8.º fallo lo deja `agotado`. Antes de enviar se coge un cerrojo (`enviando`, 60 s): dos procesos nunca envían el mismo correo; uno vencido vuelve a `pendiente` y cuenta como intento. Riesgo asumido: si la función muere entre el 2xx de Altavoz y apuntarlo, se reenvía (un correo duplicado, nunca uno perdido). «Volver a enviar» (bandeja) deja el correo a cero y lo intenta al momento.

### Los adjuntos del aviso (orden 6, decisión de Victor del 10-oct-2026)

Backoffice (`escaneos@`) recibe cada contrato con **los documentos adjuntos**, como con el sistema anterior; la bandeja queda como copia segura y para marcar tramitados. Esto sustituye al «aviso sin adjuntos» de la decisión del 8-oct. Solo el **aviso** lleva adjuntos: el acuse al comercial sigue sin ellos, sin IBAN y sin DNI.

**Qué va adjunto** (`seleccionarAdjuntos`, en `api/_lib/correos.js`; las mismas reglas que el `Code.gs` de siempre y que los topes de Altavoz, api.md §5):

| Regla | Detalle |
|---|---|
| Qué documentos | Solo los `subido` y con su tamaño comprobado (`tamano_comprobado` > 0), con una de las extensiones de Altavoz (`pdf`, `jpg`, `jpeg`, `png`, `doc`, `docx`) |
| Orden | Primero los de orden 1..N, por su orden; la **firma (orden 0) al final** |
| Topes | Entra uno si (bytes acumulados + los suyos) ≤ **3.000.000** Y quedan plazas (**10 adjuntos EN TOTAL, firma incluida**). Si uno no cabe se salta y los siguientes se miran igualmente (un PDF grande al principio no bloquea a los pequeños). Con 12 documentos y la firma, entran los 10 primeros y la firma se queda en la bandeja |
| Nombres | Altavoz **no** exige nombres distintos; lo hacemos nosotros para que backoffice no vea dos «dni.jpg»: `dni.jpg`, `dni (2).jpg`, `DNI (3).jpg` (sin distinguir mayúsculas, con la extensión intacta). Los saltos de línea, tabuladores y comillas pasan a espacio, como hace Altavoz. El nombre del adjunto es el mismo que sale en la lista del correo |
| El correo | Bloque «**Documentación adjunta a este correo (n)**» con nombre y tamaño de cada adjunto (no sale si n = 0); si algo no cabe, un aviso naranja «**No caben como adjunto y están en la bandeja:** nombre (tamaño), …»; y SIEMPRE el botón «**Abrir en la bandeja**». Versión texto equivalente. Todo escapado en el HTML |

**Cada intento de envío del aviso** (al confirmar, el vigilante o «Volver a enviar» en la bandeja: todos pasan por `cola.intentarEnvio`) hace lo mismo: elige qué va adjunto → **vuelve a descargar** esos documentos del almacén (de 2 en 2 y con un plazo común, con la clave de servicio: `descargarObjeto` en `api/_lib/supabase.js`) → comprueba que cada uno pesa **exactamente** su `tamano_comprobado` → regenera el cuerpo → lo manda con `adjuntos: [{nombre, contenido}]` (base64 estándar y estricto). **Los adjuntos no se guardan en la base** (como el cuerpo, solo se guarda en simulación).

**Si algo falla, backoffice recibe el aviso igualmente:**

| Fallo | Qué pasa |
|---|---|
| No se puede descargar un adjunto (error, tiempo, objeto que no existe o que no pesa lo comprobado) | El aviso sale con los que sí se han bajado y ese documento pasa a la lista «están en la bandeja». Evento `adjuntos_no_descargados` con `{n, ordenes, causas}` (`causas`: `tiempo`, `red`, `no_existe`, `tamano`, `otro`; **sin nombres de documentos**) |
| Altavoz rechaza por los adjuntos: **413** (Vercel corta una petición de más de ~4,5 MB) o **422 sin `codigo`** con adjuntos en la petición | **En el mismo intento** se manda otra vez, sin adjuntos y con todo «en la bandeja»; sigue contando como UN intento. Evento `adjuntos_rechazados` con `{http, n}`. Si el segundo envío también falla, se clasifica como siempre (un 422 sin adjuntos es `error_configuracion`) |
| Cualquier otro fallo (Altavoz caído, 409, 502…) | Como siempre: cola, esperas crecientes, vigilante |

⚠️ api.md §5 solo da `codigo` al 422 `marca_sin_remitente`: las validaciones de los adjuntos (más de 10, más de 3 MB, tipo, base64, vacío…) responden `{"error": "<frase>"}` **sin `codigo`**, así que no se pueden distinguir por código: un 422 sin `codigo` a una petición que llevaba adjuntos se trata como «rechazo por adjuntos» (si en realidad era otra cosa, el reintento sin adjuntos falla igual y queda `error_configuracion`, a costa de una llamada de más). El cartero también comprueba los topes ANTES de llamar (`defectoDeAdjuntos`): una selección que no cumpliera sale como el mismo rechazo, sin red.

**Historial.** `aviso_enviado` lleva ahora `{intentos, simulado, adjuntos, en_bandeja}` (cuántos documentos han ido adjuntos y cuántos solo en la bandeja). Los dos eventos nuevos (`adjuntos_no_descargados`, `adjuntos_rechazados`) solo aparecen cuando algo falla; la ficha de la bandeja los cuenta en llano: «Algún documento no se pudo adjuntar al aviso; está en la bandeja» y «Altavoz no aceptó los adjuntos: el aviso salió sin ellos; los documentos están en la bandeja» (`textoEvento` de `bandeja-ficha.html`).

**Tiempos.** El aviso tiene **15 s EN TOTAL** (descargar los documentos + entregarlos a Altavoz): las descargas usan como mucho el 40 % (6 s en total, de 2 en 2: el almacén de Supabase responde un 429 «SlowDown / Too many connections» cuando va justo de conexiones) y Altavoz el resto; el reintento sin adjuntos tiene como mínimo 4 s aunque el primer envío haya gastado el plazo. El acuse (sin adjuntos) sigue con 8 s (6 s en `confirmar`).

| Dónde | Aviso | Acuse |
|---|---|---|
| `confirmar` | 15 s | 6 s, y solo si desde el inicio han pasado menos de **20 s** (era 12) |
| Vigilante | 15 s | 8 s |
| «Volver a enviar» (bandeja, `maxDuration` 30 s) | 15 s | 8 s |

**El almacén guarda en un CDN lo que se descarga.** Una descarga de `/storage/v1/object/…` queda en el CDN de Supabase (Cloudflare, `HIT` en la segunda) y, si luego se borra o se cambia el objeto, se sigue sirviendo el viejo hasta que el CDN lo purga (≈ 60 s; medido el 10-oct-2026). En producción no afecta —los documentos no se cambian ni se borran tras subirlos—, pero las pruebas no pueden «estropear» un objeto que ya se haya descargado: estropean lo que la base cree de él (su clave o su tamaño comprobado).

## 5. El vigilante

### 5.1 El endpoint — `POST /api/tramitacion/vigilante`

Sin `Authorization: Bearer <VIGILANTE_SECRETO>` (comparación en tiempo constante) responde `401`; con otro método, `405`. Si la petición trae un Bearer pero `VIGILANTE_SECRETO` no está puesto o es corto, `500` (nunca se deja pasar a nadie por un fallo de configuración). El cuerpo de la petición se ignora. Cada pasada hace, **en este orden**:

| Paso | Qué hace |
|---|---|
| 0. Conciliar | Las `recibida`/`tramitada` de los últimos 7 días a las que les falta el aviso o el acuse los reciben (con el evento `correos_conciliados`). Sana un corte entre «recibida» y la creación de los correos. |
| 1. Liberar cerrojos | Los `enviando` con el cerrojo vencido vuelven a `pendiente` (cuenta un intento). |
| 2. Reintentar | Hasta **10** correos `pendiente` a los que ya les toca (aviso y acuse; nunca códigos de acceso), de uno en uno, cada uno con su tope: **15 s el aviso** (que vuelve a descargar los documentos y los adjunta) y 8 s el acuse. |
| 3. Abandonar | Las `subiendo` sin movimiento en 24 h pasan a `abandonada` (evento `abandonada`, actor `vigilante`). |
| 4. Limpiar | Cuotas y códigos de acceso de más de un día. |

Devuelve `200` con el parte: `conciliadas`, `liberados`, `reintentados`, `enviados`, `abandonadas`, `limpiados {cuotas, accesos}`, `atascados`, `subidas_a_medias` y `pendientes_total`. Solo lleva referencias, estados y contadores: **nunca nombres, correos ni IBAN**.

- **`atascados`**: correos aviso/acuse sin enviar que están en un estado final o llevan más de 10 minutos. Cada uno trae `id, tipo, ref, estado, intentos, codigo_respuesta, creado_en, minutos` y `ficha` (la URL de la ficha en la bandeja).
- **`subidas_a_medias`**: tramitaciones `subiendo` de 1 h a 24 h **sin movimiento**: `ref, formulario, creada_en, actualizada_en, minutos`.

**Se mide por `actualizada_en`, no por `creada_en`.** Reanudar una `abandonada` hace un UPDATE (un trigger de la tabla pone `actualizada_en = now()` en cada cambio), así que una fila reanudada de hace más de 24 h no se vuelve a abandonar; y los `minutos` de una subida a medias cuentan desde su último movimiento. Hay una prueba que lo demuestra de punta a punta.

**Presupuesto de tiempo (orden 6).** La función vive 60 s como mucho y el script del VPS corta a los **55 s**. Con los adjuntos, un aviso puede tardar hasta 15 s (descargar + entregar a Altavoz) y un acuse hasta 8 s. Por eso **no se empieza ningún envío pasados 25 s** desde el inicio de la pasada (antes 10 s): lo que no quepa lo recoge la siguiente, 5 minutos después. Peor caso, con Altavoz colgado:

| | |
|---|---|
| el último envío empieza justo antes del límite | 25 s |
| su tope (un aviso) | + 15 s |
| reintento sin adjuntos, solo si el rechazo llegó tarde | + 4 s |
| cerrojo, lectura y escritura en la base alrededor del envío | + 2 s |
| conciliar, abandonar, limpiar y el parte (consultas de ~0,2 s) | + 5 s |
| **peor pasada** | **51 s** < 55 s del script < 60 s de la función |

Así una caída de Altavoz nunca se ve desde el VPS como «la web no responde». (`tests/unit/tiempos.test.mjs` ata estos números con `vercel.json` y el script: si alguien cambia uno sin mirar los otros, falla.) Por la misma razón el bucle se detiene en la primera vuelta que no intenta nada: o no queda nada a lo que le toque, o el correo elegido lo tenía otra pasada solapada (lo que quede lo recoge la siguiente).

**Modo.** Todo lo que toca una tramitación filtra por `prueba`: el vigilante de producción solo ve lo de producción. Las cuotas y los códigos de acceso no cuelgan de una tramitación: en el servidor de pruebas solo se limpian los de prueba (claves `pruebas:*` y alias `victor.molins.10+…@gmail.com`).

### 5.2 El script del VPS — `scripts/vigilante-tramitacion.mjs`

Un cron lo lanza cada 5 minutos. Solo usa `node:fs`, `node:child_process` y `fetch` (no importa nada del repo: corre desde la copia del VPS). En cada pasada llama al endpoint (tope **55 s**; era 25 s antes de los adjuntos), avisa de lo nuevo por Telegram y toca el testigo.

**Qué avisa — una sola vez por incidencia («clave»), con mensaje de «resuelto» cuando desaparece:**

| Clave | Cuándo | Mensaje (ejemplo) |
|---|---|---|
| `correo:<id>:<estado>` | un aviso/acuse lleva más de 10 min sin salir | 🔴 Tramitación: el AVISO de GNE-… lleva 14 min sin salir (3 intentos; Altavoz no responde). Ficha: https://tramitatucontrato.energy/bandeja/c/GNE-… |
| `correo:<id>:<estado>` | estado final | 🔴 … no se ha podido enviar: el buzón de tramitación está bloqueado en Altavoz… / error de configuración / puede haber salido o no (envío incierto) / tras 8 intentos. Revísalo en la bandeja. |
| `subida:<ref>` | subida a medias (> 1 h) | 🟡 Tramitación: el envío GNE-… lleva 1 h 20 min con la documentación sin terminar de subir. |
| `endpoint` | la web no contesta **2 veces seguidas** (HTTP distinto de 2xx o sin respuesta) | 🔴 Tramitación: el vigilante no consigue hablar con la web (2 veces seguidas). Los correos pendientes no se están reintentando. |
| (resueltos) | la clave desaparece del parte | ✅ Tramitación: el AVISO de GNE-… ya ha salido. · ✅ … el envío GNE-… ya no está a medias. · ✅ … la web vuelve a responder al vigilante. |

Reglas finas:

- Si **el mismo correo empeora** (pasa de `pendiente` a `agotado`, por ejemplo) la clave cambia: se avisa de lo nuevo y **no** se dice que lo anterior «ya ha salido».
- Si la web **no contesta**, no se manda ningún «resuelto» ni se purga nada: no se sabe si las incidencias siguen ahí.
- Si **Telegram falla** (`NOTIFICAR` termina con error), esa incidencia no se da por avisada, no se insiste con las demás en esa pasada (con Telegram caído cada intento tarda decenas de segundos y las pasadas se solaparían) y todo se reintenta en la pasada siguiente.
- Las entradas del estado **no vistas en 24 h se olvidan** sin avisar.
- Los mensajes **no llevan datos personales**: solo referencias, tipo de correo, tiempos y el enlace a la ficha. Del parte solo se leen campos conocidos y con su forma comprobada.
- **Nunca imprime el secreto ni la URL** (ni en el registro ni en los mensajes). Los fallos de red se cuentan con una frase fija, nunca con el texto de la excepción. No sigue redirecciones (el secreto no viaja a otro sitio) y rechaza una URL `http://` que no sea local.

**Opciones:**

| Opción | Efecto |
|---|---|
| (ninguna) | Pasada normal: avisa, guarda el estado y toca el testigo. |
| `--dry` | Llama a la web, imprime el parte y lo que **avisaría**, pero **no avisa, no guarda estado y no toca el testigo**. ⚠️ **La web hace su trabajo de verdad**: contra producción, `--dry` sí reintenta correos reales, concilia y abandona envíos viejos; lo único que no hace es avisar por Telegram ni guardar el estado del script. Lee el estado para decir qué es nuevo y qué ya estaba avisado. |
| `--una-vez` | Pasada suelta: **ignora el estado guardado** (todo cuenta como nuevo), avisa y **no guarda estado ni toca el testigo**. |
| `--ayuda` | El uso. |

Códigos de salida: `0` pasada hecha · `1` la web no ha contestado bien · `2` mala configuración o uso.

**Ficheros y configuración** (el entorno manda sobre el fichero):

| Qué | Por defecto |
|---|---|
| Configuración | `/root/.tramitacion-vigilante.env` (0600) con `VIGILANTE_URL` y `VIGILANTE_SECRETO` |
| `NOTIFICAR` | `/root/notifica-telegram.sh` (carga él solo las credenciales de Telegram; el vigilante jamás las ve) |
| `ESTADO` | `/root/.tramitacion-vigilante-state.json` (0600) |
| `TESTIGO` | `/root/.tramitacion-vigilante-last` |
| Registro del cron | `/root/tramitacion-vigilante.log` (una línea por pasada tranquila; crece ≈ 40 KB al día) |

`VIGILANTE_ENV` (otra ruta para el fichero de configuración) y `VIGILANTE_TOPE_MS` (cambia el tope de 55 s de la llamada) solo existen para las pruebas.

**El testigo** se toca en **cada pasada normal, también si la web falló**: dice «el cron corrió». El fallo de la web ya va por Telegram, **y solo por Telegram**: con la web caída, `latido-crons.sh` dirá «vivo». `latido-crons.sh` debe darlo por CIEGO si falta o tiene más de 15 minutos (ver §9, paso 8). `--dry`, `--una-vez` y los errores de configuración (código 2) no lo tocan.

### 5.3 Qué hacer cuando llega un aviso

| Aviso | Qué mirar |
|---|---|
| «…lleva N min sin salir… Altavoz no responde» | Abrir la ficha. Si Altavoz está caído, se arregla solo (el vigilante sigue reintentando con espera creciente). Si dura, mirar Altavoz. Con «Volver a enviar» en la ficha se prueba al momento. |
| «…Altavoz está en modo prueba» | El candado `modo_prueba` de Altavoz está encendido: no envía a direcciones reales. Hablar con la sesión de Altavoz. |
| «…bloqueado en Altavoz» | El aviso: el buzón de backoffice ha rebotado y **no llega ningún aviso**: urgente. El acuse: la dirección del comercial está bloqueada (mirar la ficha). |
| «…error de configuración» | Clave, permiso o remitente de Altavoz mal puestos (`ALTAVOZ_API_KEY`, marca sin remitente). |
| «…puede haber salido o no» | Amazon no confirmó. Comprobar si llegó y, si no, «Volver a enviar». |
| «…sin terminar de subir» | El comercial se quedó a medias (mala cobertura, cerró la página). Avisarle; al reabrir el formulario con la misma referencia sigue donde lo dejó. A las 24 h sin movimiento queda «Incompleta». |
| «…no consigue hablar con la web» | Mirar si la web está caída, si `VIGILANTE_SECRETO` coincide en Vercel y en el fichero del VPS y el registro `/root/tramitacion-vigilante.log`. |

## 6. Variables de entorno

Los valores no están aquí. En Vercel las pone el orquestador (Production); en local, `.env.local` (git-ignorado, 0600).

| Variable | Dónde | Qué es |
|---|---|---|
| `SUPABASE_URL` | Vercel | URL del proyecto `gnew-plataforma` |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (secreta) | Clave de servicio: solo las funciones de `api/` la usan; nunca llega al navegador |
| `ALTAVOZ_URL` | Vercel | `https://altavoz.gruponewenergy.es` |
| `ALTAVOZ_API_KEY` | Vercel (secreta) | La clave de Altavoz **«formulario-tramitacion»** (envía como `escaneos@gruponew.energy` para GNEW y MEGA) |
| `ALTAVOZ_SIMULAR` | Vercel | En producción, `0`. Con `1` no se envía nada (solo pruebas) |
| `AVISO_DESTINO` | Vercel | Buzón que recibe el aviso: `escaneos@gruponew.energy` (GNEW y MEGA). **Durante el ensayo (§9, pasos 1-3) es un alias de Victor** (`victor.molins.10+tramitacion@gmail.com`) |
| `AVISO_DESTINO_MEGA` | Vercel (opcional) | Si existe, el aviso de MEGA va aquí. **No se pone**: MEGA usa `AVISO_DESTINO` |
| `BANDEJA_EMAILS` | Vercel | Quién puede entrar en la bandeja (separados por comas): `escaneos@gruponew.energy,victor.molins.10@gmail.com`. **Durante el ensayo (§9, pasos 1-3) es un alias de Victor** (`victor.molins.10+bandeja@gmail.com`) |
| `BANDEJA_SECRETO` | Vercel (secreta, ≥ 32 car.) | Firma las sesiones y los hashes de códigos e IP |
| `VIGILANTE_SECRETO` | Vercel y VPS (secreta, ≥ 32 car.) | El Bearer del vigilante; el mismo valor en `/root/.tramitacion-vigilante.env` |
| `SITIO_URL` | Vercel | `https://tramitatucontrato.energy` (los enlaces a la ficha) |
| `VIGILANTE_URL` | VPS | `https://tramitatucontrato.energy/api/tramitacion/vigilante` |
| `NOTIFICAR`, `ESTADO`, `TESTIGO` | VPS (opcionales) | Ver §5.2 |
| **Solo pruebas — NUNCA en Vercel** | `.env.local` / servidor local | `TRAMITACION_PRUEBA=1`, `ALTAVOZ_SIMULAR_FALLO` (`1` = Altavoz caído, 503; `adjuntos` = «rechazo por adjuntos», 422 sin `codigo` a los avisos que llevan adjuntos), `CUOTA_INICIAR_HORA`, `CUOTA_CONFIRMAR_HORA`, `CUOTA_CODIGO_IP_HORA`, `CUOTA_CODIGO_EMAIL_HORA`, `CUOTA_ENTRAR_IP_HORA`, `TRAMITACION_DEBUG` |

⚠️ `TRAMITACION_PRUEBA=1` en producción marcaría todos los contratos como de prueba y la bandeja no los enseñaría. Los `FORM_TOKEN` siguen como constantes en los `html` (no son secretos: solo frenan bots).

## 7. Seguridad y datos

- **Tablas con RLS activada y sin políticas**: solo el servidor (con la clave de servicio) lee y escribe. `anon` y `authenticated` no tienen permisos.
- **Bucket `tramitaciones` privado**, 25 MB por archivo y tipos limitados (PDF, JPG, PNG, DOC, DOCX). La clave de cada objeto es `<carpeta>/NN.ext` con un nonce no adivinable; el nombre original nunca va en una clave ni en una URL.
- **URLs firmadas**: la subida vale 2 h; la descarga de la ficha, 10 minutos. Ninguna se escribe en un registro.
- **IBAN y DNI** solo se ven en la ficha (con sesión) y en el aviso a backoffice (que el comercial no recibe). El acuse al comercial no lleva IBAN, DNI ni enlace a la bandeja. La IP nunca se guarda: solo su HMAC.
- **Los documentos viajan adjuntos por correo a `AVISO_DESTINO`** (decisión del 10-oct-2026, como con el sistema anterior): el DNI y las facturas están, además de en el almacén, en el buzón de backoffice. Lo que sigue sin guardarse en ningún sitio: los adjuntos en la base y en la cola (se descargan en cada intento), sus **nombres** en los registros, los eventos, Telegram o el parte del vigilante (los eventos solo llevan números de orden y contadores), y los ficheros en el cartero (no hay `console.*`).
- **Bandeja**: código de 6 cifras (caduca a los 10 min, 5 intentos, un solo uso, solo se guarda su HMAC); sesión de 365 días en cookie (30 hasta el 12-oct-2026) `HttpOnly; SameSite=Lax` (`Secure` salvo en local); en cada petición se vuelve a comprobar que el email sigue en `BANDEJA_EMAILS`; las mutaciones exigen `Content-Type: application/json`. Quien no está en la lista recibe la misma respuesta que quien sí, y no se le envía nada.
- **Cuotas** (en la base, no en memoria): `iniciar` 60/h por IP, `confirmar` 120/h por IP, código 10/h por IP y 5/h por email, entrar 20/h por IP.
- **Límites**: 15 archivos, 25 MB por archivo, 60 MB en total.
- **Registros del servidor**: solo frases fijas, nunca datos del formulario, correos ni cuerpos.
- ⚠️ **Pendiente de decidir (Victor):** cuánto tiempo se conservan los documentos (DNI, IBAN) tras «tramitada». Propuesta: 12 meses con borrado automático por el vigilante. No está implementado.

## 8. Pruebas

Todo se prueba contra la **base real** (`gnew-plataforma`), por eso:

- el servidor local (`tests/servidor-local.mjs`, `127.0.0.1:8765`) **se niega a arrancar** sin `TRAMITACION_PRUEBA=1` y `ALTAVOZ_SIMULAR=1`;
- todo lo que se escribe lleva `prueba = true` y vive bajo `pruebas/` en el almacén;
- **Altavoz es siempre simulado** (nunca sale un correo; «caído» se simula con un gancho);
- solo se usan alias de Victor (`victor.molins.10+algo@gmail.com`), nunca personas reales;
- `node scripts/limpiar-pruebas.mjs --todo` lo borra todo; repetido, debe decir `0 tramitaciones, 0 objetos del almacén…`.

| Qué | Comando | Cubre |
|---|---|---|
| Unitarias (sin internet ni base) | `node --test "tests/unit/*.test.mjs"` | validadores, nombres, estados, correos, sesión, ZIP, `http`, `config` y el **script del vigilante** como caja negra (`vigilante-script.test.mjs`: endpoint falso en 127.0.0.1 y un stub de Telegram que escribe a un fichero) |
| API | `node tests/servidor-local.mjs &` → `node --test "tests/api/*.test.mjs"` → `node scripts/limpiar-pruebas.mjs --todo` → `kill <PID>` | `00` almacén (subida y descarga directas con CORS), `10` iniciar/confirmar y cola, `20` bandeja, `30` vigilante, `40` adjuntos del aviso |
| Con navegador | `bash tests/e2e/run.sh formulario` (11 casos) · `bandeja` (16) · `extras` (10) · `capturas` | formulario completo, reintentos, respaldo, compresión de fotos, interruptor `V2_ACTIVO`, bandeja de punta a punta. Arranca y para solo el servidor y limpia al acabar |

**El interruptor en las pruebas (`formulario.py`).** Con `V2_ACTIVO = false` (como se despliega), todo lo que prueba la v2 tiene que abrir la página con `?v2=1`: lo hace `Caso.ir` (`tests/e2e/comun.py`) por defecto en los casos 1-9 y en los extras; `ir(ruta, v2=False)` abre la dirección tal cual, que es lo que ve un comercial. **Caso 10**: sin `?v2=1` el envío es el de siempre. Se comprueba contra el formulario REAL de antes de la v2 (`git show 6b5dd53:gnew.html` y `:mega.html`, el último commit de producción previo): el mismo envío con los dos html (el Apps Script, interceptado con `page.route`, contesta `{"success":true,"refId":…}`) tiene que dar **los mismos textos del botón** (`Preparando datos...` → `Preparando 2 archivos...` → `Enviando contrato... No cierres esta página` → `Contrato enviado correctamente`; en `mega.html`, sin tildes, como siempre), **el mismo cuerpo al Apps Script** (mismas claves y valores salvo la referencia) y **la misma gracias** (`gracias.html`/`gracias-mega.html` sin `?ref=`), sin ninguna llamada a `/api/` ni al almacén, sin fila en la base, y una foto grande se sigue reduciendo. Si `V2_ACTIVO` está en `true`, el mismo caso comprueba lo contrario: que sin `?v2=1` se usa la v2. Exige que `gnew.html` y `mega.html` lleven el mismo valor. **Caso 11**: `?v2=1` convive con el prefill por URL del comparador DPC (los campos se rellenan, `v2` no estorba, el IBAN y el DNI del firmante no entran por la dirección) y el envío va por la v2, en GNEW y en MEGA.

Ficheros de API en paralelo: `node --test "tests/api/*.test.mjs"` los lanza a la vez y todos comparten el servidor local y su entorno (los ganchos cambian cuotas, Altavoz «caído»…). Por eso `20` y `30` esperan a los hermanos de número menor (`tests/api/hermanos.mjs`): el orden es siempre `00 → 10 → 20 → 30`. Un fichero nuevo que toque el entorno compartido debe hacer lo mismo en su cabecera: `before(() => esperarAHermanosAnteriores(import.meta.url))`.

**Ruido del almacén (429).** El almacén de Supabase responde a ratos `429 SlowDown / «Too many connections issued to the database»` a cualquier operación (firmar una subida, subir, listar, firmar descargas): en `iniciar`/`confirmar` sale como un `503 temporal` (el navegador reintenta) y en las pruebas aparece como un fallo suelto en `00` o `10` (casi siempre `iniciar` o un PUT). Viene por rachas —el proyecto `gnew-plataforma` es compartido con otras sesiones y servicios— y se va solo. Medido el 10-oct-2026: con el código de la orden 5, 1 pasada con 429 de 9; con el de la orden 6, 13 de 18 durante la racha mala y ninguna de las 10 siguientes en un rato tranquilo (con y sin el fichero 40, con las descargas de 1 en 1 y de 2 en 2). Las descargas por sí solas aguantan 24 a la vez sin un 429, así que no se ha hallado causa en los adjuntos, pero tampoco se puede descartar que sumen algo de presión en una racha mala (por eso las descargas van de 2 en 2). **Si una pasada falla solo por un 429, espera un par de minutos y repítela.**

**Los adjuntos en las pruebas (`40-adjuntos`).** En simulación no sale nada, pero hay que poder ver qué adjuntos llevaría cada aviso. Eso lo anota **en memoria** el «espía» (`tests/cartero-espia.mjs`): al arrancar, `tests/servidor-local.mjs` cambia el cartero por el espía con `module.registerHooks` (Node 22.15 o más; en api/ no hay nada que solo exista para pruebas). El espía deja pasar cada llamada al cartero de verdad y apunta `para`, asunto, etiqueta, tope, resultado y los adjuntos (**nombre, bytes y md5**; nunca el cuerpo ni el contenido). Se lee con `GET /__pruebas/correos?tipo=aviso&asunto=<texto del asunto>` (`envios`, y `adjuntos` en cada correo de la base) y `/__pruebas/tramitacion?ref=` también lo enlaza. Por eso **todo se hace por HTTP** (confirmar, el vigilante, «volver a enviar»): una llamada a `cola.js` o `vigilante.js` desde el proceso de la prueba envía en ese proceso y el espía no la ve. El modo de fallo «rechazo por adjuntos» se pone con `POST /__pruebas/altavoz {"rechazo_adjuntos": true}` (o `/__pruebas/env {"ALTAVOZ_SIMULAR_FALLO": "adjuntos"}`). Un documento que «no se puede descargar» se simula cambiando lo que la base cree de él (su clave o su tamaño comprobado), no el objeto del almacén: el CDN del almacén sirve el objeto ya descargado hasta ~60 s aunque se borre (ver §4). `40` espera a los hermanos anteriores (`hermanos.mjs`). Además hay unitarias de los adjuntos (`correos`, `cartero` contra un Altavoz falso en 127.0.0.1, `supabase-descarga` contra un almacén falso) y `tiempos.test.mjs`, que ata todos los topes entre sí.

Las pruebas de `30-vigilante` insertan a mano las filas «subiendo» viejas con su fecha (un UPDATE no sirve: el trigger pone `actualizada_en = now()`), comprueban los totales del parte con «≥» (otros ficheros dejan sus correos en la cola de pruebas) y borran lo suyo al terminar. Para comprobar el aislamiento por modo insertan, durante la duración de una pasada, alguna fila con `prueba = false`: **no las lances en el mismo segundo en que el cron del vigilante de producción esté corriendo** (la ventana es de unos segundos; la prueba `aislamiento por modo` de `10` hace lo mismo).

## 9. Puesta en marcha, paso a paso

La v2 se despliega **dormida** y se enciende con un interruptor: la constante `V2_ACTIVO` de `gnew.html` y `mega.html`, hoy `false`, con el **mismo valor en los dos**. Con `false` el formulario envía **exactamente como antes** (Apps Script) y no llama a `/api/tramitacion/*`; la v2 solo se usa abriendo la página con `?v2=1` (vale solo para esa carga; no se guarda en ningún sitio). Con `true` la v2 es el camino normal y `?v2=1` da igual. Así, al desplegar, los comerciales siguen usando el formulario de siempre y la v2 se ensaya en producción antes de que la use nadie. (Sin el interruptor, desplegar la v2 con los avisos apuntando a un alias de Victor habría mandado los contratos reales de los comerciales al alias en vez de a `escaneos@`.)

Cada punto marcado **REQUIERE OK DE VICTOR** toca producción (Vercel, `git push`, correo real, cron del VPS). Nada de esto se hace antes de su OK. El SQL ya está aplicado.

**0. Antes de empezar (no toca nada)**
   - Rama `tramitacion-v2` con todo en verde (§8) y `const V2_ACTIVO = false;` en `gnew.html` y `mega.html` (`grep -n "const V2_ACTIVO" gnew.html mega.html`).
   - Confirmar el plan de Vercel de `gruponewenergy-landing` (Hobby o Pro) y si tiene Fluid. `maxDuration` de 60 s cubre ambos casos, pero Hobby no permite uso comercial.
   - Confirmar con la sesión de Altavoz que `responder_a` **y `adjuntos` (hasta 10 ficheros y 3.000.000 bytes reales entre todos)** están desplegados en `/api/v1/avisos`, que el candado `modo_prueba` está **apagado** y que la clave «formulario-tramitacion» sigue enviando como `escaneos@gruponew.energy` para GNEW y MEGA.

**1. Variables en Vercel — REQUIERE OK DE VICTOR.** Proyecto `gruponewenergy-landing`, entorno Production. Las de la tabla del §6, con `AVISO_DESTINO` y `BANDEJA_EMAILS` apuntando a **alias de Victor** mientras dure el ensayo (los valores definitivos entran en el paso 4):
   - `AVISO_DESTINO=victor.molins.10+tramitacion@gmail.com` (el aviso de los envíos por la v2 llega a ese alias, no a `escaneos@`) y `BANDEJA_EMAILS=victor.molins.10+bandeja@gmail.com` (el código de acceso a la bandeja llega a ese alias).
   - El resto, **ya definitivas**: `ALTAVOZ_SIMULAR=0`, `ALTAVOZ_URL=https://altavoz.gruponewenergy.es`, `ALTAVOZ_API_KEY` = la clave «formulario-tramitacion», `SITIO_URL=https://tramitatucontrato.energy`, `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de `gnew-plataforma`, y **dos secretos nuevos y distintos** (`BANDEJA_SECRETO`, `VIGILANTE_SECRETO`, de 32 caracteres o más, aleatorios, distintos de los de `.env.local`). No se pone `AVISO_DESTINO_MEGA`. No poner nunca `TRAMITACION_PRUEBA`, `ALTAVOZ_SIMULAR_FALLO` ni `CUOTA_*`. Comprobar la lista (solo nombres, nunca valores).

**2. Fusionar y desplegar DORMIDA — REQUIERE OK DE VICTOR.** Merge de `tramitacion-v2` en `master` y `git push` → Vercel despliega, con `V2_ACTIVO = false`: **el formulario de producción sigue igual**. Comprobar (sin hacer ningún envío real):
   - `curl -s https://tramitatucontrato.energy/gnew | grep -n "const V2_ACTIVO"` y lo mismo con `/mega` → `false` en los dos.
   - Que un envío normal sigue yendo al Apps Script y **la página no llama a `/api/tramitacion`**, sin que salga nada de verdad. Es lo que comprueba el caso 10 de `tests/e2e/formulario.py` en local; esto lo repite contra lo desplegado, SIN `?v2=1`, con datos ficticios, de una de estas dos maneras:
     - Con Playwright: interceptar `script.google.com` y contestarle un `{"success":true}` falso, abortar `/api/tramitacion/*`, rellenar `/gnew` y `/mega` y pulsar enviar → llega a la página de gracias tras UNA petición a `script.google.com` y NINGUNA a `/api/tramitacion/`.
     - A mano, con las herramientas del navegador (pestaña Red): clic derecho en una petición → «Bloquear URL de solicitud», para `script.google.com` y para `/api/tramitacion`; rellenar y pulsar enviar. Se verán **4 intentos fallidos** contra `script.google.com` (unos 15 s; es el bucle de reintentos del camino antiguo) y después el aviso «Error al enviar el formulario»; y **ninguna** petición a `/api/tramitacion`. Eso prueba que el envío va al Apps Script y no a la v2 (medido en local el 10-oct-2026: 4 peticiones en 15,9 s).
   - `/gnew` y `/mega` cargan igual que antes; `/bandeja` lleva a `/bandeja/entrar`.
   - `GET /api/_lib/config.js` → **404**; `POST /api/tramitacion/vigilante` sin secreto → **401**.
   - **404** en `/CLAUDE.md`, `/docs/tramitacion-v2.md`, `/supabase/tramitacion.sql`, `/scripts/vigilante-tramitacion.mjs`, `/tests/servidor-local.mjs` y `/google-apps-script/Code.gs`.

**3. Ensayo en producción con `?v2=1` — REQUIERE OK DE VICTOR (correo real, solo a alias suyos).** Con los alias del paso 1 en marcha, abrir `https://tramitatucontrato.energy/gnew?v2=1` y `https://tramitatucontrato.energy/mega?v2=1` (el `?v2=1` vale solo para esa carga de la página) y enviar contratos de mentira: comercial = un alias de Victor (p. ej. `victor.molins.10+ensayo@gmail.com`; el borrado de más abajo solo toca envíos de un alias suyo) y datos ficticios (CUPS y datos válidos pero inventados, **nunca un cliente real**), con 2-3 documentos y una foto grande (de más de 1 MB, para ver que se reduce). **Hacer un segundo envío con documentos que sumen más de 3 MB** (p. ej. un PDF de 4-5 MB) para ver el camino «No caben como adjunto y están en la bandeja».
   - Mientras se envía, el botón tiene que ir diciendo «Guardando los datos del contrato...», «Subiendo documento…» y «Comprobando que ha llegado todo...». ⚠️ **Si dice «Enviando contrato... No cierres esta página», el ensayo ha caído al respaldo de Apps Script** (la v2 no ha contestado tres veces): ese contrato de mentira ha salido por el camino antiguo —Drive, hoja de registro y correo a `escaneos@`, que NO obedece a `AVISO_DESTINO`—. Parar, avisar a backoffice de que lo ignore y arreglar la v2 antes de seguir.
   - Leer el aviso y el acuse en el buzón de los alias (conector de Gmail): asunto con el titular, **los documentos adjuntos (abrirlos: que se vean y pesen lo subido)**, el aviso naranja si algo no cupo, botón «Abrir en la bandeja», y el acuse sin IBAN y sin adjuntos.
   - Entrar en `/bandeja/entrar` con `victor.molins.10+bandeja@gmail.com` (el código llega a ese alias), abrir la ficha, ver y descargar los documentos (uno a uno y ZIP) y marcarla como tramitada. Hasta que esté el cron (paso 7) nada reintenta un correo que no salga a la primera: «Volver a enviar» desde la ficha.
   - **Después, borrar el ensayo (dejarlo a cero).** Las referencias salen en la página de gracias («Tu referencia: GNE-…») y en la bandeja. Desde `/root/projects/_worktrees/tramitacion-v2` (o cualquier copia del repo con `.env.local`, que lleva las claves de `gnew-plataforma`):
     ```bash
     node scripts/limpiar-ensayo.mjs GNE-… MEGA-…              # en seco: dice qué borraría, no borra nada
     node scripts/limpiar-ensayo.mjs --aplicar GNE-… MEGA-…    # lo borra
     node scripts/limpiar-ensayo.mjs GNE-… MEGA-…              # tiene que decir «no existe» en todas
     ```
     Borra cada tramitación con sus documentos, correos y eventos (en cascada) **y sus objetos del almacén uno a uno por la API**: con SQL no basta, porque borrar filas de `storage.objects` no borra el fichero. Se niega a tocar cualquier envío cuyo comercial no sea un alias de Victor (`victor.molins.10+algo@gmail.com`) —y entonces no borra nada de lo pedido— e imprime solo referencias y recuentos. `limpiar-pruebas.mjs` no sirve aquí: solo toca `prueba = true`.
   - El ensayo deja dos restos mínimos sin datos de contratos: los códigos de acceso a la bandeja de los alias (`tramitacion_accesos`, que el vigilante limpia al día siguiente) y los apuntes de «código enviado» a esos alias. Para quitarlos a mano (SQL por `execute_sql`, solo alias de Victor):
     ```sql
     delete from public.tramitacion_correos
      where tramitacion_id is null and tipo = 'codigo_acceso' and para ~* '^victor\.molins\.10\+[a-z0-9._-]+@gmail\.com$';
     delete from public.tramitacion_accesos
      where email ~* '^victor\.molins\.10\+[a-z0-9._-]+@gmail\.com$';
     ```

**4. Valores definitivos — REQUIERE OK DE VICTOR.** Poner `AVISO_DESTINO=escaneos@gruponew.energy` y `BANDEJA_EMAILS=escaneos@gruponew.energy,victor.molins.10@gmail.com`, volver a desplegar (Vercel aplica los cambios de variables solo a los despliegues nuevos) y comprobar que Victor entra en `/bandeja` con su código. ⚠️ **A partir de aquí, NO hacer más ensayos con `?v2=1`**: sus avisos ya irían a `escaneos@`.

**5. Encender — REQUIERE OK DE VICTOR (commit + push).** Poner `V2_ACTIVO = true` en `gnew.html` **y** `mega.html` (los dos con el mismo valor; el caso 10 lo exige), pasar `bash tests/e2e/run.sh formulario` (con el interruptor encendido, el caso 10 comprueba que sin `?v2=1` se usa la v2), commit y `git push` → Vercel despliega. Desde ese momento **los comerciales envían por la v2** y los avisos van a `escaneos@`. Marcha atrás en un minuto: `V2_ACTIVO = false` y otro push (el formulario vuelve a Apps Script cuando Vercel despliega; lo ya recibido por la v2 sigue en la bandeja).

**6. Vigilar el primer contrato real.** En cuanto entre el primero de un comercial de verdad (no se prueba con datos reales: se espera a que llegue), mirar: en la bandeja aparece «Pendiente» con todos sus documentos (el ZIP se abre); a `escaneos@` llega el aviso con los documentos adjuntos; el comercial recibe el acuse (sin IBAN ni adjuntos); y en la ficha «Correos» dice «enviado» y el historial lo cuenta bien. Si algo falla: marcha atrás (paso 5) y a investigar. Mientras no esté el cron (paso 7) nada reintenta un correo que no haya salido a la primera: mirar «Correos» en la ficha y «Volver a enviar»; conviene hacer el paso 7 el mismo día.

**7. El vigilante en el VPS — REQUIERE OK DE VICTOR (crea el fichero con el secreto y el cron).**
   1. `/root/.tramitacion-vigilante.env` (permisos **0600**) con `VIGILANTE_URL=https://tramitatucontrato.energy/api/tramitacion/vigilante` y `VIGILANTE_SECRETO=` el mismo valor que en Vercel. Crear el fichero **sin pasar el secreto por pantalla ni por el chat**; comprobar con `stat -c %a`.
   2. Comprobar que el script ya está en `/root/projects/gruponewenergy-landing/scripts/vigilante-tramitacion.mjs` (llega con el auto-pull tras el merge; si el repo está sucio, el auto-pull lo salta).
   3. Una pasada a mano, sin avisar: `/usr/local/bin/node /root/projects/gruponewenergy-landing/scripts/vigilante-tramitacion.mjs --dry` → debe terminar con «pasada correcta» y código 0. (⚠️ `--dry` no avisa ni guarda estado, pero **la web hace su trabajo de verdad**: reintenta correos reales, concilia y abandona envíos viejos.)
   4. El cron, con la **ruta absoluta de node** (el PATH de cron es `/usr/bin:/bin` y un `node` a secas podría no correr nunca; `command -v node` da `/usr/local/bin/node`, la misma que usan los demás crons de este servidor):
      `*/5 * * * * /usr/local/bin/node /root/projects/gruponewenergy-landing/scripts/vigilante-tramitacion.mjs >> /root/tramitacion-vigilante.log 2>&1`
   5. A los 10 minutos: el registro tiene líneas «pasada correcta», `/root/.tramitacion-vigilante-last` tiene fecha reciente y existe `/root/.tramitacion-vigilante-state.json`.

**8. El testigo en el latido — REQUIERE OK DE VICTOR (edita `/root/latido-crons.sh`).** Un bloque como el de SICOM: CIEGO si el testigo falta o tiene más de 15 minutos.
   ```bash
   # ---- Tramitación v2: vigilante (cron cada 5 min; toca el testigo en cada pasada) ----
   TESTIGO_TRAMITACION=/root/.tramitacion-vigilante-last
   if [ ! -f "$TESTIGO_TRAMITACION" ]; then
     linea "🔴 Tramitación (vigilante): CIEGO — sin rastro del cron"; PROBLEMAS=$((PROBLEMAS+1))
   else
     EDAD_TRAM=$(edad_min "$(stat -c %Y "$TESTIGO_TRAMITACION")")
     if [ "$EDAD_TRAM" -gt 15 ]; then
       linea "🔴 Tramitación (vigilante): CIEGO — el cron no deja rastro desde hace $EDAD_TRAM min"; PROBLEMAS=$((PROBLEMAS+1))
     else
       linea "✅ Tramitación (vigilante): vivo (última pasada hace $EDAD_TRAM min)"
     fi
   fi
   ```

**9. Ensayo de alarma (recomendado) — REQUIERE OK DE VICTOR.** Para saber que Telegram suena de verdad: estropear a propósito el secreto del fichero del VPS; a los 10 minutos Victor debe recibir «el vigilante no consigue hablar con la web (2 veces seguidas)»; restaurarlo, y a los 5 minutos «la web vuelve a responder al vigilante».

**10. Una semana con el respaldo activo.** Mientras tanto `RESPALDO_APPS_SCRIPT = true` (como está): si la API no contesta, el formulario usa el camino antiguo (el contrato entra por Drive, correo y hoja de registro, no por la bandeja). Mirar cada día la bandeja (¿todo lo recibido está?), el registro del cron y los avisos; cada vez que se use el respaldo, mirar por qué la API no contestaba.

**11. Retirar el respaldo — REQUIERE OK DE VICTOR (commit + push).** Pasada la semana sin incidencias: `RESPALDO_APPS_SCRIPT = false` en `gnew.html` y `mega.html`. Cuando Victor quiera, dejar los dos Apps Script como archivo (y las carpetas de Drive, que quedan como histórico). (Con el respaldo retirado, `V2_ACTIVO = false` ya no serviría de marcha atrás: no quedaría camino antiguo al que volver. Decidir entonces si se quita el interruptor.)

## 10. El respaldo temporal (Apps Script)

Los dos `Code.gs` (`google-apps-script/` y `google-apps-script-mega/`) siguen siendo el camino antiguo: Drive + correo + hoja de registro. **Se usan en dos casos.** (1) Como **camino normal mientras la v2 está apagada** (`V2_ACTIVO = false` y sin `?v2=1`): el envío va directo a Apps Script, sin pasar por la API y tenga el valor que tenga `RESPALDO_APPS_SCRIPT` (`enviarComoAntes`). (2) Como **respaldo de la v2** (encendida, o abierta con `?v2=1`): solo si `iniciar` falla tres veces seguidas por red, tiempo, 404 o 5xx **y** `RESPALDO_APPS_SCRIPT` vale `true` (hoy, en los dos `html`). No se tocan en la v2: su despliegue pendiente y sus notas (Altavoz con respaldo Gmail, `config-formulario.json`, permisos de Apps Script) están en `CLAUDE.md`, en las secciones marcadas «respaldo temporal». Los contratos que entren por ahí **no aparecen en la bandeja**: se tramitan como hasta ahora desde el correo/Drive.

## 11. Decisiones y riesgos abiertos

1. **Plan de Vercel** (Hobby no permite uso comercial) y Fluid compute: confirmar en el paso 0. Si es Hobby, pasar a Pro.
2. **Retención de documentos** (DNI/IBAN): propuesta de 12 meses con borrado automático por el vigilante. Sin decidir ni implementar.
3. **Altavoz**: `responder_a` y los códigos 409/502 están documentados pero hay que confirmar que están desplegados; con el candado `modo_prueba` encendido, el primer envío real dará `409 modo_prueba` y el vigilante avisará.
4. **MEGA**: tanto el aviso como el acuse dirigen al comercial a `escaneos@gruponew.energy` (consecuencia de la decisión del 8-oct); `gracias-mega.html` ya no cita `administracion@`. Confirmar.
5. **Honeypot**: se descarta sin avisar (como antes) pero queda visible en «Descartadas».
6. **Correo duplicado, nunca perdido**: si la función muere entre el 2xx de Altavoz y apuntarlo, el vigilante reenvía.
7. **Avisos en bloque**: cada incidencia avisa por separado; si Altavoz cae un buen rato con muchos contratos, llegarán varios mensajes (y varios «resuelto» al volver).
8. **Adjuntos y duplicados**: si el tiempo se agota con Altavoz todavía enviando (el aviso pesa hasta ~4 MB), el vigilante reenvía el aviso CON adjuntos y backoffice puede recibir dos. Es el mismo riesgo asumido del punto 6, algo más probable con adjuntos.
9. **Resuelto (orden 6b): el navegador espera 30 s por intento de `confirmar`** (antes 25 s) en `gnew.html` y `mega.html`. El peor caso del servidor (≈ 28 s: trabajo previo 3 s + aviso 15 s + acuse 6 s + 4 s de base) ya cabe; si aun así venciera, repetir `confirmar` es idempotente y responde «listo» al momento sin duplicar nada. `tests/unit/tiempos.test.mjs` lee la constante de los dos html y ata el número.
10. **Resuelto (orden 6b): la ficha de la bandeja tiene frases para `adjuntos_no_descargados` y `adjuntos_rechazados`** (§4, «Historial»). La segunda nombra a Altavoz, tal como se pidió; el regex `JERGA` de `tests/e2e/bandeja.py` no admite ese nombre en un texto que ve backoffice, por eso el caso 6 comprueba estas dos frases aparte, después de `sin_jerga()`. Si se prefiere no nombrar a Altavoz en la ficha, basta con cambiar la frase (y esa comprobación).
11. **El ensayo con `?v2=1` y el respaldo**: `?v2=1` activa la v2 «completa, con su respaldo» (orden 6b). Con `RESPALDO_APPS_SCRIPT = true`, si durante el ensayo la v2 no contesta tres veces, el formulario cae al Apps Script, que **no obedece a `AVISO_DESTINO`** y manda el contrato de mentira a `escaneos@` (y a Drive y a la hoja de registro). Se reconoce porque el botón dice «Enviando contrato... No cierres esta página» en vez de «Guardando los datos del contrato...» (§9, paso 3). Si se prefiere un ensayo sin esa red de seguridad, bastaría con que `?v2=1` ignorase el respaldo.
12. **Hay una ventana sin vigilante** entre encender la v2 (paso 5) y poner el cron (paso 7): un correo que no salga a la primera no se reintenta solo. Se cubre mirando a mano el primer contrato (paso 6) y haciendo el paso 7 el mismo día.
13. **Las fotos grandes se reducen dos veces en el respaldo de la v2**: `prepararEnvio` las reduce (para subirlas al almacén) y, si luego entra el respaldo (v2 encendida y API caída), `enviarPorRespaldo` las vuelve a reducir con `prepararArchivo`: más tiempo en «Preparando N archivos...» en un camino que ya es raro. No afecta al interruptor apagado, que no pasa por `prepararEnvio`. Arreglo posible: que `prepararArchivo` reutilice `fotosReducidas`. Sin tocar.

## 12. Lo construido que difiere del diseño

- **El aviso lleva la documentación adjunta** (orden 6, decisión de Victor del 10-oct-2026): el diseño original (y la decisión del 8-oct) decía «correo sin adjuntos» (§4, «Los adjuntos del aviso»). El botón pasa a llamarse «Abrir en la bandeja».
- **El vigilante no empieza envíos pasados 25 s** (§5.1; 10 s antes de los adjuntos) y el script corta a **55 s** (25 s antes): el diseño decía «hasta 10 correos, tope 8 s cada uno», que en el peor caso sobrepasa los 60 s de la función.
- **Sin módulo nuevo para los adjuntos**: `seleccionarAdjuntos` y los nombres viven en `correos.js`, la descarga en `supabase.js` (`descargarObjeto`) y la orquestación en `cola.js`.
- **Abandonar y «subidas a medias» se miden por `actualizada_en`**, no por `creada_en` (§5.1); `minutos` cuenta desde el último movimiento.
- **La respuesta del vigilante añade** `liberados`, `limpiados`, `ficha` (en cada atascado) y `actualizada_en` (en cada subida a medias).
- **En modo prueba la limpieza de cuotas y accesos se restringe** a lo de prueba (§5.1).
- **La conciliación** mira que existan los dos correos (aviso y acuse), no solo el aviso.
- **El bucle de reintentos se detiene en la primera vuelta que no intenta nada** (§5.1), aunque quedaran correos a los que ya les tocaba si el elegido lo tenía otra pasada solapada: los recoge la siguiente.
- **Con la web caída el script no purga** (ni manda «resuelto»): la purga de 24 h solo corre en las pasadas en que la web contesta.
- **`--dry` y `--una-vez`** concretan «imprime sin avisar» y «no toca el estado» como se describe en §5.2; el testigo se toca en cada pasada normal, también con la web caída.
- **El script lee la configuración** también de `VIGILANTE_ENV` (solo pruebas) y rechaza `http://` salvo en local.
- **El formulario tiene un interruptor, `V2_ACTIVO`** (orden 6b; el diseño no lo preveía): la v2 se despliega dormida y se ensaya con `?v2=1`. El modo apagado es `enviarComoAntes`, que reutiliza `enviarPorRespaldo` y envía igual que el formulario de producción de antes de la v2 (lo comprueba el caso 10, comparándolo con ese html). Diferencias a propósito: si falla, el aviso ya no enseña la línea «Detalle: …» con el mensaje técnico y sí la referencia. En `mega.html` los textos del botón conservan las faltas de tilde de producción («pagina», «envio»).
- **La bandeja apunta quién abre cada ficha** (14-oct-2026; el diseño no lo preveía): evento `ficha_abierta`, parámetro `abrir=1` de `ficha`, ventana de 15 minutos por persona y campo `vistas` en `lista` (ver §3). Pruebas: `20-bandeja` (parte 3, 4 casos) y casos 14, 15 y 16 de `tests/e2e/bandeja.py`; `docs/diseno-tramitacion-v2.md` §2.3 no se ha retocado (describe `ficha` y `lista` sin estos campos).
- **`scripts/limpiar-ensayo.mjs`** (orden 6b): borra por referencia los envíos del ensayo en producción y sus objetos del almacén (§9, paso 3). El diseño solo preveía `limpiar-pruebas.mjs`, que no toca `prueba = false`.
