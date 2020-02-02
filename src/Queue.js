import uuid from 'uuid/v4';
import { Consumer } from 'sqs-consumer';

function messageHandlerFunc(context, sqsQueue, handler) {
  return async (message) => {
    const { Body, ...rest } = message;
    const callInfo = {
      operationName: 'handleQueueMessage',
      message,
    };
    sqsQueue.queueClient.emit('start', callInfo);

    let messageContext = context;
    if (sqsQueue.queueClient.config.contextFunction) {
      messageContext = sqsQueue.queueClient.config.contextFunction(context, message);
    }
    const logger = messageContext?.gb?.logger || messageContext.logger;

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(Body);
    } catch (error) {
      logger.error('Failed to parse SQS Body as JSON', context.service.wrapError(error));
      sqsQueue.queueClient.emit('error', callInfo);
      throw error;
    }
    try {
      await handler(messageContext, parsedMessage, rest);
      sqsQueue.queueClient.emit('finish', callInfo);
    } catch (error) {
      logger.error('Failed to handle message', context.service.wrapError(error));
      sqsQueue.queueClient.emit('error', callInfo);
      throw error;
    }
  };
}

export default class SqsQueue {
  constructor(queueClient, sqs, config) {
    Object.assign(this, { queueClient, sqs, config });
  }

  publish(context, message, options = {}) {
    const { MessageAttributes, ...restOfOptions } = options;
    const correlationId = context.headers?.correlationid || uuid();
    const attributes = {
      ...MessageAttributes,
      CorrelationId: {
        DataType: 'String',
        StringValue: correlationId,
      },
    };

    const finalMessage = {
      MessageBody: JSON.stringify(message),
      MessageAttributes: attributes,
      ...restOfOptions,
      QueueUrl: this.config.queueUrl,
    };
    return this.sqs.sendMessage(finalMessage).promise();
  }

  async subscribe(context, handler, options = {}) {
    if (this.consumer) {
      throw new Error(`Cannot subscribe to the same queue (${this.config.logicalName}) twice`);
    }
    const { messageAttributeNames = [], ...consumerOptions } = options;
    const withCorrelation = ['CorrelationId', ...messageAttributeNames];
    this.consumer = Consumer.create({
      attributeNames: ['All'],
      messageAttributeNames: withCorrelation,
      ...consumerOptions,
      queueUrl: this.config.queueUrl,
      sqs: this.sqs,
      handleMessage: messageHandlerFunc(context, this, handler),
    });
    this.consumer.on('error', async (error) => {
      if (error.code === 'ExpiredToken') {
        this.consumer.sqs = await this.queueClient.reconnect(context, this.sqs);
      } else {
        context.logger.error('SQS error', context.service.wrapError(error));
      }
    });
    this.consumer.on('processing_error', (error) => {
      context.logger.error('Rakuten processing error', context.service.wrapError(error));
    });
    if (this.started) {
      await this.consumer.start();
    }
  }

  async start() {
    if (this.consumer) {
      await this.consumer.start();
    }
    this.started = true;
  }

  async stop() {
    if (this.consumer) {
      this.consumer.stop();
      delete this.consumer;
    }
    this.started = false;
  }
}
