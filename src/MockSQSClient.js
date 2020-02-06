import { EventEmitter } from 'events';
import { normalizeQueueConfig, messageHandlerFunc } from './util';

export class MockSQSClient extends EventEmitter {
  constructor(context, config) {
    super();
    const { queues, contextFunction } = config;
    this.config = {
      contextFunction,
    };
    this.publishMocks = {};
    normalizeQueueConfig(queues).forEach((queueConfig) => {
      const { logicalName, name } = queueConfig;
      const localName = logicalName || name;
      this.publishMocks[localName] = {
        config: {
          ...queueConfig,
          logicalName: localName,
        },
      };
    });
  }

  async publish(context, logicalQueue, message, options = {}) {
    const mock = this.publishMocks[logicalQueue];
    if (!mock) {
      throw new Error(`Invalid logical queue for publish (${logicalQueue})`);
    }

    const fn = mock.mockSubscriber || mock.subscriber;
    if (!fn) {
      (context.gb?.logger || context.logger || console).warn('Publishing to mock queue with no subscriber');
    } else {
      const virtualMessage = {
        Body: JSON.stringify(message),
        MessageAttributes: {
          DataType: 'String',
          StringValue: options.correlationid || context?.headers?.correlationid || 'mock-correlation-id',
        },
      };
      await messageHandlerFunc(context, {
        config: mock.config,
        queueClient: this,
      }, fn)(virtualMessage);
    }
  }

  async start(context) {
    this.context = context;
    return this;
  }

  async subscribe(context, logicalQueue, handler) {
    const mock = this.publishMocks[logicalQueue];
    if (!mock) {
      throw new Error(`Invalid logical queue for subscribe (${logicalQueue})`);
    }
    mock.subscriber = handler;
  }

  resetMocks() {
    Object.values(this.publishMocks).forEach((mock) => {
      delete mock.mockSubscriber;
    });
  }

  async mockPublish(logicalQueue, handler) {
    const mock = this.publishMocks[logicalQueue];
    if (!mock) {
      throw new Error(`Invalid logical queue for mockPublish (${logicalQueue})`);
    }
    mock.mockSubscriber = handler;
  }
}
