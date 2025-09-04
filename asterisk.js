const ari = require('ari-client');
const WebSocket = require('ws');
const { config, logger } = require('./config');
const { sipMap, extMap, rtpSenders, rtpReceivers, cleanupPromises } = require('./state');
const { startRTPReceiver, getNextRtpPort, releaseRtpPort } = require('./rtp');
const { startOpenAIWebSocket } = require('./openai');

let ariClient;

// How long to wait for both legs to end before forcing cleanup
const CLEANUP_GRACE_MS = Number(process.env.CLEANUP_GRACE_MS || 1500);

// External-media events to ignore after cleanup started (avoid noisy late events)
const ignoreExtEvents = new Set();

/**
 * Return true for "UnicastRTP/..." ExternalMedia channels.
 */
function isExternalMediaChannel(name = '') {
  return /^UnicastRTP\//.test(name);
}

/**
 * Add an ExternalMedia channel to a bridge (throws on failure).
 */
async function addExtToBridge(client, channel, bridgeId) {
  try {
    const bridge = await client.bridges.get({ bridgeId });
    await bridge.addChannel({ channel: channel.id });
    logger.info(`ExternalMedia channel ${channel.id} added to bridge ${bridgeId}`);
  } catch (e) {
    logger.error(`Error adding ExternalMedia channel ${channel.id} to bridge ${bridgeId}: ${e.message}`);
    throw e;
  }
}

/**
 * Resolve owning SIP channelId for any ARI channel.
 * - For SIP channels: returns its own id
 * - For ExternalMedia channels: consult extMap and sipMap
 */
function resolveSipIdForChannel(channel) {
  if (!channel) return undefined;
  const { id, name = '' } = channel;
  if (!isExternalMediaChannel(name)) return id;

  const entry = extMap.get(id); // externalId › { bridgeId, channelId }
  if (entry && entry.channelId) return entry.channelId;

  for (const [sipId, data] of sipMap.entries()) {
    if (data && data.externalChannelId === id) return sipId;
  }
  return undefined;
}

/**
 * Mark that a channel leg ended and schedule cleanup.
 * - If both legs ended › cleanup immediately.
 * - Else debounce cleanup with a grace timer.
 * - If it's a late ExternalMedia event (post-cleanup) › ignore quietly.
 */
function markChannelEndedAndMaybeCleanup(channel, sourceEvent) {
  if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
    logger.info(`ExternalMedia ${channel.id} ${sourceEvent} after cleanup; ignoring`);
    return;
  }

  const sipId = resolveSipIdForChannel(channel);
  if (!sipId) {
    if (isExternalMediaChannel(channel.name || '')) {
      logger.debug(`ExternalMedia ${channel.id} ${sourceEvent} with no owner (likely post-cleanup); ignoring`);
      return;
    }
    logger.warn(`Cannot resolve SIP owner for channel ${channel.id} (${channel.name || 'noname'}) on ${sourceEvent}`);
    return;
  }

  const isExt = isExternalMediaChannel(channel.name || '');
  const data = sipMap.get(sipId) || {};

  if (isExt) data._extEnded = true;
  else data._sipEnded = true;

  sipMap.set(sipId, data);

  if (data._sipEnded && data._extEnded) {
    cleanupChannel(sipId, `${sourceEvent}:both-ended`).catch(e =>
      logger.error(`cleanupChannel error (both-ended) for ${sipId}: ${e.message}`)
    );
    return;
  }

  if (data._cleanupTimer) clearTimeout(data._cleanupTimer);
  data._cleanupTimer = setTimeout(() => {
    cleanupChannel(sipId, `${sourceEvent}:grace-timeout`).catch(e =>
      logger.error(`cleanupChannel error (grace-timeout) for ${sipId}: ${e.message}`)
    );
  }, CLEANUP_GRACE_MS);
  sipMap.set(sipId, data);
}

/**
 * Redirect the live SIP channel to a Queue in dialplan.
 * This gracefully tears down ExternalMedia/bridge/WS/RTP but keeps the SIP leg alive,
 * then uses ARI continueInDialplan to jump to the queue.
 *
 * Safe to call once per call; multiple calls are ignored via a 'redirecting' flag.
 */
