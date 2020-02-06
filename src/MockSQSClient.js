import { normalizeQueueConfig } from './util';

export class MockSQSClient {
  constructor(context, config) {
    const { queues, contextFunction } = config;
    this.contextFunction = contextFunction;
    this.publishMocks = {};
    normalizeQueueConfig(queues).forEach((queueConfig) => {
      const { logicalName, name } = queueConfig;
      const localName = logicalName || name;
      this.publishMocks[localName] = { logicalName: localName };
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
      let messageContext = context;
      if (this.contextFunction) {
        messageContext = this.contextFunction(context, {
          Body: message,
          MessageAttributes: {
            DataType: 'String',
            StringValue: options.correlationid || context?.headers?.correlationid || 'mock-correlation-id',
          },
        });
      }
      // TODO options isn't really the same thing here as the envelope... But not sure what is yet
      fn(messageContext, message, options)
        .catch((error) => {
          (context.gb?.logger || context.logger || console).error('Subscriber failed', error);
          throw error;
        });
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
