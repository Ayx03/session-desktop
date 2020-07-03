// we don't throw or catch here

import https from 'https';
import fetch from 'node-fetch';

import { PubKey } from '../types';
import { snodeRpc } from './lokiRpc';
import { SnodeResponse } from './onions';

import { sleepFor } from '../../../js/modules/loki_primitives';

import {
  getRandomSnodeAddress,
  markNodeUnreachable,
  markUnreachableForPubkey,
  Snode,
} from './snodePool';

const snodeHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export async function getVersion(
  node: Snode,
  retries: number = 0
): Promise<string | boolean> {
  const SNODE_VERSION_RETRIES = 3;

  const { log } = window;

  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const result = await fetch(`https://${node.ip}:${node.port}/get_stats/v1`, {
      agent: snodeHttpsAgent,
    });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    const data = await result.json();
    if (data.version) {
      return data.version;
    } else {
      return false;
    }
  } catch (e) {
    // ECONNREFUSED likely means it's just offline...
    // ECONNRESET seems to retry and fail as ECONNREFUSED (so likely a node going offline)
    // ETIMEDOUT not sure what to do about these
    // retry for now but maybe we should be marking bad...
    if (e.code === 'ECONNREFUSED') {
      markNodeUnreachable(node);
      // clean up these error messages to be a little neater
      log.warn(
        `LokiSnodeAPI::_getVersion - ${node.ip}:${node.port} is offline, removing`
      );
      // if not ECONNREFUSED, it's mostly ECONNRESETs
      // ENOTFOUND could mean no internet or hiccup
    } else if (retries < SNODE_VERSION_RETRIES) {
      log.warn(
        'LokiSnodeAPI::_getVersion - Error',
        e.code,
        e.message,
        `on ${node.ip}:${node.port} retrying in 1s`
      );
      await sleepFor(1000);
      return getVersion(node, retries + 1);
    } else {
      markNodeUnreachable(node);
      log.warn(
        `LokiSnodeAPI::_getVersion - failing to get version for ${node.ip}:${node.port}`
      );
    }
    // maybe throw?
    return false;
  }
}

export async function getSnodesFromSeedUrl(urlObj: URL): Promise<Array<any>> {
  const { log } = window;

  // Removed limit until there is a way to get snode info
  // for individual nodes (needed for guard nodes);  this way
  // we get all active nodes
  const params = {
    active_only: true,
    fields: {
      public_ip: true,
      storage_port: true,
      pubkey_x25519: true,
      pubkey_ed25519: true,
    },
  };

  const endpoint = 'json_rpc';
  const url = `${urlObj.href}${endpoint}`;

  const body = {
    jsonrpc: '2.0',
    id: '0',
    method: 'get_n_service_nodes',
    params,
  };

  const fetchOptions = {
    method: 'POST',
    timeout: 10000,
    body: JSON.stringify(body),
  };

  const response = await fetch(url, fetchOptions);

  if (response.status !== 200) {
    log.error(
      `loki_snode_api:::getSnodesFromSeedUrl - invalid response from seed ${urlObj.toString()}:`,
      response
    );
    return [];
  }

  if (response.headers.get('Content-Type') !== 'application/json') {
    log.error('Response is not json');
    return [];
  }

  try {
    const json = await response.json();

    // TODO: validate that all of the fields are present?
    const result = json.result;

    if (!result) {
      log.error(
        `loki_snode_api:::getSnodesFromSeedUrl - invalid result from seed ${urlObj.toString()}:`,
        response
      );
      return [];
    }
    // Filter 0.0.0.0 nodes which haven't submitted uptime proofs
    return result.service_node_states.filter(
      (snode: any) => snode.public_ip !== '0.0.0.0'
    );
  } catch (e) {
    log.error('Invalid json response');
    return [];
  }
}

// Not entirely sure what this is used for
const sendingData: any = {};

interface SendParams {
  pubKey: string;
  ttl: string;
  nonce: string;
  timestamp: string;
  data: string;
}

// get snodes for pubkey from random snode. Uses an existing snode
export async function getSnodesForPubkey(
  pubKey: string
): Promise<Array<Snode>> {
  const { log } = window;

  let snode;
  try {
    snode = await getRandomSnodeAddress();
    const result = await snodeRpc(
      'get_snodes_for_pubkey',
      {
        pubKey,
      },
      snode
    );

    if (!result) {
      log.warn(
        `LokiSnodeAPI::_getSnodesForPubkey - lokiRpc on ${snode.ip}:${snode.port} returned falsish value`,
        result
      );
      return [];
    }

    const res = result as SnodeResponse;

    if (res.status !== 200) {
      log.warn('Status is not 200 for get_snodes_for_pubkey');
      return [];
    }

    try {
      const json = JSON.parse(res.body);

      if (!json.snodes) {
        // we hit this when snode gives 500s
        log.warn(
          `LokiSnodeAPI::_getSnodesForPubkey - lokiRpc on ${snode.ip}:${snode.port} returned falsish value for snodes`,
          result
        );
        return [];
      }

      const snodes = json.snodes.filter(
        (tSnode: any) => tSnode.ip !== '0.0.0.0'
      );
      return snodes;
    } catch (e) {
      log.warn('Invalid json');
      return [];
    }
  } catch (e) {
    log.error('LokiSnodeAPI::_getSnodesForPubkey - error', e.code, e.message);

    if (snode) {
      markNodeUnreachable(snode);
    }

    return [];
  }
}

