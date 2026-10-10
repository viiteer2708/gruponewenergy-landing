# TRAMITACIÓN v2 — diseño cerrado y órdenes de trabajo para `ejecutor-sonnet`

Worktree: `/root/projects/_worktrees/tramitacion-v2` (rama `tramitacion-v2`). Fuentes primarias leídas: `CLAUDE.md`, `gnew.html`, `mega.html`, los dos `Code.gs`, `vercel.json`, `.vercelignore`, `gracias*.html`, `/root/projects/altavoz/docs/api.md` §5 (solo lectura), `/root/notifica-telegram.sh`, `/root/latido-crons.sh`, `gnew-plataforma/supabase/migrations/0001_esquema.sql` (tabla `contratos`) y `gnew-plataforma/lib/correo/enviar.ts`; documentación de Vercel (runtime Node, límites, `maxDuration`, versiones, ficheros `_` en `api/`) y el código de `supabase/storage-js` (forma exacta de la API de Storage). Revisado dos veces por el asesor; sus huecos están incorporados.

Cambio ya aplicado respecto al encargo (coordinador, 8-oct): el **asunto lleva el titular y NO la referencia**; Victor ha autorizado el servidor local y Playwright en 127.0.0.1.

---

## 1. Decisión de diseño (en llano)

El formulario sigue igual para el comercial. Cambia el camino: ahora **primero apunta el contrato en nuestra base** (la Supabase de la plataforma), **después sube cada documento directamente al almacén** (uno a uno, con barra de progreso y reintentos) y **solo cuando el servidor comprueba que todos los archivos están y pesan lo que deben**, el comercial ve «Contrato enviado». Desde ese instante el contrato está a salvo aunque el correo tarde: el aviso a backoffice y el acuse al comercial salen por Altavoz, y si Altavoz no responde se quedan en una cola que un vigilante reintenta cada 5 minutos y que avisa a Victor por Telegram si algo lleva más de 10 minutos atascado (una vez por incidencia, con mensaje de «resuelto»). Backoffice trabaja desde una **bandeja** en la misma web (entrada con código por email) donde ve cada contrato, descarga los documentos (uno a uno o todo en un ZIP) y lo marca como tramitado. La primera semana, si la API nueva no contesta al empezar, el formulario usa el camino antiguo (Apps Script) como respaldo.

**Alternativas descartadas**
- *Seguir en Apps Script y solo cambiar el cartero*: deja los cuatro fallos históricos (hoja colgada, duplicados, pegar código a mano, remitente personal). Es el parche de hoy, no la solución.
- *Subir los archivos a través de Vercel*: corta a 4,5 MB por petición; habría que trocear. Con URL firmada el navegador sube directo y el servidor solo mueve JSON.
- *Adjuntar documentos al correo (Altavoz admite 3 MB)*: media real 2,5 MB y máximo 9,4 MB; además Victor pidió correo sin adjuntos. Enlace a la ficha de la bandeja. **⚠️ Revertido el 10-oct-2026 (orden 6): Victor decidió que backoffice SIGA recibiendo cada contrato con la documentación adjunta; ver la nota de §2.5.**
- *Enviar el correo «después de responder»*: en Vercel sin dependencias no es fiable. Se intenta en la misma petición con tope corto; la cola + vigilante garantizan que nada se pierde en silencio.
- *Bandeja dentro de la plataforma mundo.*: la absorberá, pero su tanda de bandeja no existe aún. Tablas con prefijo `tramitacion` y nombres alineados con `public.contratos` para que la mudanza sea «leer y copiar».
- *Librerías (supabase-js, zip, dotenv)*: cero dependencias; `fetch` a las API REST y un ZIP «stored» de ~80 líneas.

---

## 2. Diseño cerrado

### 2.1 Modelo de datos — `supabase/tramitacion.sql` (completo, idempotente)

```sql
-- supabase/tramitacion.sql · Tramitación v2 (tramitatucontrato.energy)
-- Base: proyecto Supabase «gnew-plataforma» (ref iigwltjzbynyvhnaqtbu, eu-west-1).
-- Idempotente: se puede aplicar varias veces. Se aplica con execute_sql (NUNCA apply_migration).
-- RLS activada y SIN políticas en todas las tablas: solo service_role (las funciones de Vercel)
-- lee y escribe. Prefijo «tramitacion» para que la plataforma lo absorba sin chocar con lo suyo.
-- Nombres alineados con public.contratos de la plataforma (cups, direccion, cp, poblacion, provincia,
-- titular_nombre, titular_nif, firmante_nombre, firmante_nif, telefono, iban, potencias, observaciones).

-- 1) Una fila por envío del formulario. `ref` la genera el navegador (GNE-/MEGA-) y es la clave de idempotencia.
create table if not exists public.tramitaciones (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  formulario        text not null check (formulario in ('gnew', 'mega')),
  estado            text not null default 'subiendo'
                    check (estado in ('subiendo', 'recibida', 'tramitada', 'abandonada', 'descartada')),
  prueba            boolean not null default false,   -- true solo en el servidor local de pruebas
  sospechosa        boolean not null default false,   -- honeypot relleno
  carpeta           text not null unique,             -- prefijo de sus objetos en el bucket (con nonce)
  -- comercial
  comercial_nombre  text not null,
  comercial_email   text not null,
  -- contrato
  compania          text not null,                    -- MEGA: 'MEGA ENERGIA' fijo
  cups              text not null,
  oferta            text,
  tarifa            text,
  tipo_suministro   text,                             -- solo MEGA (Luz/Gas)
  potencias         jsonb not null default '{}'::jsonb,  -- {"p1":"4.6",...} tal como se tecleó (coma→punto)
  -- titular
  titular_nombre    text not null,
  titular_nif       text not null,
  firmante_nombre   text,
  firmante_nif      text,
  iban              text not null,
  -- suministro
  direccion         text not null,
  cp                text not null,
  poblacion         text not null,
  provincia         text not null,
  -- contacto
  telefono          text not null,
  email_cliente     text not null,
  -- otros
  cambio_titular    boolean not null default false,
  nuevo_titular     text,
  observaciones     text,
  busqueda          text not null default '',          -- minúsculas sin tildes: titular+cups+ref+comercial+compañía
  -- origen y tiempos
  ip_hash           text,                             -- HMAC de la IP, nunca la IP
  navegador         text,                             -- user-agent recortado a 200
  creada_en         timestamptz not null default now(),
  recibida_en       timestamptz,
  tramitada_en      timestamptz,
  tramitada_por     text,                             -- email de backoffice
  actualizada_en    timestamptz not null default now()
);
create index if not exists tramitaciones_creada_idx on public.tramitaciones (creada_en desc);
create index if not exists tramitaciones_estado_idx on public.tramitaciones (estado, creada_en desc);

create or replace function public.tramitacion_tocar() returns trigger
language plpgsql as $$ begin new.actualizada_en = now(); return new; end $$;
drop trigger if exists tramitaciones_tocar on public.tramitaciones;
create trigger tramitaciones_tocar before update on public.tramitaciones
  for each row execute function public.tramitacion_tocar();

-- 2) Documentos: una fila por archivo (orden 0 = firma del comercial).
create table if not exists public.tramitacion_documentos (
  id                uuid primary key default gen_random_uuid(),
  tramitacion_id    uuid not null references public.tramitaciones (id) on delete cascade,
  orden             smallint not null check (orden between 0 and 99),
  nombre            text not null,                    -- nombre saneado que ve backoffice
  ruta              text not null unique,             -- clave del objeto: <carpeta>/NN.ext (sin nombre original)
  tipo_mime         text not null,
  tamano_declarado  bigint not null check (tamano_declarado >= 0),
  tamano_comprobado bigint,
  tamano_original   bigint,                           -- si se comprimió en el navegador
  comprimido        boolean not null default false,
  es_firma          boolean not null default false,
  estado            text not null default 'pendiente' check (estado in ('pendiente', 'subido')),
  subido_en         timestamptz,
  creado_en         timestamptz not null default now(),
  unique (tramitacion_id, orden)
);
create index if not exists tramitacion_documentos_tram_idx on public.tramitacion_documentos (tramitacion_id);

-- 3) Cola de correos (aviso a backoffice, acuse al comercial, códigos de acceso a la bandeja).
create table if not exists public.tramitacion_correos (
  id                uuid primary key default gen_random_uuid(),
  tramitacion_id    uuid references public.tramitaciones (id) on delete cascade,  -- null en codigo_acceso
  tipo              text not null check (tipo in ('aviso', 'acuse', 'codigo_acceso')),
  marca             text not null,                    -- GNEW | MEGA
  para              text not null,
  responder_a       text,
  asunto            text not null,
  etiqueta          text,
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente', 'enviando', 'enviado', 'agotado', 'suprimido', 'incierto', 'error_configuracion')),
  codigo_respuesta  text,                             -- el `codigo` de Altavoz (destinatario_suprimido, modo_prueba…) o 'red'/'tiempo'
  intentos          int not null default 0,
  proximo_intento   timestamptz not null default now(),
  bloqueado_hasta   timestamptz,                      -- cerrojo mientras está en 'enviando'
  ultimo_error      text,                             -- frase corta, sin datos personales
  altavoz_id        text,
  simulado          boolean not null default false,
  cuerpo_html       text,                             -- SOLO en simulación (pruebas)
  cuerpo_texto      text,                             -- SOLO en simulación (pruebas)
  creado_en         timestamptz not null default now(),
  enviado_en        timestamptz,
  unique (tramitacion_id, tipo)
);
create index if not exists tramitacion_correos_cola_idx on public.tramitacion_correos (estado, proximo_intento);

-- 4) Historial de cada tramitación (sin datos personales en `detalle`).
create table if not exists public.tramitacion_eventos (
  id              bigint generated always as identity primary key,
  tramitacion_id  uuid not null references public.tramitaciones (id) on delete cascade,
  tipo            text not null,     -- creada · datos_actualizados · reanudada · firma_guardada · recibida · aviso_enviado · acuse_enviado ·
                                     -- correo_fallo · correos_conciliados · tramitada · reabierta · abandonada · descartada · aviso_reenviado · acuse_reenviado
  actor           text not null default 'sistema',   -- 'comercial' | 'sistema' | 'vigilante' | email de backoffice
  detalle         jsonb not null default '{}'::jsonb,
  creado_en       timestamptz not null default now()
);
create index if not exists tramitacion_eventos_tram_idx on public.tramitacion_eventos (tramitacion_id, creado_en);

-- 5) Códigos de acceso a la bandeja (hash, nunca el código).
create table if not exists public.tramitacion_accesos (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  codigo_hash  text not null,
  caduca_en    timestamptz not null,
  intentos     smallint not null default 0,
  usado_en     timestamptz,
  ip_hash      text,
  creado_en    timestamptz not null default now()
);
create index if not exists tramitacion_accesos_email_idx on public.tramitacion_accesos (email, creado_en desc);

-- 6) Cuotas por IP/email (Vercel no tiene memoria compartida: el contador vive aquí).
create table if not exists public.tramitacion_cuotas (
  clave           text primary key,
  ventana_inicio  timestamptz not null default now(),
  cuenta          int not null default 0
);
create or replace function public.tramitacion_cuota(p_clave text, p_limite int, p_ventana_seg int)
returns boolean
language plpgsql
set search_path = public
as $$
declare v_cuenta int;
begin
  insert into public.tramitacion_cuotas as c (clave, ventana_inicio, cuenta)
  values (p_clave, now(), 1)
  on conflict (clave) do update
    set cuenta = case when c.ventana_inicio < now() - make_interval(secs => p_ventana_seg) then 1 else c.cuenta + 1 end,
        ventana_inicio = case when c.ventana_inicio < now() - make_interval(secs => p_ventana_seg) then now() else c.ventana_inicio end
  returning c.cuenta into v_cuenta;
  return v_cuenta <= p_limite;   -- true = dentro del límite
end $$;
revoke all on function public.tramitacion_cuota(text, int, int) from public, anon, authenticated;
grant execute on function public.tramitacion_cuota(text, int, int) to service_role;

-- 7) Seguridad: RLS sin políticas + sin permisos para anon/authenticated.
alter table public.tramitaciones           enable row level security;
alter table public.tramitacion_documentos  enable row level security;
alter table public.tramitacion_correos     enable row level security;
alter table public.tramitacion_eventos     enable row level security;
alter table public.tramitacion_accesos     enable row level security;
alter table public.tramitacion_cuotas      enable row level security;
revoke all on table public.tramitaciones, public.tramitacion_documentos, public.tramitacion_correos,
  public.tramitacion_eventos, public.tramitacion_accesos, public.tramitacion_cuotas from anon, authenticated;

-- 8) Bucket PRIVADO con límite y tipos (25 MB por archivo).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tramitaciones', 'tramitaciones', false, 26214400,
        array['application/pdf', 'image/jpeg', 'image/png', 'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
-- storage.objects ya tiene RLS y sin políticas para este bucket: solo service_role y las URLs firmadas.

comment on table public.tramitaciones is 'Tramitación v2: envíos del formulario tramitatucontrato.energy (GNEW y MEGA). Solo service_role.';
comment on table public.tramitacion_correos is 'Cola de correos por Altavoz: aviso a backoffice, acuse al comercial, códigos de la bandeja.';

notify pgrst, 'reload schema';
```

