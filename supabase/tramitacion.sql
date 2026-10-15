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
language plpgsql set search_path = public as $$ begin new.actualizada_en = now(); return new; end $$;
create or replace trigger tramitaciones_tocar before update on public.tramitaciones
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
                                     -- correo_fallo · correos_conciliados · tramitada · reabierta · abandonada · descartada · aviso_reenviado · acuse_reenviado ·
                                     -- ficha_abierta (backoffice abre la ficha; actor = su email) · marcada_sin_abrir (backoffice deja una
                                     -- pendiente «sin abrir»; actor = su email; solo cuentan las aperturas posteriores a la última marca)
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
