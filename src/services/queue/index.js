'use strict';
/**
 * COMPONENTE: queue-service
 *   <<< ESCALABILIDAD HORIZONTAL + SERVICIO SIN ESTADO + BASE >>>
 * 
 * Interfaz EXPUESTA : ICola (estado de la cola, mi turno, check-in presencial,
 *                     llamar al siguiente)
 * Interfaces CONSUMIDAS: Redis (estado), IRetiros de pharmacy-service
 *
 * ESTE ES EL COMPONENTE QUE ESCALAMOS A 3 REPLICAS. Puede hacerse porque:
 *  1) NO guarda NADA en memoria: la cola entera vive en Redis. Cualquier
 *     replica responde igual, no hace falta sticky session.
 *  2) Los eventos se consumen con un CONSUMER GROUP de Redis Streams: aunque
 *     haya 3 replicas leyendo el mismo stream, cada evento lo procesa UNA sola.
 *     Sin esto, el mismo ticket entraria 3 veces a la cola.
 *  3) Las operaciones sobre la lista (rPush / lPop) son ATOMICAS en Redis, asi
 *     que dos farmaceuticos simultaneos nunca llaman al mismo paciente.
 *
 * COLA HIBRIDA: entran tickets VIRTUALES (paciente desde el celular, via evento)
 * y PRESENCIALES (walk-in en el mostrador) a la MISMA lista FIFO.
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { requireAuth } = require('../../shared/auth');
const { getRedis, makeRedis, KEYS } = require('../../shared/redisClient');
const { callInternal } = require('../../shared/httpClient');
const config = require('../../shared/config');

const NOMBRE = 'queue-service';
const app = createApp(NOMBRE);

// ---------------------------------------------------------------------------
// Utilidades sobre el estado compartido (Redis)
// ---------------------------------------------------------------------------

/** Lee la cola completa con las posiciones calculadas. */
async function leerCola(redis) {
  const codigos = await redis.lRange(KEYS.colaFarmacia, 0, -1);
  const tickets = [];
  for (let i = 0; i < codigos.length; i++) {
    const datos = await redis.hGetAll(KEYS.ticket(codigos[i]));
    tickets.push({ posicion: i + 1, ticket: codigos[i], ...datos });
  }
  return tickets;
}

/**
 * Publica una notificacion en el canal pub/sub.
 * queue-service NO sabe como se entrega la notificacion (push, SMS, mail): solo
 * publica el hecho. notifications-service se encarga. Bajo acoplamiento.
 */
async function notificar(redis, pacienteId, titulo, mensaje) {
  await redis.publish(KEYS.canalNotificaciones, JSON.stringify({
    pacienteId, titulo, mensaje, ts: new Date().toISOString()
  }));
}

/** HU3: avisa a los que ya estan cerca del frente que se acerquen. */
async function avisarProximos(redis) {
  const cola = await leerCola(redis);
  for (const t of cola) {
    if (t.posicion > config.avisoPosicion) break;   // la lista ya esta ordenada
    // Marca "avisado" para no spamear al mismo paciente en cada llamada.
    const yaAvisado = await redis.hGet(KEYS.ticket(t.ticket), 'avisado');
    if (yaAvisado === '1') continue;
    await redis.hSet(KEYS.ticket(t.ticket), 'avisado', '1');
    await notificar(redis, t.pacienteId, 'Tu turno esta por llegar',
      `Ticket ${t.ticket}: quedan ${t.posicion - 1} personas delante. Acercate al mostrador de farmacia.`);
  }
}

// ---------------------------------------------------------------------------
// INTERFAZ EXPUESTA: ICola
// ---------------------------------------------------------------------------

