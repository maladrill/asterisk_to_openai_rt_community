const ari = require('ari-client');
const WebSocket = require('ws');
const { config, logger } = require('./config');
const { sipMap, extMap, rtpSenders, rtpReceivers, cleanupPromises } = require('./state');
const { startRTPReceiver, getNextRtpPort, releaseRtpPort } = require('./rtp');
const { startOpenAIWebSocket } = require('./openai');

let ariClient;

// How long we wait for both SIP and ExternalMedia channels to end before forcing cleanup.
const CLEANUP_GRACE_MS = Number(process.env.CLEANUP_GRACE_MS || 1500);

// External-media events that should be ignored because cleanup already ran.
// We put external channel IDs here when cleanup starts and remove them shortly after.
// This prevents noisy logs when late StasisEnd/ChannelDestroyed arrive for ExternalMedia.
const ignoreExtEvents = new Set();

/**
 * Returns true for names like "UnicastRTP/127.0.0.1:12000-...."
 * Used to differentiate ExternalMedia channels from SIP channels.
 */
function isExternalMediaChannel(name = '') {
  return /^UnicastRTP\//.test(name);
}

/**
 * Add an ExternalMedia channel to a bridge.
 * Throws on failure; caller should catch and log.
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
 * Resolve the owning SIP channel ID for any ARI channel (SIP or ExternalMedia).
 * - For SIP channels, returns the channel's own id.
 * - For ExternalMedia channels, consults extMap and sipMap relationships.
 */
function resolveSipIdForChannel(channel) {
  if (!channel) return undefined;
  const { id, name = '' } = channel;
  if (!isExternalMediaChannel(name)) return id;

  // extMap keyed by external channel id → { bridgeId, channelId (SIP) }
  const entry = extMap.get(id);
  if (entry && entry.channelId) return entry.channelId;

  // Fallback: scan sipMap for a match in stored external ids
  for (const [sipId, data] of sipMap.entries()) {
    if (data && (data.externalChannelId === id)) return sipId;
  }
  return undefined;
}

/**
 * Mark flags that a given channel (SIP or External) ended and schedule cleanup.
 * - If both sides have ended, cleanup immediately.
 * - Otherwise, start/refresh a grace timer; on timeout, force cleanup.
 * - If ExternalMedia event arrives after cleanup, ignore it quietly.
 */