Rutas en el bucket: `[pruebas/]<formulario>/<yyyy>/<mm>/<ref>-<nonce10>/<NN>.<ext>` (`00.png` = firma). El nonce (10 caracteres base32 de `crypto`) hace la carpeta no adivinable; el nombre original nunca va en la clave del objeto ni en ninguna URL (vive en `tramitacion_documentos.nombre`).

### 2.2 Máquinas de estado

**Tramitación** (`tramitaciones.estado`): `subiendo` →(confirmar: todo en el almacén)→ `recibida` →(backoffice «Marcar como tramitada»)→ `tramitada` →(«Volver a pendiente»)→ `recibida`. `subiendo` →(vigilante > 24 h, o `iniciar` con `ref_anterior` porque el comercial cambió la lista)→ `abandonada`; `abandonada` →(`iniciar` con esa misma ref)→ `subiendo` (se reanuda: nunca se pierde nada). `descartada` (honeypot) nace terminal. Etiquetas para backoffice: `recibida` = «Pendiente», `tramitada` = «Tramitada», `subiendo` = «Subiendo», `abandonada` = «Incompleta», `descartada` = «Descartada».

**Documento**: `pendiente` → `subido` (el servidor ve el objeto con el tamaño declarado).

**Correo** (`tramitacion_correos.estado`), decidido por el `codigo` de Altavoz, no solo por el HTTP:

| Respuesta de Altavoz | Estado | ¿Alerta del vigilante? |
|---|---|---|
| 2xx `{ok,id}` | `enviado` (guarda `altavoz_id`) | no |
| 409 `destinatario_suprimido` | `suprimido` (terminal) | sí, inmediata; si es un `aviso` significa que el buzón de backoffice rebotó: NADA llega |
| 409 `modo_prueba` | `pendiente` (reintenta) | sí (no se arregla solo: Altavoz está en modo prueba) |
| 401 / 403 / 422 (incl. `marca_sin_remitente`) | `error_configuracion` (terminal) | sí |
| 502 `envio_incierto` | `incierto` (terminal para el robot: Altavoz dice «no se repite solo») | sí; lo decide un humano con «Volver a enviar» |
| 502 `envio_rechazado` · 503 (`no_comprobado`, `envio_no_disponible`, `envio_no_encendido`) · 500 · red · tiempo (> tope) | `pendiente` con espera creciente | sí si lleva > 10 min |
| 8.º intento fallido | `agotado` (terminal) | sí |

Espera tras el intento n (minutos): 1, 3, 10, 30, 60, 120, 240; el 8.º fallo → `agotado`. Cerrojo: antes de enviar, `PATCH estado=enviando, bloqueado_hasta=now()+60s WHERE estado=pendiente` con `Prefer: return=representation` (0 filas = otro proceso lo tiene); un `enviando` con `bloqueado_hasta` vencido vuelve a `pendiente` (cuenta como intento). Riesgo asumido: si la función muere entre el 2xx de Altavoz y el `PATCH enviado`, el vigilante reenvía al minuto (un correo duplicado, nunca uno perdido). «Volver a enviar» (bandeja): `pendiente`, `intentos=0`, `proximo_intento=now()`, desde cualquier estado, y se intenta al momento.

Modo simulación (`ALTAVOZ_SIMULAR=1`): no se llama a Altavoz; el correo queda `enviado`, `simulado=true`, `altavoz_id='simulado-<ts>'`, con `cuerpo_html`/`cuerpo_texto` guardados (las pruebas leen el código de acceso de ahí). `ALTAVOZ_SIMULAR_FALLO=1` (solo pruebas) simula Altavoz caído (503).

**Acceso a la bandeja**: código de 6 cifras (`crypto`), guardado como HMAC-SHA256(`BANDEJA_SECRETO`, email+código), caduca a los 10 min, 5 intentos, un solo uso. Sesión = cookie `bandeja_sesion` = `base64url({e: email, iat, exp})` + `.` + HMAC-SHA256; HttpOnly, SameSite=Lax, Path=/, Max-Age 30 días, `Secure` salvo en `127.0.0.1`/`localhost` por http. En cada petición se comprueba además que el email sigue en `BANDEJA_EMAILS`.

### 2.3 Contratos de los endpoints

Forma común de error: `{ok:false, codigo, mensaje (en llano), retryable (true|false), campos?}`. Todas las respuestas `Cache-Control: no-store`. Solo `POST` salvo donde se indica (otro método → 405). Cuerpo JSON ilegible → `400 {codigo:'peticion'}` (en Vercel `req.body` es un getter que lanza: `leerJson` lo envuelve en try/catch).