/** GET /api/queue/farmacia -> estado publico de la cola (HU7). */
app.get('/api/queue/farmacia', requireAuth(), async (req, res, next) => {
  try {
    const redis = await getRedis();
    const atendiendoRaw = await redis.get(KEYS.atendiendo);
    const cola = await leerCola(redis);
    res.json({
      atendiendo: atendiendoRaw ? JSON.parse(atendiendoRaw) : null,
      esperando: cola.length,
      cola,
      // Header X-Served-By dice que replica respondio; esto lo repite en el body
      // para que se vea comodo en los scripts.
      atendidoPorInstancia: config.instanceId
    });
  } catch (err) { next(err); }
});

/** GET /api/queue/mi-turno -> el paciente consulta su posicion desde el celular. */
app.get('/api/queue/mi-turno', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const redis = await getRedis();
    const cola = await leerCola(redis);
    const mio = cola.find((t) => t.pacienteId === req.usuario.id);
    if (!mio) return res.status(404).json({ error: 'No tenes un ticket activo en la cola' });
    res.json({
      ticket: mio.ticket,
      posicion: mio.posicion,
      personasDelante: mio.posicion - 1,
      // Estimacion simple: 4 minutos por atencion.
      esperaEstimadaMin: (mio.posicion - 1) * 4,
      atendidoPorInstancia: config.instanceId
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/queue/farmacia/presencial  body: { pacienteId?, nota? }
 * La pata PRESENCIAL de la cola hibrida: alguien llega al mostrador sin app y
 * el farmaceutico lo agrega. Entra en la MISMA lista FIFO que los virtuales.
 */
app.post('/api/queue/farmacia/presencial', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const redis = await getRedis();
    // INCR es atomico: dos farmaceuticos simultaneos nunca generan el mismo nro.
    const nro = await redis.incr('cola:contador:presencial');
    const ticket = `P-${String(nro).padStart(3, '0')}`;

    await redis.hSet(KEYS.ticket(ticket), {
      ticket,
      pacienteId: req.body?.pacienteId || 'mostrador',
      medicamento: req.body?.nota || 'Consulta en mostrador',
      tipo: 'PRESENCIAL',
      creado: new Date().toISOString()
    });
    await redis.rPush(KEYS.colaFarmacia, ticket);
    await avisarProximos(redis);

    const largo = await redis.lLen(KEYS.colaFarmacia);
    res.status(201).json({ mensaje: 'Ticket presencial agregado', ticket, posicion: largo });
  } catch (err) { next(err); }
});

/**
 * POST /api/queue/farmacia/siguiente  (HU7)
 * El farmaceutico termino y llama al proximo.
 * lPop es ATOMICO: si dos mostradores llaman a la vez, cada uno saca un ticket
 * distinto. Es la garantia de exclusion mutua sin bloqueos aplicativos.
 */
app.post('/api/queue/farmacia/siguiente', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const redis = await getRedis();

    // Cerramos el que estaba siendo atendido.
    const anteriorRaw = await redis.get(KEYS.atendiendo);
    if (anteriorRaw) {
      const anterior = JSON.parse(anteriorRaw);
      if (anterior.retiroId) {
        // Interfaz consumida: pharmacy actualiza su registro maestro (ACID).
        await callInternal(
          `${config.urls.pharmacy}/api/pharmacy/internal/retiros/${anterior.retiroId}/atendido`,
          { method: 'POST', correlationId: req.correlationId });
      }
      await redis.del(KEYS.ticket(anterior.ticket));
    }

    const codigo = await redis.lPop(KEYS.colaFarmacia);
    if (!codigo) {
      await redis.del(KEYS.atendiendo);
      return res.json({ mensaje: 'No hay nadie esperando', atendiendo: null });
    }

    const datos = await redis.hGetAll(KEYS.ticket(codigo));
    const actual = { ticket: codigo, ...datos, desde: new Date().toISOString() };
    await redis.set(KEYS.atendiendo, JSON.stringify(actual));

    // Aviso "es tu turno" + aviso a los que quedaron cerca del frente.
    if (datos.pacienteId && datos.pacienteId !== 'mostrador') {
      await notificar(redis, datos.pacienteId, 'Es tu turno',
        `Ticket ${codigo}: pasa al mostrador de farmacia.`);
    }
    await avisarProximos(redis);

    res.json({ mensaje: 'Turno llamado', atendiendo: actual, atendidoPorInstancia: config.instanceId });
  } catch (err) { next(err); }
});

