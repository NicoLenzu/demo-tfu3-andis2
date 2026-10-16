#!/usr/bin/env bash
# Funciones compartidas por todos los scripts de demo.
# Evitamos depender de 'jq' para que corra en cualquier maquina.

BASE="${BASE:-http://localhost:8080}"
HTTPS_BASE="${HTTPS_BASE:-https://localhost:8443}"

# Extrae un campo string de un JSON plano. Uso: echo "$json" | campo token
campo() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# Extrae un campo numerico. Uso: echo "$json" | numero posicion
numero() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | grep -o '[0-9]*$'
}

# Hace login y devuelve el token.
login() {
  curl -s -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | campo token
}

titulo() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }
paso()   { echo; echo "--> $1"; }

# --- Helpers para los scripts de patrones (7 a 12) --------------------------
# Cada script acumula FALLOS y termina con 'resumen' (exit != 0 si algo fallo).

FALLOS=0

# criterio <descripcion> <esperado> <obtenido>
criterio() {
  if [ "$2" = "$3" ]; then
    echo "  [OK]    $1 (=$3)"
  else
    echo "  [FALLO] $1 (esperado=$2, obtenido=$3)"
    FALLOS=$((FALLOS + 1))
  fi
  return 0
}

# criterio_ok <descripcion> <condicion: 0 = se cumple>
criterio_ok() {
  if [ "$2" -eq 0 ]; then
    echo "  [OK]    $1"
  else
    echo "  [FALLO] $1"
    FALLOS=$((FALLOS + 1))
  fi
  return 0
}

# Comparaciones numericas con decimales (para latencias de curl).
mayor_igual() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }
menor()       { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<b)}'; }

# Crea una receta siguiendo el flujo real (el "camino feliz" del script 1):
# reserva un cupo del medico, inicia la consulta y emite la receta.
# Uso: crear_receta <token_paciente> <paciente_id> <token_medico> [medicamento]
# Devuelve el UUID de la receta (vacio si fallo).
crear_receta() {
  local t_pac="$1" pac_id="$2" t_med="$3" med="${4:-Ibuprofeno 400mg}"
  local med_id slot cita cita_id receta
  med_id=$(curl -s "$BASE/api/auth/yo" -H "Authorization: Bearer $t_med" | campo id)
  [ -n "$med_id" ] || { echo ""; return 1; }
  slot=$(curl -s "$BASE/api/scheduling/slots?medico=$med_id" \
           -H "Authorization: Bearer $t_pac" | campo id)
  [ -n "$slot" ] || { echo ""; return 1; }
  cita=$(curl -s -X POST "$BASE/api/scheduling/citas" \
           -H "Authorization: Bearer $t_pac" -H 'Content-Type: application/json' \
           -d "{\"slotId\":\"$slot\"}")
  cita_id=$(echo "$cita" | campo id)
  [ -n "$cita_id" ] || { echo ""; return 1; }
  curl -s -X POST "$BASE/api/scheduling/citas/$cita_id/iniciar" \
    -H "Authorization: Bearer $t_med" >/dev/null
  receta=$(curl -s -X POST "$BASE/api/records/recetas" \
             -H "Authorization: Bearer $t_med" -H 'Content-Type: application/json' \
             -d "{\"pacienteId\":\"$pac_id\",\"medicamento\":\"$med\",\"dosis\":\"1 cada 8hs\"}")
  echo "$receta" | grep -o '"receta":{"id":"[^"]*"' | grep -o '[0-9a-f-]\{36\}'
}

# Imprime el resumen final y devuelve 1 si algun criterio fallo.
resumen() {
  echo
  if [ "$FALLOS" -eq 0 ]; then
    echo "=============================================================="
    echo " RESULTADO: todos los criterios OK"
    echo "=============================================================="
    return 0
  fi
  echo "=============================================================="
  echo " RESULTADO: $FALLOS criterio(s) FALLARON"
  echo "=============================================================="
  return 1
}
