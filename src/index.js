import _ from 'lodash';
import { EventEmitter } from 'events';
import { SQS } from 'aws-sdk';
import SqsQueue from './Queue';

const DEFAULT_ENDPOINT = Symbol('Default SQS endpoint');
const ENDPOINT_CONFIG = Symbol('SQS Endpoint Config');

function buildQueue(queueClient, logicalName, queueConfig) {
  let finalConfig = queueConfig;
  if (typeof queueConfig === 'string') {
    finalConfig = { name: queueConfig };
  }

  const { name, endpoint, deadLetter } = finalConfig;
  const client = queueClient.sqsClients[endpoint || DEFAULT_ENDPOINT];
  const { accountId } = client[ENDPOINT_CONFIG];

  let queueUrl = name;
  if (!/^https?:/.test(name)) {
    queueUrl = `${_.trimEnd(client[ENDPOINT_CONFIG].endpoint, '/')}${accountId ? '/' : ''}${accountId || ''}/${name}`;
  }

  return new SqsQueue(queueClient, client, { queueUrl, logicalName, deadLetter });
}

export { MockSQSClient } from './MockSQSClient';

export default class ConfiguredSQSClient extends EventEmitter {
  sqsClients = {}

  queues = {}

  constructor(context, config) {
    super();

    this.config = config;
    this.logger = context.logger;
    const { queues, endpoint, endpoints, accountId, region, subscriptions } = config;

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
        endpoint: defaultEp.endpoint,
        region,
      });
      this.sqsClients[DEFAULT_ENDPOINT] = new SQS({
        region,
        ...defaultEp,
      });
      this.sqsClients[DEFAULT_ENDPOINT][ENDPOINT_CONFIG] = {
        endpoint: defaultEp.endpoint,
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

    Object.entries(queues).forEach(([logicalName, qConfig]) => {
      this.queues[logicalName] = buildQueue(this, logicalName, qConfig);
      context.logger.info('Added queue', {
        logicalName,
        url: this.queues[logicalName].config.queueUrl,
      });
    });
  }

  async start(context) {
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

  async publish(context, logicalQueue, message, options) {
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

  async reconnect() {
    // TODO
    return this.sqsClients[DEFAULT_ENDPOINT];
  }
}