/**
 * Endpoint de apoyo para los scripts de carga (mide latencia bajo estres).
 * Se AMPLIA (sin romper el JSON existente) con el estado del stream de eventos:
 *   pendientesEnStream -> mensajes entregados pero todavia no reconocidos (ACK)
 *   totalEnStream      -> largo del stream (XLEN)
 * Es la evidencia de QUEUE-BASED LOAD LEVELING: la cola "absorbe" la rafaga y
 * la drena al ritmo del consumidor.
 */
app.get('/api/queue/farmacia/resumen', async (req, res, next) => {
  try {
    const redis = await getRedis();
    const largo = await redis.lLen(KEYS.colaFarmacia);

    let pendientesEnStream = 0;
    let totalEnStream = 0;
    try {
      totalEnStream = await redis.xLen(KEYS.streamRetiros);
      // XPENDING (forma resumen) -> cuantos mensajes quedaron sin ACK.
      pendientesEnStream = contarPendientes(await redis.xPending(KEYS.streamRetiros, KEYS.grupoCola));
    } catch (err) {
      // NOGROUP al arrancar (todavia no hay consumidor) o Redis caido: no rompemos.
      pendientesEnStream = 0;
    }

    res.json({
      esperando: largo,
      instancia: config.instanceId,
      pendientesEnStream,
      totalEnStream
    });
  } catch (err) { next(err); }
});

/** Normaliza las distintas formas en que puede volver XPENDING (RESP2/RESP3). */
function contarPendientes(p) {
  if (p == null) return 0;
  if (typeof p === 'number') return p;
  if (typeof p.total === 'number') return p.total;
  if (Array.isArray(p)) return Number(p[0]) || 0;
  return 0;
}


// ---------------------------------------------------------------------------
// PATRON QUEUE-BASED LOAD LEVELING + COMPETING CONSUMERS
//
// QUÉ RESUELVE: pharmacy recibe una rafaga de retiros y NO los procesa en la
// request. Los publica en un stream (Redis) y responde 201 enseguida. La cola
// hace de amortiguador (load leveling): absorbe el pico y el trabajo se hace a
// un ritmo controlado, independiente de la rafaga de entrada.
//
// COMPETING CONSUMERS: N replicas de queue-service leen el MISMO consumer group.
// Redis entrega cada mensaje a UN solo consumidor -> el trabajo se reparte y no
// se duplica. Si una replica muere a mitad de un mensaje, XAUTOCLAIM reasigna
// los pendientes a otra replica (no se pierden eventos).
// ---------------------------------------------------------------------------

/** Duerme los ms indicados (para simular un consumidor lento en la demo). */
function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Procesa UN evento del stream y lo reconoce (ACK).
 * Idempotente: si el ticket ya existe en la cola, no lo duplica (eso es lo que
 * permite reintentar/reclamar sin miedo).
 */
async function procesarEvento(principal, redis, msgId, ev) {
  const existe = await principal.exists(KEYS.ticket(ev.ticketCode));
  if (!existe) {
    await principal.hSet(KEYS.ticket(ev.ticketCode), {
      ticket: ev.ticketCode,
      retiroId: ev.retiroId,
      pacienteId: ev.pacienteId,
      medicamento: ev.medicamento || '',
      tipo: ev.tipo || 'VIRTUAL',
      creado: new Date().toISOString()
    });
    await principal.rPush(KEYS.colaFarmacia, ev.ticketCode);
    console.log(`[${NOMBRE}@${config.instanceId}] ticket ${ev.ticketCode} agregado a la cola`);
    await avisarProximos(principal);
  }
  // ACK: le decimos a Redis que este mensaje ya fue procesado, asi
  // ninguna otra replica lo vuelve a tomar.
  await redis.xAck(KEYS.streamRetiros, KEYS.grupoCola, msgId);

  // QBLL / Competing Consumers: consumidor deliberadamente lento. Sirve para
  // que se VEA que la latencia del POST no depende de este ritmo de drenaje.
  if (config.consumerDelayMs > 0) await dormir(config.consumerDelayMs);
}

