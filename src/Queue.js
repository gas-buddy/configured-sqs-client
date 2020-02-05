import uuid from 'uuid/v4';
import { Consumer } from 'sqs-consumer';

const ALREADY_LOGGED = Symbol('Reduce duplicate logging');

function safeEmit(q, eventName, arg) {
  if (q.listenerCount(eventName)) {
    q.emit(eventName, arg);
  }
}

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
      messageContext = await sqsQueue.queueClient.config.contextFunction(context, message);
    }
    const logger = messageContext?.gb?.logger || messageContext.logger;

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(Body);
    } catch (error) {
      logger.error('Failed to parse SQS Body as JSON', context.service.wrapError(error));
      Object.defineProperty(error, ALREADY_LOGGED, { value: true, enumerable: false });
      safeEmit(sqsQueue.queueClient, 'error', callInfo);
      throw error;
    }
    try {
      await handler(messageContext, parsedMessage, rest);
      sqsQueue.queueClient.emit('finish', callInfo);
    } catch (error) {
      if (error.deadLetter) {
        if (error.deadLetter === true && !sqsQueue.config.deadLetter) {
          logger.error('Received deadLetter error but queue has not deadLetter configured', context.service.wrapError(error, {
            logicalName: sqsQueue.config.logicalName,
          }));
        } else {
          await sqsQueue.queueClient.publish(
            context,
            error.deadLetter === true ? sqsQueue.config.deadLetter : error.deadLetter,
            parsedMessage,
            {
              MessageAttributes: {
                ErrorDetail: {
                  DataType: 'String',
                  StringValue: error.message,
                },
              },
            },
          );
          // Treat this message as being handled because we have published to deadLetter
          return;
        }
      }
      Object.defineProperty(error, ALREADY_LOGGED, { value: true, enumerable: false });
      logger.error('Failed to handle message', context.service.wrapError(error));
      safeEmit(sqsQueue.queueClient, 'error', callInfo);
      throw error;
    }
  };
}

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
  consumer.on('error', async (error) => {
    if (error.code === 'ExpiredToken') {
      consumer.sqs = await queueClient.reconnect(context, this.sqs);
    } else {
      context.logger.error('SQS error', context.service.wrapError(error));
    }
  });
  consumer.on('processing_error', (error) => {
    if (!error[ALREADY_LOGGED]) {
      context.logger.error('SQS processing error', context.service.wrapError(error));
    }
  });
  consumer.on('timeout_error', (error) => {
    context.logger.error('SQS processing timeout', context.service.wrapError(error));
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