**`POST /api/tramitacion/iniciar`** — entrada:
```json
{ "formulario": "gnew|mega", "token": "<FORM_TOKEN del html>", "ref": "GNE-20261008-ABC123", "ref_anterior": "GNE-…|null", "hp": "",
  "datos": { "quien_eres","email_comercial","compania"(solo gnew),"cups","oferta","tarifa","tipo_suministro"(solo mega),
             "p1".."p6","titular","cif_nif","nombre_firmante","dni_firmante","cuenta_bancaria","dir_suministro",
             "codigo_postal","poblacion","provincia","movil","email_cliente","cambio_titular":"Si|No","nuevo_titular",
             "observaciones","terminos": true },
  "firma": "" | "data:image/png;base64,…",
  "archivos": [ { "orden": 1, "nombre": "contrato.pdf", "tamano": 5242880, "tamano_original": 7340032 } ] }
```
Salidas: `200 {ok:true, ref, estado:'subiendo', listo:false, subidas:[{orden, nombre, url, tipo_mime, ya_subido}]}` (`url` absoluta de Storage con `?token=`; `ya_subido:true` = ese archivo ya está con el tamaño correcto y no se vuelve a subir) · `200 {ok:true, ref, estado:'recibida'|'tramitada', listo:true}` (idempotente) · honeypot → `200 {ok:true, ref, estado:'recibida', listo:true}` (éxito falso; fila `descartada`, sin documentos ni correos) · `400 datos` (`campos:{cups:'CUPS no válido…'}`, no retryable) · `401 no_autorizado` («No se ha podido enviar el formulario. Recarga la página e inténtalo de nuevo.») · `409 lista_distinta` (la lista de archivos no coincide con la de esa referencia: el navegador crea referencia nueva y repite) · `413 limites` («La documentación supera el máximo: 15 archivos, 25 MB por archivo y 60 MB en total») · `429 demasiados` («Se han recibido demasiados envíos desde tu conexión. Espera unos minutos.») · `503 temporal` (retryable).
Lógica, en orden: token → cuota `iniciar:<ip_hash>` 60/h (clave con prefijo `pruebas:` en modo prueba) → honeypot → validación de servidor (mismos validadores que el html, `terminos`, extensiones, límites 15/25 MB/60 MB) → si viene `ref_anterior` válida, en `subiendo` y no de otra persona (mismo formulario): pasa a `abandonada` + evento `{motivo:'lista_cambiada', nueva_ref}` → `insert … ?on_conflict=ref` con `Prefer: resolution=ignore-duplicates,return=representation` y releer: `recibida/tramitada` → listo; `abandonada` → vuelve a `subiendo` + evento `reanudada`; `subiendo` → actualiza los datos (evento `datos_actualizados`) y compara la lista (orden, nombre, tamaño) → `409` si difiere; nueva → fila (`prueba` = `TRAMITACION_PRUEBA==='1'`, `carpeta`, `busqueda`, `ip_hash`, `navegador`) + documentos + evento `creada`. Firma (si viene y ≤ 2 M caracteres): la sube el servidor (`POST /storage/v1/object/tramitaciones/<carpeta>/00.png`, `x-upsert: true`) y crea el documento `orden 0` ya `subido`; si falla → `503 temporal`. Para cada documento `pendiente` (si la fila ya existía, comprobando antes el almacén): `POST /storage/v1/object/upload/sign/tramitaciones/<ruta>` con `x-upsert: true` → la `url` llega **relativa** con `?token=`: la URL entregada al navegador es `SUPABASE_URL + '/storage/v1' + url`. Las URLs firmadas valen 2 h (lo fija Supabase).

**`POST /api/tramitacion/confirmar`** — `{formulario, token, ref}` → `200 {ok:true, listo:true, ref, estado:'recibida'}` · `409 faltan_archivos` `{retryable:true, faltan:[{orden, nombre, motivo:'no_subido'|'tamano_distinto'}]}` (el navegador vuelve a `iniciar`, que le da URLs solo de lo que falta) · `404 desconocida` (el navegador vuelve a `iniciar`) · `401` · `429` (cuota `confirmar:<ip>` 120/h) · `503 temporal`.
Orden obligatorio: cargar fila + documentos → **si ya está `recibida`/`tramitada`: igualmente `insert` de aviso + acuse `on_conflict` ignorado e intentar los pendientes (sana un corte justo tras el PATCH), y responder éxito** → si `subiendo`: `object/list` de la carpeta y comparar `metadata.size` con `tamano_declarado` → marcar documentos `subido` → `PATCH estado=recibida, recibida_en WHERE estado=subiendo` (0 filas → releer y tratar como arriba) → evento `recibida` `{n_documentos, bytes}` → insertar aviso + acuse → intentar el aviso con tope 6 s → intentar el acuse solo si han pasado < 12 s desde el inicio (tope 6 s) → responder `listo:true` aunque algún correo quede `pendiente` (lo recoge el vigilante en ≤ 5 min).

**`POST /api/tramitacion/vigilante`** — `Authorization: Bearer <VIGILANTE_SECRETO>` (comparación en tiempo constante; sin él `401`). Hace, en este orden: (0) **conciliación**: tramitaciones `recibida`/`tramitada` de los últimos 7 días (no de prueba) sin correo `aviso` → crea aviso + acuse pendientes + evento `correos_conciliados`; (1) `enviando` con cerrojo vencido → `pendiente`; (2) reintenta hasta 10 correos `pendiente` con `proximo_intento <= now()` (tipos aviso/acuse; nunca `codigo_acceso`), en serie, tope 8 s cada uno, regenerando el cuerpo desde la fila y sus documentos; (3) `subiendo` con `creada_en < now() − 24 h` → `abandonada` + evento (actor `vigilante`); (4) limpia `tramitacion_cuotas` y `tramitacion_accesos` de más de un día. Devuelve `200 {ok:true, conciliadas, reintentados, enviados, abandonadas, atascados:[{id, tipo, ref, estado, intentos, codigo_respuesta, creado_en, minutos}], subidas_a_medias:[{ref, formulario, creada_en, minutos}], pendientes_total}`. `atascados` = correos aviso/acuse de tramitaciones no de prueba con `estado ≠ enviado` y (estado terminal **o** `creado_en < now() − 10 min`). `subidas_a_medias` = `subiendo` entre 1 h y 24 h.

**Bandeja** (todas con cookie; sin sesión válida → `401 {ok:false, codigo:'sesion'}`; las mutaciones exigen `Content-Type: application/json`, que con SameSite=Lax cierra el CSRF):
- `POST /api/bandeja/codigo` `{email}` → siempre `200 {ok:true}` (no desvela la lista); envía el código solo si el email está en `BANDEJA_EMAILS`; cuotas `codigo:<ip>` 10/h y `codigo:<email>` 5/h → `429`; si Altavoz falla al enviar → `503 {mensaje:'No hemos podido enviarte el código. Inténtalo de nuevo en un minuto.'}`.
- `POST /api/bandeja/entrar` `{email, codigo}` → `200 {ok:true}` + `Set-Cookie` · `401 {mensaje:'El código no es correcto o ha caducado. Pide uno nuevo.'}` · `429` (cuota `entrar:<ip>` 20/h o 5 intentos del código).
- `POST /api/bandeja/salir` → borra la cookie. `GET /api/bandeja/yo` → `{ok:true, email}`.
- `GET /api/bandeja/lista?estado=pendientes|tramitadas|incompletas|descartadas|todas&q=&antes=<creada_en>` → `{ok:true, items:[{ref, formulario, estado, compania, titular_nombre, cups, comercial_nombre, tarifa, creada_en, recibida_en, n_documentos}], siguiente}` (30 por página, keyset por `creada_en`; `q` normalizado a `[a-z0-9 @.-]`, ≤ 60, sobre `busqueda` con `ilike`; `prueba=false` salvo en el servidor de pruebas, donde solo `prueba=true`).
- `GET /api/bandeja/ficha?ref=` → `{ok:true, tramitacion:{…todo, IBAN completo…}, documentos:[{orden, nombre, tamano, tipo_mime, es_firma, url}], correos:[{tipo, estado, intentos, enviado_en, codigo_respuesta}], eventos:[…últimos 50…], enlaces_caducan_en}`; `url` = firma de descarga por lote (`POST /storage/v1/object/sign/tramitaciones` `{expiresIn:600, paths}`) válida 10 min; `404` si no existe o es de prueba fuera del modo prueba.
- `POST /api/bandeja/estado` `{ref, accion:'tramitar'|'reabrir'}` → `{ok:true, estado}` (+ `tramitada_por/en` + evento con `actor` = email) · `409` si la transición no vale.
- `POST /api/bandeja/reenviar` `{ref, tipo:'aviso'|'acuse'}` → pone el correo `pendiente` e intenta ahora → `{ok:true, estado}` + evento `aviso_reenviado`/`acuse_reenviado`.

### 2.4 Flujo del navegador (gnew.html / mega.html), paso a paso

Constantes nuevas en el html: `API_BASE = ''` (mismo origen), `FORMULARIO = 'gnew'|'mega'`, `RESPALDO_APPS_SCRIPT = true` (interruptor; a `false` pasada la semana). Se conservan `SCRIPT_URL`, `FORM_TOKEN`, `generateRefId`, los validadores, `fileToBase64` y el envío antiguo entero como `enviarPorRespaldo()`.