async function redirectToQueue(sipChannelId, triggerText = '') {
  const qExt = String(config.REDIRECTION_QUEUE || process.env.REDIRECTION_QUEUE || '').trim();
  if (!qExt) {
    logger.error(`REDIRECTION_QUEUE not set; cannot redirect for ${sipChannelId}`);
    return;
  }
  const data = sipMap.get(sipChannelId);
  if (!data) {
    logger.warn(`redirectToQueue: channel ${sipChannelId} not in sipMap`);
    return;
  }
  if (data.redirecting) {
    logger.info(`redirectToQueue: already in progress for ${sipChannelId}`);
    return;
  }
  data.redirecting = true;
  sipMap.set(sipChannelId, data);

  logger.info(`Redirection requested for ${sipChannelId} to queue ${qExt} (trigger="${triggerText || 'n/a'}")`);

  // 1) Stop WS/audio sending, but DO NOT hangup SIP
  try {
    if (data.streamHandler && typeof data.streamHandler.end === 'function') {
      data.streamHandler.end();
      logger.info(`Stream handler ended for ${sipChannelId} (handoff)`);
    }
  } catch (e) {
    logger.warn(`Stream handler end failed (handoff) for ${sipChannelId}: ${e.message}`);
  }

  try {
    if (!data.wsClosed && data.ws && typeof data.ws.close === 'function') {
      data.ws.close();
      logger.info(`WebSocket close requested for ${sipChannelId} (handoff)`);
    }
  } catch (e) {
    logger.warn(`WS close failed (handoff) for ${sipChannelId}: ${e.message}`);
  }

  // 2) Tear down ExternalMedia & bridge so dialplan can take over cleanly
  try {
    if (data.externalChannelId && ariClient) {
      await ariClient.channels.hangup({ channelId: data.externalChannelId }).catch(() => {});
      logger.info(`External channel ${data.externalChannelId} hangup attempted (handoff)`);
      ignoreExtEvents.add(data.externalChannelId);
      setTimeout(() => ignoreExtEvents.delete(data.externalChannelId), 10000);
    }
  } catch (e) {
    logger.warn(`External channel hangup failed (handoff) for ${sipChannelId}: ${e.message}`);
  }

  try {
    if (data.bridge && data.bridge.id && ariClient) {
      await ariClient.bridges.destroy({ bridgeId: data.bridge.id }).catch(() => {});
      logger.info(`Bridge ${data.bridge.id} destroyed (handoff)`);
    }
  } catch (e) {
    logger.warn(`Bridge destroy failed (handoff) for ${sipChannelId}: ${e.message}`);
  }

  // 3) Close RTP sockets and release the port (media path no longer needed)
  try {
    const rx = rtpReceivers.get(sipChannelId);
    if (rx && rx.isOpen) { rx.isOpen = false; rx.close(); logger.info(`RTP receiver closed for ${sipChannelId} (handoff)`); }
    rtpReceivers.delete(sipChannelId);
  } catch (e) {
    logger.warn(`RTP receiver close failed (handoff) for ${sipChannelId}: ${e.message}`);
  }
  try {
    const tx = rtpSenders.get(sipChannelId);
    if (tx && tx.isOpen) { tx.isOpen = false; tx.close(); logger.info(`RTP sender closed for ${sipChannelId} (handoff)`); }
    rtpSenders.delete(sipChannelId);
  } catch (e) {
    logger.warn(`RTP sender close failed (handoff) for ${sipChannelId}: ${e.message}`);
  }
  try {
    if (typeof data.rtpPort === 'number') {
      releaseRtpPort(data.rtpPort);
      logger.info(`Released RTP port ${data.rtpPort} for ${sipChannelId} (handoff)`);
    }
  } catch (e) {
    logger.warn(`releaseRtpPort failed (handoff) for ${sipChannelId}: ${e.message}`);
  }

  // 4) Continue in dialplan to the Queue
  const tryContexts = [];
  if (config.REDIRECTION_QUEUE_CONTEXT) tryContexts.push(config.REDIRECTION_QUEUE_CONTEXT);
  // FreePBX queue contexts to try in order:
  tryContexts.push('ext-queues', 'from-internal');

  let continued = false;
  for (const ctx of tryContexts) {
    try {
      await ariClient.channels.continueInDialplan({
        channelId: sipChannelId,
        context: ctx,
        extension: qExt,
        priority: 1
      });
      logger.info(`Channel ${sipChannelId} continued to ${ctx},${qExt},1`);
      continued = true;
      break;
    } catch (e) {
      logger.warn(`continueInDialplan failed to ${ctx}/${qExt}: ${e.message}`);
    }
  }

  if (!continued) {
    logger.error(`Failed to continue ${sipChannelId} into any queue context (${tryContexts.join(', ')}). Hanging up as fallback.`);
    try { await ariClient.channels.hangup({ channelId: sipChannelId }); } catch (_) {}
  }
}

