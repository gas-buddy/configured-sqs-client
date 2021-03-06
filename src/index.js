import _ from 'lodash';
import { EventEmitter } from 'events';
import { SQS, STS } from 'aws-sdk';
import SqsQueue from './Queue';
import { normalizeQueueConfig } from './util';

const DEFAULT_ENDPOINT = Symbol('Default SQS endpoint');
const ENDPOINT_CONFIG = Symbol('SQS Endpoint Config');

function buildQueue(queueClient, logicalName, queueConfig) {
  const { name = logicalName, endpoint, deadLetter } = queueConfig;
  const client = queueClient.sqsClients[endpoint || DEFAULT_ENDPOINT];
  const { accountId } = client[ENDPOINT_CONFIG];

  let queueUrl = name;
  if (!/^https?:/.test(name)) {
    queueUrl = `${_.trimEnd(client[ENDPOINT_CONFIG].endpoint, '/')}${accountId ? '/' : ''}${accountId || ''}/${name}`;
  }

  return new SqsQueue(queueClient, client, { ...queueConfig, queueUrl, logicalName, deadLetter });
}

export { MockSQSClient } from './MockSQSClient';

export default class ConfiguredSQSClient extends EventEmitter {
  sqsClients = {}

  queues = {}

  constructor(context, config) {
    super();

    this.config = config;
    this.logger = context.logger;
    const { queues, endpoint, endpoints, accountId, region, subscriptions, assumedRole } = config;

    this.defaultSubscriptionOptions = {
      waitTimeSeconds: 5,
      ...subscriptions,
    };

    if (endpoint || region) {
      let defaultEp = endpoint;
      if (typeof endpoint === 'string') {
        defaultEp = { endpoint, region };
      }
      this.logger.info('Creating default SQS endpoint', {
        endpoint: defaultEp?.endpoint || 'unspecified',
        region,
      });
      this.sqsClients[DEFAULT_ENDPOINT] = new SQS({
        region,
        ...defaultEp,
      });
      this.sqsClients[DEFAULT_ENDPOINT][ENDPOINT_CONFIG] = {
        endpoint: defaultEp?.endpoint || this.sqsClients[DEFAULT_ENDPOINT].endpoint?.href,
        accountId,
      };
    }

    if (endpoints) {
      Object.entries(endpoints).forEach(([logicalName, { accountId: epAccountId, endpoint: epEndpoint, ...epConfig }]) => {
        this.logger.info('Creating SQS endpoint', {
          logicalName,
          endpoint: epEndpoint,
        });
        this.sqsClients[logicalName] = new SQS({
          endpoint: epEndpoint,
          ...epConfig,
        });
        this.sqsClients[logicalName][ENDPOINT_CONFIG] = {
          accountId: epAccountId,
          endpoint: epEndpoint,
        };
      });
    }

    if (assumedRole) {
      this.assumedRole = assumedRole;
    }

    normalizeQueueConfig(queues).forEach((queueConfig) => {
      const { logicalName, name } = queueConfig;
      const localName = logicalName || name;
      this.queues[localName] = buildQueue(this, localName, queueConfig);
      context.logger.info('Added queue', {
        logicalName: localName,
        url: this.queues[localName].config.queueUrl,
      });
    });
  }

  async start(context) {
    if (this.assumedRole) {
      const sts = new STS({ apiVersion: '2011-06-15' });
      const { Arn: actualRoleArn } = await sts.getCallerIdentity({}).promise();
      if (!(actualRoleArn.includes(this.assumedRole))) {
        throw new Error(`Role is ${actualRoleArn} expecting to contain ${this.assumedRole}`);
      }
    }
    await Promise.all(Object.entries(this.queues).map(([, q]) => q.start(context)));
    return this;
  }

  getQueue(context, logicalQueue) {
    const sqsQueue = this.queues[logicalQueue];
    if (!sqsQueue) {
      const e = new Error(`Unable to find a logical queue named '${logicalQueue}'`);
      e.code = 'InvalidQueue';
      e.domain = 'SqsClient';
      throw e;
    }
    return sqsQueue;
  }