1. **Submit** → validación actual sin cambios. Botón en modo «cargando»: **«Preparando el envío...»**. Cualquier alta/baja de archivos tras un intento hace `refAnterior = currentRefId; currentRefId = null` (lista nueva = referencia nueva; `ref_anterior` viaja una vez en el siguiente `iniciar` para que la vieja quede «Incompleta» sin alertas falsas).
2. **Lectura**: `await file.slice(0,1).arrayBuffer()` por archivo; si falla → el aviso actual «No se ha podido leer un archivo» (texto sin cambios).
3. **Fotos**: JPEG/PNG > 2 MB → **«Preparando las fotos...»**: `createImageBitmap(file, {imageOrientation:'from-image'})` (respeta la orientación EXIF: un DNI nunca sale girado) → lado mayor a 2400 px → `toBlob('image/jpeg', 0.88)`; se usa solo si pesa ≥ 25 % menos (nombre `foto.jpg`, `tamano_original`); ante cualquier excepción o falta de soporte, el original. El resultado se conserva en memoria para los reintentos (misma lista, mismos tamaños).
4. **`iniciar`**: **«Guardando los datos del contrato...»**; tope 20 s; 3 intentos (esperas 2 s y 5 s): **«Reintentando... (2/3)»**. Si los 3 fallan por red, tiempo, 404 o 5xx y `RESPALDO_APPS_SCRIPT` → `enviarPorRespaldo()` con el mismo `ref` (textos de hoy: «Enviando contrato... No cierres esta página»). `400` → errores en línea en los campos y scroll (sin overlay). `401/413/429` → overlay «No se ha podido enviar el contrato» con el `mensaje` del servidor y «Cerrar». `409 lista_distinta` → referencia nueva y repetir una vez. `listo:true` → paso 7.
5. **Subida**, de una en una, con `XMLHttpRequest` (progreso real): `PUT url`, cabeceras `Content-Type: <tipo_mime>` (**por extensión, nunca `file.type`**: los móviles dan vacío en `.doc/.docx` y el bucket los rechazaría) y `x-upsert: true`, cuerpo = el `File`; `xhr.timeout = 45 s + 12 s/MB`; 3 intentos por archivo (esperas 2 s y 5 s). Texto: **«Subiendo documento 2 de 4: factura.pdf · 63 %»** y una barra fina bajo el botón; al reintentar **«Reintentando documento 2 de 4: factura.pdf (intento 2/3)»**; los `ya_subido` se saltan; tras 20 s sin cambio de porcentaje se añade «(sigue en marcha)». Si un archivo agota sus 3 intentos → paso 8a.
6. **`confirmar`**: **«Comprobando que ha llegado todo...»**; tope 25 s; 4 intentos (2,5 s × n). `faltan_archivos` → vuelve al paso 4 (`iniciar` da URLs solo de lo que falta) y sube eso; como mucho 2 vueltas, luego 8a. `desconocida` → paso 4.
7. **Éxito**: `currentRefId = null`; **«Contrato enviado»**; `window.location.href = 'gracias.html?ref=GNE-…'` (`gracias-mega.html?ref=…`). Las páginas de gracias muestran «Tu referencia: GNE-…» y el texto nuevo: «Hemos guardado tu contrato y la documentación y hemos avisado al equipo de tramitación. Recibirás un acuse de recibo con la referencia; si falta algún documento (por ejemplo, la factura), te escribirán desde ese mismo correo: responde al acuse citando la referencia.» (sin direcciones fijas; el logo de `gracias.html` pasa a `/logo-gnew.png`).
8. **Fallos**, siempre en llano y sin detalle técnico (desaparece la línea «Detalle: …»; en su lugar «Referencia: GNE-…»):
   - **8a. No termina la subida**: título «No hemos podido terminar el envío»; texto «La documentación no ha terminado de subir, seguramente por la conexión. No hace falta volver a rellenar nada: pulsa «Reintentar» y seguiremos por donde se quedó. Si no lo consigues, puedes enviar los datos y los documentos por email a escaneos@gruponew.energy.»; botones «Reintentar» (repite desde el paso 4 con el mismo `ref`), «Enviar por email» (el `mailto` de hoy), «Cerrar».
   - **8b. Respaldo también falla**: el overlay actual («Error al enviar el formulario» + mailto) sin la línea técnica.
   - **Nunca** se enseña «Enviado» sin `listo:true` del servidor; nunca `err.message` crudo.

### 2.5 Correo y acuse (Altavoz: `POST {ALTAVOZ_URL}/api/v1/avisos`, `Bearer`, tope 8 s)

> **NOTA — decisión de Victor del 10-oct-2026 (orden 6): el aviso VUELVE a llevar la documentación adjunta.** Sustituye a «correo sin adjuntos» (8-oct) en todo lo que sigue de esta sección: donde dice «Sin adjuntos» / «Documentación (n)» / botón «Ver y descargar la documentación» / tope 8 s para el aviso, manda esto (y, si algo difiere, el código y `docs/tramitacion-v2.md` §4 «Los adjuntos del aviso»). Motivo: backoffice (`escaneos@`) trabajaba abriendo los adjuntos del correo y tiene que seguir recibiendo cada contrato así; la bandeja queda como copia segura y para marcar tramitados. El acuse al comercial NO cambia (sin adjuntos, sin IBAN ni DNI). Reglas:
> - **Qué va adjunto** (las del `Code.gs` de siempre y los topes de Altavoz, api.md §5): documentos en estado `subido`; primero los de orden 1..N por su orden y la firma (orden 0) al final; entra uno si (bytes reales acumulados + los suyos) ≤ **3.000.000** Y quedan plazas (**10 adjuntos EN TOTAL, firma incluida**); si uno no cabe se salta y se miran los siguientes. Lo que no cabe se queda «solo en la bandeja». Dos documentos con el mismo nombre se desambiguan sin perder la extensión (`dni.jpg`, `dni (2).jpg`); Altavoz no exige nombres distintos, es cosa nuestra.
> - **El correo**: bloque «Documentación adjunta a este correo (n)» con nombre y tamaño de cada adjunto; si algo no cabe, «No caben como adjunto y están en la bandeja: …»; el botón pasa a «**Abrir en la bandeja**» y va SIEMPRE. Versión texto equivalente. Todo escapado.
> - **Cada intento** (confirmar, vigilante, «Volver a enviar») regenera el cuerpo Y vuelve a descargar los adjuntos del almacén (no se guardan en la base), comprobando que pesan lo que se comprobó al confirmar. Contenido en `adjuntos: [{nombre, contenido}]`, base64 estándar y estricto.
> - **Prioridad: que backoffice SIEMPRE reciba el aviso.** Si falla la descarga de un adjunto (error o tiempo), el aviso sale con lo que sí se bajó y lo que falló pasa a la lista «en la bandeja», con un evento (`adjuntos_no_descargados`, sin datos personales). Si Altavoz rechaza por los adjuntos (422 de validación —que en api.md §5 **no lleva `codigo`**— o 413 por el tamaño de la petición), se reintenta EN EL MISMO intento sin adjuntos y se apunta `adjuntos_rechazados`. El resto de fallos, como siempre (cola, reintentos, vigilante).
> - **Tiempos**: el aviso tiene 15 s EN TOTAL (descargas ≤ 6 s + Altavoz); `confirmar` intenta el acuse (6 s) solo si han pasado menos de 20 s; el vigilante no empieza envíos pasados 25 s y su script corta a 55 s (peor pasada 51 s < 60 s de la función). Detalle y cuentas en `docs/tramitacion-v2.md` §5.1.

Asuntos (cada parte en una línea, recortada y, si falta, omitida sin dejar guiones dobles; total ≤ 200):
- GNEW: `Nuevo Contrato - <compañía (40)> - <titular (60)> - <comercial (60)> - <CUPS (25)>`
- MEGA: `Nuevo Contrato MEGA - <titular (60)> - <comercial (60)> - <CUPS (25)>`
- Acuse: `Recibido: ` + el mismo asunto (recortado a 200).

**Aviso a backoffice** (`marca` GNEW|MEGA según formulario; `para` = `AVISO_DESTINO`, o `AVISO_DESTINO_MEGA` si existe para MEGA; `responder_a` = email del comercial; `etiqueta` `tramitacion-aviso`): misma estructura visual que `buildEmailHtml` del Code.gs (cabecera `#094D38` GNEW / `#0D9488` MEGA; «Nuevo contrato para tramitar», fecha Europe/Madrid y referencia; tabla con TODOS los campos, IBAN completo incluido; «Documentación (n)» con nombre y tamaño; botón grande **«Ver y descargar la documentación»** → `SITIO_URL/bandeja/c/<ref>`; pie: «Al responder a este correo, la respuesta le llega directamente al comercial (email). El comercial recibe un acuse con la indicación de enviar cualquier documento adicional a <AVISO_DESTINO> citando la referencia. Aviso automático de tramitatucontrato.energy.»; si `sospechosa`: franja «Este envío ha activado el filtro antibots: revísalo con cuidado»). Versión `texto` plana con los mismos datos. Todo escapado.

**Acuse al comercial** (`para` = email del comercial; `responder_a` = `AVISO_DESTINO`; `etiqueta` `tramitacion-acuse`): «Contrato recibido · Ref», «Hola <nombre>, hemos recibido tu contrato y la documentación. Ya está en manos del equipo de tramitación.», tabla con referencia, fecha, compañía, CUPS, titular, oferta, tarifa; «Documentación recibida (n)» con los nombres; bloque «¿Falta algo?… responde a este correo o escribe a <AVISO_DESTINO> indicando la referencia». **Sin IBAN, sin DNI, sin enlace a la bandeja.**

**Código de bandeja** (`marca` GNEW, `etiqueta` `bandeja-codigo`, solo `texto`): «Tu código para entrar en la bandeja de tramitación es 123456. Caduca en 10 minutos. Si no lo has pedido tú, ignora este correo.»

### 2.6 Bandeja (`/bandeja`, móvil primero, paleta GNEW, chip «GNEW»/«MEGA» por contrato)

