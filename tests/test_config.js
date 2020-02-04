import tap from 'tap';
import uuid from 'uuid/v4';
import SqsClient from '../src/index';

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
    unreal: 'this_queue_does_not_exist',
    quick: 'quick_queue',
  },
  subscriptions: {
    waitTimeSeconds: 1,
  },
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
    wrapError(e) { return e; },
  },
};

function getPromiseAcceptor() {
  let acceptReturn;
  const promise = new Promise((accept) => { acceptReturn = accept; });
  return { accept: acceptReturn, promise };
}

tap.test('test_config', async (t) => {
  const messageId = uuid();
  const sqs = new SqsClient(ctx, qConfig);

  const { accept: doneAccept, promise: receivePromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'basic', (req, message) => {
    if (message.messageId === messageId) {
      t.ok(true, 'Should receive the message that was sent');
      t.strictEquals(req.headers.correlationid, ctx.headers.correlationid, 'Correlation ID should match');
      doneAccept();
    }
  });

  await sqs.start(ctx);

  await sqs.publish(ctx, 'basic', { test: true, messageId });
  t.ok(true, 'Should publish a message');

  try {
    await sqs.publish(ctx, 'foo', { test: true });
    t.notOk(true, 'Should throw for invalid logical queue');
  } catch (error) {
    t.strictEquals('InvalidQueue', error.code, 'Should throw for invalid logical queue');
  }

  try {
    await sqs.publish(ctx, 'unreal', { test: true });
    t.notOk(true, 'Should throw for invalid physical queue');
  } catch (error) {
    t.strictEquals('AWS.SimpleQueueService.NonExistentQueue', error.code, 'Should throw for invalid physical queue');
  }

  await receivePromise;

  const { accept: quickAccept, promise: quickPromise } = getPromiseAcceptor();
  const { accept: slowAccept, promise: slowPromise } = getPromiseAcceptor();
  let alreadyGotItOnce = false;

  await sqs.subscribe(ctx, 'quick', async (_, message) => {
    if (message.messageId === messageId) {
      if (alreadyGotItOnce) {
        t.ok(true, 'Should get quick queue message redelivered');
        slowAccept();
      } else {
        t.ok(true, 'Should receive message on quick queue');
        alreadyGotItOnce = true;
        await new Promise(accept => setTimeout(accept, 1500));
        t.ok(true, 'Should wait 1.5s and timeout');
        quickAccept();
      }
    }
  }, { handleMessageTimeout: 100 });

  await sqs.publish(ctx, 'quick', { test: true, messageId });
  t.ok(true, 'Should publish to quick queue');

  await Promise.all([quickPromise, slowPromise]);
  t.ok(true, 'Should timeout and reprocess timed out message successfully');

  await sqs.stop(ctx);
  t.ok(true, 'Should stop the client');
});
