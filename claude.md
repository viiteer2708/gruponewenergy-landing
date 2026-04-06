# CLAUDE.md - Grupo New Energy Landing

**Landing pages de tramitación de contratos de luz y gas. Contiene dos formularios independientes:**
- **GNEW** (index.html) — Grupo New Energy, asesoría/brokerage energético, múltiples compañías
- **MEGA** (mega.html) — Mega Energía, comercializadora directa, solo contratos Mega

## Reglas de Oro
| Regla | Por qué |
|-------|---------|
| Mobile-first siempre | 70%+ usuarios son comerciales desde móvil |
| No duplicar estilos inline | Todo el CSS está en `<style>` dentro de index.html |
| Validación client-side antes de envío | Evitar envíos incompletos a Google Apps Script |
| Mantener triple seguridad: Drive + Email + reintentos | Decisión de arquitectura tras incidentes de pérdida de datos |
| No romper el flujo de firma digital | Canvas de firma es crítico para la tramitación |
| Archivos max 50MB por archivo | Límite de Google Apps Script / Drive API |

## Stack
- **Frontend:** HTML/CSS/JS vanilla (single-page, sin framework)
- **Backend:** Google Apps Script (Code.gs) — almacena en Drive + envía email
- **Hosting:** Vercel (archivos estáticos + rewrites)
- **GNEW:** Inter, Verde #0B6E4F, Accent #F9A825
- **MEGA:** Plus Jakarta Sans, Turquesa #14B8A6, Accent #EAB308

## Estructura
```
index.html                      # GNEW: formulario multi-compañía
gracias.html                    # GNEW: confirmación post-envío
google-apps-script/
  Code.gs                       # GNEW backend: Drive + Email (doPost)
mega.html                       # MEGA: formulario exclusivo Mega Energía
gracias-mega.html               # MEGA: confirmación post-envío
logo-mega-energia.png           # MEGA: logo
google-apps-script-mega/
  Code.gs                       # MEGA backend: Drive + Email (doPost)
vercel.json                     # Rewrites: /mega → mega.html
CLAUDE.md
```

## Archivos clave — GNEW
| Archivo | Qué contiene |
|---------|-------------|
| `index.html` | Hero + formulario multi-sección + firma digital canvas + JS de envío |
| `google-apps-script/Code.gs` | doPost → Drive + email a `escaneos@gruponew.energy` |
| `gracias.html` | Confirmación con animación de check verde |

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
1. Editar `index.html` (CSS en `<style>`, JS en `<script>` al final)
2. Para backend, editar `Code.gs` (luego desplegar manualmente en Google Apps Script)
3. Testear abriendo `index.html` en navegador (no hay build step)
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
