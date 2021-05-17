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

tap.test('test_config', async (t) => {
  const messageId = uuid();
  const throwId = uuid();
  let alreadyThrew = false;
  const sqs = new SqsClient(ctx, qConfig);

  const { accept: doneAccept, promise: receivePromise } = getPromiseAcceptor();
  const { accept: throwAccept, promise: throwPromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'basic', (req, message) => {
    if (message.messageId === messageId) {
      t.ok(true, 'Should receive the message that was sent');
      t.strictEquals(req.headers.correlationid, ctx.headers.correlationid, 'Correlation ID should match');
      doneAccept();
    }
  });
  const testAttr = {
    MessageAttributes: {
      TestAttr: {
        DataType: 'String',
        StringValue: 'test-attr-value',
      },
    },
  };
  const fetchTestAttr = { messageAttributeNames: ['TestAttr'] };
  await sqs.subscribe(ctx, 'redrive', (req, message) => {
    if (message.throwId === throwId) {
      if (alreadyThrew) {
        t.fail('Should not retry an explicit dead letter error');
        return;
      }
      alreadyThrew = true;
      throwAccept();
      const error = new Error('I do not like green eggs and ham');
      error.deadLetter = true;
      throw error;
    }
  }, fetchTestAttr);

  t.strictEquals(sqs.getQueueConfiguration('redrive').readers, 10, 'Configuration should be stored');
  t.throws(() => sqs.getQueueConfiguration('fakeyfakey'), 'Should throw for invalid queue name');
  t.ok(sqs.getQueueConfiguration('this_should_get_made'), 'Should auto-create dead letter queue');

  await sqs.start(ctx);

  await sqs.publish(ctx, 'basic', { test: true, messageId });
  t.ok(true, 'Should publish a message');
  await sqs.publish(ctx, 'redrive', { test: true, throwId }, testAttr);


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

  await Promise.all([receivePromise, throwPromise]);
  t.strictEquals(alreadyThrew, true, 'Should have delivered the throw message');

  const { accept: deadAccept, promise: deadPromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'dead', (req, message, envelope) => {
    if (message.throwId === throwId) {
      t.ok(true, 'Should received dead-lettered message in deadLetter queue');
      t.strictEquals(
        envelope.MessageAttributes.TestAttr?.StringValue,
        testAttr.MessageAttributes.TestAttr.StringValue,
        'Should retain message attributes',
      );
      deadAccept(envelope);
    }
  }, fetchTestAttr);
  const envelope = await deadPromise;
  t.strictEquals(envelope.MessageAttributes?.ErrorDetail?.StringValue, 'I do not like green eggs and ham', 'ErrorDetail should be present');
  t.strictEquals(envelope.MessageAttributes?.CorrelationId?.StringValue, ctx.headers.correlationid, 'CorrelationId should carry forward');

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

tap.test('test_compression', async (t) => {
  const messageId = uuid();
  const errorId = uuid();
  const sqs = new SqsClient(ctx, qConfig);
  await sqs.start(ctx);
  const { accept: doneAccept, promise: receivePromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'basic', (req, message, envelope) => {
    t.ok(message.messageId === messageId, 'messageId should match after decompressing the message');
    t.strictEquals(undefined, envelope.MessageAttributes['Content-Encoding'], 'Content-Encoding attribute should not be returned as it is already resolved');
    doneAccept(true);
  });
  await sqs.publish(ctx, 'basic', { messageId }, { compression: true });

  try {
    await sqs.publish(ctx, 'basic', { testName: 'compression' }, { compression: { encoding: 'test' } });
    t.notOk(true, 'Should throw for invalid compression encoding');
  } catch (error) {
    t.strictEquals('InvalidEncoding', error.code, 'Should attach right code to invalid compression error');
  }

  const { accept: deadAccept, promise: redrivePromise } = getPromiseAcceptor();
  await sqs.subscribe(ctx, 'redrive', (req, message) => {
    if (message.errorId === errorId) {
      const error = new Error('Compressed redrive message. Throwing Error');
      error.deadLetter = true;
      throw error;
    }
  });

  await sqs.subscribe(ctx, 'dead', (req, message, envelope) => {
    t.ok(message.errorId === errorId, 'messageId should match after decompressing the message');
    t.strictEquals('deflate', envelope.MessageAttributes['Content-Encoding'].StringValue, 'Content-Encoding attribute should be retained');
    deadAccept(true);
  });
  await sqs.publish(ctx, 'redrive', { errorId }, { compression: true });

  await Promise.all([receivePromise, redrivePromise]);
  await sqs.stop(ctx);
});