function markChannelEndedAndMaybeCleanup(channel, sourceEvent) {
  // If this is a late external-media event we intentionally ignore, short-circuit early.
  if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
    logger.info(`ExternalMedia ${channel.id} ${sourceEvent} arrived after cleanup; ignoring`);
    return;
  }

  const sipId = resolveSipIdForChannel(channel);
  if (!sipId) {
    // If we cannot resolve owner and it's ExternalMedia, it's very likely a late event post-cleanup.
    if (isExternalMediaChannel(channel.name || '')) {
      logger.debug(`ExternalMedia ${channel.id} ${sourceEvent} with no owner (probably post-cleanup); ignoring`);
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

  // If both sides ended, do it right now.
  if (data._sipEnded && data._extEnded) {
    cleanupChannel(sipId, `${sourceEvent}:both-ended`).catch(e =>
      logger.error(`cleanupChannel error (both-ended) for ${sipId}: ${e.message}`)
    );
    return;
  }

  // Debounce a single timer per SIP-id.
  if (data._cleanupTimer) clearTimeout(data._cleanupTimer);
  data._cleanupTimer = setTimeout(() => {
    cleanupChannel(sipId, `${sourceEvent}:grace-timeout`).catch(e =>
      logger.error(`cleanupChannel error (grace-timeout) for ${sipId}: ${e.message}`)
    );
  }, CLEANUP_GRACE_MS);
  sipMap.set(sipId, data);
}

/**
 * Perform a complete, idempotent cleanup for a given SIP channel id.
 * This tears down websockets, RTP sockets, bridge, channels and clears all maps.
 *
 * Note: the function accepts an optional 'reason' only for logging.
 */
async function cleanupChannel(channelId, reason = 'manual') {
  // Ensure only one cleanup runs per channelId at a time.
  if (cleanupPromises.has(channelId)) {
    await cleanupPromises.get(channelId);
    return;
  }

  const cleanupPromise = (async () => {
    const channelData = sipMap.get(channelId) || {};
    logger.info(`Cleanup started for channel ${channelId} (reason=${reason})`);

    // Make this function idempotent.
    if (channelData._cleaned) {
      logger.info(`Cleanup skipped (already done) for ${channelId}`);
      return;
    }
    channelData._cleaned = true;
    sipMap.set(channelId, channelData);

    // Cancel grace timer if present.
    if (channelData._cleanupTimer) {
      clearTimeout(channelData._cleanupTimer);
      delete channelData._cleanupTimer;
    }

    try {
      // Before tearing down maps, mark the external media channel as "ignore late events" for a short while.
      if (channelData.externalChannelId) {
        ignoreExtEvents.add(channelData.externalChannelId);
        // Remove the marker after a few seconds; enough for ARI to flush late events.
        setTimeout(() => ignoreExtEvents.delete(channelData.externalChannelId), 10000);
      }

      // 1) Cancel call duration timer if used.
      if (channelData.callTimeoutId) {
        clearTimeout(channelData.callTimeoutId);
        logger.info(`Call duration timeout cleared for channel ${channelId}`);
      }

      // 2) Stop playback / stream handler (if exposed from RTP).
      if (channelData.streamHandler && typeof channelData.streamHandler.end === 'function') {
        try {
          channelData.streamHandler.end();
          logger.info(`Stream handler ended for ${channelId}`);
        } catch (e) {
          logger.warn(`Stream handler end failed for ${channelId}: ${e.message}`);
        }
      }

      // 3) Close OpenAI WS (if not already closed).
      if (!channelData.wsClosed) {
        if (channelData.ws && typeof channelData.ws.close === 'function') {
          try {
            channelData.ws.close();
            logger.info(`WebSocket close requested for ${channelId}`);
          } catch (e) {
            logger.warn(`WebSocket close failed for ${channelId}: ${e.message}`);
          }
        }
        // Wait a short moment (best-effort) for ws close to propagate.
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // 4) Hangup ExternalMedia channel if still present.
      if (channelData.externalChannelId && ariClient) {
        try {
          await ariClient.channels.hangup({ channelId: channelData.externalChannelId }).catch(() => {});
          logger.info(`External channel ${channelData.externalChannelId} hangup attempted`);
        } catch (e) {
          logger.warn(`External channel hangup failed for ${channelId}: ${e.message}`);
        }
      }

      // 5) Destroy the bridge (removes any members left there).
      if (channelData.bridge && channelData.bridge.id && ariClient) {
        try {
          await ariClient.bridges.destroy({ bridgeId: channelData.bridge.id }).catch(() => {});
          logger.info(`Bridge ${channelData.bridge.id} destroyed`);
        } catch (e) {
          logger.warn(`Bridge destroy failed for ${channelId}: ${e.message}`);
        }
      }

      // 6) Hangup SIP channel as a last resort.
      if (channelData.channel && ariClient) {
        try {
          await ariClient.channels.hangup({ channelId });
          logger.info(`SIP channel ${channelId} hangup attempted`);
        } catch (e) {
          logger.warn(`SIP channel hangup failed for ${channelId}: ${e.message}`);
        }
      }

      // 7) Close RTP sockets and release the RTP port.
      try {
        const rx = rtpReceivers.get(channelId);
        if (rx && rx.isOpen) {
          rx.isOpen = false;
          rx.close();
          logger.info(`RTP receiver socket closed for ${channelId}`);
        }
        rtpReceivers.delete(channelId);
      } catch (e) {
        logger.warn(`RTP receiver close failed for ${channelId}: ${e.message}`);
      }

      try {
        const tx = rtpSenders.get(channelId);
        if (tx && tx.isOpen) {
          tx.isOpen = false;
          tx.close();
          logger.info(`RTP sender socket closed for ${channelId}`);
        }
        rtpSenders.delete(channelId);
      } catch (e) {
        logger.warn(`RTP sender close failed for ${channelId}: ${e.message}`);
      }

      try {
        if (typeof channelData.rtpPort === 'number') {
          releaseRtpPort(channelData.rtpPort);
          logger.info(`Released RTP port ${channelData.rtpPort} for ${channelId}`);
        }
      } catch (e) {
        logger.warn(`releaseRtpPort failed for ${channelId}: ${e.message}`);
      }

      // 8) Clear maps (both directions).
      try {
        if (channelData.externalChannelId) {
          extMap.delete(channelData.externalChannelId);
        }
        extMap.delete(channelId); // if you stored a reverse mapping keyed by SIP id
      } catch (_) {}

      // 9) Remove the main sipMap entry last.
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
 */
async function initializeAriClient() {
  try {
    ariClient = await ari.connect(config.ARI_URL, config.ARI_USER, config.ARI_PASS);
    logger.info(`Connected to ARI at ${config.ARI_URL}`);
    await ariClient.start(config.ARI_APP);
    logger.info(`ARI application "${config.ARI_APP}" started`);

    // === Main call entry point ===
    ariClient.on('StasisStart', async (evt, channel) => {
      logger.info(`StasisStart for channel ${channel.id}, name: ${channel.name}`);

      // Ignore Local/ helper legs, they are not part of this app's media graph.
      if (channel.name && channel.name.startsWith('Local/')) {
        logger.info(`Ignoring Local channel ${channel.id}, name: ${channel.name}`);
        return;
      }

      // ExternalMedia leg: add to bridge when it appears.
      if (isExternalMediaChannel(channel.name || '')) {
        logger.info(`ExternalMedia channel started: ${channel.id}`);

        // Wait briefly for the map created by the SIP leg.
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

      // SIP leg: create bridge, start RTP, create ExternalMedia, start WS.
      logger.info(`SIP channel started: ${channel.id}`);
      try {
        const bridgeId = `${channel.id}_bridge`;
        const bridge = await ariClient.bridges.create({ type: 'mixing,proxy_media', bridgeId });
        await bridge.addChannel({ channel: channel.id });
        await channel.answer();
        logger.info(`Channel ${channel.id} answered, bridge ${bridgeId} created for SIP audio`);

        const port = getNextRtpPort();
        await startRTPReceiver(channel.id, port);

        // Store initial call state in sipMap
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

        // Create ExternalMedia channel and remember both directions in extMap/sipMap
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

        // extMap: external-id → { bridgeId, channelId }
        extMap.set(extChannel.id, { bridgeId, channelId: channel.id });
        // Optional reverse mapping to simplify lookups
        extMap.set(channel.id, { bridgeId, externalChannelId: extChannel.id });

        // Also store external id in SIP entry for easy cleanup later
        const sipData = sipMap.get(channel.id) || {};
        sipData.externalChannelId = extChannel.id;
        sipMap.set(channel.id, sipData);

        // Optional call duration limit
        if (config.CALL_DURATION_LIMIT_SECONDS > 0) {
          const channelData = sipMap.get(channel.id);
          channelData.callTimeoutId = setTimeout(async () => {
            logger.info(`Call duration limit of ${config.CALL_DURATION_LIMIT_SECONDS} seconds reached for channel ${channel.id}, hanging up`);
            try {
              await ariClient.channels.hangup({ channelId: channel.id });
              logger.info(`Channel ${channel.id} hung up due to duration limit`);
            } catch (e) {
              logger.error(`Error hanging up channel ${channel.id} due to duration limit: ${e.message}`);
            }
          }, config.CALL_DURATION_LIMIT_SECONDS * 1000);
          sipMap.set(channel.id, channelData);
        }

        // Start the OpenAI Realtime WebSocket for this call.
        await startOpenAIWebSocket(channel.id);
      } catch (e) {
        logger.error(`Error in SIP channel ${channel.id}: ${e.message}`);
        await cleanupChannel(channel.id, 'stasisstart-error');
      }
    });

    // === Lifecycle: channel leaves our app ===
    ariClient.on('StasisEnd', async (evt, channel) => {
      logger.info(`StasisEnd for channel ${channel.id}, name: ${channel.name}`);

      // If this is a late ExternalMedia event post-cleanup, ignore quietly.
      if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
        logger.info(`ExternalMedia ${channel.id} StasisEnd after cleanup; ignoring`);
        return;
      }

      // Mark and schedule cleanup rather than trying to infer "still active".
      markChannelEndedAndMaybeCleanup(channel, 'StasisEnd');

      // If ExternalMedia, drop the extMap pointer now (best-effort).
      if (isExternalMediaChannel(channel.name || '')) {
        extMap.delete(channel.id);
        logger.info(`ExternalMedia channel ${channel.id} removed from extMap`);
      }
    });

    // Defensive: in some edge cases ChannelDestroyed comes without StasisEnd.
    ariClient.on('ChannelDestroyed', async (evt, channel) => {
      logger.info(`ChannelDestroyed for channel ${channel.id}, name: ${channel.name}`);

      if (isExternalMediaChannel(channel.name || '') && ignoreExtEvents.has(channel.id)) {
        logger.info(`ExternalMedia ${channel.id} ChannelDestroyed after cleanup; ignoring`);
        return;
      }

      markChannelEndedAndMaybeCleanup(channel, 'ChannelDestroyed');
    });

    // Optional: if a bridge is destroyed from outside, try to clean the call.
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

    // Graceful shutdown (service stop/CTRL-C)
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, cleaning up...');
      const channelsToClean = [...sipMap.keys()];
      const cleanupTasks = channelsToClean.map(id => cleanupChannel(id, 'sigint'));
      await Promise.all([...cleanupPromises.values(), ...cleanupTasks]).catch(() => {});
      sipMap.clear();
      extMap.clear();
      cleanupPromises.clear();
      if (ariClient) {
        try {
          await ariClient.stop();
          logger.info('ARI client stopped');
        } catch (e) {
          logger.error(`Error stopping ARI client: ${e.message}`);
        }
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