export async function requestLnsMapping(node: Snode, nameHash: any) {
  const { log } = window;

  log.debug('[lns] lns requests to {}:{}', node.ip, node.port);

  try {
    // TODO: Check response status
    return snodeRpc(
      'get_lns_mapping',
      {
        name_hash: nameHash,
      },
      node
    );
  } catch (e) {
    log.warn('exception caught making lns requests to a node', node, e);
    return false;
  }
}

function checkResponse(response: SnodeResponse): void {
  const { log, textsecure } = window;

  if (response.status === 406) {
    throw new textsecure.TimestampError('Invalid Timestamp (check your clock)');
  }

  const json = JSON.parse(response.body);

  // Wrong swarm
  if (response.status === 421) {
    log.warn('Wrong swarm, now looking at snodes', json.snodes);
    const newSwarm = json.snodes ? json.snodes : [];
    throw new textsecure.WrongSwarmError(newSwarm);
  }

  // Wrong PoW difficulty
  if (response.status === 432) {
    log.error('Wrong POW', json);
    throw new textsecure.WrongDifficultyError(json.difficulty);
  }
}

export async function storeOnNode(
  targetNode: Snode,
  params: SendParams
): Promise<boolean> {
  const { log, textsecure, lokiSnodeAPI } = window;

  let successiveFailures = 0;
  while (successiveFailures < MAX_ACCEPTABLE_FAILURES) {
    // the higher this is, the longer the user delay is
    // we don't want to burn through all our retries quickly
    // we need to give the node a chance to heal
    // also failed the user quickly, just means they pound the retry faster
    // this favors a lot more retries and lower delays
    // but that may chew up the bandwidth...
    await sleepFor(successiveFailures * 500);
    try {
      const result = await snodeRpc('store', params, targetNode);

      // succcessful messages should look like
      // `{\"difficulty\":1}`
      // but so does invalid pow, so be careful!

      // do not return true if we get false here...
      if (result === false) {
        // this means the node we asked for is likely down
        log.warn(
          `loki_message:::storeOnNode - Try #${successiveFailures}/${MAX_ACCEPTABLE_FAILURES} ${targetNode.ip}:${targetNode.port} failed`
        );
        successiveFailures += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      const snodeRes = result as SnodeResponse;

      checkResponse(snodeRes);

      if (snodeRes.status !== 200) {
        return false;
      }

      const res = snodeRes as any;

      // Make sure we aren't doing too much PoW
      const currentDifficulty = window.storage.get('PoWDifficulty', null);
      if (res && res.difficulty && res.difficulty !== currentDifficulty) {
        window.storage.put('PoWDifficulty', res.difficulty);
        // should we return false?
      }
      return true;
    } catch (e) {
      log.warn(
        'loki_message:::storeOnNode - send error:',
        e.code,
        e.message,
        `destination ${targetNode.ip}:${targetNode.port}`
      );
      if (e instanceof textsecure.WrongSwarmError) {
        const { newSwarm } = e;
        await lokiSnodeAPI.updateSwarmNodes(params.pubKey, newSwarm);
        sendingData[params.timestamp].swarm = newSwarm;
        sendingData[params.timestamp].hasFreshList = true;
        return false;
      } else if (e instanceof textsecure.WrongDifficultyError) {
        const { newDifficulty } = e;
        if (!Number.isNaN(newDifficulty)) {
          window.storage.put('PoWDifficulty', newDifficulty);
        }
        throw e;
      } else if (e instanceof textsecure.NotFoundError) {
        // TODO: Handle resolution error
      } else if (e instanceof textsecure.TimestampError) {
        log.warn('loki_message:::storeOnNode - Timestamp is invalid');
        throw e;
      } else if (e instanceof textsecure.HTTPError) {
        // TODO: Handle working connection but error response
        const body = await e.response.text();
        log.warn('loki_message:::storeOnNode - HTTPError body:', body);
      }
      successiveFailures += 1;
    }
  }
  const remainingSwarmSnodes = await markUnreachableForPubkey(
    params.pubKey,
    targetNode
  );
  log.error(
    `loki_message:::storeOnNode - Too many successive failures trying to send to node ${targetNode.ip}:${targetNode.port}, ${remainingSwarmSnodes.length} remaining swarm nodes`
  );
  return false;
}

// export async function openRetrieveConnection(pSwarmPool: any, stopPollingPromise: Promise<any>, onMessages: any) {
//   const swarmPool = pSwarmPool; // lint
//   let stopPollingResult = false;

//   // When message_receiver restarts from onoffline/ononline events it closes
//   // http-resources, which will then resolve the stopPollingPromise with true. We then
//   // want to cancel these polling connections because new ones will be created

//   // tslint:disable-next-line no-floating-promises
//   stopPollingPromise.then((result: any) => {
//     stopPollingResult = result;
//   });

//   while (!stopPollingResult && !_.isEmpty(swarmPool)) {
//     const address = Object.keys(swarmPool)[0]; // X.snode hostname
//     const nodeData = swarmPool[address];
//     delete swarmPool[address];
//     let successiveFailures = 0;
//     while (
//       !stopPollingResult &&
//       successiveFailures < MAX_ACCEPTABLE_FAILURES
//     ) {
//       // TODO: Revert back to using snode address instead of IP
//       try {
//         // in general, I think we want exceptions to bubble up
//         // so the user facing UI can report unhandled errors
//         // except in this case of living inside http-resource pollServer
//         // because it just restarts more connections...
//         let messages = await retrieveNextMessages(
//           nodeData,
//           nodeData.lastHash,
//           this.ourKey
//         );

//         // this only tracks retrieval failures
//         // won't include parsing failures...
//         successiveFailures = 0;
//         if (messages.length) {
//           const lastMessage = _.last(messages);
//           nodeData.lastHash = lastMessage.hash;
//           await lokiSnodeAPI.updateLastHash(
//             this.ourKey,
//             address,
//             lastMessage.hash,
//             lastMessage.expiration
//           );
//           messages = await this.jobQueue.add(() =>
//             filterIncomingMessages(messages)
//           );
//         }
//         // Execute callback even with empty array to signal online status
//         onMessages(messages);
//       } catch (e) {
//         log.warn(
//           'loki_message:::_openRetrieveConnection - retrieve error:',
//           e.code,
//           e.message,
//           `on ${nodeData.ip}:${nodeData.port}`
//         );
//         if (e instanceof textsecure.WrongSwarmError) {
//           const { newSwarm } = e;

//           // Is this a security concern that we replace the list of snodes
//           // based on a response from a single snode?
//           await lokiSnodeAPI.updateSwarmNodes(this.ourKey, newSwarm);
//           // FIXME: restart all openRetrieves when this happens...
//           // FIXME: lokiSnode should handle this
//           for (let i = 0; i < newSwarm.length; i += 1) {
//             const lastHash = await window.Signal.Data.getLastHashBySnode(
//               this.ourKey,
//               newSwarm[i]
//             );
//             swarmPool[newSwarm[i]] = {
//               lastHash,
//             };
//           }
//           // Try another snode
//           break;
//         } else if (e instanceof textsecure.NotFoundError) {
//           // DNS/Lokinet error, needs to bubble up
//           throw new window.textsecure.DNSResolutionError(
//             'Retrieving messages'
//           );
//         }
//         successiveFailures += 1;
//       }

//       // Always wait a bit as we are no longer long-polling
//       await sleepFor(Math.max(successiveFailures, 2) * 1000);
//     }
//     if (successiveFailures >= MAX_ACCEPTABLE_FAILURES) {
//       const remainingSwarmSnodes = await markUnreachableForPubkey(
//         this.ourKey,
//         nodeData
//       );
//       log.warn(
//         `loki_message:::_openRetrieveConnection - too many successive failures, removing ${
//           nodeData.ip
//         }:${nodeData.port} from our swarm pool. We have ${
//           Object.keys(swarmPool).length
//         } usable swarm nodes left for our connection (${
//           remainingSwarmSnodes.length
//         } in local db)`
//       );
//     }
//   }
//   // if not stopPollingResult
//   if (_.isEmpty(swarmPool)) {
//     log.error(
//       'loki_message:::_openRetrieveConnection - We no longer have any swarm nodes available to try in pool, closing retrieve connection'
//     );
//     return false;
//   }
//   return true;
// }

// mark private (_ prefix) since no error handling is done here...
export async function retrieveNextMessages(
  nodeData: Snode,
  lastHash: string,
  pubkey: PubKey
): Promise<Array<any>> {
  const params = {
    pubKey: pubkey,
    lastHash: lastHash || '',
  };

  // let exceptions bubble up
  const result = await snodeRpc('retrieve', params, nodeData);

  if (!result) {
    window.log.warn(
      `loki_message:::_retrieveNextMessages - lokiRpc could not talk to ${nodeData.ip}:${nodeData.port}`
    );
    return [];
  }

  const res = result as SnodeResponse;

  // NOTE: Retrieve cannot result in "wrong POW", but we call
  // `checkResponse` to check for "wrong swarm"
  checkResponse(res);

  if (res.status !== 200) {
    window.log('retrieve result is not 200');
    return [];
  }

  try {
    const json = JSON.parse(res.body);
    return json.messages || [];
  } catch (e) {
    return [];
  }
}

const MAX_ACCEPTABLE_FAILURES = 10;