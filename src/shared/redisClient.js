'use strict';
/**
 * REDIS  el lado BASE de la solucion
 * 
 * La COLA HIBRIDA y las NOTIFICACIONES usan Redis:
 *   Basically Available   -> la cola sigue respondiendo aunque PostgreSQL este lento
 *   Soft state            -> el estado de la cola es efimero (vive el dia)
 *   Eventually consistent -> el retiro se graba en PostgreSQL y viaja por un
 *                            stream de eventos; durante unos milisegundos la
 *                            cola todavia no lo muestra (script 05).
 *
 * Ademas es lo que hace posible que queue-service sea SIN ESTADO: el estado de
 * la cola no vive en la memoria del proceso, vive afuera. Por eso 3 replicas
 * ven exactamente la misma cola.
 */
const { createClient } = require('redis');
const config = require('./config');

async function makeRedis(etiqueta = 'main') {
  const client = createClient({ url: config.redisUrl });
  client.on('error', (err) =>
    console.error(`[${config.serviceName}][redis:${etiqueta}] ${err.message}`));
  await client.connect();
  return client;
}

let clientePrincipal = null;
async function getRedis() {
  if (!clientePrincipal) clientePrincipal = await makeRedis('main');
  return clientePrincipal;
}

// Claves y canales centralizados (para no repetir strings sueltos por ahi).
const KEYS = {
  colaFarmacia: 'cola:farmacia',                 // lista FIFO de tickets esperando
  ticket: (code) => `cola:ticket:${code}`,       // hash con los datos del ticket
  atendiendo: 'cola:farmacia:atendiendo',        // ticket en el mostrador
  notificaciones: (pid) => `notif:${pid}`,       // bandeja del paciente
  streamRetiros: 'eventos:retiros',              // stream que emite pharmacy
  grupoCola: 'grupo-cola',                       // consumer group: cada evento lo
                                                 // procesa UNA sola replica
  canalNotificaciones: 'canal:notificaciones',   // pub/sub hacia notifications

  // --- CACHE-ASIDE (patron de performance) ---
  // Copias de lecturas caras en Redis. El prefijo "cache:sch:" permite borrar
  // todo el cache de scheduling de golpe (redis-cli --scan --pattern).
  cacheEspecialidades: 'cache:sch:especialidades',
  cacheMedicos: (especialidad) => `cache:sch:medicos:${especialidad || 'all'}`,
  cacheSlots: (medico, fecha) => `cache:sch:slots:${medico}:${fecha || 'all'}`
};

module.exports = { makeRedis, getRedis, KEYS };