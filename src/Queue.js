import uuid from 'uuid/v4';
import { Consumer } from 'sqs-consumer';
import { ALREADY_LOGGED, messageHandlerFunc, safeEmit } from './util';

async function createConsumer(queueClient, context, handleMessage, options) {
  const { messageAttributeNames = [], ...consumerOptions } = options;
  const withCorrelation = ['CorrelationId', 'ErrorDetail', ...messageAttributeNames];
  const consumer = Consumer.create({
    attributeNames: ['All'],
    messageAttributeNames: withCorrelation,
    ...consumerOptions,
    queueUrl: queueClient.config.queueUrl,
    sqs: queueClient.sqs,
    handleMessage,
  });
  const errorArgs = { queueUrl: queueClient.config.queueUrl, logicalName: queueClient.config.logicalName };
  consumer.on('error', async (error) => {
    if (error.code === 'ExpiredToken') {
      consumer.sqs = await queueClient.reconnect(context, this.sqs);
    } else if (error.code === 'AccessDenied') {
      context.logger.error('Missing permission', context.service.wrapError(error, errorArgs));
      consumer.stop();
    } else if (error.code === 'AWS.SimpleQueueService.NonExistentQueue') {
      context.logger.error('Misconfigured queue', context.service.wrapError(error, errorArgs));
      consumer.stop();
    } else {
      context.logger.error('SQS error', context.service.wrapError(error, errorArgs));
    }
  });
  consumer.on('processing_error', (error) => {
    if (!error[ALREADY_LOGGED]) {
      context.logger.error('SQS processing error', context.service.wrapError(error, errorArgs));
    }
  });
  consumer.on('timeout_error', (error) => {
    context.logger.error('SQS processing timeout', context.service.wrapError(error, errorArgs));
  });
  if (queueClient.started) {
    await consumer.start();
  }
  return consumer;
}

export default class SqsQueue {
  constructor(queueClient, sqs, config) {
    Object.assign(this, { queueClient, sqs, config });
    this.consumers = [];
  }

  async publish(context, message, options = {}) {
    const { MessageAttributes, correlationid, ...restOfOptions } = options;
    const correlationId = correlationid || context.headers?.correlationid || uuid();
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
    const callInfo = { operationName: 'publish', message: finalMessage };
    this.queueClient.emit('start', callInfo);
    try {
      const retVal = await this.sqs.sendMessage(finalMessage).promise();
      this.queueClient.emit('finish', callInfo);
      return retVal;
    } catch (error) {
      callInfo.error = error;
      safeEmit(this.queueClient, 'error', callInfo);
      throw error;
    }
  }

  async subscribe(context, handler, options = {}) {
    const { readers = this.config.readers || 1, ...consumerOptions } = options;
    const handleMessage = messageHandlerFunc(context, this, handler);
    await Promise.all(new Array(readers).fill(0).map(async () => {
      this.consumers.push(await createConsumer(this, context, handleMessage, consumerOptions));
    }));
    context.logger.info('Subscribed to SQS queue', { readers, logicalName: this.config.logicalName });
  }

  async start() {
    if (!this.started) {
      if (this.consumers.length) {
        await Promise.all(this.consumers.map(c => c.start()));
      }
      this.started = true;
    }
  }

  async stop() {
    if (this.consumers) {
      await Promise.all(this.consumers.map(c => c.stop()));
      delete this.consumers;
    }
    this.started = false;
  }
}
