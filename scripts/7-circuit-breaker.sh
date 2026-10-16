#!/usr/bin/env bash
# PATRON 1 - CIRCUIT BREAKER (+ Retry)  ->  atributo de calidad: DISPONIBILIDAD
#
# Que demuestra:
#   - Cuando una dependencia (records-service) se CUELGA, el breaker cuenta los
#     fallos y, al llegar al umbral, responde 503 AL INSTANTE (fail fast).
#   - Las primeras requests pagan el timeout; las siguientes son inmediatas.
#   - La falla queda AISLADA: el resto del sistema (la cola) sigue respondiendo.
#   - Al recuperarse la dependencia, el breaker cierra solo (HALF_OPEN -> CLOSED).
set -u
source "$(dirname "$0")/lib.sh"

ANA_ID="11111111-1111-1111-1111-111111111111"
RECETA_SEMILLA="bbbbbbbb-0000-0000-0000-000000000001"

titulo "PATRON 1 - CIRCUIT BREAKER (+ Retry) [disponibilidad]"

paso "1) Login de Ana + una receta valida (flujo real de negocio)"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
[ -n "$ANA" ] || { echo "FALLO: no se pudo loguear a Ana"; exit 1; }
RECETA=$(crear_receta "$ANA" "$ANA_ID" "$LUCIA" "Amoxicilina 500mg")
if [ -z "$RECETA" ]; then
  echo "  (no se pudo crear una receta nueva; uso la semilla $RECETA_SEMILLA)"
  RECETA="$RECETA_SEMILLA"
fi
echo "  Receta a usar: $RECETA"

UMBRAL=${CB_FAILURE_THRESHOLD:-5}     # fallos consecutivos para abrir el circuito
OPEN_MS=${CB_OPEN_MS:-5000}           # ventana en que el circuito queda abierto

paso "2) Pauso records-service (se CUELGA, no rechaza la conexion)"
docker compose pause records >/dev/null 2>&1
echo "  records pausado: las llamadas van a quedar colgadas hasta el timeout."

paso "3) Disparo 12 x POST /api/pharmacy/retiros midiendo latencia"
slow_ok=0; fast_ok=0; open_ok=0; retry_ok=0
for i in $(seq 1 12); do
  OUT=$(curl -s -D "/tmp/cb_h_$i.txt" -o "/tmp/cb_b_$i.json" \
        -w '%{time_total} %{http_code}' \
        -X POST "$BASE/api/pharmacy/retiros" \
        -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
        -d "{\"recetaId\":\"$RECETA\"}")
  T=$(echo "$OUT" | awk '{print $1}')
  C=$(echo "$OUT" | awk '{print $2}')
  OPEN=$(grep -c '"circuit":"OPEN"' "/tmp/cb_b_$i.json" 2>/dev/null || true); [ -n "$OPEN" ] || OPEN=0
  RA=$(grep -ic 'retry-after' "/tmp/cb_h_$i.txt" 2>/dev/null || true); [ -n "$RA" ] || RA=0
  echo "  req $i: HTTP $C  t=${T}s  circuit=OPEN? $OPEN  Retry-After? $RA"

  if [ "$i" -le "$UMBRAL" ]; then
    mayor_igual "$T" 2.5 && slow_ok=$((slow_ok + 1))
  else
    menor "$T" 0.2 && fast_ok=$((fast_ok + 1))
    [ "$OPEN" -ge 1 ] && open_ok=$((open_ok + 1))
    [ "$RA" -ge 1 ] && retry_ok=$((retry_ok + 1))
  fi
done

paso "4) Criterios del circuit breaker"
criterio "las primeras $UMBRAL requests pagan el timeout (>= 2.5s)" "$UMBRAL" "$slow_ok"
criterio "las $((12 - UMBRAL)) siguientes responden al instante (< 0.2s)" "$((12 - UMBRAL))" "$fast_ok"
criterio "las respuestas en circuito abierto traen circuit=OPEN" "$((12 - UMBRAL))" "$open_ok"
criterio "las respuestas en circuito abierto traen header Retry-After" "$((12 - UMBRAL))" "$retry_ok"

paso "5) Aislamiento de falla: el resto del sistema sigue vivo"
QCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA")
criterio "GET /api/queue/farmacia con records caido" "200" "$QCODE"

paso "6) Despauso records y espero la ventana del circuito (${OPEN_MS}ms + 1s)"
docker compose unpause records >/dev/null 2>&1
sleep $((OPEN_MS / 1000 + 1))
sleep 2   # margen para que records vuelva a aceptar conexiones
OUT=$(curl -s -o /tmp/cb_final.json -w '%{http_code}' -X POST "$BASE/api/pharmacy/retiros" \
      -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
      -d "{\"recetaId\":\"$RECETA\"}")
echo "  respuesta post-recuperacion: HTTP $OUT"
criterio "HALF_OPEN -> CLOSED: la request vuelve a funcionar" "201" "$OUT"

paso "7) Estado de los circuitos expuesto en pharmacy /healthz"
docker compose exec -T pharmacy node -e "require('http').get('http://localhost:3000/healthz',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b));}).on('error',e=>console.log('ERR',e.message))"

resumen
exit $?