- **`/bandeja/entrar`** (`bandeja-entrar.html`): «Acceso a la bandeja de tramitación» → email → «Enviarme un código» → «Si tu correo tiene acceso, te hemos enviado un código de 6 cifras. Caduca en 10 minutos. Revisa también el spam.» → código → «Entrar». Respeta `?volver=` si empieza por `/bandeja`. Sin sesión, cualquier página de la bandeja redirige aquí con `volver` = la URL pedida (el enlace del correo a una ficha pasa por el login y vuelve a la ficha).
- **`/bandeja`** (`bandeja.html`): cabecera «Tramitaciones» + email + «Salir»; buscador «Buscar por titular, CUPS, referencia o comercial»; chips «Pendientes» (por defecto) · «Tramitadas» · «Incompletas» · «Todas» (+ «Descartadas» bajo «Más»); tarjetas: titular en negrita, compañía · tarifa, CUPS, comercial, «hace 12 min»/fecha, «3 documentos», insignia de estado y de formulario; «Cargar más»; vacío: «No hay tramitaciones que coincidan.». Más recientes primero.
- **`/bandeja/c/<ref>`** (`bandeja-ficha.html`): cabecera con la referencia, la insignia y el botón «Marcar como tramitada» / «Volver a pendiente» (confirmación de un toque); línea «Tramitada por nombre@… el 8-10-2026 a las 12:30»; secciones Comercial · Contrato · Titular (IBAN completo) · Suministro · Contacto · Cambio de titular · Observaciones; **Documentos**: nombre, tamaño, «Ver» (abre la URL firmada en pestaña nueva) y «Descargar» (`fetch` de la URL firmada + `a.download = nombre`: ningún nombre en URLs); **«Descargar todo (ZIP)»** montado en el navegador (`bandeja-zip.js`, método stored con CRC32, entradas `NN-nombre`; fichero `REF - Titular.zip`); si los enlaces caducaron (10 min), la página vuelve a pedir la ficha; **Correos**: «Aviso a tramitación: enviado a las 12:31» / «pendiente (se reintenta solo)» / «no se ha podido enviar» + «Volver a enviar»; **Historial** en llano («Recibida a las 12:30 · 4 documentos», «Aviso enviado», «Marcada como tramitada por …»).
- Cabeceras (`vercel.json`) para `/bandeja` y `/bandeja/:path*`: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.

### 2.7 Vigilante en el VPS — `scripts/vigilante-tramitacion.mjs`

Cron cada 5 min (lo instala el orquestador con OK de Victor), **con la ruta absoluta de node** (`which node`; el PATH de cron es `/usr/bin:/bin` y un `node` a secas podría no correr nunca): `*/5 * * * * /ruta/absoluta/node /root/projects/gruponewenergy-landing/scripts/vigilante-tramitacion.mjs >> /root/tramitacion-vigilante.log 2>&1`. Lee `/root/.tramitacion-vigilante.env` (`VIGILANTE_URL`, `VIGILANTE_SECRETO`; opcionales `ESTADO`, `NOTIFICAR`, `TESTIGO`), llama al endpoint (tope 25 s), toca el testigo `/root/.tramitacion-vigilante-last` (que entra en `latido-crons.sh` el día uno), guarda estado en `/root/.tramitacion-vigilante-state.json` y avisa SOLO con `/root/notifica-telegram.sh "<texto>"` (ese script carga él solo las credenciales: el vigilante jamás las lee ni imprime; tampoco imprime el secreto ni la URL). Reglas, **una vez por clave** (`correo:<id>:<estado>`, `subida:<ref>`, `endpoint`), con mensaje de resolución cuando la clave desaparece:
- 🔴 correo atascado: «Tramitación: el AVISO de GNE-… lleva 14 min sin salir (3 intentos; Altavoz no responde). Ficha: https://tramitatucontrato.energy/bandeja/c/GNE-…»; terminales: «no se ha podido enviar: destinatario suprimido / error de configuración / envío incierto: revísalo en la bandeja». Sin datos personales.
- 🟡 subida a medias (> 1 h): «Tramitación: el envío GNE-… lleva 1 h 20 min con la documentación sin terminar de subir.»
- 🔴 endpoint: tras **2 fallos seguidos** (HTTP ≠ 2xx o sin respuesta): «Tramitación: el vigilante no consigue hablar con la web (2 veces seguidas). Los correos pendientes no se están reintentando.»; al volver: «✅ Tramitación: la web vuelve a responder al vigilante.»
- `--dry` imprime sin avisar; `--una-vez` no toca el estado; entradas no vistas en 24 h se purgan.

### 2.8 Ficheros, variables y configuración

```
package.json                      {"private":true,"type":"module","engines":{"node":"22.x"},"scripts":{"test","test:api","servidor"}} — sin dependencias
vercel.json                       + "$schema" · regions ["dub1"] · rewrites /bandeja, /bandeja/entrar, /bandeja/c/:ref · headers · functions maxDuration (60 tramitación, 30 bandeja)
.vercelignore                     + supabase/ scripts/ tests/ docs/ .env.local .env* .agents/ .project-map/ .claude/   (CLAUDE.md y los Code.gs siguen fuera)
.gitignore                        + .env.local node_modules/ tests/e2e/salidas/
api/_lib/config.js                variables de entorno (lectura perezosa), límites, tokens, marcas, cuotas (sobrescribibles por env en pruebas), esPrueba()
api/_lib/http.js                  leerJson (req.body primero, try/catch → 400), responder, cookiesDe, ipDe (x-real-ip | 1.º de x-forwarded-for), esHttps, soloMetodo
api/_lib/validadores.js           CUPS, DNI/NIE/CIF, IBAN, móvil, email, CP, validarDatos(formulario, datos) → {campos}
api/_lib/nombres.js               sanearNombre, extensionDe, mimeDe, nonce, carpetaDe, rutaDe, normalizarBusqueda, enUnaLinea, recortar
api/_lib/estados.js               TRANSICIONES, esperaMinutos, MAX_INTENTOS, clasificarAltavoz
api/_lib/correos.js               asuntoDe, armarAviso, armarAcuse, armarCodigo → {asunto, html, texto}; escapeHtml; fecha Madrid
api/_lib/sesion.js                firmarSesion/verificarSesion, cookie, generarCodigo, hashCodigo, hashIp, igualesSeguro
api/_lib/supabase.js              rest(), seleccionar/insertar/actualizar/borrar/rpc, crearUrlSubida, subirObjeto, listarCarpeta, firmarDescargas, borrarObjetos (tope 10 s)
api/_lib/cartero.js               enviarAviso() → Altavoz / simulación / fallo simulado; tope por parámetro
api/_lib/cola.js                  crearCorreos(), intentarEnvio() con cerrojo, reintentarPendientes(), conciliar(), atascados(), reenviar()
api/_lib/tramitacion.js           iniciar(), confirmar(), comprobarAlmacen(), mapearDatos()
api/_lib/bandeja.js               exigirSesion()
api/tramitacion/iniciar.js · confirmar.js · vigilante.js
api/bandeja/codigo.js · entrar.js · salir.js · yo.js · lista.js · ficha.js · estado.js · reenviar.js
bandeja.html · bandeja-entrar.html · bandeja-ficha.html · bandeja-zip.js
gnew.html · mega.html · gracias.html · gracias-mega.html   (modificados)
supabase/tramitacion.sql
scripts/vigilante-tramitacion.mjs · scripts/limpiar-pruebas.mjs
tests/unit/*.test.mjs · tests/servidor-local.mjs · tests/api/*.test.mjs · tests/e2e/{comun.py,formulario.py,bandeja.py,run.sh} · tests/fixtures/generar.mjs
docs/tramitacion-v2.md            cómo funciona + puesta en marcha (sin secretos)
```
Los ficheros de `api/` que empiezan por `_` no se convierten en funciones (doc de Vercel) y `api/` no se sirve como estático; se comprueba en la puesta en marcha (`GET /api/_lib/config.js` → 404). `functions` en `vercel.json`: `{"api/tramitacion/*.js":{"maxDuration":60},"api/bandeja/*.js":{"maxDuration":30}}` (válido con y sin Fluid, Hobby o Pro; cuerpo máximo 4,5 MB, que aquí solo lleva JSON y la firma).

Variables de entorno (en Vercel las pone el orquestador; en local `.env.local`, git-ignorado): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALTAVOZ_URL`, `ALTAVOZ_API_KEY`, `ALTAVOZ_SIMULAR` (`1` = no envía), `AVISO_DESTINO`, `AVISO_DESTINO_MEGA` (opcional), `BANDEJA_EMAILS` (coma), `BANDEJA_SECRETO` (≥ 32 car.), `VIGILANTE_SECRETO` (≥ 32), `SITIO_URL` (`https://tramitatucontrato.energy`). Solo pruebas: `TRAMITACION_PRUEBA=1`, `ALTAVOZ_SIMULAR_FALLO`, `CUOTA_INICIAR_HORA`, `CUOTA_CONFIRMAR_HORA`, `CUOTA_CODIGO_IP_HORA`, `CUOTA_CODIGO_EMAIL_HORA`, `CUOTA_ENTRAR_IP_HORA`. Los `FORM_TOKEN` siguen como constantes (no son secretos).

---

## 3. Órdenes de trabajo para `ejecutor-sonnet`

