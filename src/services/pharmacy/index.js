'use strict';
/**
 * COMPONENTE: pharmacy-service        <<< PRODUCTOR DE EVENTOS (BASE) >>>
 * 
 * Interfaz EXPUESTA : IFarmacia (solicitar retiro, ver mis retiros)
 *                     IRetiros (interna, la consume queue-service)
 * Interfaces CONSUMIDAS: IRecetas de records-service, Redis Streams
 *
 * HU2: el paciente solicita el retiro desde el celular y hace la cola VIRTUAL.
 *
 * Decision arquitectonica clave (ACID + BASE conviviendo):
 *   1) El retiro se graba en PostgreSQL dentro de una TRANSACCION (es un hecho
 *      del negocio: no se puede perder ni duplicar).
 *   2) Recien despues se publica un EVENTO en un stream de Redis.
 *   3) queue-service consume ese evento y arma la cola.
 * Entre (2) y (3) pasan milisegundos en los que la cola todavia no muestra el
 * ticket: eso es CONSISTENCIA EVENTUAL. Se acepta porque una cola de farmacia
 * tolera perfectamente 200ms de desfasaje, y a cambio ganamos que farmacia y
 * cola no se caigan juntas (desacople temporal).
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { query, withTransaction, waitForDb } = require('../../shared/db');
const { requireAuth, requireInternal } = require('../../shared/auth');
const { callInternal } = require('../../shared/httpClient');
const { getRedis, KEYS } = require('../../shared/redisClient');
const config = require('../../shared/config');

const NOMBRE = 'pharmacy-service';
const app = createApp(NOMBRE);

/**
 * POST /api/pharmacy/retiros   body: { recetaId }
 * Devuelve el ticket INMEDIATAMENTE (el paciente ya puede irse a tomar un cafe).
 */
app.post('/api/pharmacy/retiros', requireAuth(['paciente']), async (req, res, next) => {
  const { recetaId } = req.body || {};
  if (!recetaId) return res.status(400).json({ error: 'Falta recetaId' });

  try {
    // 1) Validamos contra records-service (interfaz consumida).
    // Este callInternal es GET => el Circuit Breaker de httpClient aplica retry
    // con backoff. Si records se cuelga, tras CB_FAILURE_THRESHOLD fallos el
    // circuito se abre y las siguientes respuestas son INMEDIATAS (fail fast).
    const r = await callInternal(
      `${config.urls.records}/api/records/internal/recetas/${recetaId}`,
      { correlationId: req.correlationId });
    if (!r.ok) {
      // PATRON CIRCUIT BREAKER: si el rechazo viene de un circuito abierto, le
      // contamos al cliente cuanto esperar (Retry-After en segundos) para que
      // no siga martillando una dependencia que ya sabemos caida.
      if (r.datos && r.datos.circuit === 'OPEN') {
        const segundos = Math.max(1, Math.ceil((r.datos.retryAfterMs || 1000) / 1000));
        res.setHeader('Retry-After', String(segundos));
        return res.status(503).json({
          error: 'Farmacia temporalmente saturada: la validacion de recetas no responde',
          detalle: 'circuito abierto hacia records-service',
          circuit: 'OPEN',
          retryAfterSeg: segundos
        });
      }
      return res.status(r.status).json({ error: 'No se pudo validar la receta', detalle: r.datos });
    }

    const receta = r.datos.receta;
    // Autorizacion: nadie retira la receta de otro.
    if (receta.paciente_id !== req.usuario.id) {
      return res.status(403).json({ error: 'La receta no pertenece al paciente autenticado' });
    }
    if (receta.estado === 'RETIRADA') {
      return res.status(409).json({ error: 'La receta ya fue retirada' });
    }

    // 2) Persistencia ACID del retiro.
    const retiro = await withTransaction(async (client) => {
      // La secuencia da numeros unicos aun con multiples replicas concurrentes.
      const nro = (await client.query("SELECT nextval('pharmacy.ticket_seq') AS n")).rows[0].n;
      const ticket = `F-${String(nro).padStart(3, '0')}`;
      const ins = await client.query(
        `INSERT INTO pharmacy.retiros (receta_id, paciente_id, ticket_code)
         VALUES ($1,$2,$3) RETURNING *`,
        [recetaId, req.usuario.id, ticket]);
      return ins.rows[0];
    });

    // 3) Publicacion del evento (fuera de la transaccion, "fire and forget").
    // Si Redis estuviera caido, el retiro YA quedo grabado en PostgreSQL: la
    // cola se puede reconstruir despues. Degradacion controlada.
    //
    // PATRON QUEUE-BASED LOAD LEVELING: el productor NO procesa: encola y
    // responde. Ademas recortamos el stream con MAXLEN ~ STREAM_MAXLEN para
    // acotar la memoria de Redis (el stream es bitacora de trabajo, no archivo).
    try {
      const redis = await getRedis();
      await redis.xAdd(KEYS.streamRetiros, '*', {
        retiroId: retiro.id,
        pacienteId: retiro.paciente_id,
        ticketCode: retiro.ticket_code,
        medicamento: receta.medicamento,
        tipo: 'VIRTUAL'
      }, {
        TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: config.streamMaxlen }
      });
    } catch (err) {
      console.error(`[${NOMBRE}] no se pudo publicar el evento:`, err.message);
    }

    // Marcamos la receta como en proceso (no bloqueante).
    callInternal(`${config.urls.records}/api/records/internal/recetas/${recetaId}/estado`,
      { method: 'POST', body: { estado: 'EN_RETIRO' }, correlationId: req.correlationId });

    res.status(201).json({
      mensaje: 'Retiro solicitado. Ya estas en la cola virtual, no hace falta esperar en la sala.',
      ticket: retiro.ticket_code,
      retiroId: retiro.id,
      nota: 'La cola puede tardar unos milisegundos en reflejarlo (consistencia eventual).'
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un retiro para esa receta' });
    next(err);
  }
});

app.get('/api/pharmacy/retiros/mios', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, ticket_code, estado, creada_en FROM pharmacy.retiros
       WHERE paciente_id=$1 ORDER BY creada_en DESC`, [req.usuario.id]);
    res.json({ retiros: rows });
  } catch (err) { next(err); }
});

/** HU7: el farmaceutico ve los retiros pendientes segun el registro maestro. */
app.get('/api/pharmacy/retiros/pendientes', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, ticket_code, paciente_id, creada_en FROM pharmacy.retiros
       WHERE estado='EN_COLA' ORDER BY creada_en`);
    res.json({ cantidad: rows.length, retiros: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// INTERFAZ INTERNA: la invoca queue-service cuando el farmaceutico entrega.
// ---------------------------------------------------------------------------
app.post('/api/pharmacy/internal/retiros/:id/atendido', requireInternal, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE pharmacy.retiros SET estado='ATENDIDO'
       WHERE id=$1 AND estado='EN_COLA' RETURNING id, receta_id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Retiro inexistente o ya atendido' });

    // Cierre del ciclo: la receta queda RETIRADA (no se puede usar dos veces).
    await callInternal(
      `${config.urls.records}/api/records/internal/recetas/${rows[0].receta_id}/estado`,
      { method: 'POST', body: { estado: 'RETIRADA' } });

    res.json({ retiro: rows[0], estado: 'ATENDIDO' });
  } catch (err) { next(err); }
});

app.use(errorHandler(NOMBRE));

(async () => { await waitForDb(); listen(app, NOMBRE); })();