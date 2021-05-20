import zlib from 'zlib';

export const supportedCompression = 'deflate';
export const ALREADY_LOGGED = Symbol('Reduce duplicate logging');

export function normalizeQueueConfig(queues) {
  let queueArray = queues;
  if (!Array.isArray(queueArray)) {
    queueArray = Object.entries(queues).map(([logicalName, qConfig]) => {
      if (typeof qConfig === 'string') {
        return { logicalName, name: qConfig };
      }
      return { logicalName, ...qConfig };
    });
  }

  queueArray = queueArray.map(q => (typeof q === 'string' ? { name: q } : q));

  // Fix up any missing queues via deadLetter setting
  queueArray.filter(q => q.deadLetter).forEach((q) => {
    if (!queueArray.find(exQ => (exQ.logicalName || exQ.name) === q.deadLetter)) {
      queueArray.push({ name: q.deadLetter });
    }
  });
  return queueArray;
}

export function safeEmit(q, eventName, arg) {
  if (q.listenerCount(eventName)) {
    q.emit(eventName, arg);
  }
}

export function deflateMessage(message) {
  return new Promise((resolve, reject) => zlib.deflate(message, (err, buffer) => {
    if (err) {
      reject(err);
    }
    resolve(buffer.toString('base64'));
  }));
}

export function inflateMessage(message) {
  return new Promise((resolve, reject) => zlib.inflate(Buffer.from(message, 'base64'), (err, data) => {
    if (err) {
      reject(err);
    }
    resolve(data.toString());
  }));
}

export async function compressMessage(message, compression) {
  if (compression === true || compression.encoding === supportedCompression) {
    return {
      headers: { 'Content-Encoding': supportedCompression },
      body: await deflateMessage(message),
    };
  }
  const e = new Error('Compression type not supported');
  e.code = 'InvalidEncoding';
  e.domain = 'SqsClient';
  throw e;
}

export function messageHandlerFunc(context, sqsQueue, handler) {
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
    const errorWrap = context.service?.wrapError || context.gb?.wrapError || (e => e);

    let parsedMessage;
    let parsedAttr;
    try {
      const contentEncoding = rest.MessageAttributes?.['Content-Encoding']?.StringValue;
      parsedAttr = JSON.parse(JSON.stringify(rest)); // deep copy
      if (contentEncoding === supportedCompression) {
        parsedMessage = JSON.parse(await inflateMessage(Body));
        delete parsedAttr.MessageAttributes?.['Content-Encoding'];
      } else {
        parsedMessage = JSON.parse(Body);
      }
    } catch (error) {
      logger.error('Failed to parse SQS Body as JSON', errorWrap(error));
      Object.defineProperty(error, ALREADY_LOGGED, { value: true, enumerable: false });
      safeEmit(sqsQueue.queueClient, 'error', callInfo);
      throw error;
    }
    try {
      await handler(messageContext, parsedMessage, parsedAttr);
      sqsQueue.queueClient.emit('finish', callInfo);
    } catch (error) {
      if (error.deadLetter) {
        if (error.deadLetter === true && !sqsQueue.config.deadLetter) {
          logger.error('Received deadLetter error but queue has not deadLetter configured', errorWrap(error, {
            logicalName: sqsQueue.config.logicalName,
          }));
        } else {
          const msgAttributes = {
            ...rest.MessageAttributes,
            ErrorDetail: {
              DataType: 'String',
              StringValue: error.message,
            },
          };
          try {
            await sqsQueue.queueClient.publish(
              context,
              error.deadLetter === true ? sqsQueue.config.deadLetter : error.deadLetter,
              Body,
              {
                MessageAttributes: msgAttributes,
                publishRaw: true,
              },
            );
          } catch (sqsError) {
            logger.error('Failed to publish to configured DLQ', errorWrap(sqsError));
            throw sqsError;
          }
          // Treat this message as being handled because we have published to deadLetter
          return;
        }
      }
      Object.defineProperty(error, ALREADY_LOGGED, { value: true, enumerable: false });
      logger.error('Failed to handle message', errorWrap(error));
      safeEmit(sqsQueue.queueClient, 'error', callInfo);
      throw error;
    }
  };
}