**CABECERA — pegar al principio de cada orden al despacharla:**
> Trabajas SOLO en la copia aislada `/root/projects/_worktrees/tramitacion-v2` (rama `tramitacion-v2`). PROHIBIDO tocar `/root/projects/gruponewenergy-landing` (otra sesión edita ahí) y `/root/projects/altavoz` (otra sesión; puedes LEER su `docs/api.md`). Lee antes el `CLAUDE.md` del worktree. Reglas: español de España y en llano en todo texto que vea una persona; ningún mensaje técnico al comercial ni a backoffice; nunca probar con personas reales (solo `victor.molins.10+algo@gmail.com`); ningún secreto en el repo (los valores viven en `.env.local`, git-ignorado: no los leas en voz alta ni los imprimas); nada de comisiones; sin dependencias npm; Node ESM. `git add` por rutas explícitas + `commit` en español al terminar cada orden; **no hagas `git push`**. Lo que tocaría producción (Vercel, base real, cron, correo real) no lo haces: lo dejas apuntado. Victor ha autorizado el servidor local y Playwright en 127.0.0.1 para este trabajo: en serie, un navegador, con `nice -n 10`; mata el servidor por PID al acabar (nunca `pkill -f`). Si un comando falla dos veces, para y cuéntalo.

### ORDEN 1 — Cimientos y lógica pura (sin base de datos)
**Objetivo:** configuración del proyecto, SQL y toda la lógica que no habla con la red, con pruebas unitarias en verde.
**Crear:** `package.json`, `.gitignore` (añadir), `.vercelignore` (añadir), `vercel.json` (ampliar), `supabase/tramitacion.sql` (copiar TAL CUAL el bloque de la sección 2.1), `api/_lib/{config,http,validadores,nombres,estados,correos,sesion}.js`, `bandeja-zip.js`, `tests/unit/{validadores,nombres,estados,correos,sesion,zip,http,config}.test.mjs`.
**NO tocar:** `gnew.html`, `mega.html`, `gracias*.html`, `index.html`, los dos `Code.gs`, `CLAUDE.md`.
**Detalle:** `vercel.json` final = el actual + `"$schema": "https://openapi.vercel.sh/vercel.json"`, `"regions":["dub1"]`, rewrites `/bandeja`→`/bandeja.html`, `/bandeja/entrar`→`/bandeja-entrar.html`, `/bandeja/c/:ref`→`/bandeja-ficha.html`, `headers` para `/bandeja`, `/bandeja/:path*` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`) y `/api/:path*` (`no-store`), y `functions` de 2.8; conservar `/`→`/gnew`, `/gnew`, `/mega`, `/gracias-mega`, `/clave`. `.vercelignore` añade `supabase/`, `scripts/`, `tests/`, `docs/`, `.env.local`, `.env*`, `.agents/`, `.project-map/`, `.claude/`. Validadores: portar los de `gnew.html` (CUPS con checksum, DNI/NIE/CIF, IBAN mod-97, móvil con +34, CP de 5 cifras, email simple) y `validarDatos(formulario, datos)` → `{campos:{nombre:'frase'}}` con las mismas frases que el html, que exige `terminos`, y en MEGA valida `tarifa` contra la lista del `<select>` de `mega.html` y deriva `tipo_suministro`. `nombres.js`: `sanearNombre` (sin `..` ni rutas, sin `\/:*?"<>|`, tildes fuera, ≤ 80, extensión en minúsculas), `extensionDe`, `mimeDe` (pdf, jpg/jpeg, png, doc, docx; otra → null), `nonce(10)` base32 de `crypto.randomBytes`, `carpetaDe({prueba, formulario, ref, fecha, nonce})`, `rutaDe(carpeta, orden, ext)` → `NN.ext`, `normalizarBusqueda` (NFD, sin marcas, minúsculas, espacios compactos), `enUnaLinea`, `recortar`. `estados.js`: `TRANSICIONES`, `esperaMinutos(intento)` = [1,3,10,30,60,120,240], `MAX_INTENTOS = 8`, `clasificarAltavoz({status, codigo, red})` según la tabla de 2.2. `correos.js`: `asuntoDe(formulario, datos)` con el formato de 2.5 (partes vacías omitidas, ≤ 200, una línea), `armarAviso({tramitacion, documentos, urlFicha, destino})`, `armarAcuse({tramitacion, documentos, destino})`, `armarCodigo(codigo)`; fechas con `Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid'})`. `sesion.js` con `node:crypto` (HMAC-SHA256, `timingSafeEqual`), cookie `bandeja_sesion` (HttpOnly, SameSite=Lax, Path=/, Max-Age 30 d, `Secure` opcional). `bandeja-zip.js`: módulo ESM sin dependencias de Node (debe funcionar en el navegador) que exporta `crearZip(entradas)` (`[{nombre, datos: Uint8Array}]` → `Uint8Array`, método stored, CRC32 por tabla, bit 11 UTF-8, nombres duplicados prefijados). `http.js`: `leerJson(req)` usa `req.body` si está definido (Vercel ya lo parsea; el getter lanza con JSON roto → capturar y devolver `400 peticion`) y si no, lee el stream (≤ 3 MB). `config.js`: lectura perezosa (`requerida('SUPABASE_URL')` lanza solo al usarse) y cuotas con prefijo `pruebas:` cuando `esPrueba()`.
**Verificación:** `cd /root/projects/_worktrees/tramitacion-v2 && for f in api/_lib/*.js bandeja-zip.js; do node --check "$f" || exit 1; done && node --test "tests/unit/*.test.mjs" && node -e "import('./bandeja-zip.js').then(async m=>{const fs=await import('node:fs');fs.writeFileSync('/tmp/p.zip',m.crearZip([{nombre:'a.txt',datos:new TextEncoder().encode('hola')},{nombre:'b.pdf',datos:new Uint8Array(70000)}]))})" && python3 -m zipfile -t /tmp/p.zip && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"`.
**Hecho cuando:** unitarias en verde (mínimo: 12 casos de validadores con valores reales y falsos; asuntos GNEW/MEGA con y sin partes y recorte a 200; acuse sin IBAN ni DNI; aviso con IBAN y botón; `<script>` escapado; cookie manipulada rechazada y caducada rechazada; clasificación de los 7 casos de Altavoz; ZIP válido para Python; `leerJson` con `req.body` presente, con stream y con JSON roto), el SQL leído de arriba abajo sin un solo `apply_migration`, y commit.

### PUNTO DE CONTROL A (lo hace el orquestador — `REQUIERE OK DE VICTOR`)
Aplicar `supabase/tramitacion.sql` en `iigwltjzbynyvhnaqtbu` con `execute_sql` (es la base real de la plataforma) y comprobar: 6 tablas con RLS, la RPC, el bucket privado (`select id, public, file_size_limit from storage.buckets where id='tramitaciones'`). Dejar en el worktree `.env.local` (0600) con `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRAMITACION_PRUEBA=1`, `ALTAVOZ_SIMULAR=1`, `AVISO_DESTINO=victor.molins.10+tramitacion@gmail.com`, `BANDEJA_EMAILS=victor.molins.10+bandeja@gmail.com`, `BANDEJA_SECRETO` y `VIGILANTE_SECRETO` de prueba (32+ car.), `SITIO_URL=http://127.0.0.1:8765`. El ejecutor no abre `/root/.gnew-plataforma-supabase.env`.

