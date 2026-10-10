#!/usr/bin/env bash
# tests/e2e/run.sh · Pruebas con navegador de Tramitación v2, de principio a fin y sin dejar nada detrás.
#
#   bash tests/e2e/run.sh formulario    los 11 casos del formulario (gnew.html, mega.html y las páginas de gracias; el 10 y el 11 son del interruptor V2_ACTIVO)
#   bash tests/e2e/run.sh extras        comprobaciones extra (rutas que los 11 casos no tocan; no cuentan en el «11/11»)
#   bash tests/e2e/run.sh capturas      capturas a 390 px del html de MASTER (antes) y del actual (después), comparadas
#   bash tests/e2e/run.sh bandeja       la bandeja de backoffice (acceso con código, lista, ficha, descargas, estado) y sus capturas a 390 y 1440 px
#
# Qué hace, por este orden:
#   1. arranca el servidor local (127.0.0.1:8765) con nice: base REAL en MODO PRUEBA (todo lleva prueba=true y vive bajo
#      «pruebas/») y Altavoz SIMULADO (nunca sale un correo);
#   2. corre los casos en serie, con un solo Chromium y con nice -n 10 (Playwright de Python: el venv de scrapling);
#   3. borra todo lo de prueba con scripts/limpiar-pruebas.mjs --todo, y lo repite: la segunda pasada tiene que decir
#      0 tramitaciones y 0 objetos (esa es la prueba de que base y almacén quedan a cero);
#   4. para el servidor POR SU PID (nunca con pkill -f).
# Termina con código 0 solo si los casos pasan Y la base queda limpia.
set -u
export PYTHONDONTWRITEBYTECODE=1   # sin __pycache__ en tests/e2e

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ" || exit 1

SUITE="${1:-formulario}"
PY=/root/.venvs/scrapling/bin/python
URL=http://127.0.0.1:8765
SALIDAS="$RAIZ/tests/e2e/salidas"
LOG="$SALIDAS/servidor-local.log"

case "$SUITE" in
  formulario) PRUEBAS=("$PY" tests/e2e/formulario.py) ;;
  extras)     PRUEBAS=("$PY" tests/e2e/formulario.py extras) ;;
  capturas)   PRUEBAS=("$PY" tests/e2e/formulario.py capturas) ;;
  bandeja)    PRUEBAS=("$PY" tests/e2e/bandeja.py) ;;
  *)
    echo "Uso: bash tests/e2e/run.sh formulario|extras|capturas|bandeja" >&2
    exit 2 ;;
esac

[ -x "$PY" ] || { echo "No encuentro el Python con Playwright: $PY" >&2; exit 1; }
[ -f .env.local ] || { echo "Falta .env.local en la raíz del proyecto (punto de control A del diseño)." >&2; exit 1; }
mkdir -p "$SALIDAS"

# El puerto tiene que estar libre: así el servidor al que hablan las pruebas es SIEMPRE el que arranca este script
if curl -s -o /dev/null --max-time 2 "$URL/gnew"; then
  echo "Ya hay algo escuchando en 127.0.0.1:8765. Para ese servidor (por su PID) y vuelve a lanzarlo." >&2
  exit 1
fi

# Documentos de prueba para set_input_files (están git-ignorados: el PDF de 5,5 MB no debe subirse nunca)
if [ ! -f tests/fixtures/documento-5-5mb.pdf ] || [ ! -f tests/fixtures/foto-pequena.jpg ] || [ ! -f tests/fixtures/firma-pequena.png ]; then
  node tests/fixtures/generar.mjs > /dev/null || { echo "No se han podido generar los documentos de prueba." >&2; exit 1; }
fi

PID=""
LIMPIO=0

parar_servidor() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  PID=""
}

# Salida anormal (Ctrl+C, un fallo del script...): se limpia igualmente y se para el servidor
al_salir() {
  if [ "$LIMPIO" -eq 0 ]; then
    node scripts/limpiar-pruebas.mjs --todo > /dev/null 2>&1
  fi
  parar_servidor
}
trap al_salir EXIT
trap 'exit 130' INT TERM

nice -n 10 node tests/servidor-local.mjs > "$LOG" 2>&1 &
PID=$!

LISTO=0
for _ in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "El servidor local se ha parado al arrancar:" >&2
    sed 's/^/  | /' "$LOG" >&2
    exit 1
  fi
  if [ "$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$URL/gnew")" = "200" ]; then LISTO=1; break; fi
  sleep 0.5
done
[ "$LISTO" -eq 1 ] || { echo "El servidor local no ha contestado en 30 s." >&2; exit 1; }
echo "Servidor local en marcha (PID $PID, modo prueba, Altavoz simulado)."

echo "=== Pruebas: $SUITE ==="
nice -n 10 "${PRUEBAS[@]}"
RESULTADO=$?

echo "=== Limpieza de lo de prueba ==="
node scripts/limpiar-pruebas.mjs --todo
LIMPIEZA1=$?
SEGUNDA="$(node scripts/limpiar-pruebas.mjs --todo 2>&1)"
LIMPIEZA2=$?
echo "(segunda pasada) $SEGUNDA"
LIMPIO=1

parar_servidor

ACERO=0
if [ "$LIMPIEZA1" -eq 0 ] && [ "$LIMPIEZA2" -eq 0 ] && echo "$SEGUNDA" | grep -q ': 0 tramitaciones, 0 objetos del almacén, 0 correos de código, 0 accesos y 0 cuotas\.'; then
  ACERO=1
  echo "BASE Y ALMACÉN A CERO: sí (la segunda pasada no ha encontrado nada)"
else
  echo "BASE Y ALMACÉN A CERO: NO — revisa scripts/limpiar-pruebas.mjs --todo" >&2
fi

if [ "$RESULTADO" -ne 0 ] || [ "$ACERO" -ne 1 ]; then exit 1; fi
exit 0