/**
 * Full, idempotent cleanup for a given SIP channelId.
 * Tears down WS, RTP, bridge, ExternalMedia; may hangup SIP as last resort
 * (unless handoff/redirecting happened).
 */
async function cleanupChannel(channelId, reason = 'manual') {
  if (cleanupPromises.has(channelId)) {
    await cleanupPromises.get(channelId);
    return;
  }

  const cleanupPromise = (async () => {
    const channelData = sipMap.get(channelId) || {};
    logger.info(`Cleanup started for channel ${channelId} (reason=${reason})`);

    if (channelData._cleaned) {
      logger.info(`Cleanup skipped (already done) for ${channelId}`);
      return;
    }
    channelData._cleaned = true;
    sipMap.set(channelId, channelData);

    if (channelData._cleanupTimer) {
      clearTimeout(channelData._cleanupTimer);
      delete channelData._cleanupTimer;
    }

    try {
      if (channelData.externalChannelId) {
        ignoreExtEvents.add(channelData.externalChannelId);
        setTimeout(() => ignoreExtEvents.delete(channelData.externalChannelId), 10000);
      }

      if (channelData.callTimeoutId) {
        clearTimeout(channelData.callTimeoutId);
        logger.info(`Call duration timeout cleared for channel ${channelId}`);
      }

      if (channelData.streamHandler && typeof channelData.streamHandler.end === 'function') {
        try { channelData.streamHandler.end(); logger.info(`Stream handler ended for ${channelId}`); }
        catch (e) { logger.warn(`Stream handler end failed for ${channelId}: ${e.message}`); }
      }

      if (!channelData.wsClosed && channelData.ws && typeof channelData.ws.close === 'function') {
        try { channelData.ws.close(); logger.info(`WebSocket close requested for ${channelId}`); }
        catch (e) { logger.warn(`WebSocket close failed for ${channelId}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 300));
      }

      if (channelData.externalChannelId && ariClient) {
        try { await ariClient.channels.hangup({ channelId: channelData.externalChannelId }).catch(() => {}); logger.info(`External channel ${channelData.externalChannelId} hangup attempted`); }
        catch (e) { logger.warn(`External channel hangup failed for ${channelId}: ${e.message}`); }
      }

      if (channelData.bridge && channelData.bridge.id && ariClient) {
        try { await ariClient.bridges.destroy({ bridgeId: channelData.bridge.id }).catch(() => {}); logger.info(`Bridge ${channelData.bridge.id} destroyed`); }
        catch (e) { logger.warn(`Bridge destroy failed for ${channelId}: ${e.message}`); }
      }

      // IMPORTANT: do not hangup SIP if we handed the call to the queue
      if (!channelData.redirecting && channelData.channel && ariClient) {
        try { await ariClient.channels.hangup({ channelId }); logger.info(`SIP channel ${channelId} hangup attempted`); }
        catch (e) { logger.warn(`SIP channel hangup failed for ${channelId}: ${e.message}`); }
      }

      try {
        const rx = rtpReceivers.get(channelId);
        if (rx && rx.isOpen) { rx.isOpen = false; rx.close(); logger.info(`RTP receiver socket closed for ${channelId}`); }
        rtpReceivers.delete(channelId);
      } catch (e) { logger.warn(`RTP receiver close failed for ${channelId}: ${e.message}`); }

      try {
        const tx = rtpSenders.get(channelId);
        if (tx && tx.isOpen) { tx.isOpen = false; tx.close(); logger.info(`RTP sender socket closed for ${channelId}`); }
        rtpSenders.delete(channelId);
      } catch (e) { logger.warn(`RTP sender close failed for ${channelId}: ${e.message}`); }

      try {
        if (typeof channelData.rtpPort === 'number') {
          releaseRtpPort(channelData.rtpPort);
          logger.info(`Released RTP port ${channelData.rtpPort} for ${channelId}`);
        }
      } catch (e) { logger.warn(`releaseRtpPort failed for ${channelId}: ${e.message}`); }

      try {
        if (channelData.externalChannelId) extMap.delete(channelData.externalChannelId);
        extMap.delete(channelId);
      } catch (_) {}

      sipMap.delete(channelId);
      logger.info(`Cleanup finished for ${channelId}`);
    } catch (e) {
      logger.error(`Cleanup error for ${channelId}: ${e.message}`);
    } finally {
      cleanupPromises.delete(channelId);
    }
  })();

  cleanupPromises.set(channelId, cleanupPromise);
  await cleanupPromise;
}

/**
 * Initialize ARI client, register event handlers and orchestrate call flow.
 * - On SIP StasisStart: create bridge, start RTP receiver, create ExternalMedia,
 *   wire maps, start OpenAI WS.
 * - On ExternalMedia StasisStart: add to bridge.
 * - On channel StasisEnd/ChannelDestroyed: mark ended and schedule cleanup.
 * - Provides a handoff-to-queue callback to the OpenAI socket layer.
 */
async function initializeAriClient() {
  try {
    ariClient = await ari.connect(config.ARI_URL, config.ARI_USER, config.ARI_PASS);
    logger.info(`Connected to ARI at ${config.ARI_URL}`);
    await ariClient.start(config.ARI_APP);
    logger.info(`ARI application "${config.ARI_APP}" started`);

    ariClient.on('StasisStart', async (evt, channel) => {
      logger.info(`StasisStart for channel ${channel.id}, name: ${channel.name}`);

      if (channel.name && channel.name.startsWith('Local/')) {
        logger.info(`Ignoring Local channel ${channel.id}, name: ${channel.name}`);
        return;
      }

      // ExternalMedia leg: add it to the bridge
      if (isExternalMediaChannel(channel.name || '')) {
        logger.info(`ExternalMedia channel started: ${channel.id}`);
        let mapping = extMap.get(channel.id);
        let attempts = 0;
        const maxAttempts = 10;
        while (!mapping && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 50));
          mapping = extMap.get(channel.id);
          attempts++;
        }
        if (mapping && mapping.bridgeId) {
          try {
            await addExtToBridge(ariClient, channel, mapping.bridgeId);
            logger.info(`Bridge ${mapping.bridgeId} ready for audio routing, external channel ${channel.id} active with codec ulaw`);
          } catch (e) {
            logger.error(`Failed to add ExternalMedia ${channel.id} to bridge ${mapping.bridgeId}: ${e.message}`);
          }
        } else {
          logger.error(`No mapping found for ExternalMedia channel ${channel.id} after ${maxAttempts} attempts`);
        }
        return;
      }

      // SIP leg: create bridge, start RTP, create ExternalMedia, start WS
      logger.info(`SIP channel started: ${channel.id}`);
      try {
        const bridgeId = `${channel.id}_bridge`;
        const bridge = await ariClient.bridges.create({ type: 'mixing,proxy_media', bridgeId });
        await bridge.addChannel({ channel: channel.id });
        await channel.answer();
        logger.info(`Channel ${channel.id} answered, bridge ${bridgeId} created for SIP audio`);

        const port = getNextRtpPort();
        await startRTPReceiver(channel.id, port);

        const callerId = (
          channel?.caller?.number ||
          channel?.caller?.name ||
          channel?.connected?.number ||
          channel?.connected?.name ||
          ''
        ).toString();

        sipMap.set(channel.id, {
          bridgeId,
          bridge,
          channel,
          channelId: channel.id,
          rtpPort: port,
          wsClosed: false,
          callerId
        });

        const extParams = {
          app: config.ARI_APP,
          external_host: `127.0.0.1:${port}`,
          format: 'ulaw',
          transport: 'udp',
          encapsulation: 'rtp',
          connection_type: 'client',
          direction: 'both'
        };
        const extChannel = await ariClient.channels.externalMedia(extParams);
        logger.info(`ExternalMedia channel ${extChannel.id} created with codec ulaw, RTP to 127.0.0.1:${port}`);

        extMap.set(extChannel.id, { bridgeId, channelId: channel.id });
        extMap.set(channel.id, { bridgeId, externalChannelId: extChannel.id });

        const sipData = sipMap.get(channel.id) || {};
        sipData.externalChannelId = extChannel.id;
        sipMap.set(channel.id, sipData);

        if (config.CALL_DURATION_LIMIT_SECONDS > 0) {
          const cd = sipMap.get(channel.id);
          cd.callTimeoutId = setTimeout(async () => {
            logger.info(`Call duration limit of ${config.CALL_DURATION_LIMIT_SECONDS} seconds reached for channel ${channel.id}, hanging up`);
            try { await ariClient.channels.hangup({ channelId: channel.id }); }
            catch (e) { logger.error(`Duration-limit hangup error for ${channel.id}: ${e.message}`); }
          }, config.CALL_DURATION_LIMIT_SECONDS * 1000);
          sipMap.set(channel.id, cd);
        }

        // Start OpenAI WS and pass callbacks so it can request a handoff or termination
        await startOpenAIWebSocket(channel.id, {
          onRedirectRequest: (chanId, phraseMatched) => {
            // Defensive: only accept requests for the active SIP id
            if (chanId !== channel.id) return;
            redirectToQueue(chanId, phraseMatched).catch(e =>
              logger.error(`redirectToQueue failed for ${chanId}: ${e.message}`)
            );
          },
          onTerminateRequest: async (chanId, phraseMatched) => {
            if (chanId !== channel.id) return;
            logger.info(`Assistant termination phrase matched ("${phraseMatched}") for ${chanId}; cleaning up call`);
            await cleanupChannel(chanId, `assistant-terminate:${phraseMatched}`);
          }
        });
      } catch (e) {
        logger.error(`Error in SIP channel ${channel.id}: ${e.message}`);
        await cleanupChannel(channel.id, 'stasisstart-error');
      }
    });

    // Legs leave Stasis › mark and maybe cleanup
    ariClient.on('StasisEnd', async (evt, channel) => {
      logger.info(`StasisEnd for channel ${channel.id}, name: ${channel.name}`);
      if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
        logger.info(`ExternalMedia ${channel.id} StasisEnd after cleanup; ignoring`);
        return;
      }
      markChannelEndedAndMaybeCleanup(channel, 'StasisEnd');
      if (isExternalMediaChannel(channel.name || '')) {
        extMap.delete(channel.id);
        logger.info(`ExternalMedia channel ${channel.id} removed from extMap`);
      }
    });

    // Defensive: sometimes ChannelDestroyed arrives without StasisEnd
    ariClient.on('ChannelDestroyed', async (evt, channel) => {
      logger.info(`ChannelDestroyed for channel ${channel.id}, name: ${channel.name}`);
      if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
        logger.info(`ExternalMedia ${channel.id} ChannelDestroyed after cleanup; ignoring`);
        return;
      }
      markChannelEndedAndMaybeCleanup(channel, 'ChannelDestroyed');
    });

    // If a bridge is destroyed from outside, try to clean the call state
    ariClient.on('BridgeDestroyed', (evt, bridge) => {
      const bridgeId = bridge.id;
      for (const [sipId, d] of sipMap.entries()) {
        if (d.bridgeId === bridgeId) {
          logger.info(`BridgeDestroyed seen for ${bridgeId} (sip ${sipId}), triggering cleanup`);
          cleanupChannel(sipId, 'BridgeDestroyed').catch(e =>
            logger.error(`cleanupChannel error (BridgeDestroyed) for ${sipId}: ${e.message}`)
          );
          break;
        }
      }
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, cleaning up...');
      const channelsToClean = [...sipMap.keys()];
      const cleanupTasks = channelsToClean.map(id => cleanupChannel(id, 'sigint'));
      await Promise.all([...cleanupPromises.values(), ...cleanupTasks]).catch(() => {});
      sipMap.clear();
      extMap.clear();
      cleanupPromises.clear();
      if (ariClient) {
        try { await ariClient.stop(); logger.info('ARI client stopped'); }
        catch (e) { logger.error(`Error stopping ARI client: ${e.message}`); }
      }
      logger.info('Cleanup completed, exiting.');
      process.exit(0);
    });
  } catch (e) {
    logger.error(`ARI connection error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { initializeAriClient, ariClient };