### ORDEN 2 — Servidor: Supabase, cartero, cola, `iniciar` y `confirmar` + servidor local + pruebas de API
**Objetivo:** que un cliente pueda registrar una tramitación, subir archivos directamente al almacén y confirmarla; y demostrar PRIMERO que la subida y la descarga directas funcionan (son la pieza que sostiene todo).
**Requisito previo:** existe `.env.local` (si no, para y avisa).
**Crear:** `api/_lib/{supabase,cartero,cola,tramitacion}.js`, `api/tramitacion/iniciar.js`, `api/tramitacion/confirmar.js`, `tests/servidor-local.mjs`, `tests/fixtures/generar.mjs` (un «PDF» de 5,5 MB con cabecera `%PDF-1.4` y bytes aleatorios; un JPEG y un PNG pequeños válidos desde base64 fijo), `tests/api/00-almacen.test.mjs` (el spike), `tests/api/10-tramitacion.test.mjs`, `scripts/limpiar-pruebas.mjs`.
**NO tocar:** los html, `Code.gs`, nada de la orden 1 salvo errores que descubras (dilo en el commit).
**Detalle:** `supabase.js` solo `fetch` con `apikey` + `Authorization: Bearer <service_role>`, tope 10 s, errores con `status` y sin volcar cuerpos; Storage: `crearUrlSubida(ruta)` → `POST /storage/v1/object/upload/sign/tramitaciones/<ruta>` con `x-upsert: true` → devolver `SUPABASE_URL + '/storage/v1' + url` (la `url` llega relativa con `?token=`); `subirObjeto(ruta, buffer, mime)` → `POST /storage/v1/object/tramitaciones/<ruta>` (`x-upsert`); `listarCarpeta(carpeta)` → `POST /storage/v1/object/list/tramitaciones` `{prefix, limit:100, offset:0, sortBy:{column:'name',order:'asc'}}` → `[{nombre, tamano: metadata.size, mime: metadata.mimetype}]`; `firmarDescargas(rutas, seg)` → `POST /storage/v1/object/sign/tramitaciones` `{expiresIn, paths}` → URLs absolutas; `borrarObjetos(rutas)` → `DELETE /storage/v1/object/tramitaciones` `{prefixes}`. **`00-almacen.test.mjs` (correr el primero):** crea una URL firmada bajo `pruebas/__spike/…`; `OPTIONS` con `Origin: http://127.0.0.1:8765` y `Access-Control-Request-Method: PUT` + `Access-Control-Request-Headers: content-type,x-upsert` y comprueba `access-control-allow-origin`; `PUT` de 5,5 MB con `Content-Type: application/pdf` → 2xx; lista y ve `size` exacto; `PUT` con `Content-Type: text/plain` → rechazado; `PUT` de 26 MB → rechazado; firma de descarga y `GET` con `Origin: http://127.0.0.1:8765` → 200 y `access-control-allow-origin` presente (lo necesitan el ZIP y «Descargar»); borra. **Si algo de esto falla, para y repórtalo: no construyas encima.** `tramitacion.js` y los dos handlers según 2.3 (incluidos `ref_anterior`, reanudar una `abandonada`, el orden de operaciones de `confirmar` y su rama «ya recibida» que concilia correos). `cartero.js`: payload `{marca, para, asunto, html, texto, etiqueta, responder_a}`, tope por parámetro (8 s por defecto), clasifica con `estados.clasificarAltavoz`, simulación y fallo simulado. `cola.js`: cerrojo optimista por `PATCH … ?estado=eq.pendiente` con `Prefer: return=representation`, regeneración del cuerpo con `correos.js`, eventos, `conciliar()`. **Servidor local** (`127.0.0.1:8765`): carga `.env.local` (parser propio), sirve estáticos del worktree con las `rewrites`/`redirects` de `vercel.json` (soporta `:param`), enruta `/api/<ruta>` a `import('../api/<ruta>.js')` pasando `req` con `body` ya parseado cuando es JSON (igual que Vercel), `query`, `cookies`, y `res` con `status().json()`; ganchos SOLO en este servidor (nunca en `api/`): `GET /__pruebas/correos?para=&tipo=` (últimos 5 simulados, con cuerpo), `GET /__pruebas/tramitacion?ref=` (fila + documentos + correos + eventos; es por donde las pruebas leen la base), `POST /__pruebas/altavoz {caido:true|false}`, `POST /__pruebas/env {VARIABLE: 'valor'|null}` (pone o quita variables de proceso para probar cuotas). `limpiar-pruebas.mjs`: borra tramitaciones `prueba=true` (en cascada) y sus objetos, los accesos de los alias de prueba y las cuotas `clave=like.pruebas:*` (nunca las de producción); `--todo` o `--horas N`.
**Verificación:** `node tests/servidor-local.mjs &` (guarda el PID) → `node --test "tests/api/*.test.mjs"` → `node scripts/limpiar-pruebas.mjs --todo` → `kill <PID>`. Casos exigidos en `10-tramitacion`: envío completo con 3 archivos (uno de 5,5 MB) + firma → `listo:true`, fila `recibida`, 4 documentos `subido` con `tamano_comprobado`, aviso y acuse `enviado` simulados con el asunto correcto, el aviso con IBAN y botón a `/bandeja/c/<ref>`, el acuse sin IBAN; `iniciar` repetido con el mismo `ref` → `listo:true` sin segunda fila; `confirmar` sin subir → `409 faltan_archivos` y tras subir → `listo`; lista distinta → `409`; `ref_anterior` → la vieja `abandonada` y `iniciar` sobre ella la reanuda a `subiendo`; token malo → `401`; honeypot → `200 listo:true`, fila `descartada`, sin correos; CUPS malo → `400 campos.cups`; 16 archivos → `413`; con `/__pruebas/env {CUOTA_INICIAR_HORA:'3'}` la 4.ª llamada → `429` (y se restaura); con Altavoz «caído» los correos quedan `pendiente` y `confirmar` sigue dando `listo:true`; JSON roto → `400`.
**Hecho cuando:** todo en verde dos veces seguidas, sin filas ni objetos de prueba en la base al terminar, y commit.

### ORDEN 3 — Formulario: `gnew.html`, `mega.html`, páginas de gracias + pruebas con navegador
**Objetivo:** que el comercial use el camino nuevo sin notar cambio de aspecto, con progreso, reintentos y respaldo.
**Cambiar:** `gnew.html`, `mega.html`, `gracias.html`, `gracias-mega.html`. **Crear:** `tests/e2e/{comun.py, formulario.py, run.sh}`.
**NO tocar:** campos y `name`, validaciones, firma, honeypot, prefill por URL, estilos existentes (solo añadir la barra de progreso en `<style>`), los `Code.gs`, nada en `api/`.
**Detalle:** aplicar 2.4 al pie de la letra (constantes, pasos 1-8, textos exactos, `refAnterior`/`currentRefId`, `XMLHttpRequest` con `Content-Type` por extensión y `x-upsert`, compresión con `createImageBitmap(file, {imageOrientation:'from-image'})` y vuelta al original ante cualquier error, respaldo solo si `iniciar` falla por red/tiempo/404/5xx tres veces, overlays sin detalle técnico). Primero `gnew.html`; después `mega.html` espejo (`FORMULARIO='mega'`, `hp: form.mega_hp.value`, `tipo_suministro`, `gracias-mega.html`). Playwright en Python con `/root/.venvs/scrapling/bin/python` (chromium ya instalado), viewport 390×844, escuchando `pageerror`/`console` (0 errores forma parte del criterio), ficheros con `set_input_files` (el de 5,5 MB desde `tests/fixtures/`), el JPEG grande de la prueba de compresión generado en la propia página con un canvas de 4000×3000 con ruido; el estado de la base se lee SIEMPRE por `/__pruebas/tramitacion?ref=` (nunca desde Python contra Supabase). Casos: (1) GNEW completo con 3 archivos → `gracias.html?ref=` con la referencia visible, fila `recibida`, correos simulados; (2) corte de red en `confirmar` (`page.route` aborta la 1.ª) → reintento → gracias, una sola fila y un solo aviso; (3) 1.ª `PUT` a Storage abortada → reintento del archivo → gracias; (4) `/api/tramitacion/iniciar` → 503 ×3 y `script.google.com/**` → `{"success":true}` → gracias sin fila nueva (respaldo); (5) foto de 3 MB → documento `comprimido=true` y `tamano_original` mayor; (6) MEGA completo → asunto `Nuevo Contrato MEGA - …`; (7) CUPS inválido → error en línea sin salir de la página; (8) todos los `PUT` abortados → overlay «No hemos podido terminar el envío» con «Reintentar» → se quita la ruta → «Reintentar» → gracias con la MISMA referencia; (9) tras un fallo, el comercial quita un archivo y reenvía → la referencia vieja queda `abandonada` y la nueva `recibida`. `run.sh`: arranca el servidor local, corre los casos en serie con `nice -n 10`, limpia pruebas y mata por PID.
**Verificación:** `bash tests/e2e/run.sh formulario` termina con «9/9 OK» y 0 errores de consola; `grep -c "Detalle: " gnew.html mega.html` da 0 en ambos.
**Hecho cuando:** 9/9, aspecto idéntico (captura a 390 px de `gnew.html` antes y después en `tests/e2e/salidas/`, comparadas), y commit.

### ORDEN 4 — Bandeja de backoffice
**Objetivo:** que backoffice entre con código, vea lista y ficha, descargue (uno a uno y ZIP) y marque tramitada.
**Crear:** `api/_lib/bandeja.js`, `api/bandeja/{codigo,entrar,salir,yo,lista,ficha,estado,reenviar}.js`, `bandeja.html`, `bandeja-entrar.html`, `bandeja-ficha.html`, `tests/api/20-bandeja.test.mjs`, `tests/e2e/bandeja.py`.
**NO tocar:** `gnew.html`, `mega.html`, `api/tramitacion/*`.
**Detalle:** 2.3 (bandeja) y 2.6 al pie de la letra. CSS dentro de cada html, móvil primero, paleta GNEW; JS en línea salvo `bandeja-zip.js`; la ficha lee `ref` de `location.pathname`; `401` → `location = '/bandeja/entrar?volver=' + encodeURIComponent(ruta actual)` (solo si empieza por `/bandeja`). `lista`: `select=…,tramitacion_documentos(count)`, keyset `creada_en=lt.`, `prueba=eq.false` salvo `TRAMITACION_PRUEBA=1` (entonces solo `prueba=eq.true`). `ficha`: URLs de descarga por lote válidas 10 min; «Descargar» por `fetch` + `a.download`. Textos de botones y estados exactamente los de 2.6. Cuotas con prefijo `pruebas:` en modo prueba.
**Verificación:** servidor local → `node --test tests/api/20-bandeja.test.mjs` (pedir código para el alias → leerlo en `/__pruebas/correos` → entrar → cookie → `lista` muestra la tramitación creada → `ficha` con IBAN y URLs que responden 200 → `estado` tramitar/reabrir con eventos y `tramitada_por` → `reenviar` deja el aviso `enviado` otra vez; email fuera de la lista → `200` sin correo; código erróneo ×5 → `429`; sin cookie → `401`; con `/__pruebas/env {TRAMITACION_PRUEBA:'0'}` la fila de prueba no sale y se restaura) → `bash tests/e2e/run.sh bandeja` (login con código leído de la simulación, lista, ficha, «Ver» abre 200, ZIP descargado y validado con `python3 -m zipfile -t`, «Marcar como tramitada» cambia la insignia, «Volver a pendiente», enlace directo a `/bandeja/c/<ref>` sin sesión → login → vuelve a la ficha) → limpiar → `kill`.
**Hecho cuando:** API y e2e en verde, capturas 390/1440 de las tres pantallas en `tests/e2e/salidas/`, 0 errores de consola, commit.