/**
 * Recupera mensajes PENDIENTES (entregados y nunca reconocidos) de mas de 15s.
 * Cubre el caso "se cayo una replica con un mensaje en la mano".
 */
async function reclamarPendientes(principal, redis, consumidor) {
  try {
    const res = await redis.xAutoClaim(
      KEYS.streamRetiros, KEYS.grupoCola, consumidor, 15000, '0-0', { COUNT: 50 }
    );
    const mensajes = (res && res.messages) || [];
    for (const m of mensajes) {
      if (m && m.message) await procesarEvento(principal, redis, m.id, m.message);
    }
    if (mensajes.length) console.log(`[${NOMBRE}@${config.instanceId}] reclamados ${mensajes.length} eventos pendientes`);
  } catch (err) {
    // NOGROUP (grupo aun no creado) u otro error transitorio: no rompemos.
    if (!String(err.message).includes('NOGROUP')) {
      console.error(`[${NOMBRE}] XAUTOCLAIM fallo: ${err.message}`);
    }
  }
}

// CONSUMIDOR DE EVENTOS: convierte retiros en tickets de la cola
async function arrancarConsumidor() {
  // Cliente dedicado: la lectura es BLOQUEANTE, no puede compartir conexion.
  const redis = await makeRedis('consumidor');

  // Creamos el grupo de consumidores (idempotente).
  try {
    await redis.xGroupCreate(KEYS.streamRetiros, KEYS.grupoCola, '0', { MKSTREAM: true });
    console.log(`[${NOMBRE}] consumer group creado`);
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err; // ya existia: OK
  }

  const principal = await getRedis();
  const consumidor = `consumidor-${config.instanceId}`;
  console.log(`[${NOMBRE}] escuchando ${KEYS.streamRetiros} como ${consumidor}` +
              (config.consumerDelayMs > 0 ? ` (delay ${config.consumerDelayMs}ms/mensaje)` : ''));

  // Red de seguridad: cada 30s reclamamos los pendientes que dejaron otras
  // replicas caidas. Junto con el ACK, esto da "at-least-once" sin perder nada.
  const timer = setInterval(() => reclamarPendientes(principal, redis, consumidor).catch(() => {}), 30000);
  timer.unref();

  // Bucle infinito de consumo.
  for (;;) {
    try {
      const respuesta = await redis.xReadGroup(
        KEYS.grupoCola, consumidor,
        [{ key: KEYS.streamRetiros, id: '>' }],   // '>' = solo mensajes nuevos
        { COUNT: 10, BLOCK: 2000 }                // espera hasta 2s sin consumir CPU
      );
      if (!respuesta) continue;

      for (const stream of respuesta) {
        for (const msg of stream.messages) {
          await procesarEvento(principal, redis, msg.id, msg.message);
        }
      }
    } catch (err) {
      console.error(`[${NOMBRE}] error en el consumidor:`, err.message);
      await new Promise((r) => setTimeout(r, 1000));  // backoff simple
    }
  }
}

app.use(errorHandler(NOMBRE));

(async () => {
  // Ojo: queue-service NO espera a PostgreSQL. No lo usa. Por eso la cola sigue
  // operativa aunque la base relacional este degradada (Basically Available).
  listen(app, NOMBRE);
  arrancarConsumidor().catch((err) => console.error(`[${NOMBRE}] consumidor caido:`, err));
})();