  async publish(context, logicalQueue, message, options = {}) {
    const sqsQueue = this.getQueue(context, logicalQueue);
    return sqsQueue.publish(context, message, options);
  }

  /**
   * Subscribe to a logical queue with a handler. The handler
   * will receive a context, the message body, and envelope information
   */
  async subscribe(context: any, logicalQueue: String, handler: (any, any, Map<string, any>) => Promise, options: Map<string, any>) {
    if (process.env.DISABLE_SQS_SUBSCRIPTIONS === 'true') {
      return Promise.resolve(false);
    }
    if (process.env.DISABLE_SQS_SUBSCRIPTIONS) {
      const disabled = process.env.DISABLE_SQS_SUBSCRIPTIONS.split(',');
      if (disabled.includes(logicalQueue)) {
        return Promise.resolve(false);
      }
    }

    const sqsQueue = this.getQueue(context, logicalQueue);
    return sqsQueue.subscribe(context, handler, {
      ...this.defaultSubscriptionOptions,
      ...options,
    });
  }

  async stop(context) {
    context.logger.info('Stopping SQS subscriptions');
    await Promise.all(Object.entries(this.queues).map(([, q]) => q.stop(context)));
    context.logger.info('SQS subscriptions stopped');
  }

  async moveMessages(context: any, sourceQueue: String, destinationQueue: String, maxMessages: Number = 0xFFFFFF) {
    const sqsSourceQueue = this.queues[sourceQueue] || buildQueue(this, 'source', { logicalName: 'source', name: sourceQueue });
    const sqsDestQueue = this.queues[destinationQueue] || buildQueue(this, 'destination', { logicalName: 'destination', name: destinationQueue });
    let moved = 0;
    while (moved < maxMessages) {
      try {
        // Use long polling to avoid empty message responses
        const receiveParams = {
          QueueUrl: sqsSourceQueue.config.queueUrl,
          MaxNumberOfMessages: Math.min(10, maxMessages - moved),
          WaitTimeSeconds: 1,
        };

        // Get messages from the DLQ
        // Continue looping until no more messages are left
        // eslint-disable-next-line no-await-in-loop
        const DLQMessages = await sqsSourceQueue.sqs.receiveMessage(receiveParams).promise();

        if (!DLQMessages.Messages || DLQMessages.Messages.length === 0) {
          (context.gb?.logger || context.logger).info('moveMessages complete', {
            sourceQueue,
            destinationQueue,
            count: moved,
          });
          break;
        }

        for (const message of DLQMessages.Messages) {
          // Send message to original queue
          const outboundMessage = {
            MessageBody: message.Body,
            QueueUrl: sqsDestQueue.config.queueUrl,
          };
          // eslint-disable-next-line no-await-in-loop
          await sqsDestQueue.sqs.sendMessage(outboundMessage).promise();
          // Delete message from DLQ
          const deleteParams = {
            QueueUrl: sqsSourceQueue.config.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          };
          // eslint-disable-next-line no-await-in-loop
          await sqsSourceQueue.sqs.deleteMessage(deleteParams).promise();
          moved += 1;
        }
      } catch (err) {
        const errorWrap = context.service?.wrapError || context.gb?.wrapError || (e => e);
        (context.gb?.logger || context.logger).error('moveMessages failed', errorWrap(err, {
          sourceQueue,
          destinationQueue,
          count: moved,
        }));
        throw err;
      }
    }
    return moved;
  }

  async reconnect() {
    // TODO
    return this.sqsClients[DEFAULT_ENDPOINT];
  }

  getQueueConfiguration(logicalQueue) {
    const sqsQueue = this.queues[logicalQueue];
    if (!sqsQueue) {
      const e = new Error(`Unable to find a logical queue named '${logicalQueue}'`);
      e.code = 'InvalidQueue';
      e.domain = 'SqsClient';
      throw e;
    }
    return sqsQueue.config || {};
  }

  // eslint-disable-next-line class-methods-use-this
  reject(message) {
    const error = new Error(message);
    error.deadLetter = true;
    throw error;
  }
}