### ORDEN 5 — Vigilante (endpoint + script del VPS) y documentación
**Objetivo:** que nada se pierda en silencio: reintentos automáticos, conciliación y aviso a Victor.
**Crear:** `api/tramitacion/vigilante.js`, `scripts/vigilante-tramitacion.mjs`, `tests/api/30-vigilante.test.mjs`, `tests/unit/vigilante-script.test.mjs`, `docs/tramitacion-v2.md`. **Cambiar:** `CLAUDE.md` del worktree (sección «Tramitación v2»: arquitectura, estados, variables, pruebas, puesta en marcha; lo de Drive/Brevo pasa a «respaldo temporal»).
**NO tocar:** html, `Code.gs`.
**Detalle:** 2.3 (`vigilante`, pasos 0-4) y 2.7 al pie de la letra. El script no importa nada del repo (correrá desde `/root/projects/gruponewenergy-landing/scripts/` tras el merge): solo `node:fs`, `node:child_process` y `fetch`; `NOTIFICAR` por defecto `/root/notifica-telegram.sh`, sobrescribible por env para probar con un stub que escribe a un fichero; `ESTADO` y `TESTIGO` idem. Nunca imprime el secreto ni la URL con el secreto.
**Verificación:** servidor local → `node --test tests/api/30-vigilante.test.mjs` (con Altavoz «caído»: confirmar deja 2 correos pendientes → sin secreto `401` → con secreto y aún caído: `reintentados=2, enviados=0`, `intentos` sube, `proximo_intento` futuro → poner `proximo_intento=now()` con el gancho `/__pruebas/env`+`/__pruebas/altavoz` o por el propio endpoint tras forzar la fecha desde la cola de pruebas, quitar el fallo → `enviados=2`; **conciliación**: borrar a mano los correos de una recibida (gancho de pruebas o `limpiar` selectivo) → el vigilante los recrea y envía, con evento `correos_conciliados`; una `subiendo` con `creada_en` hace 2 h aparece en `subidas_a_medias`; con `creada_en` hace 25 h pasa a `abandonada`) → `node --test tests/unit/vigilante-script.test.mjs` (el script contra un endpoint falso en `127.0.0.1` con `NOTIFICAR` = stub: avisa una vez por clave, no repite en la 2.ª pasada, avisa «resuelto» al desaparecer, avisa de endpoint caído solo al 2.º fallo y de recuperación después; `--dry` no toca el stub) → limpiar → `kill`.
**Hecho cuando:** todo en verde, `node scripts/vigilante-tramitacion.mjs --dry` contra el servidor local imprime el parte sin avisar, `CLAUDE.md` y `docs/tramitacion-v2.md` actualizados sin secretos, commit.

### TANDA FINAL — Puesta en marcha (orquestador; cada punto `REQUIERE OK DE VICTOR`)
1. Variables en Vercel (`gruponewenergy-landing`, Production): las de 2.8 con `ALTAVOZ_SIMULAR=0`, `AVISO_DESTINO=escaneos@gruponew.energy`, `SITIO_URL=https://tramitatucontrato.energy`, `BANDEJA_EMAILS` (lista que diga Victor), secretos nuevos de 32+ caracteres; clave Altavoz propia (`/root/.altavoz-api-formulario-tramitacion.key` ya existe; si no tiene `avisos:enviar`, crear otra con `crear-clave-api.ts`). Confirmar con la sesión de Altavoz que `responder_a` está desplegado y si el candado `modo_prueba` está apagado. Confirmar plan de Vercel (Hobby/Pro) y Fluid.
2. Merge de `tramitacion-v2` en `master` y push → deploy. Comprobar: `/gnew` y `/mega` iguales, `/bandeja` carga, `GET /api/_lib/config.js` → 404, `POST /api/tramitacion/vigilante` sin secreto → 401, `/CLAUDE.md` → 404, `/supabase/tramitacion.sql` → 404.
3. Primer envío real desde `/gnew` con el alias de Victor como comercial y `AVISO_DESTINO` apuntando temporalmente a otro alias suyo; leer aviso y acuse por el conector de Gmail; después poner `escaneos@`.
4. En el VPS: `/root/.tramitacion-vigilante.env` (0600) con `VIGILANTE_URL` y el secreto; crontab `*/5` con la **ruta absoluta de node** (`which node`); una pasada manual con `--dry`; añadir el testigo `/root/.tramitacion-vigilante-last` a `latido-crons.sh` (CIEGO si falta o > 15 min).
5. A la semana sin incidencias: `RESPALDO_APPS_SCRIPT=false` en los dos html (commit + push) y, cuando Victor quiera, dejar los Apps Script como archivo.

---

## 4. Cómo se verifica que está bien hecho (visión global)
- Unitarias (`node --test "tests/unit/*.test.mjs"`) y de API (`tests/api/*`) en verde en el VPS; e2e (`tests/e2e/run.sh formulario|bandeja`) 9/9 y todos los de bandeja, con 0 errores de consola; capturas antes/después del formulario iguales.
- `00-almacen` demuestra el PUT directo de 5,5 MB desde otro origen con CORS, el GET de descarga con CORS, y el rechazo por tipo y por tamaño.
- Idempotencia demostrada: dos `iniciar`/`confirmar` con el mismo `ref` = una fila, un aviso; cambio de lista = referencia vieja «Incompleta» sin alerta.
- Cola: con Altavoz caído nada se pierde (pendientes) y el vigilante los saca; una recibida sin correos los recupera por conciliación; avisos de Telegram una vez por clave (probado con stub).
- Sin PII en URLs ni logs: `grep -n "console\.\(log\|error\)" api/` no vuelca `datos`, `iban`, `email` ni cuerpos; claves de objetos `NN.ext`; `grep -c "Detalle: "` = 0 en los html.
- Producción (tanda final): un contrato real con alias de Victor de punta a punta y los 404 de `/api/_lib/*`, `/CLAUDE.md`, `/supabase/*`.

## 5. Riesgos y dudas (con recomendación)
1. **Plan de Vercel y Fluid compute.** Si `gruponewenergy-landing` está en Hobby (uso comercial no permitido) o sin Fluid (tope de 10 s por defecto), `maxDuration: 60` lo cubre, y el orden de `confirmar` + la conciliación protegen el contrato aunque se corte el correo. Recomiendo confirmar el plan en la puesta en marcha y pasar a Pro si es Hobby.
2. **La subida y descarga directas (CORS + lista MIME + `x-upsert`) son la hipótesis que sostiene el diseño.** Por eso se prueban las primeras (orden 2, `00-almacen`). Si fallara, plan B: trocear por Vercel (≤ 4 MB por trozo), peor pero viable; no construir el front hasta que `00-almacen` esté en verde.
3. **Altavoz:** `responder_a` y los códigos 409/502 están documentados (8-oct) pero hay que confirmar que están desplegados; con el candado de entorno encendido el primer envío real dará `409 modo_prueba` y el vigilante avisará. Coordinar con esa sesión antes del punto 3 de la puesta en marcha.
4. **Datos personales en el almacén (DNI, IBAN) sin política de retención.** `AMBIGUO` para Victor: ¿cuánto se conservan los documentos tras «tramitada»? Propongo 12 meses y borrado automático por el vigilante; no se implementa hasta que lo decida.
5. **Pequeñas decisiones de Victor/backoffice:** (a) en MEGA el acuse y el aviso dirigen al comercial a `escaneos@gruponew.energy` (consecuencia de la decisión del 8-oct; `gracias-mega.html` deja de citar `administracion@`): confirmar; (b) quién va en `BANDEJA_EMAILS`; (c) honeypot: se descarta sin avisar (como hoy) pero queda visible en la bandeja bajo «Descartadas» por si fuera un falso positivo. Riesgo técnico menor asumido: un correo duplicado si la función muere entre el 2xx de Altavoz y el apunte en la base (nunca uno perdido).

Rutas relevantes: `/root/projects/_worktrees/tramitacion-v2/CLAUDE.md` · `/root/projects/_worktrees/tramitacion-v2/gnew.html` · `/root/projects/_worktrees/tramitacion-v2/mega.html` · `/root/projects/_worktrees/tramitacion-v2/google-apps-script/Code.gs` (fuente de `buildEmailHtml`/`buildAcuseHtml` y del asunto antiguo) · `/root/projects/_worktrees/tramitacion-v2/vercel.json` · `/root/projects/altavoz/docs/api.md` (contrato de avisos, solo lectura) · `/root/notifica-telegram.sh` (cartero de Telegram del vigilante) · `/root/latido-crons.sh` (donde entra el testigo).

Fuentes externas: [Vercel · Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js) · [Vercel · límites de funciones](https://vercel.com/docs/functions/limitations) · [Vercel · maxDuration](https://vercel.com/docs/functions/configuring-functions/duration) · [Vercel · versiones de Node](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) · [Vercel · configuración avanzada (ficheros `_` en api/)](https://vercel.com/docs/functions/configuring-functions/advanced-configuration) · [supabase/storage-js StorageFileApi.ts](https://raw.githubusercontent.com/supabase/storage-js/main/src/packages/StorageFileApi.ts).