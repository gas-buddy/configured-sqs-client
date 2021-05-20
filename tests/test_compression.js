import tap from 'tap';
import uuid from 'uuid/v4';
import SqsClient from '../src/index';
import oneKbPayload from './mock/1kb.json';

const sqsHost = process.env.SQS_HOST || 'localhost';
const sqsPort = process.env.SQS_PORT || 9324;

const qConfig = {
  region: 'us-east-1',
  endpoint: {
    // ElasticMQ wants "queue" there rather than an account id
    endpoint: `http://${sqsHost}:${sqsPort}/queue`,
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  },
  queues: {
    basic: 'basic_queue',
    redrive: { name: 'redrive_queue', deadLetter: 'dead', readers: 10 },
    dead: 'dead_letter_queue',
    autoDead: { deadLetter: 'this_should_get_made' },
  },
  subscriptions: {
    waitTimeSeconds: 1,
  },
  // assumedRole: 'user',
  contextFunction(context, message) {
    return {
      ...context,
      headers: { correlationid: message?.MessageAttributes?.CorrelationId?.StringValue },
    };
  },
};

const ctx = {
  logger: console,
  headers: { correlationid: uuid() },
  service: {
    wrapError(e, args = {}) { return Object.assign(e, args); },
  },
};

function getPromiseAcceptor() {
  let acceptReturn;
  const promise = new Promise((accept) => { acceptReturn = accept; });
  return { accept: acceptReturn, promise };
}

tap.test('test_compression', async (t) => {
  const messageId = uuid();
  const largeMsgId = uuid();
  const errorId = uuid();
  const sqs = new SqsClient(ctx, qConfig);
  const { accept: doneAccept, promise: receivePromise } = getPromiseAcceptor();
  const { accept: doneAcceptLarge, promise: receivePromiseLarge } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'basic', (req, message, envelope) => {
    if (message.messageId === messageId) {
      t.strictEquals(undefined, envelope.MessageAttributes['Content-Encoding'], 'Content-Encoding attribute should not be returned as it is already resolved');
      doneAccept(true);
    }
    if (message.largeMsgId === largeMsgId) {
      doneAcceptLarge(true);
    }
  });

  const { accept: deadAccept, promise: redrivePromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'redrive', (req, message) => {
    if (message.errorId === errorId) {
      const error = new Error('Compressed redrive message. Throwing Error');
      error.deadLetter = true;
      throw error;
    }
  });
  await sqs.subscribe(ctx, 'dead', (req, message) => {
    if (message.errorId === errorId) {
      deadAccept(true);
    }
  });
  await sqs.start(ctx);
  try {
    await sqs.publish(ctx, 'basic', { testName: 'compression' }, { compression: { encoding: 'test' } });
    t.notOk(true, 'Should throw for invalid compression encoding');
  } catch (error) {
    t.strictEquals('InvalidEncoding', error.code, 'Should attach right code to invalid compression error');
  }
  const largeMsg = { largeMsgId, payload: new Array(1000).fill(oneKbPayload) };
  const kbSize = Math.floor(Buffer.byteLength(JSON.stringify(largeMsg), 'utf8') / 1024);
  try {
    await sqs.publish(ctx, 'basic', largeMsg);
    t.notOk(true, `Should throw when publishing large payloads of ${kbSize} kb`);
  } catch (error) {
    t.strictEquals('MessageTooLong', error.code, 'Should throw for large messages');
  }
  try {
    await sqs.publish(ctx, 'basic', largeMsg, { compression: true });
    t.ok(true, `Should publish large message of ${kbSize} kb with compression`);
  } catch (error) {
    t.notOk(true, 'The large message should have been published');
  }
  await sqs.publish(ctx, 'basic', { messageId }, { compression: true });
  await sqs.publish(ctx, 'redrive', { errorId }, { compression: true });
  await Promise.all([receivePromise, receivePromiseLarge, redrivePromise]);
  await sqs.stop(ctx);
});
