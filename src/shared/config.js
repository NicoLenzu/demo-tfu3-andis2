'use strict';
/**
 * CONFIGURACION (patron 12-factor: todo viene del entorno)
 * 
 * Un SERVICIO SIN ESTADO no guarda configuracion ni sesiones en memoria. Toda
 * la config entra por variables de entorno, asi cualquier replica arranca
 * identica a las demas y es intercambiable. Eso es lo que permite hacer
 * `docker compose up --scale queue=3` sin tocar una linea de codigo.
 */
const config = {
  // Nombre logico del componente (aparece en logs y en el header X-Served-By).
  serviceName: process.env.SERVICE_NAME || 'servicio-desconocido',
  port: parseInt(process.env.PORT || '3000', 10),

  // En Docker, HOSTNAME es el id corto del contenedor. Lo usamos como prueba
  // visible de que el balanceador reparte entre replicas distintas.
  instanceId: process.env.HOSTNAME || 'local',

  pg: {
    host: process.env.PGHOST || 'postgres',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'clinicare',
    password: process.env.PGPASSWORD || 'clinicare',
    database: process.env.PGDATABASE || 'clinicare',
    // Pool chico por replica: N replicas x M conexiones no deben agotar el
    // max_connections de PostgreSQL cuando escalamos.
    max: parseInt(process.env.PG_POOL_MAX || '8', 10)
  },

  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',

  // Secreto de firma del JWT. Compartido por todos los componentes: por eso
  // cualquiera valida un token emitido por auth-service, sin consultar a nadie.
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '4h',

  // Token para INTERFACES INTERNAS (componente -> componente), que no se
  // exponen a traves del gateway.
  internalToken: process.env.INTERNAL_TOKEN || 'internal-dev-token',

  // Interfaces CONSUMIDAS. Se resuelven por DNS interno de Docker usando el
  // nombre del servicio del compose.
  urls: {
    auth:       process.env.AUTH_URL       || 'http://auth:3000',
    scheduling: process.env.SCHEDULING_URL || 'http://scheduling:3000',
    records:    process.env.RECORDS_URL    || 'http://records:3000',
    pharmacy:   process.env.PHARMACY_URL   || 'http://pharmacy:3000',
    queue:      process.env.QUEUE_URL      || 'http://queue:3000',
    notifications: process.env.NOTIFICATIONS_URL || 'http://notifications:3000'
  },

  // A cuantas posiciones del frente se le avisa al paciente que se acerque.
  avisoPosicion: parseInt(process.env.AVISO_POSICION || '2', 10),

  // ---------------------------------------------------------------------------
  // PATRON: CIRCUIT BREAKER (+ Retry)  -> atributo de calidad: DISPONIBILIDAD
  //
  // Evita el efecto cascada: si una dependencia (por ejemplo records-service)
  // se cuelga, cada llamada esperaria el timeout completo y agotaria las
  // conexiones del llamador. El breaker corta de inmediato tras N fallos
  // consecutivos. El estado vive en memoria del proceso (una replica no le
  // cuenta a otra): es aceptable porque es una optimizacion, no un dato.
  // ---------------------------------------------------------------------------
  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
    openMs: parseInt(process.env.CB_OPEN_MS || '10000', 10),
    // Los reintentos SOLO aplican a metodos idempotentes (GET). Reintentar un
    // POST podria duplicar una operacion (doble retiro, doble cita).
    retries: parseInt(process.env.CB_RETRIES || '2', 10),
    retryBaseMs: parseInt(process.env.CB_RETRY_BASE_MS || '100', 10)
  },

  // ---------------------------------------------------------------------------
  // PATRON: CACHE-ASIDE  -> atributo de calidad: PERFORMANCE
  //
  // Redis guarda copias de lecturas caras (catalogos, cupos). El cache NUNCA
  // puede tumbar el endpoint: ante cualquier error de Redis se degrada a
  // PostgreSQL (X-Cache: BYPASS). timeoutMs corta el get/set si Redis esta
  // colgado en vez de esperar el timeout TCP completo.
  // ---------------------------------------------------------------------------
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    ttlCatalogo: parseInt(process.env.CACHE_TTL_CATALOGO || '300', 10),
    ttlSlots: parseInt(process.env.CACHE_TTL_SLOTS || '30', 10),
    timeoutMs: parseInt(process.env.CACHE_TIMEOUT_MS || '200', 10)
  }
};

module.exports = config;