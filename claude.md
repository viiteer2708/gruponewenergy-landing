\# CLAUDE.md - Landing page o web estática



\## Descripción

LANDING PAGE DE CAPTURA DE INFORMACIÓN Y DOCUMENTACION DE CLIENTES PARA GESTIONAR EN COMERCIALIZADORAS DE LUZ Y GAS.\*\*

Target: COMERCIALES DEL SECTOR ENERGÉTICO QUE QUIEREN TRAMITAR CONTRATOS DE LUZ Y GAS CON MI GESTORIA.



\## Stack Tecnológico

Next.js 15 - TypeScript estricto

Tailwind CSS + shadcn/ui





\## Estructura

app/           # Next.js App Router

components/    # 100+ componentes

lib/           # Supabase, Stripe, Mux, Resend

docs/          # Specs y reglas de diseño

```



\## Convenciones de Código

| Regla | Por qué |

|-------|---------|

| Componentes existentes primero | 100+ en components/, no dupliques |

| UI\_DESIGN\_RULES.md antes de UI | Sistema de diseño establecido |

| RLS en TODAS las tablas | Tier access en BD |

| Mobile-first | 70% usuarios móvil |





\## Estado Actual

(Rellena esto manualmente con lo que funciona y lo que falta)



\## Prohibiciones

\*\*PROHIBIDO sin pedir permiso:\*\*

\- git push (hago push manualmente)

\- rm -rf / borrar archivos

\- Playwright / browser testing

\- npm run dev / levantar servidores



\*\*PERMITIDO sin preguntar (YOLO mode):\*\*

\- Leer/escribir cualquier archivo de código

\- Ejecutar builds, linters, type checks

\- Crear migraciones SQL

\- Instalar dependencias

\- git add, git commit

\- Operaciones de Supabase (MCP)

