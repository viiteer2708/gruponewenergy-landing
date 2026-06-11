# CLAUDE.md - Grupo New Energy Landing

**Landing pages de tramitación de contratos de luz y gas. Contiene dos formularios independientes:**
- **GNEW** (gnew.html, ruta `/gnew`) — Grupo New Energy, asesoría/brokerage energético, múltiples compañías
- **MEGA** (mega.html, ruta `/mega`) — Mega Energía, comercializadora directa, solo contratos Mega

Además, `index.html` es una **landing de captación** independiente (formulario de email → webhook Make) para vender la plataforma; NO es el formulario de tramitación. La raíz `/` redirige a `/gnew` (ver vercel.json).

## Reglas de Oro
| Regla | Por qué |
|-------|---------|
| Mobile-first siempre | 70%+ usuarios son comerciales desde móvil |
| No duplicar estilos inline | Todo el CSS está en `<style>` dentro de cada html |
| Validación client-side antes de envío | Formatos españoles (CUPS, NIF/NIE/CIF, IBAN mod-97, móvil) validados en gnew.html antes de enviar |
| Mantener triple seguridad: Drive + Email + Sheet de registro | Decisión de arquitectura tras incidentes de pérdida de datos |
| Solo confirmar "enviado" si el backend responde `success:true` | Un fallo de red NO es un envío; el `ref_id` idempotente permite reintentar sin duplicar |
| No romper el flujo de firma digital | Canvas de firma es crítico para la tramitación |
| Archivos GNEW: máx 15 archivos y 30MB EN TOTAL (validado en front y back) | Apps Script corta el POST en ~50MB y base64 infla +33%; Code.gs además rechaza >15 archivos y >45M chars base64 (`MAX_FILES`/`MAX_TOTAL_BASE64_CHARS`) |

## Stack
- **Frontend:** HTML/CSS/JS vanilla (single-page, sin framework)
- **Backend:** Google Apps Script (Code.gs) — almacena en Drive + envía email
- **Hosting:** Vercel (archivos estáticos + rewrites)
- **GNEW:** Inter, Verde #0B6E4F, Accent #F9A825
- **MEGA:** Plus Jakarta Sans, Turquesa #14B8A6, Accent #EAB308

## Estructura
```
gnew.html                       # GNEW: formulario multi-compañía (ruta /gnew)
gracias.html                    # GNEW: confirmación post-envío
logo-gnew.png                   # GNEW: logo (local, ya no depende de Dropbox)
favicon-gnew.png                # GNEW: favicon (64x64)
google-apps-script/
  Code.gs                       # GNEW backend: Drive + Email + Sheet (doPost)
mega.html                       # MEGA: formulario exclusivo Mega Energía (ruta /mega)
gracias-mega.html               # MEGA: confirmación post-envío
logo-mega-energia.png           # MEGA: logo
favicon-mega.png                # MEGA: favicon
google-apps-script-mega/
  Code.gs                       # MEGA backend: Drive + Email (doPost)
index.html                      # Landing de captación (email → webhook Make)
aviso-legal.html                # Páginas legales (enlazadas desde términos y footer)
privacidad.html
cookies.html
vercel.json                     # Redirect / → /gnew · rewrites /gnew, /mega, /gracias-mega
claude.md
```

## Archivos clave — GNEW
| Archivo | Qué contiene |
|---------|-------------|
| `gnew.html` | Hero + formulario multi-sección + validadores españoles + firma canvas + honeypot + JS de envío con confirmación y reintentos idempotentes |
| `google-apps-script/Code.gs` | doPost → valida token/honeypot/límites → Drive + email a `escaneos@gruponew.energy` + registro en Sheet |
| `gracias.html` | Confirmación con animación de check verde |

### GNEW — Config backend
- **Drive folder ID**: `1UF1OLd9E0GOpnA721GOq4bLyFPC5S4Jc`
- **Ref IDs**: `GNE-YYYYMMDD-XXXXXX` (los genera el cliente; el backend deduplica con CacheService 6h)
- **Token anti-spam**: `FORM_TOKEN` debe coincidir en gnew.html y Code.gs (no es un secreto, solo frena bots)
- **Registro**: Sheet "Registro Tramitaciones GNEW" auto-creado en la carpeta de Drive (ID en ScriptProperties `LOG_SHEET_ID`)
- **Apps Script deployment**: acceso DEBE ser "Cualquier persona" (el front lee la respuesta JSON para confirmar el envío)
- **⚠️ Orden de despliegue** si cambian front y back: primero Vercel (gnew.html), DESPUÉS la nueva versión del Apps Script (el back nuevo rechaza envíos sin token; el back viejo ignora los campos nuevos)
- **Prefill DPC**: el comparador DPC abre `/gnew?quien_eres=...&cups=...` con los `name` de los inputs (`dpc-comparador/src/lib/contracting/build-contract-url.ts`). El prefill NUNCA acepta `cuenta_bancaria` ni `dni_firmante` por URL (PII en historiales/logs)

## Archivos clave — MEGA
| Archivo | Qué contiene |
|---------|-------------|
| `mega.html` | Formulario con branding turquesa Mega, tarifa desplegable, tipo suministro auto |
| `google-apps-script-mega/Code.gs` | doPost → Drive + email a `administracion@megaenergia.es` + `victormarron@megaenergia.es` |
| `gracias-mega.html` | Confirmación con branding Mega |

### MEGA — Config backend
- **Drive folder ID**: `1cfxHV8Oz_N9wsG6E9MRM_74dMSiioXUx`
- **Ref IDs**: `MEGA-YYYYMMDD-XXXX`
- **Apps Script deployment**: acceso DEBE ser "Cualquier persona" (no "Solo yo")

## Flujo de trabajo
1. Editar `gnew.html` / `mega.html` (CSS en `<style>`, JS en `<script>` al final)
2. Para backend, editar el `Code.gs` correspondiente (luego desplegar manualmente en Google Apps Script — ver orden de despliegue arriba)
3. Testear abriendo el html en navegador (no hay build step)
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

**PERMITIDO sin preguntar:**
- Leer/escribir cualquier archivo de código
- git add, git commit
- Cualquier operación local de lectura/análisis

---

## Vault de Obsidian (contexto transversal)
Este proyecto está conectado con mi vault de Obsidian en `/mnt/c/Users/viite/Documents/OBSIDIAN/VIITEER`.

Si el vault no está cargado como directorio adicional, cárgalo:
/add-dir /mnt/c/Users/viite/Documents/OBSIDIAN/VIITEER

### Contexto de negocio
Este repo contiene dos formularios: **GNEW** (brokerage, múltiples compañías) y **MEGA** (comercializadora directa, solo Mega Energía). Son negocios distintos con flujos separados. En el vault busca:

- **Mega Energía**: tarifas, comisiones, estructura de red comercial, incentivos
- **API SICOM**: integración con comercializadoras, flujos de contratación
- **ATR / regulación**: cambios regulatorios que afecten al formulario
- **Equipo comercial**: jerarquía de agentes, onboarding, materiales de venta
- **GNEW CRM**: si hay interacción con el CRM (Supabase, roles, RLS)

### Regla
Antes de tomar decisiones de arquitectura o negocio en este proyecto, consulta el vault para verificar decisiones previas o contexto relevante.
